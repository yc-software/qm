import { isDeepStrictEqual } from "node:util";
import { isCronRuntime } from "../../../cron/runtime.ts";
import { errMessage } from "../../../util/errors.ts";
import { parseScopeId, scopeId, type Destination } from "../../../types.ts";
import { appUrlOf } from "../../../deploy/deploy-store.ts";
import { sendJson } from "../../http.ts";
import { audit, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import { notifyOwnerOfCronEdit } from "../../../triggers/edit-notice.ts";
import { personNamer, requireScopedResource } from "./common.ts";

function adminCronDestination(v: unknown, current: Destination | undefined): Destination | null {
  if (typeof v !== "object" || v === null) return null;
  const d = v as Record<string, unknown>;
  if (d.type !== "principal" && d.type !== "slack") return null;
  if (typeof d.target !== "string" || d.target.trim() === "") return null;
  if (d.onBehalfOf !== undefined && typeof d.onBehalfOf !== "string") return null;
  if (!Object.keys(d).every((k) => k === "type" || k === "target" || k === "onBehalfOf")) return null;
  const channel = d.target.split(":")[0]!;
  const sameChannel =
    d.type === "slack" &&
    (current?.type === "slack" || current?.type === "group") &&
    current.target.split(":")[0] === channel;
  const derived = d.type === "principal" ? scopeId("personal", d.target) : scopeId("channel", channel);
  const audienceScopeId = sameChannel ? current?.audienceScopeId : derived;
  return {
    type: d.type,
    target: d.target,
    ...(audienceScopeId ? { audienceScopeId } : {}),
    ...(d.onBehalfOf !== undefined ? { onBehalfOf: d.onBehalfOf } : {}),
  };
}

export async function listAdminArtifacts(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, pathname } = ctx;
  const resource = pathname.slice("/v1/admin/".length);
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(ctx, { principalId: actor.id, action: `${resource}.read`, resource, scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";
  const nameOf = resource === "skills" ? undefined : await personNamer(app, deps);
  const named = (principalId: string | undefined) => {
    const name = principalId ? nameOf?.(principalId) : undefined;
    return name && name !== principalId ? name : undefined;
  };
  if (resource === "crons") {
    const crons = (await app.listCrons())
      .filter((c) => orgWide || c.ownerScopeId === scope)
      .map((c) => ({
        id: c.id,
        ownerScopeId: c.ownerScopeId,
        title: c.title,
        action: c.action,
        message: c.message,
        owner: c.owner,
        createdBy: c.createdBy,
        createdByName: named(c.createdBy),
        enabled: c.enabled,
        archived: c.archived,
        schedule: c.schedule,
        runtime: c.runtime,
        loopId: c.loopId,
        destination: c.destination,
        createdAt: c.createdAt,
        lastFiredAt: c.lastFiredAt,
      }));
    return sendJson(res, 200, { scopeId: scope, crons });
  }
  if (resource === "apps") {
    const publishedApps = (await app.listApps())
      .filter((d) => orgWide || d.ownerScopeId === scope)
      .map((d) => ({
        id: d.id,
        ownerScopeId: d.ownerScopeId,
        name: d.displayName || d.name,
        status: d.status,
        currentVersion: d.currentVersion,
        versions: d.versions.length,
        createdBy: d.createdBy,
        createdByName: named(d.createdBy),
        createdAt: d.versions[0]?.createdAt,
        lastAccessAt: d.lastAccessAt,
        publicUrl: appUrlOf(d, { sharedWebUrl: deps.portalUrl, appsDomain: deps.deployAppsDomain }),
      }));
    return sendJson(res, 200, { scopeId: scope, deployments: publishedApps });
  }
  const packsById = new Map((await app.listSkillPacks()).map((p) => [p.id, p]));
  const skills = (await app.listSkills())
    .filter((s) => orgWide || s.scopeId === scope)
    .map((s) => {
      const provenancePack = s.pack ? packsById.get(s.pack.packId) : undefined;
      return {
        id: s.id,
        ownerScopeId: s.scopeId,
        name: s.manifest.name,
        description: s.manifest.description,
        status: s.status,
        version: s.version,
        createdBy: s.createdBy,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastUsedAt: s.lastUsedAt,
        ...(provenancePack ? { pack: { id: provenancePack.id, url: provenancePack.url } } : {}),
      };
    });
  return sendJson(res, 200, { scopeId: scope, skills });
}

export async function putAdminCronRuntime(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = params.id!;
  const scoped = await requireScopedResource(
    ctx,
    () => app.getCron(id),
    (cron) => cron.ownerScopeId,
    "cron",
  );
  if (!scoped) return;
  if (
    typeof body !== "object" ||
    body === null ||
    !("runtime" in body) ||
    Object.keys(body).some((key) => key !== "runtime") ||
    body.runtime === undefined ||
    !isCronRuntime(body.runtime)
  )
    return sendJson(res, 400, { error: "bad_request", message: "runtime is required; use null to inherit" });
  try {
    const updated = await app.setCronRuntime(id, body.runtime);
    audit(ctx, {
      principalId: scoped.actor.id,
      action: "cron.runtime.update",
      resource: id,
      scopeLabel: scoped.record.ownerScopeId,
    });
    return sendJson(res, 200, { cron: updated ? { id: updated.id, runtime: updated.runtime } : null });
  } catch (error) {
    return sendJson(res, 400, { error: "bad_request", message: errMessage(error) });
  }
}

export async function putAdminCronDestination(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const id = params.id!;
  const scoped = await requireScopedResource(
    ctx,
    () => app.getCron(id),
    (c) => c.ownerScopeId,
    "cron",
  );
  if (!scoped) return;
  const { actor, record: cron } = scoped;
  if (typeof body !== "object" || body === null || !("destination" in body)) {
    return sendJson(res, 400, { error: "bad_request", message: "destination is required; use null to clear" });
  }
  const requested = (body as { destination: unknown }).destination;
  const next = requested === null ? undefined : adminCronDestination(requested, cron.destination);
  if (next === null) {
    return sendJson(res, 400, {
      error: "bad_request",
      message:
        "destination must be a principal or slack destination with a target and an optional onBehalfOf; its audience follows the target",
    });
  }
  if (isDeepStrictEqual(cron.destination, next))
    return sendJson(res, 200, { cron: { id: cron.id, destination: cron.destination } });
  const updated = await app.setCronDestination(id, next, { actorId: actor.id });
  await notifyOwnerOfCronEdit(app, {
    cron,
    editorId: actor.id,
    changeSummary: ["destination"],
  });
  audit(ctx, {
    principalId: actor.id,
    action: "cron.destination.update",
    resource: id,
    scopeLabel: cron.ownerScopeId,
  });
  return sendJson(res, 200, { cron: updated ? { id: updated.id, destination: updated.destination } : null });
}

export async function getAdminSkill(ctx: ApiCtx): Promise<void> {
  const { res, app, params } = ctx;
  const id = params.id!;
  const scoped = await requireScopedResource(
    ctx,
    () => app.getSkill(id),
    (s) => s.scopeId,
    "skill",
    "fallback",
  );
  if (!scoped) return;
  const { actor, record: skill } = scoped;
  const provenance = skill.pack;
  const provenancePack = provenance ? ((await app.getSkillPack(provenance.packId)) ?? undefined) : undefined;
  audit(ctx, { principalId: actor.id, action: "skill.read", resource: id, scopeLabel: skill.scopeId });
  return sendJson(res, 200, {
    id: skill.id,
    ownerScopeId: skill.scopeId,
    name: skill.manifest.name,
    description: skill.manifest.description,
    body: skill.manifest.body,
    files: (skill.manifest.files ?? []).map((f) => ({ path: f.path, executable: f.executable === true })),
    requiredCapabilities: skill.manifest.requiredCapabilities,
    grantedCapabilities: skill.grantedCapabilities,
    approvals: skill.approvals,
    status: skill.status,
    version: skill.version,
    createdBy: skill.createdBy,
    ...(provenancePack ? { pack: { id: provenancePack.id, url: provenancePack.url } } : {}),
  });
}

export async function archiveAdminSkill(ctx: ApiCtx): Promise<void> {
  const { res, app, params } = ctx;
  const id = params.id!;
  const scoped = await requireScopedResource(
    ctx,
    () => app.getSkill(id),
    (s) => s.scopeId,
    "skill",
  );
  if (!scoped) return;
  const { actor, record: skill } = scoped;
  await app.archiveSkill(id);
  audit(ctx, { principalId: actor.id, action: "skill.archive", resource: id, scopeLabel: skill.scopeId });
  return sendJson(res, 200, { ok: true });
}
