import {
  CUSTOM_PROVIDER_PROTOCOLS,
  type CustomProviderSpec,
  type CustomProviderProtocol,
} from "../../../model/custom-providers.ts";
import { parseProviderBaseUrl } from "../../../model/provider-endpoints.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const MAX_MODELS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERED_MODELS = 200;
const MODEL_FIELD_DELIMITERS = /[\u0000-\u001f\u007f|]/;

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

/**
 * Key validation against the registered endpoint, protocol-appropriate.
 * A gateway may not implement a models listing, so callers can skip
 * with {"validate": false} — the registration is admin-only either way.
 */
function modelsRequest(protocol: CustomProviderProtocol, baseUrl: string, apiKey: string, limit?: number) {
  const url = protocol === "anthropic" ? new URL(`${baseUrl}/v1/models`) : new URL(`${baseUrl}/models`);
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  return {
    url: url.toString(),
    headers:
      protocol === "anthropic"
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${apiKey}` },
  };
}

async function boundedModelsJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MODELS_RESPONSE_BYTES)
    throw new Error("models response is too large");
  if (!response.body) throw new Error("models response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_MODELS_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("models response is too large");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}

async function fetchModels(
  ctx: ApiCtx,
  protocol: CustomProviderProtocol,
  baseUrl: string,
  apiKey: string,
  options: { timeoutMs?: number; limit?: number } = {},
): Promise<Response | null> {
  const request = modelsRequest(protocol, baseUrl, apiKey, options.limit);
  try {
    return await (ctx.deps.modelCredentialFetch ?? fetch)(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch {
    return null;
  }
}

async function validateKey(
  ctx: ApiCtx,
  protocol: CustomProviderProtocol,
  baseUrl: string,
  apiKey: string,
): Promise<boolean> {
  return Boolean((await fetchModels(ctx, protocol, baseUrl, apiKey))?.ok);
}

function discoveredModels(payload: unknown): Array<{ id: string; name?: string }> {
  const container = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  let candidates: unknown[] = [];
  if (Array.isArray(payload)) candidates = payload;
  else if (Array.isArray(container?.data)) candidates = container.data;
  else if (Array.isArray(container?.models)) candidates = container.models;
  const models = new Map<string, { id: string; name?: string }>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || id.length > 200 || MODEL_FIELD_DELIMITERS.test(id) || models.has(id)) continue;
    const rawName = [item.name, item.display_name, item.displayName].find(
      (value) => typeof value === "string" && value.trim(),
    );
    const candidateName = typeof rawName === "string" ? rawName.trim().slice(0, 200) : undefined;
    const name = candidateName && !MODEL_FIELD_DELIMITERS.test(candidateName) ? candidateName : undefined;
    models.set(id, { id, ...(name ? { name } : {}) });
  }
  return [...models.values()];
}

export async function getCustomProviders(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.read",
    resource: "custom-providers",
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { providers: await ctx.deps.customProviders.statuses() });
}

export async function discoverCustomProviderModels(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = ctx.body as {
    providerId?: unknown;
    protocol?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
  };
  if (
    typeof body.protocol !== "string" ||
    !(CUSTOM_PROVIDER_PROTOCOLS as readonly string[]).includes(body.protocol) ||
    typeof body.baseUrl !== "string"
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "protocol and baseUrl are required" });
  }
  let baseUrl: string;
  try {
    baseUrl = parseProviderBaseUrl("custom provider baseUrl", body.baseUrl);
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: (error as Error).message });
  }
  const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
  const suppliedKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const apiKey =
    suppliedKey ||
    (providerId
      ? await ctx.deps.customProviders.resolveMatchingKey(providerId, body.protocol as CustomProviderProtocol, baseUrl)
      : null);
  if (!apiKey) {
    return sendJson(ctx.res, 400, {
      error: "missing_api_key",
      message: "Enter an API key, or use the unchanged endpoint of a saved provider.",
    });
  }
  const response = await fetchModels(ctx, body.protocol as CustomProviderProtocol, baseUrl, apiKey, {
    timeoutMs: 10_000,
    ...(body.protocol === "anthropic" ? { limit: MAX_DISCOVERED_MODELS } : {}),
  });
  if (!response) {
    return sendJson(ctx.res, 502, {
      error: "model_discovery_failed",
      message: `Could not reach ${baseUrl}.`,
    });
  }
  if (!response.ok) {
    const rejected = response.status === 401 || response.status === 403;
    return sendJson(ctx.res, rejected ? 400 : 502, {
      error: rejected ? "invalid_api_key" : "model_discovery_failed",
      message: rejected
        ? `${baseUrl} rejected this API key.`
        : `${baseUrl} returned HTTP ${response.status} while listing models.`,
    });
  }
  let payload: unknown;
  try {
    payload = await boundedModelsJson(response);
  } catch {
    return sendJson(ctx.res, 502, {
      error: "invalid_models_response",
      message: `${baseUrl} returned an invalid models response.`,
    });
  }
  const models = discoveredModels(payload);
  if (models.length === 0) {
    return sendJson(ctx.res, 502, {
      error: "invalid_models_response",
      message: `${baseUrl} returned no recognizable models.`,
    });
  }
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.discover-models",
    resource: providerId || "new-provider",
    scopeLabel: orgScope(ctx.deps),
  });
  const hasMore =
    body.protocol === "anthropic" &&
    payload !== null &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).has_more === true;
  return sendJson(ctx.res, 200, {
    models: models.slice(0, MAX_DISCOVERED_MODELS),
    total: models.length,
    truncated: hasMore || models.length > MAX_DISCOVERED_MODELS,
  });
}

export async function putCustomProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.provider;
  if (!id) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = ctx.body as {
    name?: unknown;
    protocol?: unknown;
    baseUrl?: unknown;
    models?: unknown;
    apiKey?: unknown;
    validate?: unknown;
  };
  if (typeof body.name !== "string" || typeof body.protocol !== "string" || typeof body.baseUrl !== "string") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "name, protocol, and baseUrl are required" });
  }
  if (!(CUSTOM_PROVIDER_PROTOCOLS as readonly string[]).includes(body.protocol)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `protocol must be one of ${CUSTOM_PROVIDER_PROTOCOLS.join(", ")}`,
    });
  }
  const spec: CustomProviderSpec = {
    id,
    name: body.name,
    protocol: body.protocol as CustomProviderProtocol,
    baseUrl: body.baseUrl.trim().replace(/\/+$/, ""),
    models: Array.isArray(body.models) ? (body.models as CustomProviderSpec["models"]) : [],
  };
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
  const shouldValidate = body.validate !== false && apiKey !== undefined;
  if (shouldValidate && !(await validateKey(ctx, spec.protocol, spec.baseUrl, apiKey!))) {
    return sendJson(ctx.res, 400, {
      error: "invalid_api_key",
      message: `${spec.baseUrl} rejected this API key (pass "validate": false to skip for endpoints without a models listing)`,
    });
  }
  try {
    await ctx.deps.customProviders.upsert(spec, apiKey, authorized.id);
  } catch (e) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: (e as Error).message });
  }
  await ctx.deps.refreshCustomProviders?.();
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.update",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  const status = (await ctx.deps.customProviders.statuses()).find((item) => item.id === id);
  return sendJson(ctx.res, 200, { ok: true, status });
}

export async function deleteCustomProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.provider;
  if (!id) return sendJson(ctx.res, 404, { error: "not_found" });
  const removed = await ctx.deps.customProviders.delete(id, authorized.id);
  if (!removed) return sendJson(ctx.res, 404, { error: "not_found" });
  await ctx.deps.refreshCustomProviders?.();
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.delete",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
