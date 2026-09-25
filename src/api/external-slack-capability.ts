import { currentExternalSlackRun } from "../resolution/external-slack.ts";
import { parseRef } from "../acl/resource-ref.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import { orgId } from "../config.ts";
import { principalEntitledToScope } from "../resolution/context-filter.ts";
import { scopeId } from "../types.ts";
import type { ServerDeps } from "./deps.ts";

export async function externalSlackCapabilityAllowed(
  claims: CapabilityClaims,
  deps: Pick<ServerDeps, "runs" | "acl" | "externalSlackPolicies">,
): Promise<boolean> {
  const run = await currentExternalSlackRun(claims, deps);
  if (!run?.request.externalSlack || !deps.acl) return false;
  const allowed = new Set(run.request.externalSlack.serviceCredentials);
  const grants = await deps.acl.grantsOfKind(
    "service-cred",
    run.request.conversation.audience,
    claims.scopeId,
    scopeId("org", orgId()),
    principalEntitledToScope,
  );
  const granted = new Set(grants.map((grant) => parseRef(grant.ref).id));
  return !!claims.credentials?.length && claims.credentials.every((slug) => allowed.has(slug) && granted.has(slug));
}
