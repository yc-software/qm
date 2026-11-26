import { grantedToEvery, type AclStore } from "../acl/acl-store.ts";
import { deployRef, encodeRef, parseRef, serviceCredRef } from "../acl/resource-ref.ts";
import type { PublicServiceCredential } from "../credentials/keychain.ts";
import { onTeam, type TeamStore } from "../teams/teams.ts";
import { parseScopeId, personalScope, scopeId, type ScopeId } from "../types.ts";
import type { Tenant } from "../tenants/context.ts";
import type { PublishedApp } from "./deploy-store.ts";

export interface AppCredentialAccess {
  tenant: Tenant;
  orgScope: ScopeId;
  acl: Pick<AclStore, "grantsFor" | "find">;
  teams: Pick<TeamStore, "forTurn"> | undefined;
}

export async function appCredentialGrants(
  app: Pick<PublishedApp, "id" | "ownerScopeId" | "createdBy" | "public">,
  access: AppCredentialAccess,
  slug?: string,
): Promise<Set<string>> {
  const { tenant, orgScope, acl } = access;
  const grants = slug
    ? await acl.grantsFor(tenant, orgScope, encodeRef(serviceCredRef(slug)))
    : await acl.find(tenant, { ownerScopeId: orgScope, kind: "service-cred" });
  const slugsOf = (audience: readonly ReadonlySet<ScopeId>[]) =>
    new Set(grants.filter(grantedToEvery(audience)).map((g) => parseRef(g.ref).id));
  const orgWide = slugsOf([new Set([orgScope])]);
  if (app.public || (slug && orgWide.has(slug))) return orgWide;
  const teamIds = grants.flatMap((g) => {
    const grantee = parseScopeId(g.granteeScopeId);
    return grantee.kind === "team" ? [grantee.ref] : [];
  });
  const shares = await acl.grantsFor(tenant, app.ownerScopeId, encodeRef(deployRef(app.id)));
  const scopes = [...new Set([app.ownerScopeId, personalScope(app.createdBy), ...shares.map((g) => g.granteeScopeId)])];
  const people = scopes.flatMap((scope) => {
    const person = parseScopeId(scope);
    return person.kind === "personal" ? [person.ref] : [];
  });
  const teams =
    teamIds.length && people.length && access.teams
      ? (await access.teams.forTurn(tenant, app.ownerScopeId, people)).filter((team) => teamIds.includes(team.id))
      : [];
  return slugsOf(
    scopes.map((scope) => {
      const person = parseScopeId(scope);
      const own = person.kind === "personal" ? teams.filter((team) => onTeam(team, person.ref)) : [];
      return new Set([orgScope, scope, ...own.map((team) => scopeId("team", team.id))]);
    }),
  );
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
