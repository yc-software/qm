import { isModelProvider, type ModelProvider } from "../../../model/pi-models.ts";
import { selectableModelCatalog } from "../../../model/model-catalog.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const NEXFORCE_KEY_PROBE = JSON.stringify({
  model: "deepseek/deepseek-v4-flash",
  max_tokens: 1,
  messages: [{ role: "user", content: "ping" }],
});

const VALIDATION_REQUESTS: Record<
  ModelProvider,
  { url: string; headers: (apiKey: string) => Record<string, string>; body?: string }
> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    headers: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/key",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  },
  nexforce: {
    url: "https://router.nexforce.ai/v1/chat/completions",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}`, "content-type": "application/json" }),
    body: NEXFORCE_KEY_PROBE,
  },
};

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

async function validate(ctx: ApiCtx, provider: ModelProvider, apiKey: string): Promise<boolean> {
  const request = VALIDATION_REQUESTS[provider];
  try {
    const response = await (ctx.deps.modelCredentialFetch ?? fetch)(request.url, {
      method: request.body ? "POST" : "GET",
      headers: request.headers(apiKey),
      ...(request.body ? { body: request.body } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getModelProviders(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.modelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "model-providers.read",
    resource: "model-providers",
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, {
    providers: await ctx.deps.modelCredentials.statuses(),
    models: await selectableModelCatalog(ctx.deps.modelCredentialFetch),
  });
}

export async function putModelProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.modelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const provider = ctx.params.provider;
  if (!isModelProvider(provider)) return sendJson(ctx.res, 404, { error: "not_found" });
  const apiKey = (ctx.body as { apiKey?: unknown }).apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "API key is required" });
  }
  if (!(await validate(ctx, provider, apiKey.trim()))) {
    return sendJson(ctx.res, 400, { error: "invalid_api_key", message: `${provider} rejected this API key` });
  }
  await ctx.deps.modelCredentials.set(provider, apiKey.trim(), authorized.id);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "model-providers.update",
    resource: provider,
    scopeLabel: orgScope(ctx.deps),
  });
  const status = (await ctx.deps.modelCredentials.statuses()).find((item) => item.provider === provider);
  return sendJson(ctx.res, 200, { ok: true, status });
}

export async function deleteModelProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.modelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const provider = ctx.params.provider;
  if (!isModelProvider(provider)) return sendJson(ctx.res, 404, { error: "not_found" });
  await ctx.deps.modelCredentials.delete(provider, authorized.id);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "model-providers.delete",
    resource: provider,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
