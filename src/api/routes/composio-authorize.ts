import { externalOrgId } from "../../tenants/external-org.ts";
import { mintSignedPayload } from "../../auth/signed-token.ts";
import { orgId } from "../../config.ts";
import { canonicalPerson } from "../../directory/person.ts";
import { createExactSecretValueMasker } from "../../security/secret-masking.ts";
import { scopeId } from "../../types.ts";
import { errMessage, reportFailure } from "../../util/errors.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { livePersonCapability } from "../artifact-share.ts";
import { sendJson } from "../http.ts";
import { ACCOUNT_ID, composioUserId, credential, request } from "./composio.ts";
import { audit, isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

export function composioCallbackUrl(publicUrl: string | undefined, returnTo: unknown, state: unknown): string | null {
  if (!publicUrl || typeof returnTo !== "string" || typeof state !== "string" || !/^[a-zA-Z0-9_-]{20,100}$/.test(state))
    return null;
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || /[\\\r\n]/.test(returnTo) || returnTo.length > 4096)
    return null;
  const base = new URL(publicUrl);
  const target = new URL(returnTo, base);
  const prefix = base.pathname.replace(/\/$/, "");
  if (
    target.origin !== base.origin ||
    !(
      target.pathname === `${prefix}/` ||
      target.pathname === `${prefix}/settings` ||
      new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/s/[a-zA-Z0-9_-]+$`).test(target.pathname)
    )
  )
    return null;
  for (const key of ["status", "error", "connectedAccountId", "composioReturn"]) target.searchParams.delete(key);
  target.hash = "";
  target.searchParams.set("composioReturn", state);
  return target.href;
}

async function authorize(ctx: ApiCtx, linkSlack: boolean, callbackUrl: unknown): Promise<void> {
  if (ctx.capability && !livePersonCapability(ctx.capability))
    return sendJson(ctx.res, 403, { error: "human_consent_required" });
  const access = await credential(ctx);
  if (!access) return;
  const toolkit = linkSlack ? "slack" : (ctx.body as { toolkit?: unknown } | null)?.toolkit;
  if (linkSlack && (!ctx.deps.signingSecret || !ctx.deps.principalLinks || ctx.actor?.imp))
    return sendJson(ctx.res, 403, { error: "link_unavailable", message: "Sign in as yourself to connect Slack." });
  if (typeof toolkit !== "string" || !/^[a-z0-9_-]{1,100}$/.test(toolkit))
    return sendJson(ctx.res, 400, { error: "invalid_toolkit" });
  if (callbackUrl !== undefined) {
    try {
      if (typeof callbackUrl !== "string" || callbackUrl.length > 4096) throw new Error("Invalid callback");
      const callback = new URL(callbackUrl);
      if (
        callback.username ||
        callback.password ||
        callback.hash ||
        !(
          callback.protocol === "https:" ||
          (callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname))
        )
      )
        throw new Error("Invalid callback");
    } catch {
      return sendJson(ctx.res, 400, { error: "invalid_callback" });
    }
  }
  const userId = composioUserId(externalOrgId(), canonicalPerson(access.principal));
  try {
    const session = await request(ctx, access.key, "/tool_router/session", {
      user_id: userId,
      toolkits: { enable: [toolkit] },
      manage_connections: { enable: false },
      workbench: { enable: false },
    });
    if (typeof session.session_id !== "string" || !/^trs_[a-zA-Z0-9_-]+$/.test(session.session_id))
      throw new Error("Invalid session");
    const link = await request(ctx, access.key, `/tool_router/session/${encodeURIComponent(session.session_id)}/link`, {
      toolkit,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    });
    if (typeof link.connected_account_id !== "string" || !ACCOUNT_ID.test(link.connected_account_id))
      throw new Error("Invalid account");
    await ctx.deps.composioReturns?.put(`${userId}:${link.connected_account_id}`, {
      url: typeof callbackUrl === "string" ? callbackUrl : null,
      toolkit,
      expiresAt: Date.now() + 20 * 60_000,
    });
    const url = new URL(String(link.redirect_url));
    if (
      !(
        (url.origin === "https://connect.composio.dev" && /^\/link\/lk_[a-zA-Z0-9_-]+$/.test(url.pathname)) ||
        (url.origin === "https://app.composio.dev" && /^\/link\/lt_[a-zA-Z0-9_-]+$/.test(url.pathname))
      ) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid authorization URL");
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.authorize",
      resource: toolkit,
      scopeLabel: scopeId("personal", access.principal),
    });
    const ticket = linkSlack
      ? await mintSignedPayload(
          {
            purpose: "slack-account-link",
            principal: access.principal,
            org: orgId(),
            accountId: link.connected_account_id,
            exp: Date.now() + 20 * 60_000,
          },
          ctx.deps.signingSecret!,
        )
      : undefined;
    return sendJson(ctx.res, 200, {
      url: url.href,
      accountId: link.connected_account_id,
      ...(ticket ? { ticket } : {}),
    });
  } catch (error) {
    const mask = createExactSecretValueMasker([access.key]);
    reportFailure("composio: authorize", new Error(mask(redactSecrets(errMessage(error)))), `toolkit=${toolkit}`);
    return sendJson(ctx.res, 502, {
      error: "composio_authorization_failed",
      message: "Could not start authorization. Please try again.",
    });
  }
}

async function authorizeToolkit(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  if (ctx.capability) return authorize(ctx, false, body.callbackUrl);
  ctx.res.setHeader("Cache-Control", "no-store");
  const callbackUrl = composioCallbackUrl(ctx.deps.portalUrl, body.returnTo, body.state);
  if (!callbackUrl && (body.returnTo !== undefined || body.state !== undefined))
    return sendJson(ctx.res, 400, { error: "invalid_return_url" });
  return authorize(ctx, false, callbackUrl ?? undefined);
}

async function authorizeSlack(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const callback = composioCallbackUrl(ctx.deps.portalUrl, body.returnTo, body.state);
  if (!callback) return sendJson(ctx.res, 400, { error: "invalid_return_url" });
  const url = new URL(callback);
  url.searchParams.delete("composioReturn");
  url.searchParams.set("slackReturn", String(body.state));
  ctx.res.setHeader("Cache-Control", "no-store");
  return authorize(ctx, true, url.href);
}

export const composioAuthorizeRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/composio/authorize",
    browser: true,
    actor: "person",
    auth: "either",
    handle: authorizeToolkit,
  },
  {
    method: "POST",
    path: "/v1/composio/slack/authorize",
    browser: true,
    actor: "person",
    auth: "source",
    handle: authorizeSlack,
  },
];
