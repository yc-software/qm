import { randomUUID } from "node:crypto";
import { isTerminal } from "../../runs/run-store.ts";
import { waitForClientResult } from "../../runs/run-signal-store.ts";
import type { UiSignal } from "../../runs/session-state-bus.ts";
import {
  isUiCanvasSessionId,
  readUiCanvas,
  uiObserveKey,
  UiCanvasTooLargeError,
  writeUiCanvas,
  type UiCanvas,
  type UiCanvasPatch,
} from "../../surfaces/ui-canvas.ts";
import { uiStateId, UI_STATE_MAX_BYTES } from "../../surfaces/ui-state.ts";
import { scopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import { conversationRef } from "./pins.ts";
import { samePerson } from "../../directory/person.ts";
import { audit, isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

const OBSERVE_TIMEOUT_MS = 15_000;
const MAX_SELECTOR_CHARS = 500;

interface UiTurn {
  actorId: string;
  sessionId: string;
  threadRef: string;
  runId: string;
  personal: boolean;
}

async function liveWebTurn(ctx: ApiCtx): Promise<UiTurn | null> {
  const { res, deps } = ctx;
  const threadRef = await conversationRef(ctx);
  if (!threadRef) return null;
  const cap = ctx.capability!;
  if (!deps.uiState || !deps.runs || !deps.sessions) {
    sendJson(res, 404, { error: "not_available", message: "this deployment has no UI state store" });
    return null;
  }
  if ((await deps.featureFlags?.enabled("ui_canvas", scopeId("personal", cap.actorId))) !== true) {
    sendJson(res, 403, {
      error: "feature_disabled",
      message: "The ui_canvas feature flag is off for this person. An org admin can enable it under feature flags.",
    });
    return null;
  }
  if (cap.surface !== "web" || !cap.liveActor || cap.triggered || cap.botActor) {
    sendJson(res, 403, {
      error: "not_live_web_turn",
      message: "Only available during a turn the person started from the web UI.",
    });
    return null;
  }
  const run = cap.runId ? await deps.runs.get(cap.runId) : null;
  if (!run || isTerminal(run.status)) {
    sendJson(res, 409, { error: "turn_ended", message: "The turn that issued this token has ended." });
    return null;
  }
  const session = await deps.sessions.getByThread(threadRef);
  if (!session || !isUiCanvasSessionId(session.id)) {
    sendJson(res, 404, { error: "not_found", message: "no such conversation" });
    return null;
  }
  return {
    actorId: cap.actorId,
    sessionId: session.id,
    threadRef,
    runId: run.id,
    personal: cap.scopeId === scopeId("personal", cap.actorId),
  };
}

function signalBrowser(ctx: ApiCtx, turn: Pick<UiTurn, "actorId" | "sessionId" | "threadRef">, ui: UiSignal): void {
  ctx.deps.sessionStateBus?.emit({
    threadRef: turn.threadRef,
    sessionId: turn.sessionId,
    participants: [turn.actorId],
    state: "ui",
    at: Date.now(),
    ui,
  });
}

function canvasSummary(canvas: UiCanvas | null): Record<string, unknown> | null {
  if (!canvas) return null;
  return {
    rev: canvas.rev,
    pinned: canvas.pinned,
    bytes: { html: canvas.html.length, css: canvas.css.length, js: canvas.js.length },
  };
}

async function getCanvas(ctx: ApiCtx): Promise<void> {
  const turn = await liveWebTurn(ctx);
  if (!turn) return;
  return sendJson(ctx.res, 200, { canvas: await readUiCanvas(ctx.deps.uiState!, turn.actorId, turn.sessionId) });
}

function parsePatch(body: unknown): UiCanvasPatch | string {
  const b = isObj(body) ? body : {};
  const patch: UiCanvasPatch = {};
  for (const field of ["html", "css", "js"] as const) {
    if (b[field] === undefined) continue;
    if (typeof b[field] !== "string") return `${field} must be a string`;
    patch[field] = b[field];
  }
  for (const field of ["pinned", "replace"] as const) {
    if (b[field] === undefined) continue;
    if (typeof b[field] !== "boolean") return `${field} must be a boolean`;
    patch[field] = b[field];
  }
  if (Object.keys(patch).length === 0) return "pass html, css, js, pinned, or replace";
  return patch;
}

async function applyCanvas(
  ctx: ApiCtx,
  turn: Pick<UiTurn, "actorId" | "sessionId" | "threadRef">,
  patch: UiCanvasPatch | null,
): Promise<void> {
  let canvas: UiCanvas | null;
  try {
    canvas = await writeUiCanvas(ctx.deps.uiState!, turn.actorId, turn.sessionId, patch);
  } catch (error) {
    if (!(error instanceof UiCanvasTooLargeError)) throw error;
    return sendJson(ctx.res, 413, {
      error: "payload_too_large",
      message: `html, css and js together must stay under ${UI_STATE_MAX_BYTES} bytes`,
    });
  }
  if (patch && !canvas)
    return sendJson(ctx.res, 404, { error: "no_canvas", message: "there is no canvas yet; pass html, css or js" });
  audit(ctx.deps, {
    principalId: turn.actorId,
    action: patch ? "ui.canvas.write" : "ui.canvas.dismiss",
    resource: `session:${turn.sessionId}`,
    scopeLabel: scopeId("personal", turn.actorId),
    ...(canvas ? { detail: `rev ${canvas.rev}` } : {}),
  });
  signalBrowser(ctx, turn, { kind: "canvas" });
  return sendJson(ctx.res, 200, { canvas: canvasSummary(canvas) });
}

async function postCanvas(ctx: ApiCtx): Promise<void> {
  const turn = await liveWebTurn(ctx);
  if (!turn) return;
  const patch = parsePatch(ctx.body);
  if (typeof patch === "string") return sendJson(ctx.res, 400, { error: "bad_request", message: patch });
  return applyCanvas(ctx, turn, patch);
}

async function deleteCanvas(ctx: ApiCtx): Promise<void> {
  const turn = await liveWebTurn(ctx);
  if (!turn) return;
  return applyCanvas(ctx, turn, null);
}

async function observe(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const turn = await liveWebTurn(ctx);
  if (!turn) return;
  if (!turn.personal) {
    return sendJson(res, 403, {
      error: "not_private",
      message: "UI observation is only available in the person's own web conversations, not shared ones.",
    });
  }
  if (!deps.signals) return sendJson(res, 404, { error: "not_available", message: "run signals are unavailable" });
  const b = isObj(body) ? body : {};
  const selector = typeof b.selector === "string" && b.selector.trim() ? b.selector.trim() : undefined;
  if (selector && selector.length > MAX_SELECTOR_CHARS)
    return sendJson(res, 400, { error: "bad_request", message: "selector is too long" });
  const callId = randomUUID();
  const pendingId = uiStateId(turn.actorId, uiObserveKey(callId));
  await deps.uiState!.put(pendingId, { value: { runId: turn.runId }, updatedAt: Date.now() });
  signalBrowser(ctx, turn, {
    kind: "observe",
    callId,
    ...(selector ? { selector } : {}),
    ...(b.css === true ? { css: true } : {}),
    ...(b.screenshot === true ? { screenshot: true } : {}),
  });
  let outcome: Awaited<ReturnType<typeof waitForClientResult>>;
  try {
    outcome = await waitForClientResult(deps.signals, turn.runId, callId, { timeoutMs: OBSERVE_TIMEOUT_MS });
  } finally {
    await deps.uiState!.delete(pendingId);
  }
  audit(deps, {
    principalId: turn.actorId,
    action: "ui.observe",
    resource: `session:${turn.sessionId}`,
    scopeLabel: scopeId("personal", turn.actorId),
    status: typeof outcome === "string" ? outcome : "ok",
  });
  if (typeof outcome === "string") {
    return sendJson(res, 504, {
      error: "ui_not_open",
      message: `No open web UI tab answered within ${OBSERVE_TIMEOUT_MS / 1000}s. The person may have closed QM; ask them to open it and retry.`,
    });
  }
  return sendJson(res, 200, { snapshot: outcome.structured ?? null });
}

async function observeResult(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, params } = ctx;
  const b = isObj(body) ? body : {};
  const principalId = typeof b.principalId === "string" ? b.principalId : "";
  if (!principalId || !isObj(b.snapshot))
    return sendJson(res, 400, { error: "bad_request", message: "principalId and snapshot required" });
  if (!deps.uiState || !deps.signals) return sendJson(res, 404, { error: "not_found" });
  const pending = await deps.uiState.take(uiStateId(principalId, uiObserveKey(params.callId!)));
  const runId = isObj(pending?.value) && typeof pending.value.runId === "string" ? pending.value.runId : null;
  const run = runId ? await deps.runs?.get(runId) : null;
  if (!run || !samePerson(run.request.actor.id, principalId)) return sendJson(res, 404, { error: "not_found" });
  await deps.signals.send(run.id, {
    kind: "client_result",
    callId: params.callId!,
    result: { content: "web UI snapshot", structured: b.snapshot },
    dedupeKey: `ui-observe:${run.id}:${params.callId}`,
  });
  return sendJson(res, 200, { ok: true });
}

async function canvasEnabled(ctx: ApiCtx, principalId: string): Promise<boolean> {
  return (await ctx.deps.featureFlags?.enabled("ui_canvas", scopeId("personal", principalId))) === true;
}

async function userCanvasContent(ctx: ApiCtx): Promise<void> {
  const { res, deps, url, params } = ctx;
  const principalId = url.searchParams.get("principalId") ?? "";
  if (!principalId || !isUiCanvasSessionId(params.sessionId!))
    return sendJson(res, 400, { error: "bad_request", message: "principalId and a session id required" });
  if (!deps.uiState || !(await canvasEnabled(ctx, principalId))) return sendJson(res, 404, { error: "not_found" });
  const canvas = await readUiCanvas(deps.uiState, principalId, params.sessionId!);
  return canvas ? sendJson(res, 200, { canvas }) : sendJson(res, 404, { error: "not_found" });
}

async function userCanvas(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, params } = ctx;
  const b = isObj(body) ? body : {};
  const principalId = typeof b.principalId === "string" ? b.principalId : "";
  const sessionId = params.sessionId!;
  if (!principalId || !isUiCanvasSessionId(sessionId))
    return sendJson(res, 400, { error: "bad_request", message: "principalId and a session id required" });
  if (!deps.uiState || !(await canvasEnabled(ctx, principalId))) return sendJson(res, 404, { error: "not_found" });
  if (b.dismiss !== true && typeof b.pinned !== "boolean")
    return sendJson(res, 400, { error: "bad_request", message: "pass dismiss or pinned" });
  const patch = b.dismiss === true ? null : { pinned: b.pinned as boolean };
  const canvas = await writeUiCanvas(deps.uiState, principalId, sessionId, patch);
  if (patch && !canvas) return sendJson(res, 404, { error: "not_found" });
  const session = await deps.sessions?.get(sessionId);
  if (session)
    signalBrowser(ctx, { actorId: principalId, sessionId, threadRef: session.threadRef }, { kind: "canvas" });
  return sendJson(res, 200, { canvas: canvasSummary(canvas) });
}

export const uiCanvasRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/ui/canvas", auth: "either", handle: getCanvas },
  { method: "POST", path: "/v1/ui/canvas", auth: "either", handle: postCanvas },
  { method: "DELETE", path: "/v1/ui/canvas", auth: "either", handle: deleteCanvas },
  { method: "POST", path: "/v1/ui/observe", auth: "either", handle: observe },
  {
    method: "POST",
    path: "/v1/ui/observe/:callId/result",
    auth: "source",
    maxBodyBytes: 2_000_000,
    handle: observeResult,
  },
  { method: "GET", path: "/v1/ui/canvases/:sessionId", auth: "source", handle: userCanvasContent },
  { method: "POST", path: "/v1/ui/canvases/:sessionId", auth: "source", handle: userCanvas },
];
