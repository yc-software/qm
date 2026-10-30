import type { NewEntry } from "../sessions/session-store.ts";
import { isApprovalEntry } from "../sessions/session-store.ts";
import { isObj } from "../util/objects.ts";
import { reportFailureAs } from "../util/errors.ts";
import { turnEndState, type DecisionHooks, type DecisionTurn } from "./hooks.ts";

export const REPLY_REVISIONS = 2;

export interface ReplyCheck {
  review(entry: NewEntry): Promise<NewEntry>;
  takeRevision(): string | undefined;
}

export function createReplyCheck(opts: {
  decide: DecisionHooks;
  surfaceName?: string;
  guidance?: string;
  input: string;
  turn: DecisionTurn & { cancel: AbortSignal };
  posted: () => boolean;
  onRevise: () => void;
}): ReplyCheck {
  let revisions = 0;
  let awaitingApproval = false;
  let revision: { note: string; draft: string } | undefined;
  const where = `session=${opts.turn.sessionId}`;
  return {
    async review(entry) {
      if (isApprovalEntry(entry)) awaitingApproval = true;
      if (entry.type !== "assistant") return entry;
      revision = undefined;
      if (awaitingApproval || opts.posted() || opts.turn.cancel.aborted) return entry;
      const payload = isObj(entry.payload) ? entry.payload : {};
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text.trim() || payload.stopped === true) return entry;
      if (revisions >= REPLY_REVISIONS) {
        console.error(`[decisions] reply revision cap of ${REPLY_REVISIONS} reached, delivering unchecked ${where}`);
        return entry;
      }
      const verdict = await opts.decide
        .run(
          "turn_end",
          turnEndState({
            ...(opts.surfaceName ? { surfaceName: opts.surfaceName } : {}),
            scopeLabel: opts.turn.scopeLabel,
            ...(opts.guidance ? { guidance: opts.guidance } : {}),
            input: opts.input,
            reply: text,
          }),
          opts.turn,
        )
        .catch(reportFailureAs("reply check", undefined, where));
      if (verdict?.action !== "revise" || !verdict.message || opts.turn.cancel.aborted) return entry;
      revisions += 1;
      revision = { note: verdict.message, draft: text };
      opts.onRevise();
      console.error(`[decisions] reply revision ${revisions} ${where}`);
      return { ...entry, type: "text", payload: { ...payload, demoted: true } };
    },
    takeRevision() {
      const held = revision;
      revision = undefined;
      return (
        held &&
        `[system] Your draft reply was held back, not delivered. ${held.note}\n\nThe held-back draft:\n${held.draft}\n\nWrite the reply again.`
      );
    },
  };
}
