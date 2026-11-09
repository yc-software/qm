import type { Loop, LoopItem, LoopItemVerdict } from "../types.ts";
import type { LoopItemLedger } from "../item-ledger.ts";
import type { FeatureFlagStore } from "../../feature-flags.ts";
import type { ErrorLog } from "../../admin/error-log.ts";
import type { AuditLog } from "../../audit/audit-log.ts";
import { personalScope } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { isResolved } from "../ledger-view.ts";
import { draftOf } from "../sources/adapter.ts";
import { changedSinceLastLook, SourceRateLimited, type ConversationFetcher } from "./fetch.ts";
import { newestTs } from "./transcript.ts";
import { runVerdict, writeDraft, type VerdictInput, type VerdictModel } from "./verdict.ts";

export const INBOX_VERDICT_DISAGREEMENT = "inbox.verdict_disagreement";
const ITEMS_PER_PASS = 100;
const CONCURRENCY = 4;

export interface InboxVerdictDeps {
  featureFlags: Pick<FeatureFlagStore, "enabled">;
  items: Pick<LoopItemLedger, "byLoop" | "setVerdict">;
  fetch: ConversationFetcher;
  model: VerdictModel;
  audit: Pick<AuditLog, "record">;
  errors?: Pick<ErrorLog, "record">;
  ownerName?: (owner: string) => Promise<string | undefined>;
  now?: () => number;
}

export type InboxVerdictPass = (loop: Loop, voiceProfile?: string) => Promise<void>;

export function ledgerClassification(item: Pick<LoopItem, "status" | "sourcePayload">): LoopItemVerdict["ledgerState"] {
  return isResolved(item) || item.sourcePayload?.probablyResolved === true ? "resolved" : "needs_reply";
}

function disagrees(verdict: Pick<LoopItemVerdict, "state" | "ledgerState">): boolean {
  return verdict.state !== verdict.ledgerState;
}

function passOrder(a: LoopItem, b: LoopItem): number {
  const open = Number(isResolved(a)) - Number(isResolved(b));
  return open || (a.verdict?.at ?? 0) - (b.verdict?.at ?? 0);
}

export function createInboxVerdictPass(deps: InboxVerdictDeps): InboxVerdictPass {
  const now = deps.now ?? Date.now;

  function fail(owner: string, item: LoopItem, error: unknown): void {
    deps.errors?.record(
      {
        category: "inbox",
        code: "verdict_failed",
        message: redactSecrets(`Inbox verdict for item ${item.id}: ${errMessage(error)}`),
        scopeLabel: personalScope(owner),
      },
      error,
    );
  }

  async function one(loop: Loop, item: LoopItem, ownerName: string | undefined, voiceProfile?: string): Promise<void> {
    const owner = loop.owner;
    const outcome = await deps.fetch(owner, item);
    if (outcome.kind === "skipped") return;
    const { conversation } = outcome;
    if (!changedSinceLastLook(item, conversation)) return;
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
    let draft: string | null = null;
    let draftFailure: unknown;
    if (result.state === "needs_reply")
      try {
        draft = await writeDraft(deps.model, input, result.waitingTs);
      } catch (error) {
        draftFailure = error;
      }
    const verdict: LoopItemVerdict = {
      ...result,
      draft,
      lastSeenTs,
      ledgerState: ledgerClassification(item),
      at: now(),
    };
    await deps.items.setVerdict(item.id, verdict);
    if (draftFailure !== undefined) fail(owner, item, draftFailure);
    if (disagrees(verdict))
      deps.audit.record({
        at: verdict.at,
        principalId: owner,
        action: INBOX_VERDICT_DISAGREEMENT,
        resource: `loop_item:${item.id}`,
        scopeLabel: personalScope(owner),
        status: verdict.state,
        detail: `Inbox shows ${verdict.ledgerState.replace("_", " ")}; verdict ${verdict.state.replace("_", " ")}: ${verdict.reason}`,
      });
  }

  return async (loop, voiceProfile) => {
    try {
      if (!(await deps.featureFlags.enabled("inbox_verdict", personalScope(loop.owner)))) return;
      const items = (await deps.items.byLoop(loop.id)).sort(passOrder).slice(0, ITEMS_PER_PASS);
      const ownerName = await deps.ownerName?.(loop.owner);
      const stopped = new Set<string>();
      for (let index = 0; index < items.length; index += CONCURRENCY) {
        await Promise.all(
          items.slice(index, index + CONCURRENCY).map(async (item) => {
            if (!item.source || stopped.has(item.source)) return;
            try {
              await one(loop, item, ownerName, voiceProfile);
            } catch (error) {
              if (error instanceof SourceRateLimited) stopped.add(item.source);
              fail(loop.owner, item, error);
            }
          }),
        );
      }
    } catch (error) {
      deps.errors?.record(
        {
          category: "inbox",
          code: "verdict_pass_failed",
          message: redactSecrets(`Inbox verdict pass for loop ${loop.id}: ${errMessage(error)}`),
          scopeLabel: personalScope(loop.owner),
        },
        error,
      );
    }
  };
}
