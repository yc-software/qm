import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { approvedCallRunning, newApprovalRecord } from "../core/orchestrator/approvals.ts";
import { approvalCardId, commandApprovalId, toolCallApprovalKey } from "../core/approval-id.ts";
import { approvalCallText } from "../agent/agent-tools/wrappers.ts";
import { APPROVED_ACTION_HEADER, API_ACTION_TOOL } from "./contract.ts";
import { sendJson } from "./http.ts";
import type { ApiCtx } from "./routes/route.ts";

interface ApiAction {
  method: string;
  path: string;
  body?: unknown;
}

function requestAction(ctx: ApiCtx): ApiAction {
  return {
    method: ctx.method,
    path: `${ctx.url.pathname}${ctx.url.search}`,
    ...(ctx.body !== undefined && ctx.body !== null && ctx.body !== "" ? { body: ctx.body } : {}),
  };
}

function sameAction(a: unknown, b: ApiAction): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b);
}

export async function actionApproved(ctx: ApiCtx, card: { summary: string; shownBody?: unknown }): Promise<boolean> {
  const claims = ctx.capability;
  if (!claims) return true;
  const { deps, res } = ctx;
  const action = requestAction(ctx);
  const presented = ctx.req.headers[APPROVED_ACTION_HEADER];
  if (typeof presented === "string" && presented && claims.sessionId && claims.runId && deps.sessions) {
    const items = await deps.sessions.getItems(claims.sessionId, { turnId: claims.runId });
    if (sameAction(approvedCallRunning(items, presented, claims.actorId)?.input, action)) return true;
    sendJson(res, 403, { error: "approval_mismatch", message: "That approval does not cover this exact request." });
    return false;
  }
  const run = claims.runId ? await deps.runs?.get(claims.runId) : null;
  if (!run || !claims.sessionId || !deps.approvals) {
    sendJson(res, 403, {
      error: "approval_unavailable",
      message: "This step needs an approval card, and this request isn't tied to a run that can carry one.",
    });
    return false;
  }
  const command = approvalCallText(`${action.method} ${action.path}`, card.shownBody ?? action.body);
  const approvalKey = toolCallApprovalKey(API_ACTION_TOOL, action);
  const requestId = commandApprovalId(claims.sessionId, command, approvalKey);
  if (!(await deps.approvals.get(requestId))) {
    const record = newApprovalRecord(
      {
        sessionId: claims.sessionId,
        command,
        summary: card.summary,
        reason: "Needs your sign-off",
        approvalKey,
        kind: "approval",
        blocksInput: false,
        call: { tool: API_ACTION_TOOL, input: { ...action } },
      },
      run.request,
      { session: false, always: false },
    );
    await deps.approvals.put(requestId, record);
  }
  sendJson(res, 202, {
    error: "approval_required",
    card: approvalCardId(approvalKey),
    message:
      "This step needs the person's sign-off, so an approval card for this exact request was sent to them. Approving it runs this request as-is and continues the task; don't retry it.",
  });
  return false;
}

export function routeSignOff(ctx: ApiCtx) {
  let held = false;
  const signOff = async (summary: string) => {
    held = !(await actionApproved(ctx, { summary }));
    return !held;
  };
  return { signOff, held: () => held };
}
