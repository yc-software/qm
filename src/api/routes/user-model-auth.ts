import type { ModelProvider } from "../../model/pi-models.ts";
import { completeClaudeLogin, startClaudeLogin } from "../../model/subscription-oauth.ts";
import { createCodexDeviceLogin } from "../../model/codex-device-login.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { validateProviderApiKey } from "./admin/model-providers.ts";
import type { ApiCtx, Route } from "./route.ts";
import { audit } from "./shared.ts";

function caller(ctx: ApiCtx): string | null {
  return ctx.actor?.p ?? null;
}

function bodyObj(ctx: ApiCtx): Record<string, unknown> {
  return typeof ctx.body === "object" && ctx.body !== null ? (ctx.body as Record<string, unknown>) : {};
}

function connectProvider(raw: unknown): ModelProvider | null {
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  if (raw === "openai" || raw === "chatgpt" || raw === "codex") return "openai";
  return null;
}

async function getStatus(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const required = (await ctx.deps.config?.getIndividualModelAuthDurable()) ?? false;
  const connections = (await ctx.deps.userModelCredentials?.connections(principal)) ?? [];
  return sendJson(ctx.res, 200, { individualModelAuth: required, connections });
}

async function disconnect(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const provider = connectProvider(bodyObj(ctx).provider);
  if (!provider) return sendJson(ctx.res, 400, { error: "bad_request", message: "provider must be claude or chatgpt" });
  await ctx.deps.userModelCredentials.delete(principal, provider);
  audit(ctx.deps, {
    principalId: principal,
    action: "user-model-auth.disconnect",
    resource: provider,
    scopeLabel: principal,
  });
  return sendJson(ctx.res, 200, { ok: true });
}

async function putApiKey(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = bodyObj(ctx);
  const provider = connectProvider(body.provider);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!provider) return sendJson(ctx.res, 400, { error: "bad_request", message: "provider must be claude or chatgpt" });
  if (!apiKey) return sendJson(ctx.res, 400, { error: "bad_request", message: "API key is required" });
  if (!(await validateProviderApiKey(ctx, provider, apiKey))) {
    return sendJson(ctx.res, 400, { error: "invalid_api_key", message: `${provider} rejected this API key` });
  }
  await ctx.deps.userModelCredentials.setApiKey(principal, provider, apiKey);
  audit(ctx.deps, {
    principalId: principal,
    action: "user-model-auth.api-key",
    resource: provider,
    scopeLabel: principal,
  });
  return sendJson(ctx.res, 200, { ok: true });
}

// ChatGPT device-code login is delegated to the vendored Codex binary's own
// login RPCs (supported, version-matched surface) rather than a hand-rolled
// flow against undocumented endpoints.
const codexDeviceLogin = createCodexDeviceLogin();

async function chatgptStart(ctx: ApiCtx): Promise<void> {
  if (!caller(ctx)) return sendJson(ctx.res, 401, { error: "unauthorized" });
  try {
    const prompt = await codexDeviceLogin.start();
    return sendJson(ctx.res, 200, prompt);
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "oauth_start_failed", message: errMessage(e) });
  }
}

async function chatgptPoll(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = bodyObj(ctx);
  const deviceAuthId = typeof body.deviceAuthId === "string" ? body.deviceAuthId : "";
  if (!deviceAuthId) return sendJson(ctx.res, 400, { error: "bad_request" });
  try {
    const result = await codexDeviceLogin.poll(deviceAuthId);
    if (result === "pending") return sendJson(ctx.res, 200, { status: "pending" });
    await ctx.deps.userModelCredentials.setOAuth(principal, "openai", result);
    audit(ctx.deps, {
      principalId: principal,
      action: "user-model-auth.oauth",
      resource: "openai",
      scopeLabel: principal,
    });
    return sendJson(ctx.res, 200, { status: "connected" });
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "oauth_poll_failed", message: errMessage(e) });
  }
}

async function claudeStart(ctx: ApiCtx): Promise<void> {
  if (!caller(ctx)) return sendJson(ctx.res, 401, { error: "unauthorized" });
  return sendJson(ctx.res, 200, startClaudeLogin());
}

async function claudeComplete(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = bodyObj(ctx);
  const code = typeof body.code === "string" ? body.code : "";
  const verifier = typeof body.verifier === "string" ? body.verifier : "";
  if (!code || !verifier) return sendJson(ctx.res, 400, { error: "bad_request" });
  try {
    const tokens = await completeClaudeLogin(code, verifier);
    await ctx.deps.userModelCredentials.setOAuth(principal, "anthropic", tokens);
    audit(ctx.deps, {
      principalId: principal,
      action: "user-model-auth.oauth",
      resource: "anthropic",
      scopeLabel: principal,
    });
    return sendJson(ctx.res, 200, { ok: true });
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "oauth_complete_failed", message: errMessage(e) });
  }
}

export const userModelAuthRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/user-model-auth/status", auth: "source", handle: getStatus },
  { method: "POST", path: "/v1/user-model-auth/api-key", auth: "source", handle: putApiKey },
  { method: "POST", path: "/v1/user-model-auth/disconnect", auth: "source", handle: disconnect },
  { method: "POST", path: "/v1/user-model-auth/chatgpt/start", auth: "source", handle: chatgptStart },
  { method: "POST", path: "/v1/user-model-auth/chatgpt/poll", auth: "source", handle: chatgptPoll },
  { method: "POST", path: "/v1/user-model-auth/claude/start", auth: "source", handle: claudeStart },
  { method: "POST", path: "/v1/user-model-auth/claude/complete", auth: "source", handle: claudeComplete },
];
