import { validEmail } from "../../../plugins/chassis/src/auth-email.ts";
import { mintAdminBootstrapToken } from "../../../plugins/chassis/src/admin-bootstrap.ts";
import { AuthEmailSettingsConflict } from "../../auth/email-settings.ts";
import { createAuthEmailServiceClient, AuthEmailServiceError } from "../../auth/email-service-client.ts";
import { orgId as configuredOrgId, orgScope } from "../../config.ts";
import { sendJson } from "../http.ts";
import { audit, isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function runtime(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.authEmailSettings;
  if (!store) return sendJson(ctx.res, 404, { error: "not_found" });
  const status = await store.status();
  const active = await store.get();
  return sendJson(ctx.res, 200, {
    managed: status.managed,
    active: Boolean(active),
    ...(active ? { version: active.version, settings: active.settings } : {}),
  });
}

async function consumeBootstrap(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const principal = typeof body.principal === "string" ? body.principal.trim().toLowerCase() : "";
  const org = typeof body.org === "string" ? body.org : "";
  const jti = typeof body.jti === "string" ? body.jti : "";
  const expiresAtMs = typeof body.expiresAtMs === "number" ? body.expiresAtMs : 0;
  if (!validEmail(principal) || org !== configuredOrgId() || !jti || expiresAtMs <= Date.now()) {
    return sendJson(ctx.res, 400, { error: "invalid_bootstrap" });
  }
  if (!ctx.deps.authEmailSettings) return sendJson(ctx.res, 404, { error: "not_found" });
  if (!ctx.deps.admin || !(await ctx.deps.admin.adminStatusOf({ id: principal, type: "internal" })).isAdmin) {
    return sendJson(ctx.res, 403, { error: "forbidden" });
  }
  if (!ctx.deps.replayDedupe?.durable) return sendJson(ctx.res, 503, { error: "durable_store_required" });
  if (!(await ctx.deps.replayDedupe.claim(`admin-bootstrap:${jti}`, expiresAtMs))) {
    return sendJson(ctx.res, 409, { error: "already_used" });
  }
  if (!(await ctx.deps.authEmailSettings.permitBootstrap())) {
    return sendJson(ctx.res, 403, {
      error: "bootstrap_disabled",
      message: "admin bootstrap is permanently disabled because email settings have already been managed",
    });
  }
  audit(ctx.deps, {
    principalId: principal,
    action: "auth-email-settings.bootstrap",
    resource: "admin-bootstrap",
    scopeLabel: orgScope(),
  });
  return sendJson(ctx.res, 200, { ok: true, principal });
}

async function bootstrap(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const principal = typeof body.principal === "string" ? body.principal.trim().toLowerCase() : "";
  if (!validEmail(principal))
    return sendJson(ctx.res, 400, { error: "bad_request", message: "principal must be an email" });
  if (!ctx.deps.authEmailSettings || (await ctx.deps.authEmailSettings.hasEverBeenManaged())) {
    return sendJson(ctx.res, 403, { error: "bootstrap_disabled" });
  }
  if (!ctx.deps.admin || !(await ctx.deps.admin.adminStatusOf({ id: principal, type: "internal" })).isAdmin) {
    return sendJson(ctx.res, 403, { error: "forbidden" });
  }
  if (!ctx.deps.signingSecret) return sendJson(ctx.res, 503, { error: "signing_secret_required" });
  const minted = mintAdminBootstrapToken({ org: configuredOrgId(), principal }, ctx.deps.signingSecret);
  audit(ctx.deps, {
    principalId: "source-authenticated deployment CLI",
    action: "auth-email-settings.bootstrap-link",
    resource: principal,
    scopeLabel: orgScope(),
  });
  return sendJson(ctx.res, 200, { token: minted.token, expiresAt: minted.claims.exp * 1000 });
}

async function fallback(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const principal = typeof body.principal === "string" ? body.principal.trim().toLowerCase() : "";
  if (!validEmail(principal))
    return sendJson(ctx.res, 400, { error: "bad_request", message: "principal must be an email" });
  if (!ctx.deps.admin || !(await ctx.deps.admin.adminStatusOf({ id: principal, type: "internal" })).isAdmin) {
    return sendJson(ctx.res, 403, { error: "forbidden" });
  }
  if (!ctx.deps.authEmailSettings || !ctx.deps.authServiceUrl) return sendJson(ctx.res, 404, { error: "not_found" });
  const current = await ctx.deps.authEmailSettings.status();
  if (current.source !== "admin" || !current.version) {
    return sendJson(ctx.res, 409, {
      error: "no_managed_settings",
      message: "there is no Admin-managed email configuration to replace",
    });
  }
  const client = createAuthEmailServiceClient({
    baseUrl: ctx.deps.authServiceUrl,
    signingSecret: ctx.deps.signingSecret,
    ...(ctx.deps.authServiceFetch ? { fetchImpl: ctx.deps.authServiceFetch } : {}),
  });
  try {
    await client.validateEnvironment(principal);
    const status = await ctx.deps.authEmailSettings.useEnvironment(
      "source-authenticated deployment CLI",
      current.version,
    );
    audit(ctx.deps, {
      principalId: "source-authenticated deployment CLI",
      action: "auth-email-settings.fallback",
      resource: principal,
      scopeLabel: orgScope(),
    });
    return sendJson(ctx.res, 200, { ok: true, status });
  } catch (error) {
    if (error instanceof AuthEmailSettingsConflict) {
      return sendJson(ctx.res, 409, { error: "conflict", message: error.message });
    }
    if (error instanceof AuthEmailServiceError) {
      return sendJson(ctx.res, error.status >= 500 ? 502 : 400, {
        error: "environment_validation_failed",
        message: error.message,
      });
    }
    throw error;
  }
}

export const authEmailSettingsRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/auth/email-settings/runtime", auth: "source", handle: runtime },
  { method: "POST", path: "/v1/auth/bootstrap/consume", auth: "source", handle: consumeBootstrap },
  { method: "POST", path: "/v1/operator/auth-email-settings/bootstrap", auth: "source", handle: bootstrap },
  { method: "POST", path: "/v1/operator/auth-email-settings/fallback", auth: "source", handle: fallback },
];
