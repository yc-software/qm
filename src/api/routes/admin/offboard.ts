import type { AdminGrant } from "../../../admin/admin-grant-store.ts";
import { AdminError, trustedSubjectPrincipal } from "../../../admin/admin-service.ts";
import { inTenant } from "../../../tenants/claim.ts";
import type { DirectoryMember } from "../../../directory/directory-store.ts";
import { personKey, samePerson, samePersonMatcher } from "../../../directory/person.ts";
import { parseScopeId, scopeId as makeScopeId, type ScopeId } from "../../../types.ts";
import { errMessage } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope, type AuthorizedAdmin } from "../shared.ts";
import { tenantOf, type ApiCtx } from "../route.ts";
import { resolveAdminUser } from "./users.ts";
import { syncLoopSchedule } from "../loops.ts";

interface Change {
  kind: string;
  id: string;
  label: string;
  action: string;
  result?: "done" | "failed";
  error?: string;
}

type Step = Change & { run: () => Promise<unknown> };

type OffboardActor = AuthorizedAdmin & { system?: true };

const TRUSTED_SYSTEM_ACTOR: OffboardActor = {
  id: "system:trusted-issuer",
  type: "internal",
  role: "org_admin",
  system: true,
};

interface TargetGovernance {
  grants: AdminGrant[];
  isOrgAdmin: boolean;
  isOwner: boolean;
  otherActiveOrgAdmins: number;
  otherActiveOwners: number;
}

function keysFor(id: string, member?: DirectoryMember | null): string[] {
  const keys = [personKey(id)];
  if (member?.principalId) keys.push(personKey(member.principalId));
  if (member?.slackId) keys.push(personKey(member.slackId));
  return keys;
}

async function targetGovernance(
  ctx: ApiCtx,
  principalId: string,
  aliases: readonly string[],
  targetMember?: DirectoryMember | null,
): Promise<TargetGovernance> {
  const { deps } = ctx;
  const all = (await deps.admin?.listGrants(tenantOf(ctx))) ?? [];
  const grantIds = [...new Set(all.map((grant) => grant.principalId))];
  const members = grantIds.length && deps.directory ? await deps.directory.getMany(grantIds) : new Map();
  const targetKeys = new Set([...keysFor(principalId, targetMember), ...aliases.map((alias) => personKey(alias))]);
  const grants = all.filter((grant) =>
    keysFor(grant.principalId, members.get(grant.principalId)).some((key) => targetKeys.has(key)),
  );
  const owned = new Set(grants);
  const isActive = (id: string) => (deps.identity ? deps.identity.classify(id).type === "internal" : true);
  const activeOther = (role: "org_admin" | "owner") => {
    const seen = new Set<string>();
    for (const grant of all) {
      if (grant.role !== role || owned.has(grant) || !isActive(grant.principalId)) continue;
      seen.add(personKey(grant.principalId));
    }
    return seen.size;
  };
  return {
    grants,
    isOrgAdmin: grants.some((grant) => grant.role === "org_admin"),
    isOwner: grants.some((grant) => grant.role === "owner"),
    otherActiveOrgAdmins: activeOther("org_admin"),
    otherActiveOwners: activeOther("owner"),
  };
}

async function deactivateAndSignOut(
  deps: ApiCtx["deps"],
  principalId: string,
  emails: Iterable<string>,
): Promise<void> {
  await deps.identity!.deactivate(principalId);
  if (!deps.brokerSessions) return;
  const revoked = new Set<string>();
  for (const candidate of emails) {
    const email = candidate.trim().toLowerCase();
    if (!email.includes("@") || revoked.has(email)) continue;
    revoked.add(email);
    await deps.brokerSessions.revoke(email);
  }
}

