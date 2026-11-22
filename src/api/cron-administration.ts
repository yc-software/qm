import type { App, AppDeps } from "./app-types.ts";
import { asOrgAdmin, personOrOwningBot, type CapabilityClaims } from "../auth/capability-token.ts";
import { actsAsScope, parseScopeId, type Grant, type Permission, type ScopeId } from "../types.ts";
import { samePersonInDirectory } from "../directory/person.ts";
import { cronRef, encodeRef } from "../acl/resource-ref.ts";
import { ambientTenant } from "../tenants/context.ts";
import { reportFailureAs } from "../util/errors.ts";
import {
  createCanManageScope,
  createCanReadScope,
  createCanWriteScope,
  createIsCurrentSharedScopeMember,
  createMembershipControlsScope,
  scopeMembershipSnapshot,
} from "../resolution/scope-membership.ts";
import type { Cron } from "../triggers/types.ts";

export async function managesPersonaCron(
  app: Pick<App, "managesScope">,
  cron: Pick<Cron, "ownerScopeId">,
  actorId: string,
): Promise<boolean> {
  return parseScopeId(cron.ownerScopeId).kind === "persona" && app.managesScope(actorId, cron.ownerScopeId);
}

export async function ownsCron(
  app: Pick<App, "samePerson" | "isCurrentSharedScopeMember" | "membershipControlsScope" | "managesScope">,
  cron: Cron,
  actorId: string,
  isActor?: (id: string) => Promise<boolean>,
): Promise<boolean> {
  if (actsAsScope(cron.owner, cron.ownerScopeId))
    return parseScopeId(cron.ownerScopeId).kind === "persona"
      ? app.managesScope(actorId, cron.ownerScopeId)
      : app.isCurrentSharedScopeMember(actorId, cron.ownerScopeId);
  if (!(await (isActor ? isActor(cron.owner) : app.samePerson(cron.owner, actorId)))) return false;
  return !(await app.membershipControlsScope(cron.ownerScopeId)) || app.managesScope(actorId, cron.ownerScopeId);
}

export async function canAdministerCron(
  app: Pick<
    App,
    "samePerson" | "isCurrentSharedScopeMember" | "artifactGrantPermission" | "membershipControlsScope" | "managesScope"
  >,
  cron: Cron,
  actor: Pick<CapabilityClaims, "actorId" | "botActor">,
  isActor?: (id: string) => Promise<boolean>,
): Promise<boolean> {
  const owns = () => (isActor ? isActor(cron.owner) : app.samePerson(cron.owner, actor.actorId));
  if (!(await personOrOwningBot(actor, owns, cron))) return false;
  if (await ownsCron(app, cron, actor.actorId, isActor)) return true;
  if (actsAsScope(cron.owner, cron.ownerScopeId) || cron.ownerScopeId.startsWith("personal:")) return false;
  if (await managesPersonaCron(app, cron, actor.actorId)) return true;
  if (await ownsCron(app, { ...cron, owner: cron.createdBy }, actor.actorId, isActor)) return true;
  return (await app.artifactGrantPermission(cron.ownerScopeId, encodeRef(cronRef(cron.id)), actor.actorId)) === "write";
}

export async function administersCron(
  app: Parameters<typeof canAdministerCron>[0] & Pick<App, "isOrgAdmin">,
  cron: Cron,
  actor: Pick<CapabilityClaims, "actorId" | "botActor">,
): Promise<boolean> {
  return (await canAdministerCron(app, cron, actor)) || asOrgAdmin(app, actor);
}

const grantKey = (r: { ownerScopeId: ScopeId; ref: string }) => `${r.ownerScopeId}\n${r.ref}`;

export async function cronAdministration(
  deps: AppDeps,
  actor: Pick<CapabilityClaims, "actorId" | "botActor">,
  crons: readonly Cron[],
): Promise<boolean[]> {
  if (!crons.length) return [];
  const { actorId } = actor;
  const tenant = ambientTenant();
  const resources = crons
    .filter((c) => !c.ownerScopeId.startsWith("personal:"))
    .map((c) => ({ ownerScopeId: c.ownerScopeId, ref: encodeRef(cronRef(c.id)) }));
  const grants = resources.length
    ? ((await deps.acl?.find(tenant, { resources }).catch(reportFailureAs("cron grants", []))) ?? [])
    : [];
  const snapshot = await scopeMembershipSnapshot(
    {
      directory: deps.directory,
      identity: deps.identity,
      ...(deps.projects ? { managedGroups: deps.projects } : {}),
      ...(deps.personas ? { personas: deps.personas } : {}),
      ...(deps.teams
        ? {
            teams: {
              memberTeams: (id: string, teamIds: readonly string[]) => deps.teams!.memberTeams(tenant, id, teamIds),
            },
          }
        : {}),
    },
    actorId,
    [...crons.map((c) => c.ownerScopeId), ...grants.map((g) => g.granteeScopeId)],
    crons.flatMap((c) => [c.owner, c.createdBy]),
  );
  const byCron = Map.groupBy(grants, grantKey);
  const canRead = createCanReadScope(snapshot);
  const canWrite = createCanWriteScope(snapshot);
  const manages = createCanManageScope(snapshot);
  const sharedMember = createIsCurrentSharedScopeMember(snapshot);
  const membership = createMembershipControlsScope(snapshot);
  const canUseWriteGrant = async (scope: ScopeId): Promise<boolean> => {
    if (await canWrite(actorId, scope)) return true;
    const { kind, ref } = parseScopeId(scope);
    if (kind !== "channel" || !deps.identity.isInternal(deps.identity.classify(actorId))) return false;
    return (await snapshot.directory.channelPrivacy?.(ref)) === false && canRead(actorId, scope);
  };
  const grantPermission = async (ownerScopeId: ScopeId, ref: string): Promise<Permission | null> => {
    let best: Permission | null = null;
    for (const g of byCron.get(grantKey({ ownerScopeId, ref })) ?? ([] as Grant[])) {
      if (g.permission !== "read" && g.permission !== "write") continue;
      if (g.permission === "write" && (await canUseWriteGrant(g.granteeScopeId))) return "write";
      best = "read";
    }
    return best;
  };
  const policy = {
    samePerson: (a: string, b: string) => samePersonInDirectory(snapshot.directory, a, b),
    isCurrentSharedScopeMember: (_actor: string, scope: ScopeId) => sharedMember(actorId, scope),
    membershipControlsScope: membership,
    managesScope: (_actor: string, scope: ScopeId) => manages(actorId, scope),
    artifactGrantPermission: (ownerScopeId: ScopeId, ref: string) => grantPermission(ownerScopeId, ref),
  };
  return Promise.all(crons.map((cron) => canAdministerCron(policy, cron, actor)));
}
