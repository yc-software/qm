import { grantedToEvery, type AclStore } from "../acl/acl-store.ts";
import { deployRef, encodeRef, parseRef } from "../acl/resource-ref.ts";
import type { PublicServiceCredential } from "../credentials/keychain.ts";
import { parseScopeId, personalScope, scopeId, type ScopeId } from "../types.ts";
import type { Tenant } from "../tenants/context.ts";
import type { PublishedApp } from "./deploy-store.ts";

export interface AppCredentialAccess {
  tenant: Tenant;
  orgScope: ScopeId;
  acl: Pick<AclStore, "grantsFor" | "find">;
  memberTeams: (principalId: string, teamIds: readonly string[]) => Promise<ReadonlySet<string>>;
}

export async function appCredentialGrants(
  app: Pick<PublishedApp, "id" | "ownerScopeId" | "createdBy" | "public">,
  access: AppCredentialAccess,
): Promise<Set<string>> {
  const { tenant, orgScope, acl } = access;
  const [grants, shares] = await Promise.all([
    acl.find(tenant, { ownerScopeId: orgScope, kind: "service-cred" }),
    app.public ? [] : acl.grantsFor(tenant, app.ownerScopeId, encodeRef(deployRef(app.id))),
  ]);
  const teamIds = grants.flatMap((g) => {
    const grantee = parseScopeId(g.granteeScopeId);
    return grantee.kind === "team" ? [grantee.ref] : [];
  });
  const audience = app.public
    ? [new Set([orgScope])]
    : await Promise.all(
        [...new Set([app.ownerScopeId, personalScope(app.createdBy), ...shares.map((g) => g.granteeScopeId)])].map(
          async (scope) => {
            const person = parseScopeId(scope);
            const teams =
              person.kind === "personal" && teamIds.length ? await access.memberTeams(person.ref, teamIds) : [];
            return new Set([orgScope, scope, ...[...teams].map((team) => scopeId("team", team))]);
          },
        ),
      );
  return new Set(grants.filter(grantedToEvery(audience)).map((g) => parseRef(g.ref).id));
}

export function appCredentialSlugs(
  credentials: readonly PublicServiceCredential[],
  granted: ReadonlySet<string>,
): string[] {
  return credentials
    .filter(
      (credential) =>
        credential.enabled &&
        credential.hasSecret &&
        credential.delivery === "broker" &&
        credential.deployments &&
        granted.has(credential.slug),
    )
    .map((credential) => credential.slug);
}
