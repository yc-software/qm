import { brokerCredentialCall, realBrokerFetch, type BrokerAudit } from "../credential-broker.ts";
import { brokerConnectorCall } from "../connector-broker.ts";
import { viewerAttestationKey } from "../../deploy/access-token.ts";
import { scopeId as makeScopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { orgId as configOrgId } from "../../config.ts";

async function brokerCredential(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability, app, secret } = ctx;
  const audit: BrokerAudit = (event) => deps.auditLog?.record({ at: Date.now(), ...event });
  if ((body as { connector?: unknown }).connector !== undefined) {
    if (!deps.keychain || !secret) return sendJson(res, 404, { error: "not_found" });
    const result = await brokerConnectorCall({
      claims: capability!,
      body: body as Record<string, unknown>,
      loadDeployment: (id) => app.getDeployment(id),
      tokens: deps.keychain,
      attestationKey: viewerAttestationKey(secret, capability!.deployment ?? ""),
      fetchImpl: deps.brokerFetch ?? realBrokerFetch,
      audit,
    });
    return sendJson(res, result.status, result.json);
  }
  if (!deps.serviceCreds) return sendJson(res, 404, { error: "not_found" });
  const orgScope = makeScopeId("org", configOrgId());
  const result = await brokerCredentialCall({
    claims: capability!,
    body: body as Record<string, unknown>,
    orgScopeId: orgScope,
    reader: deps.serviceCreds,
    fetchImpl: deps.brokerFetch ?? realBrokerFetch,
    ...(deps.credentialUsage ? { usage: deps.credentialUsage } : {}),
    audit,
  });
  return sendJson(res, result.status, result.json);
}

export const credentialRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/credentials/broker", auth: { aud: "credential-broker" }, handle: brokerCredential },
];