async function plan(
  ctx: ApiCtx,
  actor: OffboardActor,
  principalId: string,
  emails: string[],
  isThem: (id: string) => Promise<boolean>,
  governance: TargetGovernance,
): Promise<Step[]> {
  const { app, deps } = ctx;
  const actorId = actor.id;
  const personal = async (scope: ScopeId) => {
    const { kind, ref } = parseScopeId(scope);
    return kind === "personal" && (await isThem(ref));
  };
  const owns = async (owner: string, scope: ScopeId) => (await isThem(owner)) || (await personal(scope));
  const steps: Step[] = [];
  const step = (kind: string, id: string, label: string | undefined, action: string, run: () => Promise<unknown>) =>
    steps.push({ kind, id, label: label || id, action, run });

  if (deps.identity && deps.identity.deactivationSource(principalId) !== "manual")
    step("principal", principalId, "sign-in", "deactivate", () => deactivateAndSignOut(deps, principalId, emails));
  const { runs, signals } = deps;
  if (runs && signals)
    for (const run of await runs.inFlight([...new Set(emails)]))
      step("turn", run.id, run.sessionId, "stop", async () => {
        await signals.send(run.id, { kind: "abort", reason: "offboarded" });
        if (run.status === "pending") await runs.withdraw(run.id);
      });
  for (const grant of governance.grants)
    step(
      "admin_grant",
      `${grant.principalId}:${grant.role}`,
      grant.role === "owner" ? "owner access" : "admin access",
      "revoke",
      () =>
        deps.admin!.revokeGrant(
          tenantOf(ctx),
          actor,
          grant.principalId,
          grant.scopeId,
          grant.role,
          actor.system ? { system: true } : undefined,
        ),
    );
  if (actor.role === "owner") return steps;
  for (const c of await app.listCrons())
    if (!c.loopId && !c.archived && (await owns(c.owner, c.ownerScopeId)))
      step("cron", c.id, c.title ?? "", "disable_and_archive", () =>
        app.updateCron(c.id, { enabled: false, archived: true }, { actorId }),
      );
  const loops = deps.loops;
  for (const l of (await loops?.store.list()) ?? [])
    if (l.state === "enabled" && (await owns(l.owner, l.ownerScopeId)))
      step("loop", l.id, l.name, "pause", async () => {
        await loops!.store.setState(l.id, "paused");
        await syncLoopSchedule(loops!, l, "paused");
      });
  for (const w of await app.listWebhooks())
    if (w.enabled && (await owns(w.owner, w.ownerScopeId)))
      step("webhook", w.id, w.action.split("\n", 1)[0]!, "disable", () => app.setWebhookEnabled(w.id, false));
  for (const g of (await deps.keychain?.listGrants({ ownerId: principalId })) ?? [])
    if (g.status === "active")
      step("keychain_grant", g.id, g.purpose, "revoke", () => deps.keychain!.revokeGrant(g.ownerId, g.id));
  for (const d of await app.listApps())
    if (d.status !== "archived" && (await personal(d.ownerScopeId)))
      step("app", d.id, d.displayName || d.name, "archive", () => app.archiveApp(d.id));
  for (const s of await app.listSkills())
    if (s.status !== "archived" && (await personal(s.scopeId)))
      step("skill", s.id, s.manifest.name, "archive", () => app.archiveSkill(s.id));
  const computers = deps.sandboxResources;
  const home = makeScopeId("personal", principalId);
  const listed = actor.system ? undefined : await computers?.list(actorId, home);
  for (const c of listed?.sandboxes ?? [])
    if (c.state !== "retired" && c.availableActions?.includes("retire") && (await personal(c.ownerScopeId)))
      step("computer", c.id, c.name, "retire", async () => {
        if ((await computers!.resolve(c.ownerScopeId))?.id === c.id)
          await computers!.setDefault(actorId, c.ownerScopeId, null);
        await computers!.retire(actorId, c.id);
      });
  const personas = app.personaHandover;
  for (const handover of (await personas?.handovers(isThem)) ?? []) {
    const to = (await deps.directory?.get(handover.to))?.displayName || handover.to;
    step("persona", handover.persona.id, `${handover.persona.name} → ${to}`, "transfer_owner", () =>
      personas!.handOver(handover, actorId),
    );
  }
  return steps;
}

export async function offboardUser(ctx: ApiCtx): Promise<void> {
  const { res, deps, params, body } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const input = body ?? {};
  if (
    !isObj(input) ||
    Object.keys(input).some((k) => k !== "apply") ||
    !["boolean", "undefined"].includes(typeof input.apply)
  )
    return sendJson(res, 400, { error: "bad_request", message: "body is { apply?: boolean }; omit apply to preview" });
  const { principalId, user: resolvedUser, member } = await resolveAdminUser(deps, params.principalId!);
  const isThem = deps.directory
    ? await samePersonMatcher(deps.directory, principalId)
    : async (id: string) => samePerson(id, principalId);
  if (await isThem(actor.id))
    return sendJson(res, 400, { error: "bad_request", message: "you cannot offboard yourself" });
  const governance = await targetGovernance(ctx, principalId, resolvedUser?.aliases ?? [], member);
  if (actor.role === "owner" && governance.isOrgAdmin)
    return sendJson(res, 403, { error: "forbidden", message: "only an org admin may offboard an org admin" });
  if (ctx.capability && governance.grants.length > 0)
    return sendJson(res, 403, {
      error: "portal_only",
      message: "offboarding an admin or owner must be done in the admin portal",
    });
  if (governance.isOrgAdmin && governance.otherActiveOrgAdmins === 0)
    return sendJson(res, 400, { error: "bad_request", message: "cannot offboard the last org admin" });
  if (governance.isOwner && governance.otherActiveOrgAdmins === 0 && governance.otherActiveOwners === 0)
    return sendJson(res, 400, { error: "bad_request", message: "cannot offboard the last owner" });
  const emails = [principalId, params.principalId!, ...(resolvedUser?.aliases ?? [])];
  return sendJson(
    res,
    200,
    await applyOffboard(ctx, actor, principalId, emails, isThem, governance, input.apply === true),
  );
}

