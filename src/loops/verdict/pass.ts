import type { Loop, LoopItem, LoopItemVerdict } from "../types.ts";
import type { LoopItemLedger } from "../item-ledger.ts";
import type { ErrorLog } from "../../admin/error-log.ts";
import { personalScope } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { isResolved } from "../ledger-view.ts";
import { draftOf, isObj } from "../sources/adapter.ts";
import { INBOX_LEDGER_MAX_ITEMS, INBOX_LEDGER_RETENTION_MS } from "../inbox-loop.ts";
import { changedSinceLastLook, SourceRateLimited, type ConversationFetcher } from "./fetch.ts";
import { scanSince, type Discoverer } from "./discover.ts";
import { conversationPayload, draftData, waitingMessage } from "./payload.ts";
import { newestTs } from "./transcript.ts";
import { runVerdict, writeDraft, type VerdictInput, type VerdictModel } from "./verdict.ts";

export interface InboxPassDeps {
  items: Pick<LoopItemLedger, "byLoop" | "ingest" | "recordVerdict" | "skip" | "prune">;
  fetch: ConversationFetcher;
  discover: Discoverer;
  model: VerdictModel;
  errors?: Pick<ErrorLog, "record">;
  ownerName?: (owner: string) => Promise<string | undefined>;
  now?: () => number;
}

export interface InboxPassOptions {
  discover: boolean;
  voiceProfile?: string;
}

export interface InboxPassSummary {
  discovered: number;
  checked: number;
  verdicts: number;
  failures: string[];
  scanned: boolean;
  firstError?: unknown;
}

export type InboxPass = (loop: Loop, options: InboxPassOptions) => Promise<InboxPassSummary>;

const CONCURRENCY = 4;

function passOrder(a: LoopItem, b: LoopItem): number {
  const open = Number(isResolved(a)) - Number(isResolved(b));
  return open || (a.verdict?.at ?? 0) - (b.verdict?.at ?? 0);
}

function alwaysRead(item: LoopItem): boolean {
  if (!item.verdict || item.status === "queued") return true;
  const slack = isObj(item.sourcePayload?.slack) ? item.sourcePayload.slack : undefined;
  return slack !== undefined && typeof slack.threadTs === "string" && slack.isDirectMessage !== true;
}

function onlyOwnerSince(item: LoopItem, messages: Array<{ ts: string; at: number; owner: boolean }>): boolean {
  const index = item.verdict
    ? messages.findIndex((message) => message.ts === item.verdict!.lastSeenTs)
    : messages.findLastIndex((message) => message.at <= (item.sourceAt ?? 0));
  return index >= 0 && messages.slice(index + 1).every((message) => message.owner);
}

export function createInboxPass(deps: InboxPassDeps): InboxPass {
  const now = deps.now ?? Date.now;

  function record(owner: string, code: string, message: string, error: unknown): void {
    deps.errors?.record(
      { category: "inbox", code, message: redactSecrets(message), scopeLabel: personalScope(owner) },
      error,
    );
  }

  async function one(
    loop: Loop,
    item: LoopItem,
    ownerName: string | undefined,
    voiceProfile?: string,
  ): Promise<boolean> {
    const owner = loop.owner;
    const outcome = await deps.fetch(owner, item);
    if (outcome.kind === "skipped") {
      if (outcome.reason === "bad_item") await deps.items.skip(item.id, "the item has no usable source reference");
      return false;
    }
    const { conversation } = outcome;
    if (!changedSinceLastLook(item, conversation)) return false;
    if (isResolved(item) && onlyOwnerSince(item, conversation.messages)) return false;
    const lastSeenTs = newestTs(conversation)!;
    const previousDraft = draftOf(item)?.body;
    const input: VerdictInput = {
      owner: { id: owner, ...(ownerName ? { name: ownerName } : {}) },
      conversation,
      ...(previousDraft ? { previousDraft } : {}),
      ...(voiceProfile ? { voiceProfile } : {}),
      now: now(),
    };
    const result = await runVerdict(deps.model, input);
    const waiting = waitingMessage(conversation, result.waitingTs);
    let draft: string | undefined;
    let draftFailure: unknown;
    if (result.state === "needs_reply")
      try {
        draft = await writeDraft(deps.model, input, result.waitingTs);
      } catch (error) {
        draftFailure = error;
      }
    const verdict: LoopItemVerdict = { ...result, lastSeenTs, at: now() };
    const newest = conversation.messages.at(-1)!;
    await deps.items.recordVerdict(item.id, {
      verdict,
      sourcePayload: conversationPayload(item.sourcePayload, conversation, result.waitingTs),
      sourceAt: newest.at,
      ...(draft ? { draft: draftData(conversation, waiting, draft) } : {}),
      ...(result.state === "resolved" && newest.owner ? { replied: newest.text } : {}),
    });
    if (draftFailure !== undefined)
      record(owner, "draft_failed", `Inbox draft for item ${item.id}: ${errMessage(draftFailure)}`, draftFailure);
    return true;
  }

  return async (loop, options) => {
    const summary: InboxPassSummary = { discovered: 0, checked: 0, verdicts: 0, failures: [], scanned: false };
    const fail = (code: string, message: string, error: unknown) => {
      summary.failures.push(errMessage(error));
      summary.firstError ??= error;
      record(loop.owner, code, message, error);
    };
    let active: Set<string> | undefined;
    if (options.discover)
      try {
        const tracked = new Set((await deps.items.byLoop(loop.id)).map((item) => item.sourceKey));
        const found = await deps.discover(loop, scanSince(loop, now()));
        active = new Set(found.map((entry) => entry.dedupeKey));
        const fresh = found.filter((entry) => !tracked.has(entry.dedupeKey));
        if (fresh.length) summary.discovered = (await deps.items.ingest(fresh)).created;
        summary.scanned = true;
      } catch (error) {
        fail("discover_failed", `Inbox scan for loop ${loop.id}: ${errMessage(error)}`, error);
      }
    const everything = options.discover && !summary.scanned;
    const items = (await deps.items.byLoop(loop.id))
      .filter((item) => everything || alwaysRead(item) || active?.has(item.sourceKey))
      .sort(passOrder);
    const ownerName = await deps.ownerName?.(loop.owner).catch((error: unknown) => {
      record(loop.owner, "owner_name_failed", `Inbox owner name for loop ${loop.id}: ${errMessage(error)}`, error);
      return undefined;
    });
    let stopped = false;
    for (let index = 0; index < items.length && !stopped; index += CONCURRENCY) {
      await Promise.all(
        items.slice(index, index + CONCURRENCY).map(async (item) => {
          try {
            summary.checked++;
            if (await one(loop, item, ownerName, options.voiceProfile)) summary.verdicts++;
          } catch (error) {
            if (error instanceof SourceRateLimited) stopped = true;
            fail("verdict_failed", `Inbox verdict for item ${item.id}: ${errMessage(error)}`, error);
          }
        }),
      );
    }
    await deps.items
      .prune(loop.id, { maxItems: INBOX_LEDGER_MAX_ITEMS, retentionMs: INBOX_LEDGER_RETENTION_MS, now: now() })
      .catch((error: unknown) => fail("prune_failed", `Inbox prune for loop ${loop.id}: ${errMessage(error)}`, error));
    return summary;
  };
}
