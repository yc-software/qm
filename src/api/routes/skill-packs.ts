import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { audit, authorizeAdmin, orgScope } from "./shared.ts";
import type { NewSkillPack, SkillPack } from "../../skills/skill-pack-store.ts";
import type { PackConfig } from "../../skills/normalize.ts";
import { parseScopeId, type ScopeId } from "../../types.ts";

function asSubset(v: unknown): "all" | string[] | undefined {
  if (v === "all" || v === undefined) return "all";
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}

function asScopeIds(v: unknown): ScopeId[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: ScopeId[] = [];
  for (const x of v) {
    if (typeof x !== "string") return undefined;
    const { kind, ref } = parseScopeId(x);
    if (!kind || !ref) return undefined;
    out.push(x);
  }
  return [...new Set(out)];
}

function asConfig(v: unknown): PackConfig | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const cfg: PackConfig = {};
  if (Array.isArray(o.skillGlobs)) cfg.skillGlobs = o.skillGlobs.filter((x): x is string => typeof x === "string");
  if (Array.isArray(o.exclude)) cfg.exclude = o.exclude.filter((x): x is string => typeof x === "string");
  if (o.fieldOverrides && typeof o.fieldOverrides === "object")
    cfg.fieldOverrides = o.fieldOverrides as Record<string, string>;
  return cfg;
}

async function listPacks(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  const packs = await ctx.app.listSkillPacks();
  const importedByPack = new Map<string, Set<string>>();
  for (const sk of await ctx.app.listSkills()) {
    if (sk.status === "published" && sk.pack) {
      const set = importedByPack.get(sk.pack.packId) ?? new Set<string>();
      set.add(sk.pack.upstreamName);
      importedByPack.set(sk.pack.packId, set);
    }
  }
  const decorated = packs.map((p) => ({ ...p, importedCount: importedByPack.get(p.id)?.size ?? 0 }));
  audit(ctx.deps, {
    principalId: actor.id,
    action: "skill_packs.read",
    resource: "skill_packs",
    scopeLabel: orgScope(ctx.deps),
  });
  sendJson(ctx.res, 200, { packs: decorated });
}

async function registerPack(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  const b = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof b.url !== "string" || !b.url.trim()) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "url is required" });
  }
  const subset = asSubset(b.subset);
  if (subset === undefined)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "subset must be 'all' or string[]" });
  const input: NewSkillPack = {
    kind: "git",
    url: b.url.trim(),
    ref: typeof b.ref === "string" ? b.ref.trim() : "",

    syncMode: "pinned",
    trustTier: b.trustTier === "internal" ? "internal" : "third-party",
    targetScopeId: orgScope(ctx.deps),
    subset,
    createdBy: actor.id,
    ...(asConfig(b.config) ? { config: asConfig(b.config) } : {}),
    ...(typeof b.authCredentialSlug === "string" && b.authCredentialSlug
      ? { authCredentialSlug: b.authCredentialSlug }
      : {}),
  };
  const pack = await ctx.app.registerSkillPack(input);
  audit(ctx.deps, {
    principalId: actor.id,
    action: "skill_pack.register",
    resource: pack.id,
    scopeLabel: pack.targetScopeId,
  });
  sendJson(ctx.res, 200, { pack });
}

async function packCatalog(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  const plan = await ctx.app.skillPackCatalog(ctx.params.id!);
  audit(ctx.deps, {
    principalId: actor.id,
    action: "skill_pack.catalog",
    resource: ctx.params.id!,
    scopeLabel: orgScope(ctx.deps),
  });
  sendJson(ctx.res, 200, plan);
}

async function importPack(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  const body = (ctx.body as Record<string, unknown> | null) ?? {};
  const subset = asSubset(body.selected);
  if (subset === undefined)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "selected must be 'all' or string[]" });
  const scopeIds = asScopeIds(body.scopeIds);
  if (scopeIds === undefined)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "scopeIds must be an array of 'kind:ref' scope ids",
    });
  const result = await ctx.app.importSkillPack(ctx.params.id!, subset, scopeIds);
  audit(ctx.deps, {
    principalId: actor.id,
    action: "skill_pack.import",
    resource: ctx.params.id!,
    scopeLabel: scopeIds.length ? scopeIds.join(",") : orgScope(ctx.deps),
  });
  sendJson(ctx.res, 200, result);
}

async function syncPack(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  const result = await ctx.app.syncSkillPack(ctx.params.id!);
  audit(ctx.deps, {
    principalId: actor.id,
    action: "skill_pack.sync",
    resource: ctx.params.id!,
    scopeLabel: orgScope(ctx.deps),
  });
  sendJson(ctx.res, 200, result);
}

async function patchPack(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  const b = (ctx.body ?? {}) as Record<string, unknown>;
  const patch: Partial<Omit<SkillPack, "id" | "createdAt">> = {};
  if (typeof b.ref === "string" && b.ref.trim()) patch.ref = b.ref.trim();
  if (typeof b.url === "string" && b.url.trim()) patch.url = b.url.trim();
  if (b.trustTier === "internal" || b.trustTier === "third-party") patch.trustTier = b.trustTier;
  if (b.syncMode === "pinned" || b.syncMode === "tracked") patch.syncMode = b.syncMode;
  if (b.subset !== undefined) {
    const subset = asSubset(b.subset);
    if (subset === undefined)
      return sendJson(ctx.res, 400, { error: "bad_request", message: "subset must be 'all' or string[]" });
    patch.subset = subset;
  }
  if (b.config !== undefined) patch.config = asConfig(b.config);
  const pack = await ctx.app.updateSkillPack(ctx.params.id!, patch);
  audit(ctx.deps, {
    principalId: actor.id,
    action: "skill_pack.update",
    resource: pack.id,
    scopeLabel: pack.targetScopeId,
  });
  sendJson(ctx.res, 200, { pack });
}

async function removePack(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  const result = await ctx.app.removeSkillPack(ctx.params.id!);
  audit(ctx.deps, {
    principalId: actor.id,
    action: "skill_pack.remove",
    resource: ctx.params.id!,
    scopeLabel: orgScope(ctx.deps),
  });
  sendJson(ctx.res, 200, result);
}

export const skillPackRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/admin/skill-packs", auth: "either", handle: registerPack },
  { method: "GET", path: "/v1/admin/skill-packs", auth: "either", handle: listPacks },
  { method: "GET", path: "/v1/admin/skill-packs/:id/catalog", auth: "either", handle: packCatalog },
  { method: "POST", path: "/v1/admin/skill-packs/:id/import", auth: "either", handle: importPack },
  { method: "POST", path: "/v1/admin/skill-packs/:id/sync", auth: "either", handle: syncPack },
  { method: "PATCH", path: "/v1/admin/skill-packs/:id", auth: "either", handle: patchPack },
  { method: "DELETE", path: "/v1/admin/skill-packs/:id", auth: "either", handle: removePack },
];
