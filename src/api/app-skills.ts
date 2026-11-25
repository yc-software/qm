import type { ScopeId } from "../types.ts";
import { parseScopeId, scopeId } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import { foreignSkillCollision, type SkillManifest } from "../skills/skill-store.ts";
import type { SkillPack, SkillPackStore } from "../skills/skill-pack-store.ts";
import type { SkillPackFetcher } from "../skills/pack-fetcher.ts";
import { planIngest, importPack, collectSharedBundle, type ImportResult } from "../skills/ingest.ts";
import { computeBundleHash } from "../skills/skill-bundle-store.ts";
import { persistedSkillRecordPaths, SKILL_MATERIALIZATION_LOCK } from "../skills/skill-collision.ts";
import { authorPublishesSkill, sharedSkillRefused, type SkillEditor } from "./artifact-share.ts";
import { asOrgAdmin } from "../auth/capability-token.ts";
import type { Skill } from "../skills/skill-store.ts";

import type { App, AppDeps } from "./app-types.ts";
import { parseRef } from "../acl/resource-ref.ts";
import { entitledScopes, loadsScopeContext } from "../resolution/context-filter.ts";
import type { Principal } from "../types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import { ambientTenant } from "../tenants/context.ts";
import { errMessage, errText } from "../util/errors.ts";

export async function skillVisibilityContext(
  deps: AppDeps,
  h: AppHelpers,
  principalId: string,
  homes: readonly ScopeId[],
  ownScopeBotWork: boolean,
  onlyScope?: ScopeId | null,
) {
  const org = scopeId("org", orgIdOf());
  if (onlyScope !== undefined) {
    const room = onlyScope && (await h.principalCanAccessCurrentScope(principalId, onlyScope)) ? [onlyScope] : [];
    const ordered = [...new Set([...room, org])].filter((scope) =>
      loadsScopeContext(principalId, scope, ownScopeBotWork),
    );
    return { ordered, granted: [] };
  }
  const actor = deps.identity.classify(principalId);
  const sharedHomes = [
    ...new Set(
      homes.filter((sid) => {
        const k = parseScopeId(sid).kind;
        return k === "channel" || k === "group" || k === "persona";
      }),
    ),
  ];
  const accessibleScopes = new Set(await h.currentResourceScopesForViewer(principalId, ownScopeBotWork));
  const member = sharedHomes.map((sid) => (accessibleScopes.has(sid) ? sid : null));
  const shared = member.filter((sid): sid is ScopeId => sid !== null);
  const teams = (actor.teamIds ?? []).map((t) => scopeId("team", t));
  const ordered = [...new Set([scopeId("personal", principalId), ...shared, ...teams, org])].filter((scope) =>
    loadsScopeContext(principalId, scope, ownScopeBotWork),
  );
  const entitled = (p: Principal, sess: ScopeId, o: ScopeId) => [
    ...entitledScopes(ownScopeBotWork)(p, sess, o),
    ...accessibleScopes,
  ];
  const granted = (
    await deps.acl
      .sharedOfKindForAudience(ambientTenant(), "skill", [actor], scopeId("personal", principalId), org, entitled)
      .catch(() => [])
  ).map((g) => ({ id: parseRef(g.ref).id, ownerScopeId: g.ownerScopeId }));
  return { ordered, granted };
}

function requireRegistry(deps: AppDeps): { packs: SkillPackStore; fetcher: SkillPackFetcher } {
  if (!deps.skillPacks || !deps.skillFetcher) throw new Error("skill registry not configured");
  return { packs: deps.skillPacks, fetcher: deps.skillFetcher };
}

async function nativeNamesFor(deps: AppDeps, packId: string, scope: ScopeId): Promise<Set<string>> {
  const all = await deps.skills.list();
  return new Set(
    all
      .filter((s) => s.scopeId === scope && s.status !== "archived" && s.pack?.packId !== packId)
      .map((s) => s.manifest.name),
  );
}

async function importedPackSkills(
  deps: AppDeps,
  packId: string,
): Promise<Array<{ scopeId: ScopeId; upstreamName: string }>> {
  return (await deps.skills.list()).flatMap((s) =>
    s.status === "published" && s.pack?.packId === packId
      ? [{ scopeId: s.scopeId, upstreamName: s.pack.upstreamName }]
      : [],
  );
}

async function buildClaimedPaths(deps: AppDeps, exceptPackId: string, scopeId: ScopeId): Promise<Map<string, string>> {
  const claimed = new Map<string, string>();
  for (const s of await deps.skills.list()) {
    if (s.status !== "published" || s.pack?.packId === exceptPackId || s.scopeId !== scopeId) continue;
    for (const p of persistedSkillRecordPaths(s.manifest.name, s.manifest.files)) claimed.set(p, s.createdBy);
  }
  return claimed;
}

