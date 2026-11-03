import { isModelProvider, type ModelProvider } from "../../../model/model-credential-store.ts";
import { providerBaseUrl } from "../../../model/provider-endpoints.ts";
import { cachedModelCatalog, selectableModelCatalog } from "../../../model/model-catalog.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";

const VALIDATION_REQUESTS: Record<
  ModelProvider,
  { baseUrl: string; path: string; headers: (apiKey: string) => Record<string, string> }
> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    path: "/v1/models",
    headers: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    path: "/models",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    path: "/key",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  },
};

function validationUrl(provider: ModelProvider): string {
  const request = VALIDATION_REQUESTS[provider];
  return `${providerBaseUrl(provider) ?? request.baseUrl}${request.path}`;
}

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

export async function rejectUnusableApiKey(ctx: ApiCtx, provider: ModelProvider, apiKey: string): Promise<boolean> {
  let response: Response;
  try {
    response = await (ctx.deps.modelCredentialFetch ?? fetch)(validationUrl(provider), {
      headers: VALIDATION_REQUESTS[provider].headers(apiKey),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    sendJson(ctx.res, 502, {
      error: "provider_unreachable",
      message: `could not reach ${provider} to check this API key: ${error instanceof Error ? error.message : String(error)}`,
    });
    return true;
  }
  if (response.ok) return false;
  if (response.status === 401 || response.status === 403)
    sendJson(ctx.res, 400, { error: "invalid_api_key", message: `${provider} rejected this API key` });
  else
    sendJson(ctx.res, 502, {
      error: "provider_unreachable",
      message: `${provider} could not check this API key: HTTP ${response.status}`,
    });
  return true;
}

export async function getModelProviders(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  await ctx.deps.refreshModels?.();
  if (!ctx.deps.modelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "model-providers.read",
    resource: "model-providers",
    scopeLabel: orgScope(ctx.deps),
  });
  const cached =
    ctx.url.searchParams.get("catalog") === "cached" ? cachedModelCatalog(ctx.deps.modelCredentialFetch) : undefined;
  const [providers, models] = await Promise.all([
    ctx.deps.modelCredentials.statuses(),
    cached?.models ?? selectableModelCatalog(ctx.deps.modelCredentialFetch),
  ]);
  const subscriptionAuth = await ctx.deps.companySubscriptionAuth?.();
  return sendJson(ctx.res, 200, {
    providers,
    models,
    ...(cached?.refreshing ? { modelCatalogRefreshing: true } : {}),
    ...(subscriptionAuth ? { subscriptionAuth: { provider: subscriptionAuth } } : {}),
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
  const current = async () => (await ctx.deps.modelCredentials!.statuses()).find((item) => item.provider === provider);
  if (isObj(ctx.body) && ctx.body.ifUnset === true && (await current())?.configured)
    return sendJson(ctx.res, 200, { ok: true, status: await current(), unchanged: true });
  if (await rejectUnusableApiKey(ctx, provider, apiKey.trim())) return;
  await ctx.deps.modelCredentials.set(provider, apiKey.trim(), authorized.id);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "model-providers.update",
    resource: provider,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true, status: await current() });
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
