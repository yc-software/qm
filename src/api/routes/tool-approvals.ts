import { randomUUID } from "node:crypto";
import { approvalCardId, toolCallApprovalKey } from "../../core/approval-id.ts";
import { samePerson } from "../../directory/person.ts";
import { isTerminal } from "../../runs/run-store.ts";
import { SIGNAL_POLL_MS } from "../../runs/run-signal-store.ts";
import { sleep } from "../../util/async.ts";
import { sendJson } from "../http.ts";
import { audit, isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

// A live run's signal poll wakes on notify and falls back to polling every SIGNAL_POLL_MS, so two of its rounds is long enough to know no run will take the request.
const TAKE_WAIT_MS = 2 * SIGNAL_POLL_MS;
const TAKE_POLL_MS = 200;
const RUN_CHECK_MS = 1_000;

const NO_LIVE_TURN =
  "this call needs the person's approval, and only a live QM turn can show them an approval card; published apps and commands that outlive their turn can't run it";

async function requestToolApproval(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability } = ctx;
  if (!capability) {
    return sendJson(res, 401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  }
  const b = isObj(body) ? body : {};
  const tool = b.tool;
  const input = b.input;
  if (typeof tool !== "string" || !tool || !isObj(input)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "pass `tool` (a tool name) and `input` (its arguments)",
    });
  }
  const runId = capability.runId;
  if (!runId || !capability.sessionId) return sendJson(res, 409, { error: "no_live_turn", message: NO_LIVE_TURN });
  const { runs, signals } = deps;
  if (!runs || !signals) {
    return sendJson(res, 503, { error: "unavailable", message: "approval requests aren't available on this server" });
  }
  const run = await runs.get(runId);
  if (!run || run.sessionId !== capability.sessionId || !samePerson(run.request.actor.id, capability.actorId)) {
    return sendJson(res, 409, { error: "no_live_turn", message: NO_LIVE_TURN });
  }
  if (isTerminal(run.status)) return sendJson(res, 409, { error: "no_live_turn", message: NO_LIVE_TURN });
  const dedupeKey = `tool-approval:${runId}:${randomUUID()}`;
  await signals.send(runId, { kind: "approval_request", tool, input, dedupeKey });
  const resource = `${tool}/${typeof input.tool === "string" ? input.tool : ""}`;
  const record = (status: "ok" | "refused") =>
    audit(deps, {
      principalId: capability.actorId,
      action: "tool_approval.request",
      resource,
      scopeLabel: capability.scopeId,
      status,
    });
  const refuse = () => {
    record("refused");
    sendJson(res, 409, {
      error: "not_raised",
      message:
        "QM could not show an approval card for this call on the current turn: the turn has ended, or this tool isn't one of its connector tools that needs approval",
    });
  };
  const deadline = Date.now() + TAKE_WAIT_MS;
  let nextRunCheck = Date.now() + RUN_CHECK_MS;
  for (;;) {
    const mine = (await signals.pending(runId)).find(({ signal }) => signal.dedupeKey === dedupeKey);
    if (!mine) {
      // Only a live run's signal poll takes the request while the run is unfinished; a finished run's signal drain also consumes it, so a run that has ended by now did not show the card.
      const after = await runs.get(runId);
      if (!after || isTerminal(after.status)) return refuse();
      record("ok");
      return sendJson(res, 200, {
        status: "pending_approval",
        card: approvalCardId(toolCallApprovalKey(tool, input)),
      });
    }
    let live = Date.now() < deadline;
    if (live && Date.now() >= nextRunCheck) {
      nextRunCheck = Date.now() + RUN_CHECK_MS;
      const current = await runs.get(runId);
      live = !!current && !isTerminal(current.status);
    }
    if (!live) {
      await signals.acknowledge(runId, mine.id);
      return refuse();
    }
    await sleep(TAKE_POLL_MS);
  }
}

export const toolApprovalRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/tool-approvals", auth: "either", handle: requestToolApproval },
];
