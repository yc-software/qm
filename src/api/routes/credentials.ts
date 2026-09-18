import { isObj } from "../../util/objects.ts";
import { encodeRef, serviceCredRef } from "../../acl/resource-ref.ts";
import { personalDeploymentCredential } from "../../deploy/credential-bindings.ts";
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
    body: isObj(body) ? body : {},
    orgScopeId: orgScope,
    reader: deps.serviceCreds,
    ...(capability!.deployment
      ? {
          deploymentReader: async (credential: string) => {
            const deployment = await ctx.app.getDeployment(capability!.deployment!);
            if (
              !deployment ||
              deployment.id !== capability!.deployment ||
              deployment.status !== "running" ||
              deployment.createdBy !== capability!.actorId
            )
              return null;
            const personal =
              deployment.credentialBindings?.some((b) => b.credentialId === credential) ||
              (deps.keychain && (await deps.keychain.getCredential(credential)));
            if (personal)
              return deps.keychain
                ? personalDeploymentCredential(deployment, capability!, credential, deps.keychain)
                : null;
            if (!capability!.credentials?.includes(credential) || !deps.acl) return null;
            const grants = await deps.acl.grantsFor(orgScope, encodeRef(serviceCredRef(credential)));
            if (!grants.some((g) => g.ownerScopeId === orgScope && g.granteeScopeId === orgScope)) return null;
            return deps.serviceCreds!.getServiceCredentialSecret(orgScope, credential);
          },
        }
      : {}),
    fetchImpl: deps.brokerFetch ?? realBrokerFetch,
    ...(deps.brokerFetch ? { personalFetchImpl: deps.brokerFetch } : {}),
    ...(deps.credentialUsage ? { usage: deps.credentialUsage } : {}),
    audit: (event) => deps.auditLog?.record({ at: Date.now(), ...event }),
  });
  return sendJson(res, result.status, result.json);
}

export const credentialRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/credentials/broker", auth: { aud: "credential-broker" }, handle: brokerCredential },
];
