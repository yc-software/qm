import { isModelProvider, type ModelProvider } from "../../../model/model-credential-store.ts";
import { DEFAULT_WEBUI_MODEL_IDS } from "../../../model/pi-models.ts";
import { providerBaseUrl } from "../../../model/provider-endpoints.ts";
import { boundedJson, selectableModelCatalog } from "../../../model/model-catalog.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

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

export async function validateProviderApiKey(ctx: ApiCtx, provider: ModelProvider, apiKey: string): Promise<boolean> {
  try {
    const response = await (ctx.deps.modelCredentialFetch ?? fetch)(validationUrl(provider), {
      headers: VALIDATION_REQUESTS[provider].headers(apiKey),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const MAX_DISCOVERY_MODELS = 1_000;
const DISCOVERY_TTL_MS = 5 * 60_000;
const DISCOVERY_FAILURE_TTL_MS = 30_000;

interface DiscoveredModel {
  id: string;
  displayName: string;
}
type LiveResult = { models: DiscoveredModel[] } | { error: string };
interface DiscoveryCacheEntry {
  expiresAt: number;
  result: LiveResult;
  inFlight?: Promise<LiveResult>;
}

const discoveryCache = new WeakMap<typeof fetch, Map<ModelProvider, DiscoveryCacheEntry>>();

function normalizeModels(provider: ModelProvider, body: unknown): DiscoveredModel[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const candidate of data.slice(0, MAX_DISCOVERY_MODELS)) {
    if (!candidate || typeof candidate !== "object") continue;
    const { id, display_name: displayNameRaw } = candidate as Record<string, unknown>;
    if (typeof id !== "string" || !id || id.length > 200) continue;
    const displayName =
      provider === "anthropic" && typeof displayNameRaw === "string" && displayNameRaw.length <= 200
        ? displayNameRaw
        : id;
    out.push({ id, displayName });
  }
  return out;
}

async function fetchProviderModels(ctx: ApiCtx, provider: ModelProvider, apiKey: string): Promise<LiveResult> {
  try {
    const response = await (ctx.deps.modelCredentialFetch ?? fetch)(validationUrl(provider), {
      headers: VALIDATION_REQUESTS[provider].headers(apiKey),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { error: `status_${response.status}` };
    return { models: normalizeModels(provider, await boundedJson(response)) };
  } catch {
    return { error: "unreachable" };
  }
}

async function liveModels(ctx: ApiCtx, provider: ModelProvider, apiKey: string): Promise<LiveResult> {
  const fetcher = ctx.deps.modelCredentialFetch ?? fetch;
  let byProvider = discoveryCache.get(fetcher);
  if (!byProvider) {
    byProvider = new Map();
    discoveryCache.set(fetcher, byProvider);
  }
  const existing = byProvider.get(provider);
  if (existing && existing.expiresAt > Date.now()) return existing.result;
  if (existing?.inFlight) return existing.inFlight;
  const entry: DiscoveryCacheEntry = existing ?? { expiresAt: 0, result: { models: [] } };
  entry.inFlight = fetchProviderModels(ctx, provider, apiKey)
    .then((result) => {
      entry.result = result;
      entry.expiresAt = Date.now() + ("error" in result ? DISCOVERY_FAILURE_TTL_MS : DISCOVERY_TTL_MS);
      return result;
    })
    .finally(() => {
      delete entry.inFlight;
    });
  byProvider.set(provider, entry);
  return entry.inFlight;
}

async function resolveLive(ctx: ApiCtx, provider: ModelProvider): Promise<LiveResult> {
  if (provider === "openrouter") {
    const models = (await selectableModelCatalog(ctx.deps.modelCredentialFetch))
      .filter((model) => model.provider === "openrouter")
      .map((model) => ({ id: model.id, displayName: model.name }));
    return { models };
  }
  const apiKey = await ctx.deps.modelCredentials!.resolve(provider);
  if (!apiKey) return { error: "no_key" };
  return liveModels(ctx, provider, apiKey);
}

export async function getProviderModels(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.modelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const provider = ctx.params.provider;
  if (!isModelProvider(provider)) return sendJson(ctx.res, 404, { error: "not_found" });
  const live = await resolveLive(ctx, provider);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "model-providers.discover",
    resource: provider,
    scopeLabel: orgScope(ctx.deps),
  });
  if ("error" in live) return sendJson(ctx.res, 200, { provider, error: live.error });
  const catalog = await selectableModelCatalog(ctx.deps.modelCredentialFetch);
  const knownIds = new Set(catalog.map((model) => model.id));
  const liveIds = new Set(live.models.map((model) => model.id));
  const enabled = (await ctx.deps.config?.getWebuiModelsDurable(orgScope(ctx.deps))) ?? DEFAULT_WEBUI_MODEL_IDS;
  const enabledSet = new Set(enabled);
  return sendJson(ctx.res, 200, {
    provider,
    known: live.models.filter((model) => knownIds.has(model.id)),
    new: live.models.filter((model) => !knownIds.has(model.id)),
    missing: catalog
      .filter((model) => model.provider === provider && enabledSet.has(model.id) && !liveIds.has(model.id))
      .map((model) => ({ id: model.id, displayName: model.name })),
  });
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
  return sendJson(ctx.res, 200, {
    providers: await ctx.deps.modelCredentials.statuses(),
    models: await selectableModelCatalog(ctx.deps.modelCredentialFetch),
    ...(ctx.deps.harnessCarriedModelAuth
      ? { harnessAuth: { harnessId: ctx.deps.harnessId ?? "pi", provider: ctx.deps.harnessCarriedModelAuth } }
      : {}),
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
  if (!(await validateProviderApiKey(ctx, provider, apiKey.trim()))) {
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
