import { parseScopeId, type Destination } from "../../../types.ts";
import { publicUrlOf } from "../../../deploy/deploy-store.ts";
import { sendJson } from "../../http.ts";
import { audit, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import { notifyOwnerOfCronEdit } from "../../../triggers/edit-notice.ts";
import { requireScopedResource } from "./common.ts";

function isAdminCronDestination(v: unknown): v is Destination {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  const keys = Object.keys(d);
  if (d.type !== "principal" && d.type !== "slack") return false;
  if (typeof d.target !== "string" || d.target.trim() === "") return false;
  if (d.audienceScopeId !== undefined && typeof d.audienceScopeId !== "string") return false;
  if (d.onBehalfOf !== undefined && typeof d.onBehalfOf !== "string") return false;
  return keys.every((k) => k === "type" || k === "target" || k === "audienceScopeId" || k === "onBehalfOf");
}

export async function listAdminArtifacts(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, pathname } = ctx;
  const resource = pathname.slice("/v1/admin/".length);
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: `${resource}.read`, resource, scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";
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
        enabled: c.enabled,
        archived: c.archived,
        schedule: c.schedule,
        destination: c.destination,
        createdAt: c.createdAt,
        lastFiredAt: c.lastFiredAt,
      }));
    return sendJson(res, 200, { scopeId: scope, crons });
  }
  if (resource === "deployments") {
    const deployments = (await app.listDeployments())
      .filter((d) => orgWide || d.ownerScopeId === scope)
      .map((d) => ({
        id: d.id,
        ownerScopeId: d.ownerScopeId,
        name: d.displayName || d.name,
        status: d.status,
        currentVersion: d.currentVersion,
        versions: d.versions.length,
        createdBy: d.createdBy,
        createdAt: d.versions[0]?.createdAt,
        lastAccessAt: d.lastAccessAt,
        publicUrl: publicUrlOf(d.endpoint),
      }));
    return sendJson(res, 200, { scopeId: scope, deployments });
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

export async function putAdminCronDestination(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, params, body } = ctx;
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
  const destination = (body as { destination: unknown }).destination;
  if (destination !== null && !isAdminCronDestination(destination)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "destination must be a principal or slack destination with a target",
    });
  }
  const next = destination === null ? undefined : destination;
  const updated = await app.setCronDestination(id, next);
  await notifyOwnerOfCronEdit(app, {
    cron,
    editorId: actor.id,
    changeSummary: ["destination"],
    editFingerprint: `destination:${next?.target ?? "cleared"}`,
  });
  audit(deps, {
    principalId: actor.id,
    action: "cron.destination.update",
    resource: id,
    scopeLabel: cron.ownerScopeId,
  });
  return sendJson(res, 200, { cron: updated });
}

export async function getAdminSkill(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, params } = ctx;
  const id = params.id!;
  const scoped = await requireScopedResource(
    ctx,
    () => app.getSkill(id),
    (s) => s.scopeId,
    "skill",
  );
  if (!scoped) return;
  const { actor, record: skill } = scoped;
  const provenance = skill.pack;
  const provenancePack = provenance ? ((await app.getSkillPack(provenance.packId)) ?? undefined) : undefined;
  audit(deps, { principalId: actor.id, action: "skill.read", resource: id, scopeLabel: skill.scopeId });
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
  const { res, app, deps, params } = ctx;
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
  audit(deps, { principalId: actor.id, action: "skill.archive", resource: id, scopeLabel: skill.scopeId });
  return sendJson(res, 200, { ok: true });
}
