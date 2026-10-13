import {
  CUSTOM_PROVIDER_PROTOCOLS,
  type CustomProviderSpec,
  type CustomProviderProtocol,
} from "../../../model/custom-providers.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope, rejectNonObjectBody } from "../shared.ts";

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

type KeyCheck =
  | { ok: true }
  | { ok: false; error: "endpoint_unreachable" | "invalid_api_key" | "validation_failed"; message: string };

async function validateKey(
  ctx: ApiCtx,
  protocol: CustomProviderProtocol,
  baseUrl: string,
  apiKey: string,
): Promise<KeyCheck> {
  const url = protocol === "anthropic" ? `${baseUrl}/v1/models` : `${baseUrl}/models`;
  const headers: Record<string, string> =
    protocol === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${apiKey}` };
  let response: Response;
  try {
    response = await (ctx.deps.modelCredentialFetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(5_000) });
  } catch {
    return {
      ok: false,
      error: "endpoint_unreachable",
      message: `Couldn't reach ${url}. Check the base URL, or that the endpoint is up. Turn off key validation to save anyway.`,
    };
  }
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403)
    return { ok: false, error: "invalid_api_key", message: `${baseUrl} rejected this API key.` };
  return {
    ok: false,
    error: "validation_failed",
    message: `${url} answered HTTP ${response.status}, so the key couldn't be checked. If this endpoint has no models listing, turn off key validation to save anyway.`,
  };
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

export function putCustomProvider(ctx: ApiCtx): Promise<void> {
  return saveCustomProvider(ctx, ctx.params.provider, "upsert");
}

export function createCustomProvider(ctx: ApiCtx): Promise<void> {
  const id = (ctx.body as { id?: unknown } | undefined)?.id;
  return saveCustomProvider(ctx, typeof id === "string" ? id : undefined, "create");
}

async function saveCustomProvider(ctx: ApiCtx, id: string | undefined, mode: "upsert" | "create"): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  if (!id)
    return sendJson(ctx.res, mode === "create" ? 400 : 404, { error: mode === "create" ? "bad_request" : "not_found" });
  if (rejectNonObjectBody(ctx)) return;
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
  const check = shouldValidate ? await validateKey(ctx, spec.protocol, spec.baseUrl, apiKey!) : { ok: true as const };
  if (!check.ok) return sendJson(ctx.res, 400, { error: check.error, message: check.message });
  try {
    if (mode === "upsert") await ctx.deps.customProviders.upsert(spec, apiKey, authorized.id);
    else if (!(await ctx.deps.customProviders.create(spec, apiKey, authorized.id)))
      return sendJson(ctx.res, 409, {
        error: "provider_exists",
        message: `A provider with the id "${id}" already exists. Choose another id, or edit that provider instead.`,
      });
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
