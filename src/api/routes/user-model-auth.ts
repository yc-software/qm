import type { ModelProvider } from "../../model/provider-endpoints.ts";
import { completeClaudeLogin, startClaudeLogin } from "../../model/subscription-oauth.ts";
import { createCodexDeviceLogin } from "../../model/codex-device-login.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { validateProviderApiKey } from "./admin/model-providers.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";
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

export async function modelAuthStatus(deps: ApiCtx["deps"], principal: string) {
  const [required, connections, individualModelAuth, account] = await Promise.all([
    deps.config?.getIndividualModelAuthDurable(),
    deps.userModelCredentials?.connections(principal),
    deps.config?.getIndividualModelAuthDurable(principal),
    deps.config?.getModelAccountDurable(principal),
  ]);
  return {
    individualModelAuth: individualModelAuth ?? false,
    required: required ?? false,
    account: account ?? "company",
    connections: connections ?? [],
  };
}

async function getStatus(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  return sendJson(ctx.res, 200, await modelAuthStatus(ctx.deps, principal));
}

async function setAccount(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!ctx.deps.config || !ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const account = bodyObj(ctx).account;
  if (account !== "personal" && account !== "company") return sendJson(ctx.res, 400, { error: "bad_request" });
  if (account === "company" && (await ctx.deps.config.getIndividualModelAuthDurable())) {
    return sendJson(ctx.res, 403, { error: "Your organization requires a personal AI account." });
  }
  if (account === "personal" && !(await ctx.deps.userModelCredentials.connections(principal)).length) {
    return sendJson(ctx.res, 409, { error: "Connect an AI account first." });
  }
  const provider = bodyObj(ctx).provider;
  if (provider !== undefined && provider !== "anthropic" && provider !== "openai")
    return sendJson(ctx.res, 400, { error: "bad_request" });
  if (
    account === "personal" &&
    provider &&
    !(await ctx.deps.userModelCredentials.connections(principal)).some((c) => c.provider === provider)
  ) {
    return sendJson(ctx.res, 409, { error: "Connect this AI account first." });
  }
  await ctx.deps.config.setPersonalModelAuth(principal, account === "personal", provider);
  audit(ctx, {
    principalId: principal,
    action: "user-model-auth.account",
    resource: account,
    scopeLabel: principal,
  });
  return getStatus(ctx);
}

async function disconnect(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const provider = connectProvider(bodyObj(ctx).provider);
  if (!provider) return sendJson(ctx.res, 400, { error: "bad_request", message: "provider must be claude or chatgpt" });
  await ctx.deps.userModelCredentials.delete(principal, provider);
  audit(ctx, {
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
  audit(ctx, {
    principalId: principal,
    action: "user-model-auth.api-key",
    resource: provider,
    scopeLabel: principal,
  });
  return sendJson(ctx.res, 200, { ok: true });
}

const codexDeviceLogin = createCodexDeviceLogin();

async function chatgptStart(ctx: ApiCtx): Promise<void> {
  const principal = caller(ctx);
  if (!principal) return sendJson(ctx.res, 401, { error: "unauthorized" });
  try {
    const prompt = await codexDeviceLogin.start(principal);
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
    const result = await codexDeviceLogin.poll(deviceAuthId, principal);
    if (result === "unknown")
      return sendJson(ctx.res, 404, { error: "oauth_poll_failed", message: "login expired or unknown — start again" });
    if (result === "pending") return sendJson(ctx.res, 200, { status: "pending" });
    await ctx.deps.userModelCredentials.setOAuth(principal, "openai", result);
    audit(ctx, {
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
    audit(ctx, {
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
  {
    method: "GET",
    path: "/v1/user-model-auth/status",
    browser: true,
    actor: "query.principalId",
    auth: "source",
    handle: getStatus,
  },
  ...withActor("body.principalId", [
    { method: "POST", path: "/v1/user-model-auth/account", browser: true, auth: "source", handle: setAccount },
    { method: "POST", path: "/v1/user-model-auth/api-key", browser: true, auth: "source", handle: putApiKey },
    { method: "POST", path: "/v1/user-model-auth/disconnect", browser: "self", auth: "source", handle: disconnect },
    { method: "POST", path: "/v1/user-model-auth/chatgpt/start", browser: true, auth: "source", handle: chatgptStart },
    { method: "POST", path: "/v1/user-model-auth/chatgpt/poll", browser: true, auth: "source", handle: chatgptPoll },
    { method: "POST", path: "/v1/user-model-auth/claude/start", browser: true, auth: "source", handle: claudeStart },
    {
      method: "POST",
      path: "/v1/user-model-auth/claude/complete",
      browser: true,
      auth: "source",
      handle: claudeComplete,
    },
  ]),
];