async function applyOffboard(
  ctx: ApiCtx,
  actor: OffboardActor,
  principalId: string,
  emails: string[],
  isThem: (id: string) => Promise<boolean>,
  governance: TargetGovernance,
  apply: boolean,
) {
  const { deps } = ctx;
  const steps = await plan(ctx, actor, principalId, emails, isThem, governance);
  const user = apply ? await deps.admin!.users.markOffboarded(principalId, actor.id) : undefined;
  const changes: Change[] = [];
  for (const { run, ...change } of steps) {
    if (apply) {
      try {
        await run();
        change.result = "done";
      } catch (e) {
        Object.assign(change, { result: "failed", error: errMessage(e) });
      }
      audit(ctx, {
        principalId: actor.id,
        action: `user.offboard.${change.kind}.${change.action}`,
        resource: change.id,
        scopeLabel: orgScope(deps),
        status: change.result,
        detail: [principalId, change.error].filter(Boolean).join(": "),
      });
    }
    changes.push(change);
  }
  return { principalId, applied: apply, changes, ...(user ? { user } : {}) };
}

export async function offboardTrustedSubject(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const issuer = deps.trustedOidcIssuer;
  const tenantsFor = deps.directory?.tenantsForPrincipal;
  if (!issuer || !deps.admin || !deps.identity || !tenantsFor) return sendJson(res, 503, { error: "not_configured" });
  const input = isObj(body) ? body : null;
  if (
    !input ||
    Object.keys(input).some((k) => k !== "subject" && k !== "apply") ||
    typeof input.subject !== "string" ||
    !["boolean", "undefined"].includes(typeof input.apply)
  )
    return sendJson(res, 400, {
      error: "bad_request",
      message: "body is { subject: string, apply?: boolean }; omit apply to preview",
    });
  let principalId: string;
  try {
    principalId = trustedSubjectPrincipal(issuer, input.subject);
  } catch (e) {
    if (e instanceof AdminError) return sendJson(res, e.status, { error: "bad_request", message: e.message });
    throw e;
  }
  const apply = input.apply === true;
  const workspaces = [];
  for (const { id, brandName } of await tenantsFor(principalId)) {
    const workspace = { tenant: id, ...(brandName ? { name: brandName } : {}) };
    try {
      const result = await inTenant(id, async (tenant) => {
        const bound = { ...ctx, tenant };
        const { user, member } = await resolveAdminUser(deps, principalId);
        const isThem = deps.directory
          ? await samePersonMatcher(deps.directory, principalId)
          : async (other: string) => samePerson(other, principalId);
        const governance = await targetGovernance(bound, principalId, user?.aliases ?? [], member);
        const emails = [principalId, ...(user?.aliases ?? [])];
        return applyOffboard(bound, TRUSTED_SYSTEM_ACTOR, principalId, emails, isThem, governance, apply);
      });
      workspaces.push({ ...workspace, changes: result.changes });
    } catch (e) {
      workspaces.push({ ...workspace, error: errMessage(e) });
    }
  }
  return sendJson(res, 200, { principalId, applied: apply, workspaces });
}

export async function reactivateUser(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
  const { principalId, user: resolvedUser, member } = await resolveAdminUser(deps, params.principalId!);
  if (actor.role === "owner") {
    const governance = await targetGovernance(ctx, principalId, resolvedUser?.aliases ?? [], member);
    if (governance.isOrgAdmin)
      return sendJson(res, 403, { error: "forbidden", message: "only an org admin may reactivate an org admin" });
  }
  const user = await deps.admin!.users.markReactivated(principalId);
  await deps.identity.reactivate(principalId);
  audit(ctx, {
    principalId: actor.id,
    action: "principal.reactivate",
    resource: principalId,
    scopeLabel: orgScope(deps),
  });
  return sendJson(res, 200, { principalId, active: true, user });
}
