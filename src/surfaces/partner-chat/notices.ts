import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { unfinishedTurnText, userFacingFailureClause } from "../../core/failure-copy.ts";
import { reachEnqueue } from "../../reach/reach.ts";
import type { Run, RunStore } from "../../runs/run-store.ts";
import type { Destination, TurnResult } from "../../types.ts";
import { reportFailureAs } from "../../util/errors.ts";

const AWAITING_APPROVAL = "This conversation is waiting on a pending approval.";
const SWEEP_LOOKBACK_MS = 60 * 60_000;
const SWEEP_GRACE_MS = 60_000;
const SWEEP_PAGE = 200;

function noticeText(result: Partial<TurnResult>): string | undefined {
  if (result.status === "pending_approval") return result.reason ?? AWAITING_APPROVAL;
  if (result.status === "refused") return unfinishedTurnText(userFacingFailureClause(result));
  return undefined;
}

function runNotice(run: Run): { destination: Destination; text: string; idempotencyKey: string } | undefined {
  const target = run.request.deliveryTarget;
  if (run.request.surface !== "partner-chat" || run.request.origin.kind !== "human" || !target || !run.result)
    return undefined;
  const text = noticeText(run.result);
  return text ? { destination: { type: "partner-chat", target }, text, idempotencyKey: `notice:${run.id}` } : undefined;
}

export function createPartnerChatNotices(deps: {
  deliveries: DeliveryStore;
  runs: Pick<RunStore, "terminalFinished">;
}) {
  const enqueue = (notice: { destination: Destination; text: string; idempotencyKey: string }) =>
    reachEnqueue({ deliveries: deps.deliveries, ...notice });
  return {
    runEnded(run: Run): void {
      const notice = runNotice(run);
      if (notice) void enqueue(notice).catch(reportFailureAs("partner-chat: notice", undefined));
    },
    async unanswered(result: Partial<TurnResult>, destination: Destination, idempotencyKey: string): Promise<void> {
      const text = noticeText(result);
      if (text) await enqueue({ destination, text, idempotencyKey });
    },
    async sweep(now = Date.now()): Promise<void> {
      let cursor = { finishedAt: now - SWEEP_LOOKBACK_MS, id: "" };
      for (;;) {
        const batch = await deps.runs.terminalFinished(cursor, now - SWEEP_GRACE_MS, SWEEP_PAGE);
        const notices = batch.flatMap((run) => runNotice(run) ?? []);
        const existing = await deps.deliveries.existingKeys(notices.map((n) => n.idempotencyKey));
        for (const notice of notices) if (!existing.has(notice.idempotencyKey)) await enqueue(notice);
        const last = batch.at(-1);
        if (!last || batch.length < SWEEP_PAGE) return;
        cursor = { finishedAt: last.finishedAt!, id: last.id };
      }
    },
  };
}
