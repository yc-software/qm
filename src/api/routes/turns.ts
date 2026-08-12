import type { TurnOrigin, TurnRequest } from "../../types.ts";
import { resolveTurnOrigin } from "../../core/turn-origin.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

function isTurnRequest(body: unknown): body is TurnRequest {
  return isObj(body) && typeof body.text === "string" && isObj(body.actor) && isObj(body.conversation);
}

function publicOrigin(origin: TurnOrigin | undefined): TurnOrigin | undefined {
  if (origin?.kind !== "automation") return origin;
  const { useOwnerKeychain: _internalOnly, ...safe } = origin;
  return safe;
}

function publicTurnOrigin(body: TurnRequest): { origin?: TurnOrigin; error?: string } {
  const typed = publicOrigin(body.origin);
  if (
    typed?.kind === "automation" &&
    body.triggered === true &&
    typed.screenData !== undefined &&
    body.securityScreenData !== undefined &&
    typed.screenData !== body.securityScreenData
  ) {
    return { error: "conflicting typed and legacy automation screen data" };
  }
  return { origin: resolveTurnOrigin({ ...body, ...(typed ? { origin: typed } : { origin: undefined }) }) };
}

async function postTurn(ctx: ApiCtx): Promise<void> {
  const { res, app, url, body } = ctx;
  if (!isTurnRequest(body)) {
    return sendJson(res, 400, { error: "bad_request", message: "expected a TurnRequest" });
  }
  const wantAsync = url.searchParams.get("async") === "1" || body.async === true;
  const { ownerKeychainUnion: _ownerKeychainUnion, spawned: _spawned, ...safeBody } = body;
  const resolvedOrigin = publicTurnOrigin(safeBody);
  if (resolvedOrigin.error) return sendJson(res, 400, { error: "bad_request", message: resolvedOrigin.error });
  const origin = resolvedOrigin.origin;
  const result = await app.turn({ ...safeBody, ...(origin ? { origin } : {}), async: wantAsync });
  if (result.status === "queued") return sendJson(res, 202, result);
  const status = result.status === "refused" ? 403 : 200;
  return sendJson(res, status, result);
}

async function getApproval(ctx: ApiCtx): Promise<void> {
  const { res, app, actor } = ctx;
  const id = ctx.params.id!;
  if (!id || id.includes("/")) return sendJson(res, 404, { error: "not_found" });
  const record = await app.getApproval(id, actor?.p);
  return record ? sendJson(res, 200, record) : sendJson(res, 404, { error: "not_found" });
}

async function getPendingApproval(ctx: ApiCtx): Promise<void> {
  const { res, app, url, actor } = ctx;
  const threadRef = url.searchParams.get("threadRef") ?? "";
  if (!threadRef) return sendJson(res, 400, { error: "bad_request", message: "threadRef required" });
  return sendJson(res, 200, { pending: await app.pendingApprovalForThread(threadRef, actor?.p) });
}

async function postRunDeliveryState(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const id = ctx.params.id!;
  const editRef = isObj(body) && typeof body.editRef === "string" ? body.editRef : "";
  if (!id || !editRef) return sendJson(res, 400, { error: "bad_request", message: "editRef required" });
  const found = await app.setRunDeliveryState(id, { editRef });
  if (!found) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { ok: true });
}

async function postRunSignal(ctx: ApiCtx): Promise<void> {
  const { res, app, body, actor } = ctx;
  const id = ctx.params.id!;
  const kind = isObj(body) && typeof body.kind === "string" ? body.kind : "";
  if (kind !== "abort" && kind !== "steer") {
    return sendJson(res, 400, { error: "bad_request", message: "kind must be abort or steer" });
  }
  const text = isObj(body) && typeof body.text === "string" ? body.text : undefined;
  const outcome = await app.signalRun(id, { kind, ...(text !== undefined ? { text } : {}) }, actor?.p);
  if (outcome.accepted) return sendJson(res, 200, outcome);
  if (outcome.reason === "not_found") return sendJson(res, 404, { error: "not_found" });
  if (outcome.reason === "text_required")
    return sendJson(res, 400, { error: "bad_request", message: "text required", ...outcome });
  return sendJson(res, 409, outcome);
}

