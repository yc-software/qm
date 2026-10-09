import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { awaitContextOutcome } from "../surface-context-puller.ts";
import { askAgentAvailable } from "../../resolution/sharing-posture.ts";

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;
const FULFILL_WAIT_MS = 25_000;
const FULFILL_POLL_MS = 100;

async function askAgent(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, body, capability } = ctx;
  if (!capability) {
    return sendJson(res, 401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  }
  const b = isObj(body) ? body : {};
  const person = typeof b.person === "string" ? b.person.trim() : "";
  const task = typeof b.task === "string" ? b.task.trim() : "";
  if (!SLACK_USER_ID.test(person) || !task) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: 'person (their Slack user id, e.g. "U123") and task (what their personal agent should do) are required',
    });
  }
  const available =
    !!capability.runId &&
    (await askAgentAvailable(deps.config, {
      surface: capability.surface,
      scopeId: capability.scopeId,
      actorId: capability.actorId,
      external: !!capability.externalSlack,
    }));
  if (!available) {
    return sendJson(res, 409, {
      error: "unavailable",
      message:
        "asking a personal agent works only during a live turn in an internal, Isolated Slack channel; in Open conversations do the work yourself with the requester's own access",
    });
  }
  const request = await app.createContextRequest("slack", {
    count: 1,
    askAgent: { runId: capability.runId!, targetUserId: person, task: task.slice(0, 4000) },
  });
  const outcome = await awaitContextOutcome(app, request.id, { waitMs: FULFILL_WAIT_MS, pollMs: FULFILL_POLL_MS });
  if (outcome.status === "done" && outcome.result.handoff) {
    return sendJson(res, 200, {
      ok: true,
      requestId: outcome.result.handoff.requestId,
      message: `Sent the request to ${outcome.result.handoff.target} for approval and posted its status in this thread. Nothing has run yet; the result posts here only if they approve.`,
    });
  }
  if (outcome.status === "timeout") {
    return sendJson(res, 504, {
      error: "timeout",
      message: "Slack didn't confirm the request in time; calling again with the same person and task is safe",
    });
  }
  return sendJson(res, 409, {
    error: "not_sent",
    message: outcome.status === "failed" && outcome.error ? outcome.error : "the request was not sent",
  });
}

export const askAgentRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/ask-agent", auth: "either", handle: askAgent },
];
