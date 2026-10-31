import { adminStatusFromGrants } from "../../../admin/admin-service.ts";
import { samePerson, samePersonMatcher } from "../../../directory/person.ts";
import { parseScopeId, scopeId as makeScopeId, type ScopeId } from "../../../types.ts";
import { errMessage } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import { resolveAdminUser } from "./users.ts";
import { grantLive } from "../../../credentials/keychain.ts";
import type { OffboardedChange, PrincipalRecord, PrincipalSummary } from "../../../identity/identity-service.ts";
import { followLoopState } from "../loops.ts";

type Kind = "principal" | "cron" | "loop" | "webhook" | "keychain" | "deployment" | "skill" | "sandbox";

interface Change {
  kind: Kind;
  id: string;
  label: string;
  scopeId: string;
  action: string;
  result?: "done" | "failed";
  error?: string;
}

interface Kept {
  kind: Kind | "credential" | "admin_grant";
  id: string;
  label: string;
  scopeId: string;
  reason: string;
}

type Step = Change & { run: () => Promise<unknown> };

async function present(found: Promise<unknown>, what: string): Promise<void> {
  if (!(await found)) throw new Error(`${what} no longer exists`);
}

const firstLine = (text: string | undefined): string => text?.trim().split("\n", 1)[0] ?? "";

const SHARED_HOME = "lives in a shared scope where others may rely on it; archive it there if nobody needs it";

async function planOffboarding(ctx: ApiCtx, actorId: string, principalId: string, member: boolean) {
  const { app, deps } = ctx;
  const isThem = deps.directory
    ? await samePersonMatcher(deps.directory, principalId)
    : async (id: string) => samePerson(id, principalId);
  const theirScopes = new Map<string, Promise<boolean>>();
  const ownScope = (scope: ScopeId): Promise<boolean> => {
    let known = theirScopes.get(scope);
    if (!known) {
      const { kind, ref } = parseScopeId(scope);
      known = kind === "personal" ? isThem(ref) : Promise.resolve(false);
      theirScopes.set(scope, known);
    }
    return known;
  };
  const owns = async (owner: string, scope: ScopeId) => (await isThem(owner)) || (await ownScope(scope));
  const steps: Step[] = [];
  const kept: Kept[] = [];
  const org = orgScope(deps);

  await deps.identity?.refresh(true);
  for (const cron of await app.listCrons()) {
    if (cron.loopId || (cron.archived && !cron.enabled) || !(await owns(cron.owner, cron.ownerScopeId))) continue;
    steps.push({
      kind: "cron",
      id: cron.id,
      label: cron.title || firstLine(cron.action ?? cron.message) || cron.id,
      scopeId: cron.ownerScopeId,
      action: "disable_and_archive",
      run: () => present(app.updateCron(cron.id, { enabled: false, archived: true }), "the cron"),
    });
  }
  const loops = deps.loops;
  for (const loop of (await loops?.store.list()) ?? []) {
    if (loop.state !== "enabled" || !(await owns(loop.owner, loop.ownerScopeId))) continue;
    steps.push({
      kind: "loop",
      id: loop.id,
      label: loop.name,
      scopeId: loop.ownerScopeId,
      action: "pause",
      run: async () => {
        await present(loops!.store.setState(loop.id, "paused"), "the loop");
        await followLoopState(loops!, loop, "paused");
      },
    });
  }
  for (const webhook of await app.listWebhooks()) {
    if (!webhook.enabled || !(await owns(webhook.owner, webhook.ownerScopeId))) continue;
    steps.push({
      kind: "webhook",
      id: webhook.id,
      label: firstLine(webhook.action) || webhook.id,
      scopeId: webhook.ownerScopeId,
      action: "disable",
      run: () => present(app.setWebhookEnabled(webhook.id, false), "the webhook"),
    });
  }
  if (deps.keychain) {
    const keychain = deps.keychain;
    const [credentials, grants] = await Promise.all([
      keychain.listByOwner(principalId),
      keychain.listGrants({ ownerId: principalId }),
    ]);
    const service = new Map(credentials.map((c) => [c.id, c.service]));
    for (const grant of grants) {
      if (!grantLive(grant, Date.now())) continue;
      steps.push({
        kind: "keychain",
        id: grant.id,
        label: `${service.get(grant.credentialId) ?? grant.credentialId}: ${grant.purpose}`,
        scopeId: grant.audienceScopeId,
        action: "revoke",
        run: () => present(keychain.revokeGrant(grant.ownerId, grant.id), "the grant"),
      });
    }
    for (const credential of credentials)
      kept.push({
        kind: "credential",
        id: credential.id,
        label: credential.service,
        scopeId: makeScopeId("personal", principalId),
        reason:
          "stays encrypted in their keychain; their grants are revoked and their crons, loops and webhooks stopped",
      });
  }
  for (const deployment of await app.listDeployments()) {
    if (deployment.status === "archived") continue;
    const label = deployment.displayName || deployment.name || deployment.id;
    if (await ownScope(deployment.ownerScopeId))
      steps.push({
        kind: "deployment",
        id: deployment.id,
        label,
        scopeId: deployment.ownerScopeId,
        action: "archive",
        run: () => app.archiveDeployment(deployment.id),
      });
    else if (await isThem(deployment.createdBy))
      kept.push({
        kind: "deployment",
        id: deployment.id,
        label,
        scopeId: deployment.ownerScopeId,
        reason: SHARED_HOME,
      });
  }
  for (const skill of await app.listSkills()) {
    if (skill.status === "archived") continue;
    if (await ownScope(skill.scopeId))
      steps.push({
        kind: "skill",
        id: skill.id,
        label: skill.manifest.name,
        scopeId: skill.scopeId,
        action: "archive",
        run: () => app.archiveSkill(skill.id),
      });
    else if (await isThem(skill.createdBy))
      kept.push({
        kind: "skill",
        id: skill.id,
        label: skill.manifest.name,
        scopeId: skill.scopeId,
        reason: SHARED_HOME,
      });
  }
  const resources = deps.sandboxResources;
  if (resources) {
    const listing = await resources.list(actorId, makeScopeId("personal", principalId));
    for (const computer of listing.sandboxes) {
      if (!(await ownScope(computer.ownerScopeId))) {
        if (computer.state !== "retired" && (await isThem(computer.createdBy)))
          kept.push({
            kind: "sandbox",
            id: computer.id,
            label: computer.name,
            scopeId: computer.ownerScopeId,
            reason: SHARED_HOME,
          });
        continue;
      }
      const retirable = computer.availableActions?.includes("retire") ?? false;
      if (computer.state === "retired" && !retirable) continue;
      if (!retirable) {
        kept.push({
          kind: "sandbox",
          id: computer.id,
          label: computer.name,
          scopeId: computer.ownerScopeId,
          reason: `the ${computer.backend} provider cannot retire computers`,
        });
        continue;
      }
      steps.push({
        kind: "sandbox",
        id: computer.id,
        label: `${computer.name} (${computer.backend})`,
        scopeId: computer.ownerScopeId,
        action: "retire",
        run: async () => {
          const selected = await resources.resolve(computer.ownerScopeId);
          if (selected?.id === computer.id) await resources.setDefault(actorId, computer.ownerScopeId, null);
          await resources.retire(actorId, computer.id);
        },
      });
    }
  }
  if (adminStatusFromGrants((await deps.admin?.listGrants()) ?? [], principalId).isAdmin)
    kept.push({
      kind: "admin_grant",
      id: principalId,
      label: "org admin",
      scopeId: org,
      reason: "admin grants are portal-only; revoke it under Admins",
    });
  if (!member && !deps.identity?.knows(principalId) && steps.length === 0 && kept.length === 0) return null;
  if (deps.identity && deps.identity.deactivationSource(principalId) !== "manual")
    steps.unshift({
      kind: "principal",
      id: principalId,
      label: "sign-in and app access",
      scopeId: org,
      action: "deactivate",
      run: () => deps.identity!.deactivate(principalId),
    });
  return { steps, kept };
}