async function getRun(ctx: ApiCtx): Promise<void> {
  const { res, app, actor } = ctx;
  const id = ctx.params.id!;
  const run = await app.getRun(id, actor?.p);
  if (!run) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, run);
}

async function getActiveRunForThread(ctx: ApiCtx): Promise<void> {
  const { res, app, url, actor } = ctx;
  const threadRef = url.searchParams.get("threadRef") ?? "";
  if (!threadRef) return sendJson(res, 400, { error: "bad_request", message: "threadRef required" });
  const active = await app.activeRunForThread(threadRef, actor?.p);
  return sendJson(res, 200, { runId: active?.runId ?? null, ...(active?.queued ? { queued: active.queued } : {}) });
}

async function postRunWithdraw(ctx: ApiCtx): Promise<void> {
  const { res, app, actor } = ctx;
  const outcome = await app.withdrawRun(ctx.params.id!, actor?.p);
  if (outcome.withdrawn) return sendJson(res, 200, outcome);
  if (outcome.reason === "not_found") return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 409, outcome);
}

async function listDeliveries(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const type = url.searchParams.get("type") ?? "";
  const claimMsRaw = Number(url.searchParams.get("claimMs") ?? 0);
  const claimMs = Number.isFinite(claimMsRaw) && claimMsRaw > 0 ? claimMsRaw : 0;
  return sendJson(res, 200, { deliveries: await app.pendingDeliveries(type, claimMs) });
}

async function ackDelivery(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const id = ctx.params.id!;
  const recipientThreadRef =
    isObj(body) && typeof body.recipientThreadRef === "string" ? body.recipientThreadRef : undefined;
  const slackApiMs =
    isObj(body) && typeof body.slackApiMs === "number" && Number.isFinite(body.slackApiMs) && body.slackApiMs >= 0
      ? body.slackApiMs
      : undefined;
  if (recipientThreadRef) await app.recordPrincipalDelivery(id, recipientThreadRef);
  await app.ackDelivery(id, slackApiMs);
  return sendJson(res, 200, { ok: true });
}

async function ackDeliveryByKey(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const idempotencyKey = isObj(body) && typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  if (!idempotencyKey) return sendJson(res, 400, { error: "bad_request", message: "idempotencyKey required" });
  await app.ackDeliveryByKey(idempotencyKey);
  return sendJson(res, 200, { ok: true });
}

async function postTurnMetrics(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const runId = ctx.params.runId!;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const deliverMs = isObj(body) ? num(body.deliverMs) : undefined;
  const slackInflightMs = isObj(body) ? num(body.slackInflightMs) : undefined;
  if (deliverMs === undefined && slackInflightMs === undefined) {
    return sendJson(res, 400, { error: "bad_request", message: "deliverMs or slackInflightMs required" });
  }
  await deps.metrics
    ?.updateByRunId(runId, {
      ...(deliverMs !== undefined ? { deliverMs } : {}),
      ...(slackInflightMs !== undefined ? { slackInflightMs } : {}),
    })
    .catch(() => undefined);
  return sendJson(res, 200, { ok: true });
}

export const turnRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/turns", auth: "source", handle: postTurn },
  { method: "POST", path: "/v1/turns/:runId/metrics", auth: "source", handle: postTurnMetrics },
  { method: "GET", path: "/v1/approvals/pending", auth: "source", handle: getPendingApproval },
  { method: "GET", path: "/v1/approvals/:id", auth: "source", handle: getApproval },
  { method: "POST", path: "/v1/runs/:id/delivery-state", auth: "source", handle: postRunDeliveryState },
  { method: "POST", path: "/v1/runs/:id/signal", auth: "source", handle: postRunSignal },
  { method: "POST", path: "/v1/runs/:id/withdraw", auth: "source", handle: postRunWithdraw },
  { method: "GET", path: "/v1/runs/:id", auth: "source", handle: getRun },
  { method: "GET", path: "/v1/runs", auth: "source", handle: getActiveRunForThread },
  { method: "GET", path: "/v1/deliveries", auth: "source", handle: listDeliveries },
  { method: "POST", path: "/v1/deliveries/:id/ack", auth: "source", handle: ackDelivery },
  { method: "POST", path: "/v1/deliveries/ack-by-key", auth: "source", handle: ackDeliveryByKey },
];
