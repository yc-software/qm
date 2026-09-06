import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

function conversationRef(ctx: ApiCtx): string | null {
  const { res, capability } = ctx;
  if (!capability) {
    sendJson(res, 401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
    return null;
  }
  if (!capability.threadRef) {
    sendJson(res, 400, { error: "no_conversation", message: "this token isn't bound to a conversation" });
    return null;
  }
  return capability.threadRef;
}

async function addPin(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  const threadRef = conversationRef(ctx);
  if (!threadRef) return;
  const b = isObj(body) ? body : {};
  const text = typeof b.text === "string" && b.text.trim() ? b.text.trim() : undefined;
  const seq = b.seq;
  if (seq !== undefined && (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0)) {
    return sendJson(res, 400, { error: "bad_request", message: "seq must be a non-negative integer" });
  }
  if (!text && seq === undefined) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "pass `text` (a note to pin) and/or `seq` (a transcript entry to pin)",
    });
  }
  const out = await app.pinConversationItem(threadRef, capability!.actorId, {
    ...(text ? { text } : {}),
    ...(seq !== undefined ? { entrySeq: seq } : {}),
  });
  if ("error" in out) {
    if (out.error === "not_found") return sendJson(res, 404, { error: "not_found", message: "no such conversation" });
    if (out.error === "bad_entry") {
      return sendJson(res, 404, { error: "entry_not_found", message: `no transcript entry with seq ${seq}` });
    }
    return sendJson(res, 409, {
      error: "pin_limit",
      message: "this conversation already has the maximum number of pins — unpin something first",
    });
  }
  return sendJson(res, 200, { ok: true, pin: out.pin });
}

async function listPins(ctx: ApiCtx): Promise<void> {
  const { res, app, capability } = ctx;
  const threadRef = conversationRef(ctx);
  if (!threadRef) return;
  const pins = await app.listConversationPins(threadRef, capability!.actorId);
  if (pins === null) return sendJson(res, 404, { error: "not_found", message: "no such conversation" });
  return sendJson(res, 200, { pins });
}

async function removePin(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  const threadRef = conversationRef(ctx);
  if (!threadRef) return;
  const removed = await app.unpinConversationItem(threadRef, ctx.params.id!);
  if (removed === null) return sendJson(res, 404, { error: "not_found", message: "no such conversation" });
  if (!removed) return sendJson(res, 404, { error: "not_found", message: "no such pin" });
  return sendJson(res, 200, { ok: true });
}

export const pinRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/pins", auth: "either", handle: addPin },
  { method: "GET", path: "/v1/pins", auth: "either", handle: listPins },
  { method: "DELETE", path: "/v1/pins/:id", auth: "either", handle: removePin },
];
