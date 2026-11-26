import type { AclStore } from "../acl/acl-store.ts";
import { deployRef, encodeRef, serviceCredRef } from "../acl/resource-ref.ts";
import type { PublicServiceCredential } from "../credentials/keychain.ts";
import { parseScopeId, personalScope, type ScopeId } from "../types.ts";
import type { Tenant } from "../tenants/context.ts";
import type { PublishedApp } from "./deploy-store.ts";

type BorrowingApp = Pick<PublishedApp, "id" | "ownerScopeId" | "createdBy" | "public">;

export interface AppCredentialAccess {
  tenant: Tenant;
  orgScope: ScopeId;
  acl: Pick<AclStore, "grantsFor">;
  memberTeams?: (principalId: string, teamIds: readonly string[]) => Promise<ReadonlySet<string>>;
}

export function appBorrowing(app: BorrowingApp, access: AppCredentialAccess): (slug: string) => Promise<boolean> {
  const { tenant, orgScope, acl } = access;
  let audience: Promise<ScopeId[]> | undefined;
  const audienceScopes = (): Promise<ScopeId[]> =>
    (audience ??= acl
      .grantsFor(tenant, app.ownerScopeId, encodeRef(deployRef(app.id)))
      .then((shares) => [
        ...new Set([app.ownerScopeId, personalScope(app.createdBy), ...shares.map((g) => g.granteeScopeId)]),
      ]));
  const covers = async (grantee: ScopeId, scope: ScopeId): Promise<boolean> => {
    if (grantee === scope) return true;
    const team = parseScopeId(grantee);
    const person = parseScopeId(scope);
    if (team.kind !== "team" || person.kind !== "personal" || !access.memberTeams) return false;
    return (await access.memberTeams(person.ref, [team.ref])).has(team.ref);
  };
  return async (slug) => {
    const grantees = (await acl.grantsFor(tenant, orgScope, encodeRef(serviceCredRef(slug)))).map(
      (g) => g.granteeScopeId,
    );
    if (grantees.includes(orgScope)) return true;
    if (app.public || grantees.length === 0) return false;
    const scopes = await audienceScopes();
    for (const grantee of grantees) {
      if ((await Promise.all(scopes.map((scope) => covers(grantee, scope)))).every(Boolean)) return true;
    }
    return false;
  };
}

export function deploymentBorrowing(
  loadApp: (id: string) => Promise<BorrowingApp | null>,
  access: AppCredentialAccess,
): (deployment: string, slug: string) => Promise<boolean> {
  return async (deployment, slug) => {
    const app = await loadApp(deployment);
    return !!app && app.id === deployment && (await appBorrowing(app, access)(slug));
  };
}

export async function appCredentialSlugs(
  credentials: readonly PublicServiceCredential[],
  borrows: (slug: string) => Promise<boolean>,
): Promise<string[]> {
  const eligible = credentials.filter(
    (credential) =>
      credential.enabled && credential.hasSecret && credential.delivery === "broker" && credential.deployments,
  );
  const allowed = await Promise.all(eligible.map((credential) => borrows(credential.slug)));
  return eligible.filter((_, i) => allowed[i]).map((credential) => credential.slug);
}
