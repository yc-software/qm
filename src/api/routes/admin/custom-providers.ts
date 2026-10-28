import {
  CUSTOM_PROVIDER_PROTOCOLS,
  type CustomProviderSpec,
  type CustomProviderProtocol,
} from "../../../model/custom-providers.ts";
import { refusal } from "../../http.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "../route.ts";
import { badRequest, notFound, orgAdmin } from "./common.ts";
import { apiKeyAccepted } from "./model-providers.ts";

export async function getCustomProviders(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  if (!ctx.deps.customProviders) throw notFound();
  authz.audit("custom-providers.read", "custom-providers");
  return ok({ providers: await ctx.deps.customProviders.statuses() });
}

export async function putCustomProvider(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  const store = ctx.deps.customProviders;
  const id = ctx.params.provider;
  if (!store || !id) throw notFound();
  const body = ctx.body as {
    name?: unknown;
    protocol?: unknown;
    baseUrl?: unknown;
    models?: unknown;
    apiKey?: unknown;
    validate?: unknown;
  };
  if (typeof body.name !== "string" || typeof body.protocol !== "string" || typeof body.baseUrl !== "string")
    throw badRequest("name, protocol, and baseUrl are required");
  if (!(CUSTOM_PROVIDER_PROTOCOLS as readonly string[]).includes(body.protocol))
    throw badRequest(`protocol must be one of ${CUSTOM_PROVIDER_PROTOCOLS.join(", ")}`);
  const spec: CustomProviderSpec = {
    id,
    name: body.name,
    protocol: body.protocol as CustomProviderProtocol,
    baseUrl: body.baseUrl.trim().replace(/\/+$/, ""),
    models: Array.isArray(body.models) ? (body.models as CustomProviderSpec["models"]) : [],
  };
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
  const anthropic = spec.protocol === "anthropic";
  const url = `${spec.baseUrl}${anthropic ? "/v1/models" : "/models"}`;
  if (body.validate !== false && apiKey !== undefined && !(await apiKeyAccepted(ctx, url, anthropic, apiKey)))
    return reply(400, {
      error: "invalid_api_key",
      message: `${spec.baseUrl} rejected this API key (pass "validate": false to skip for endpoints without a models listing)`,
    });
  try {
    await store.upsert(spec, apiKey, authz.actor.id);
  } catch (e) {
    throw refusal(400, "bad_request", e);
  }
  authz.audit("custom-providers.update", id);
  const status = (await store.statuses()).find((item) => item.id === id);
  return ok({ ok: true, status });
}

export async function deleteCustomProvider(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  const id = ctx.params.provider;
  if (!ctx.deps.customProviders || !id) throw notFound();
  if (!(await ctx.deps.customProviders.delete(id, authz.actor.id))) throw notFound();
  authz.audit("custom-providers.delete", id);
  return ok({ ok: true });
}
