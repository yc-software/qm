import { brokerCredentialCall, realBrokerFetch, type BrokerAudit } from "../credential-broker.ts";
import { brokerConnectorCall } from "../connector-broker.ts";
import { scopeId as makeScopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import { tenantOf, type ApiCtx, type Route } from "./route.ts";
import { orgId as configOrgId } from "../../config.ts";
import { appCredentialGrants } from "../../deploy/app-credentials.ts";
import type { BaseCtx } from "./route.ts";

export function appBorrows(ctx: BaseCtx): (deployment: string, slug: string) => Promise<boolean> {
  return async (deployment, slug) => {
    const { acl, teams } = ctx.deps;
    const app = acl ? await ctx.app.getApp(deployment) : null;
    if (!acl || !app || app.id !== deployment) return false;
    const granted = await appCredentialGrants(
      app,
      { tenant: tenantOf(ctx), orgScope: makeScopeId("org", configOrgId()), acl, teams },
      slug,
    );
    return granted.has(slug);
  };
}

async function brokerCredential(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability, app } = ctx;
  const audit: BrokerAudit = (event) => deps.auditLog.record(tenantOf(ctx), { at: Date.now(), ...event });
  if ((body as { connector?: unknown }).connector !== undefined) {
    if (!deps.keychain) return sendJson(res, 404, { error: "not_found" });
    const result = await brokerConnectorCall({
      claims: capability!,
      body: body as Record<string, unknown>,
      loadApp: (id) => app.getApp(id),
      tokens: deps.keychain,
      fetchImpl: deps.brokerFetch ?? realBrokerFetch,
      audit,
    });
    return sendJson(res, result.status, result.json);
  }
  const orgScope = makeScopeId("org", configOrgId());
  const result = await brokerCredentialCall({
    tenant: tenantOf(ctx),
    claims: capability!,
    body: body as Record<string, unknown>,
    orgScopeId: orgScope,
    reader: deps.serviceCreds,
    appBorrows: appBorrows(ctx),
    fetchImpl: deps.brokerFetch ?? realBrokerFetch,
    usage: deps.credentialUsage,
    audit,
  });
  return sendJson(res, result.status, result.json);
}

export const credentialRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/credentials/broker", auth: { aud: "credential-broker" }, handle: brokerCredential },
];
