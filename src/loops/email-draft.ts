import { randomUUID } from "node:crypto";
import type { EmailDraftInput, HeldEmailDraft } from "../types.ts";
import { ensureInboxLoop, INBOX_LEDGER_MAX_ITEMS, INBOX_LEDGER_RETENTION_MS } from "./inbox-loop.ts";
import { loopItemId, type LoopItemLedger } from "./item-ledger.ts";
import type { LoopStore } from "./loop-store.ts";

export interface EmailDraftDeps {
  loops: LoopStore;
  items: LoopItemLedger;
}

const SNIPPET_CHARS = 200;

export async function holdEmailDraft(
  deps: EmailDraftDeps,
  owner: string,
  draft: EmailDraftInput,
  sessionId?: string,
): Promise<HeldEmailDraft> {
  const loop = await ensureInboxLoop(deps.loops, owner);
  const dedupeKey = `compose:${randomUUID()}`;
  const now = Date.now();
  const snippet = draft.body.trim().split("\n")[0]?.slice(0, SNIPPET_CHARS) || draft.subject;
  await deps.items.ingest([
    {
      loopId: loop.id,
      dedupeKey,
      source: "gmail",
      summary: draft.subject,
      sourceAt: now,
      sourcePayload: { source: "gmail", compose: true, title: draft.subject, from: owner, snippet, receivedAt: now },
      proposal: {
        data: { to: draft.to, ...(draft.cc?.length ? { cc: draft.cc } : {}), subject: draft.subject, body: draft.body },
        by: "agent",
        ...(sessionId ? { sessionId } : {}),
      },
    },
  ]);
  await deps.items.prune(loop.id, { maxItems: INBOX_LEDGER_MAX_ITEMS, retentionMs: INBOX_LEDGER_RETENTION_MS });
  return { loopId: loop.id, itemId: loopItemId(loop.id, dedupeKey) };
}
