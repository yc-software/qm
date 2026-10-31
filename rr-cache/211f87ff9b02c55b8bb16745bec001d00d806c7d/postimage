import { brokerCredentialCall, realBrokerFetch, type BrokerAudit } from "../../../api/credential-broker.ts";
import { brokerConnectorCall } from "../../../api/connector-broker.ts";
import { sendJson } from "../../../api/http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { tenantRootScope } from "../../../tenants/context.ts";

async function brokerCredential(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability, app } = ctx;
  const audit: BrokerAudit = (event) => deps.auditLog?.record({ at: Date.now(), ...event });
  if ((body as { connector?: unknown }).connector !== undefined) {
    if (!deps.keychain) return sendJson(res, 404, { error: "not_found" });
    const result = await brokerConnectorCall({
      claims: capability!,
      body: body as Record<string, unknown>,
      loadDeployment: (id) => app.getDeployment(id),
      tokens: deps.keychain,
      fetchImpl: deps.brokerFetch ?? realBrokerFetch,
      audit,
    });
    return sendJson(res, result.status, result.json);
  }
  if (!deps.serviceCreds) return sendJson(res, 404, { error: "not_found" });
  const orgScope = tenantRootScope();
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
