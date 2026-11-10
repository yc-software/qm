import { samePerson, samePersonMatcher } from "../../../directory/person.ts";
import { parseScopeId, scopeId as makeScopeId, type ScopeId } from "../../../types.ts";
import { errMessage } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
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

const signInStep = ({ identity }: ApiCtx["deps"], principalId: string): Step[] =>
  identity && identity.deactivationSource(principalId) !== "manual"
    ? [
        {
          kind: "principal",
          id: principalId,
          label: "sign-in",
          action: "deactivate",
          run: () => identity.deactivate(principalId),
        },
      ]
    : [];

async function plan(ctx: ApiCtx, actorId: string, principalId: string): Promise<Step[]> {
  const { app, deps } = ctx;
  const isThem = deps.directory
    ? await samePersonMatcher(deps.directory, principalId)
    : async (id: string) => samePerson(id, principalId);
  const personal = async (scope: ScopeId) => {
    const { kind, ref } = parseScopeId(scope);
    return kind === "personal" && (await isThem(ref));
  };
  const owns = async (owner: string, scope: ScopeId) => (await isThem(owner)) || (await personal(scope));
  const steps: Step[] = [];
  const step = (kind: string, id: string, label: string | undefined, action: string, run: () => Promise<unknown>) =>
    steps.push({ kind, id, label: label || id, action, run });

  for (const c of await app.listCrons())
    if (!c.loopId && !c.archived && (await owns(c.owner, c.ownerScopeId)))
      step("cron", c.id, c.title ?? "", "disable_and_archive", () =>
        app.updateCron(c.id, { enabled: false, archived: true }),
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
  for (const d of await app.listDeployments())
    if (d.status !== "archived" && (await personal(d.ownerScopeId)))
      step("app", d.id, d.displayName || d.name, "archive", () => app.archiveDeployment(d.id));
  for (const s of await app.listSkills())
    if (s.status !== "archived" && (await personal(s.scopeId)))
      step("skill", s.id, s.manifest.name, "archive", () => app.archiveSkill(s.id));
  const computers = deps.sandboxResources;
  const home = makeScopeId("personal", principalId);
  for (const c of (await computers?.list(actorId, home))?.sandboxes ?? [])
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
  const { principalId } = await resolveAdminUser(deps, params.principalId!);
  if (samePerson(principalId, actor.id))
    return sendJson(res, 400, { error: "bad_request", message: "you cannot offboard yourself" });
  const signIn = signInStep(deps, principalId);
  const steps = await plan(ctx, actor.id, principalId);
  if (input.apply !== true)
    return sendJson(res, 200, {
      principalId,
      applied: false,
      changes: [...signIn, ...steps].map(({ run: _, ...change }) => change),
    });
  const changes: Change[] = [];
  const execute = async ({ run, ...change }: Step): Promise<Change> => {
    try {
      await run();
      change.result = "done";
    } catch (e) {
      Object.assign(change, { result: "failed", error: errMessage(e) });
    }
    audit(deps, {
      principalId: actor.id,
      action: `user.offboard.${change.kind}.${change.action}`,
      resource: change.id,
      scopeLabel: orgScope(deps),
      status: change.result,
      detail: [principalId, change.error].filter(Boolean).join(": "),
    });
    changes.push(change);
    return change;
  };
  for (const step of signIn)
    if ((await execute(step)).result === "failed")
      return sendJson(res, 502, { error: "deactivate_failed", principalId, applied: false, changes });
  const user = await deps.admin!.users.markOffboarded(principalId, actor.id);
  for (const step of steps) await execute(step);
  return sendJson(res, 200, { principalId, applied: true, changes, user });
}

export async function reactivatePerson(deps: ApiCtx["deps"], principalId: string) {
  await deps.identity!.reactivate(principalId);
  return deps.admin?.users.markReactivated(principalId);
}

export async function reactivateUser(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
  const { principalId } = await resolveAdminUser(deps, params.principalId!);
  const user = await reactivatePerson(deps, principalId);
  audit(deps, {
    principalId: actor.id,
    action: "principal.reactivate",
    resource: principalId,
    scopeLabel: orgScope(deps),
  });
  return sendJson(res, 200, { principalId, active: true, user });
}
