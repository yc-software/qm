import { randomUUID } from "node:crypto";
import { samePerson } from "../../directory/person.ts";
import { isTerminal } from "../../runs/run-store.ts";
import { SIGNAL_POLL_MS, waitForClientResult } from "../../runs/run-signal-store.ts";
import { sendJson } from "../http.ts";
import { audit, isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

// A live run's signal poll wakes on notify and falls back to polling every SIGNAL_POLL_MS, so it answers well within two of its rounds.
const ANSWER_WAIT_MS = 2 * SIGNAL_POLL_MS;

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
  if (
    !run ||
    isTerminal(run.status) ||
    run.sessionId !== capability.sessionId ||
    !samePerson(run.request.actor.id, capability.actorId)
  ) {
    return sendJson(res, 409, { error: "no_live_turn", message: NO_LIVE_TURN });
  }
  const dedupeKey = `tool-approval:${runId}:${randomUUID()}`;
  await signals.send(runId, { kind: "approval_request", tool, input, dedupeKey });
  const answer = await waitForClientResult(signals, runId, dedupeKey, { timeoutMs: ANSWER_WAIT_MS });
  let card: string | undefined;
  if (typeof answer === "object" && !answer.isError && isObj(answer.structured)) {
    const raised = answer.structured.card;
    if (typeof raised === "string") card = raised;
  }
  if (typeof answer !== "object") {
    const unanswered = (await signals.pending(runId)).find(({ signal }) => signal.dedupeKey === dedupeKey);
    if (unanswered) await signals.acknowledge(runId, unanswered.id);
  }
  audit(deps, {
    principalId: capability.actorId,
    action: "tool_approval.request",
    resource: `${tool}/${typeof input.tool === "string" ? input.tool : ""}`,
    scopeLabel: capability.scopeId,
    status: card ? "ok" : "refused",
    ...(card ? {} : { detail: typeof answer === "object" ? answer.content : "unanswered" }),
  });
  if (card) return sendJson(res, 200, { status: "pending_approval", card });
  return sendJson(res, 409, {
    error: "not_raised",
    message:
      typeof answer === "object"
        ? `QM could not show an approval card for this call: ${answer.content}`
        : "QM could not show an approval card for this call: no live turn answered",
  });
}

export const toolApprovalRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/tool-approvals", auth: "either", handle: requestToolApproval },
];
