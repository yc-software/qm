import type { AclStore } from "../acl/acl-store.ts";
import { encodeRef, serviceCredRef } from "../acl/resource-ref.ts";
import type { PublicServiceCredential } from "../credentials/keychain.ts";
import type { ScopeId } from "../types.ts";

export async function deploymentCredentialSlugs(
  credentials: readonly PublicServiceCredential[],
  orgScope: ScopeId,
  acl: Pick<AclStore, "grantsFor">,
): Promise<string[]> {
  const slugs: string[] = [];
  for (const credential of credentials) {
    if (!credential.enabled || !credential.hasSecret || credential.delivery !== "broker" || !credential.deployments) {
      continue;
    }
    const grants = await acl.grantsFor(orgScope, encodeRef(serviceCredRef(credential.slug)));
    if (grants.some((grant) => grant.ownerScopeId === orgScope && grant.granteeScopeId === orgScope)) {
      slugs.push(credential.slug);
    }
  }
  return slugs;
}