async function buildClaimedBundlePaths(deps: AppDeps): Promise<Map<string, string>> {
  const claimed = new Map<string, string>();
  for (const skill of await deps.skills.list()) {
    if (skill.status !== "published") continue;
    for (const path of persistedSkillRecordPaths(skill.manifest.name, skill.manifest.files)) {
      claimed.set(path, `skill "${skill.manifest.name}" in ${skill.scopeId}`);
    }
  }
  return claimed;
}

async function archiveRemoved(deps: AppDeps, packId: string, scopeId: ScopeId, kept: string[]): Promise<string[]> {
  const keptSet = new Set(kept);
  const archived: string[] = [];
  for (const s of await deps.skills.list()) {
    if (s.pack?.packId !== packId || s.scopeId !== scopeId || s.status === "archived") continue;
    const upstream = s.pack?.upstreamName;
    if (upstream && !keptSet.has(upstream)) {
      await deps.skills.archive(s.id);
      archived.push(s.manifest.name);
    }
  }
  return archived;
}

interface ReconcileTarget {
  scopeId: ScopeId;
  selected: "all" | string[];
}

function skillPackSourceIdentity(pack: SkillPack): string {
  return JSON.stringify([
    pack.url,
    pack.ref,
    pack.syncMode,
    pack.trustTier,
    pack.config ?? null,
    pack.targetScopeId,
    pack.subset,
    pack.authCredentialSlug ?? null,
    pack.lastImport ?? null,
  ]);
}

function withSkillMutationLock<T>(deps: AppDeps, fn: () => Promise<T>): Promise<T> {
  return deps.advisoryLock.withLock(SKILL_MATERIALIZATION_LOCK, fn);
}

async function reconcilePack(
  deps: AppDeps,
  packs: SkillPackStore,
  fetcher: SkillPackFetcher,
  id: string,
  targets: ReconcileTarget[],
): Promise<ImportResult> {
  const pack = await packs.get(id);
  if (!pack) throw new Error(`unknown skill pack: ${id}`);
  let repo: Awaited<ReturnType<SkillPackFetcher["fetch"]>>;
  try {
    repo = await fetcher.fetch(pack);
  } catch (e) {
    console.error("%s", `[skills] pack ${id} import failed:`, errMessage(e));
    await packs.recordImport(id, {
      at: Date.now(),
      commit: pack.ref,
      status: "error",
      error: errText(e),
    });
    throw e;
  }
  const applyFetched = async (): Promise<ImportResult> => {
    const current = await packs.get(id);
    if (!current) throw new Error(`unknown skill pack: ${id}`);
    if (skillPackSourceIdentity(current) !== skillPackSourceIdentity(pack)) {
      throw new Error(`skill pack changed while fetching: ${id}`);
    }
    try {
      const bundleFiles = collectSharedBundle(repo, pack.config);
      const canonPlan = planIngest(repo, {
        ...(pack.config ? { config: pack.config } : {}),
        nativeNames: await nativeNamesFor(deps, id, pack.targetScopeId),
      });
      const imported: string[] = [];
      const updated: string[] = [];
      const skipped: string[] = [];
      const archived: string[] = [];
      for (const target of targets) {
        const nativeNames = await nativeNamesFor(deps, id, target.scopeId);
        const claimedPaths = await buildClaimedPaths(deps, id, target.scopeId);
        const claimedBundlePaths = await buildClaimedBundlePaths(deps);
        const { kept, ...base } = await importPack(repo, deps.skills, {
          pack,
          selected: target.selected,
          targetScopeId: target.scopeId,
          nativeNames,
          claimedPaths,
          claimedBundlePaths,
          bundleFiles,
        });
        imported.push(...base.imported);
        updated.push(...base.updated);
        skipped.push(...base.skipped);
        archived.push(...(await archiveRemoved(deps, id, target.scopeId, kept)));
      }
      if (deps.skillBundles) {
        await deps.skillBundles.put({
          packId: id,
          commit: repo.commit,
          files: bundleFiles,
          hash: computeBundleHash(bundleFiles),
        });
      }
      const result: ImportResult = { imported, updated, skipped, archived, counts: canonPlan.counts };
      await packs.recordImport(id, {
        at: Date.now(),
        commit: repo.commit,
        status: "ok",
        counts: {
          ...canonPlan.counts,
          imported: imported.length,
          updated: updated.length,
          skipped: skipped.length,
          archived: archived.length,
        },
      });
      await packs.update(id, { updateAvailable: false, available: canonPlan.counts.eligible });
      return result;
    } catch (e) {
      console.error("%s", `[skills] pack ${id} import failed:`, errMessage(e));
      await packs.recordImport(id, {
        at: Date.now(),
        commit: pack.ref,
        status: "error",
        error: errText(e),
      });
      throw e;
    }
  };
  return withSkillMutationLock(deps, applyFetched);
}

