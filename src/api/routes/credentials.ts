import { brokerCredentialCall, realBrokerFetch } from "../credential-broker.ts";
import { scopeId as makeScopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { orgId as configOrgId } from "../../config.ts";

async function brokerCredential(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability } = ctx;
  if (!deps.serviceCreds) return sendJson(res, 404, { error: "not_found" });
  const orgScope = makeScopeId("org", configOrgId());
  const result = await brokerCredentialCall({
    claims: capability!,
    body: body as Record<string, unknown>,
    orgScopeId: orgScope,
    reader: deps.serviceCreds,
    fetchImpl: deps.brokerFetch ?? realBrokerFetch,
    ...(deps.credentialUsage ? { usage: deps.credentialUsage } : {}),
    audit: (event) => deps.auditLog?.record({ at: Date.now(), ...event }),
  });
  return sendJson(res, result.status, result.json);
}

export const credentialRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/credentials/broker", auth: { aud: "credential-broker" }, handle: brokerCredential },
];
