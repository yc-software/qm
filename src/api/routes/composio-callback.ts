import { canonicalPerson } from "../../directory/person.ts";
import { scopeId } from "../../types.ts";
import { orgId } from "../../config.ts";
import { sendJson } from "../http.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { createExactSecretValueMasker } from "../../security/secret-masking.ts";
import { errMessage, reportFailure } from "../../util/errors.ts";
import { ACCOUNT_ID, composioUserId, credential, request } from "./composio.ts";
import { audit } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function completeAuth(ctx: ApiCtx): Promise<void> {
  ctx.res.setHeader("cache-control", "no-store");
  ctx.res.setHeader("referrer-policy", "no-referrer");
  if (!ctx.actor || ctx.actor.imp || ctx.capability)
    return sendJson(ctx.res, 403, { error: "browser_identity_required" });
  const access = await credential(ctx);
  if (!access) return;
  const connectFailed = () =>
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.connect_failed",
      resource: "unknown",
      scopeLabel: scopeId("personal", access.principal),
    });
  const base = new URL(ctx.deps.portalUrl!);
  const sessionUri = ctx.url.searchParams.get("session_uri");
  if (!sessionUri || sessionUri.length > 8192) {
    connectFailed();
    return sendJson(ctx.res, 400, { error: "invalid_session" });
  }
  const userId = composioUserId(orgId(), canonicalPerson(access.principal));
  let accountId: string;
  try {
    const result = await request(ctx, access.key, "/connected_accounts/complete_auth", {
      session_uri: sessionUri,
      user_id: userId,
    });
    if (typeof result.connected_account_id !== "string" || !ACCOUNT_ID.test(result.connected_account_id))
      throw new Error("Invalid account");
    accountId = result.connected_account_id;
  } catch (error) {
    const mask = createExactSecretValueMasker([access.key]);
    reportFailure("composio: complete-auth", new Error(mask(redactSecrets(errMessage(error)))));
    connectFailed();
    return sendJson(ctx.res, 400, {
      error: "verification_failed",
      message: "Sign in to the QM account that started this connection and try connecting again.",
    });
  }
  const key = `${userId}:${accountId}`;
  const saved = await ctx.deps.composioReturns?.get(key);
  await ctx.deps.composioReturns?.delete(key);
  audit(ctx.deps, {
    principalId: access.principal,
    action: "composio.connected",
    resource: saved?.toolkit ?? "unknown",
    scopeLabel: scopeId("personal", access.principal),
  });
  const target =
    saved?.url && saved.expiresAt > Date.now()
      ? new URL(saved.url, base)
      : new URL("./?view=settings", `${ctx.deps.portalUrl!.replace(/\/$/, "")}/`);
  if (target.origin !== base.origin) return sendJson(ctx.res, 400, { error: "invalid_return_url" });
  ctx.res.writeHead(303, { location: target.href });
  ctx.res.end();
}

export const composioCallbackRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "GET",
    path: "/v1/composio/callback",
    browser: true,
    actor: "person",
    auth: "source",
    handle: completeAuth,
  },
];