export function createSkillMethods(
  deps: AppDeps,
  h: AppHelpers,
): Pick<
  App,
  | "listSkills"
  | "getSkill"
  | "archiveSkill"
  | "listVisibleSkills"
  | "canManageSkill"
  | "manageableSkills"
  | "updateOwnedSkill"
  | "restoreOwnedSkill"
  | "listSkillPacks"
  | "getSkillPack"
  | "registerSkillPack"
  | "updateSkillPack"
  | "skillPackCatalog"
  | "importSkillPack"
  | "syncSkillPack"
  | "removeSkillPack"
  | "createOwnedSkill"
  | "deleteOwnedSkill"
> {
  const { canManageSkill, manageableSkills, republishIfShared } = h;
  const managesSkillById = async (skill: Skill, principalId: string, opts?: SkillEditor) =>
    (await canManageSkill(skill, principalId, opts?.botActor === true)) ||
    asOrgAdmin(deps, {
      actorId: principalId,
      botActor: opts?.botActor,
      personAuthority: opts?.personAuthority,
      scopeId: skill.scopeId,
    });
  return {
    listSkills() {
      return deps.skills.list();
    },
    getSkill(id) {
      return deps.skills.get(id);
    },
    archiveSkill(id) {
      return deps.skills.archive(id);
    },
    async listVisibleSkills(principalId, ownScopeBotWork, onlyScope) {
      const { ordered, granted } = await skillVisibilityContext(
        deps,
        h,
        principalId,
        onlyScope !== undefined ? [] : (await deps.skills.list()).map((s) => s.scopeId),
        ownScopeBotWork,
        onlyScope,
      );
      return deps.skills.visibleFor(ordered, granted);
    },
    canManageSkill(skill, principalId, botWork) {
      return canManageSkill(skill, principalId, botWork);
    },
    manageableSkills,
    async updateOwnedSkill(id, principalId, patch, opts) {
      const skill = await deps.skills.get(id);
      if (!skill || !(await managesSkillById(skill, principalId, opts))) return null;
      if (sharedSkillRefused(skill.scopeId, opts)) return "authority_required";
      const live = await deps.skills.withNameLock(skill.scopeId, skill.manifest.name, async () => {
        const current = await deps.skills.get(id);
        if (!current || current.status === "archived") return null;
        const updated = await deps.skills.update(id, {
          ...current.manifest,
          description: patch.description ?? current.manifest.description,
          body: patch.body ?? current.manifest.body,
        });
        return republishIfShared(updated, principalId);
      });
      if (!live) return null;
      h.recordAudit({
        at: Date.now(),
        principalId,
        action: "skill_update",
        resource: id,
        scopeLabel: skill.scopeId,
      });
      return live;
    },
    async restoreOwnedSkill(id, principalId, opts) {
      const skill = await deps.skills.get(id);
      if (!skill || skill.status !== "archived" || !(await managesSkillById(skill, principalId, opts))) return null;
      if (sharedSkillRefused(skill.scopeId, opts)) return "authority_required";
      return deps.skills.withNameLock(skill.scopeId, skill.manifest.name, async () => {
        const current = await deps.skills.get(id);
        if (!current || current.status !== "archived") return null;
        if (foreignSkillCollision(await deps.skills.list(), current.scopeId, current.manifest.name, (s) => s.id === id))
          return "exists" as const;
        await deps.skills.review(id, principalId, current.manifest.requiredCapabilities);
        const restored = await deps.skills.publish(id);
        h.recordAudit({
          at: Date.now(),
          principalId,
          action: "skill_restore",
          resource: id,
          scopeLabel: current.scopeId,
        });
        return restored;
      });
    },
    listSkillPacks() {
      return deps.skillPacks ? deps.skillPacks.list() : Promise.resolve([]);
    },
    getSkillPack(id) {
      return deps.skillPacks ? deps.skillPacks.get(id) : Promise.resolve(null);
    },
    async registerSkillPack(input) {
      const { packs, fetcher } = requireRegistry(deps);
      const pack = await packs.create(input);
      try {
        const repo = await fetcher.fetch(pack);
        const nativeNames = await nativeNamesFor(deps, pack.id, pack.targetScopeId);
        const plan = planIngest(repo, { ...(pack.config ? { config: pack.config } : {}), nativeNames });
        return await packs.update(pack.id, { available: plan.counts.eligible });
      } catch (e) {
        console.error("%s", `[skills] pack ${pack.id} import failed:`, errMessage(e));
        await packs.recordImport(pack.id, {
          at: Date.now(),
          commit: pack.ref,
          status: "error",
          error: errText(e),
        });
        return (await packs.get(pack.id)) ?? pack;
      }
    },
    async updateSkillPack(id, patch) {
      const { packs } = requireRegistry(deps);
      return withSkillMutationLock(deps, () => packs.update(id, patch));
    },
    async skillPackCatalog(id) {
      const { packs, fetcher } = requireRegistry(deps);
      const pack = await packs.get(id);
      if (!pack) throw new Error(`unknown skill pack: ${id}`);
      const repo = await fetcher.fetch(pack);
      const nativeNames = await nativeNamesFor(deps, id, pack.targetScopeId);
      const plan = planIngest(repo, { ...(pack.config ? { config: pack.config } : {}), nativeNames });
      const bundlePaths = collectSharedBundle(repo, pack.config).map((file) => file.path);
      const importedScopesByUpstream = new Map<string, ScopeId[]>();
      for (const { scopeId, upstreamName } of await importedPackSkills(deps, id)) {
        const arr = importedScopesByUpstream.get(upstreamName) ?? [];
        arr.push(scopeId);
        importedScopesByUpstream.set(upstreamName, arr);
      }
      return {
        ...plan,
        bundlePaths,
        candidates: plan.candidates.map((c) => ({
          ...c,
          importedScopes: importedScopesByUpstream.get(c.upstreamName) ?? [],
        })),
      };
    },
    async importSkillPack(id, selected, scopeIds) {
      const { packs, fetcher } = requireRegistry(deps);
      const pack = await packs.get(id);
      if (!pack) throw new Error(`unknown skill pack: ${id}`);
      const scopes = scopeIds && scopeIds.length ? scopeIds : [pack.targetScopeId];
      return reconcilePack(
        deps,
        packs,
        fetcher,
        id,
        scopes.map((scopeId) => ({ scopeId, selected })),
      );
    },
    async syncSkillPack(id) {
      const { packs, fetcher } = requireRegistry(deps);
      const pack = await packs.get(id);
      if (!pack) throw new Error(`unknown skill pack: ${id}`);
      const importedByScope = new Map<ScopeId, string[]>();
      for (const { scopeId, upstreamName } of await importedPackSkills(deps, id)) {
        const arr = importedByScope.get(scopeId) ?? [];
        arr.push(upstreamName);
        importedByScope.set(scopeId, arr);
      }
      const targets = [...importedByScope].map(([scopeId, selected]) => ({ scopeId, selected }));
      if (!targets.length) targets.push({ scopeId: pack.targetScopeId, selected: [] });
      return reconcilePack(deps, packs, fetcher, id, targets);
    },
    async removeSkillPack(id) {
      const { packs } = requireRegistry(deps);
      return withSkillMutationLock(deps, async () => {
        const mine = (await deps.skills.list()).filter((s) => s.pack?.packId === id);
        for (const s of mine) await deps.skills.delete(s.id);
        await deps.skillBundles?.delete(id);
        await packs.remove(id);
        return { removed: mine.length };
      });
    },
    async createOwnedSkill(input) {
      const name = input.name.trim();
      const description = input.description.trim();
      const body = input.body.trim();
      if (!name || !description || !body) throw new Error("skill requires a non-empty name, description, and body");
      const homeScope = input.homeScope ?? scopeId("personal", input.principalId);
      if (!authorPublishesSkill(homeScope)) {
        throw new Error(
          "a skill cannot be created directly in an org or team scope — promote a published skill instead",
        );
      }
      return deps.skills.withNameLock(homeScope, name, async () => {
        const sameName = (await deps.skills.list()).filter((s) => s.scopeId === homeScope && s.manifest.name === name);
        if (sameName.some((s) => s.status !== "archived")) return null;
        for (const s of sameName) await deps.skills.delete(s.id);
        const manifest: SkillManifest = {
          name,
          description,
          requiredCapabilities: input.requiredCapabilities ?? [],
          body,
        };
        const skill = await deps.skills.create({ scopeId: homeScope, manifest, createdBy: input.principalId });
        await deps.skills.review(skill.id, "system:skill-authoring", manifest.requiredCapabilities);
        const published = await deps.skills.publish(skill.id);
        h.recordAudit({
          at: Date.now(),
          principalId: input.principalId,
          action: "skill_create",
          resource: skill.id,
          scopeLabel: homeScope,
        });
        return published;
      });
    },
    async deleteOwnedSkill({ principalId, id, ...editor }) {
      const skill = await deps.skills.get(id);
      if (!skill) return "missing";
      if (!(await managesSkillById(skill, principalId, editor))) return "forbidden";
      if (sharedSkillRefused(skill.scopeId, editor)) return "authority_required";
      await deps.skills.archive(id);
      h.recordAudit({
        at: Date.now(),
        principalId,
        action: "skill_archive",
        resource: id,
        scopeLabel: skill.scopeId,
      });
      return "deleted";
    },
  };
}