const summary = (record: PrincipalRecord | null): PrincipalSummary | null => {
  if (!record) return null;
  const { offboardChanges: _changes, ...rest } = record;
  return rest;
};

export async function offboardUser(ctx: ApiCtx): Promise<void> {
  const { res, deps, params, body } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const input = body === undefined || body === null ? {} : body;
  if (
    !isObj(input) ||
    Object.keys(input).some((k) => k !== "apply") ||
    !["boolean", "undefined"].includes(typeof input.apply)
  )
    return sendJson(res, 400, { error: "bad_request", message: "body is { apply?: boolean }; omit apply to preview" });
  const { member, principalId } = await resolveAdminUser(deps, params.principalId!);
  if (!principalId) return sendJson(res, 404, { error: "not_found", message: "no such person" });
  if (samePerson(principalId, actor.id))
    return sendJson(res, 400, { error: "bad_request", message: "you cannot offboard yourself" });
  const plan = await planOffboarding(ctx, actor.id, principalId, !!member);
  if (!plan) return sendJson(res, 404, { error: "not_found", message: `nothing is known about ${principalId}` });
  const { steps, kept } = plan;
  const org = orgScope(deps);
  const view = ({ run: _run, ...change }: Step): Change => change;
  if (input.apply !== true) {
    audit(deps, { principalId: actor.id, action: "user.offboard.preview", resource: principalId, scopeLabel: org });
    return sendJson(res, 200, { principalId, applied: false, changes: steps.map(view), kept });
  }
  const changes: OffboardedChange[] = [];
  let principal: PrincipalRecord | null = null;
  for (const step of steps) {
    const change = view(step);
    try {
      await step.run();
      changes.push({ ...change, result: "done" });
    } catch (error) {
      changes.push({ ...change, result: "failed", error: errMessage(error) });
    }
    const recorded = changes.at(-1)!;
    audit(deps, {
      principalId: actor.id,
      action: `${step.kind}.${step.action}`,
      resource: step.id,
      scopeLabel: step.scopeId,
      status: recorded.result === "done" ? "ok" : "error",
      ...(recorded.error ? { detail: recorded.error } : {}),
    });
    if (deps.identity?.deactivationSource(principalId) === "manual")
      principal = await deps.identity.recordOffboarded(principalId, actor.id, [recorded]);
  }
  if (!principal && deps.identity?.deactivationSource(principalId) === "manual")
    principal = await deps.identity.recordOffboarded(principalId, actor.id, []);
  const failed = changes.filter((c) => c.result === "failed").length;
  audit(deps, {
    principalId: actor.id,
    action: "user.offboard",
    resource: `${principalId}/done=${changes.length - failed}/failed=${failed}`,
    scopeLabel: org,
  });
  return sendJson(res, 200, { principalId, applied: true, changes, kept, principal: summary(principal) });
}

export async function reactivateUser(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
  const { principalId } = await resolveAdminUser(deps, params.principalId!);
  await deps.identity.reactivate(principalId, actor.id);
  audit(deps, {
    principalId: actor.id,
    action: "principal.reactivate",
    resource: principalId,
    scopeLabel: orgScope(deps),
  });
  return sendJson(res, 200, {
    ok: true,
    principalId,
    active: true,
    principal: summary(await deps.identity.principal(principalId)),
  });
}
