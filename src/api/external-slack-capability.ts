import { currentExternalSlackRun } from "../resolution/external-slack.ts";
import { parseRef } from "../acl/resource-ref.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import { orgId } from "../config.ts";
import { entitledScopes } from "../resolution/context-filter.ts";
import { scopeId } from "../types.ts";
import type { ServerDeps } from "./deps.ts";

export async function externalSlackCapabilityAllowed(
  claims: CapabilityClaims,
  deps: Pick<ServerDeps, "runs" | "acl" | "externalSlackPolicies">,
): Promise<boolean> {
  const run = await currentExternalSlackRun(claims, deps);
  const origin = run?.request.surfaceOrigin;
  if (!run || origin?.audience !== "external" || !deps.acl) return false;
  const allowed = new Set(origin.access.serviceCredentials);
  const grants = await deps.acl.grantsOfKind(
    "service-cred",
    run.request.conversation.audience,
    claims.scopeId,
    scopeId("org", orgId()),
    entitledScopes,
  );
  const granted = new Set(grants.map((grant) => parseRef(grant.ref).id));
  return !!claims.credentials?.length && claims.credentials.every((slug) => allowed.has(slug) && granted.has(slug));
}
