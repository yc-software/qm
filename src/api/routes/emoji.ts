import { runEmojiUpload, type EmojiUploadDeps } from "../../connectors/emoji-upload-service.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function addEmoji(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability } = ctx;
  if (!capability) return sendJson(res, 401, { error: "unauthorized", message: "agent capability token required" });
  if (!deps.browserSessionStore) {
    return sendJson(res, 404, {
      error: "not_supported",
      message: "the emoji uploader isn't available in this deployment",
    });
  }
  const b = isObj(body) ? body : {};
  const name = typeof b.name === "string" ? b.name : "";
  const imageBase64 = typeof b.image === "string" ? b.image : "";
  if (!name || !imageBase64) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "name (string) and image (base64 PNG/GIF) are required",
    });
  }
  const workspaceArg = typeof b.workspace === "string" ? b.workspace : undefined;
  const connectorWorkspace = (deps.directory ? (await deps.directory.meta()).workspaceUrl : null) ?? undefined;

  const uploadDeps: EmojiUploadDeps = {
    principalId: capability.actorId,
    sessionStore: deps.browserSessionStore,
    ...(connectorWorkspace ? { connectorWorkspace } : {}),
  };
  const result = await runEmojiUpload(uploadDeps, {
    name,
    imageBase64,
    ...(workspaceArg ? { workspace: workspaceArg } : {}),
  });
  return sendJson(res, result.ok ? 200 : 422, result);
}

export const emojiRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/emoji", auth: "either", handle: addEmoji },
];
