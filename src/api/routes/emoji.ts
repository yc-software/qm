import { reportFailure } from "../../util/errors.ts";
import { slackWebClient } from "../../slack/web-client.ts";
import type { EmojiListResponse } from "@slack/web-api";
import { runEmojiUpload, type EmojiUploadDeps } from "../../connectors/emoji-upload-service.ts";
import { sendJson } from "../http.ts";
import { activePrincipal, orgScope, isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

export async function listWorkspaceEmoji(ctx: ApiCtx): Promise<void> {
  if (!ctx.actor || ctx.actor.imp || ctx.capability || !(await activePrincipal(ctx.deps, ctx.actor.p)))
    return sendJson(ctx.res, 403, { error: "forbidden" });
  ctx.res.setHeader("Cache-Control", "private, max-age=300");
  const cached = await ctx.deps.config?.getSlackEmojiCatalogDurable(orgScope(ctx.deps));
  if (cached && Object.keys(cached.emoji).length) return sendJson(ctx.res, 200, { emoji: cached.emoji });
  const installation = await ctx.deps.slackInstallation?.get();
  const token = installation?.botToken ?? ctx.deps.slackEnvBotToken;
  if (!token) return sendJson(ctx.res, 200, { emoji: {} });
  try {
    const data = (await slackWebClient(token, ctx.deps.slackWebClient, 10_000).apiCall(
      "emoji.list",
    )) as EmojiListResponse;
    if (!data.ok) return sendJson(ctx.res, 502, { error: "emoji_unavailable" });
    return sendJson(ctx.res, 200, { emoji: data.emoji ?? {} });
  } catch (error) {
    reportFailure("Slack workspace emoji", error);
    return sendJson(ctx.res, 502, { error: "emoji_unavailable" });
  }
}

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
  { method: "GET", path: "/v1/slack/emoji", auth: "source", handle: listWorkspaceEmoji },
  { method: "POST", path: "/v1/emoji", auth: "either", handle: addEmoji },
];
