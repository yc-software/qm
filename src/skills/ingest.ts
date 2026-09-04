import { isOrgEligibleScope, normalizeSkill, type NormalizedSkill, type PackConfig } from "./normalize.ts";
import { upsertSeedSkill, type UpsertOutcome } from "./seed.ts";
import { safeSkillFilePath, type SkillFile, type SkillManifest, type SkillStore } from "./skill-store.ts";
import type { SkillPack } from "./skill-pack-store.ts";
import type { ScopeId } from "../types.ts";
import {
  skillRecordPaths,
  bundleFilePaths,
  detectPathCollisions,
  materializationControlPathCollisions,
  SkillPackCollisionError,
} from "./skill-collision.ts";

export interface RepoFile {
  path: string;
  text: string;
  binary: boolean;
}
export interface FetchedRepo {
  commit: string;
  files: RepoFile[];
}

type ExcludeReason = "scope" | "private" | "collision" | "binary-asset" | "malformed";

interface IngestCandidate {
  upstreamName: string;
  skillPath: string;
  normalized?: NormalizedSkill;
  eligible: boolean;
  excludeReason?: ExcludeReason;
  importedScopes?: ScopeId[];
}

export interface IngestPlan {
  candidates: IngestCandidate[];
  counts: Record<string, number>;
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .split("**")
    .map((seg) =>
      seg
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${re}$`);
}
function matchesAny(path: string, globs: string[] | undefined): boolean {
  return !!globs && globs.some((g) => globToRegExp(g).test(path));
}

function skillDirOf(skillMdPath: string): string {
  const i = skillMdPath.lastIndexOf("/");
  return i < 0 ? "" : skillMdPath.slice(0, i);
}
function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function collectAssets(repo: FetchedRepo, skillDir: string): SkillFile[] | null {
  const prefix = skillDir ? `${skillDir}/` : "";
  const out: SkillFile[] = [];
  for (const f of repo.files) {
    if (!f.path.startsWith(prefix)) continue;
    const rel = f.path.slice(prefix.length);
    if (rel === "SKILL.md" || rel.includes("/SKILL.md")) continue;
    if (f.binary) return null;
    let safe: string;
    try {
      safe = safeSkillFilePath(rel);
    } catch {
      return null;
    }
    out.push({ path: safe, content: f.text });
  }
  return out.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
}

function isExcludedPath(path: string, globs: string[] | undefined): boolean {
  if (!globs?.length) return false;
  if (matchesAny(path, globs)) return true;
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (matchesAny(parts.slice(0, i).join("/"), globs)) return true;
  }
  return false;
}

const BUNDLE_IGNORE_ANYWHERE = new Set([
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".editorconfig",
  ".npmignore",
  ".ds_store",
]);
const BUNDLE_IGNORE_ROOT = new Set([
  "readme",
  "readme.md",
  "readme.txt",
  "readme.rst",
  "license",
  "license.md",
  "license.txt",
  "licence",
  "licence.md",
  "notice",
  "contributing.md",
  "code_of_conduct.md",
  "changelog.md",
  "changelog",
  "security.md",
  "codeowners",
]);
function isRepoMetadata(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower === ".github" || lower.startsWith(".github/")) return true;
  if (lower === ".claude-plugin" || lower.startsWith(".claude-plugin/")) return true;
  if (lower === ".claude" || lower.startsWith(".claude/")) return true;
  const base = lower.split("/").at(-1) ?? lower;
  if (BUNDLE_IGNORE_ANYWHERE.has(base)) return true;
  return !lower.includes("/") && BUNDLE_IGNORE_ROOT.has(base);
}

export function collectSharedBundle(repo: FetchedRepo, config?: PackConfig): SkillFile[] {
  const skillDirs: string[] = [];
  let hasRootSkill = false;
  for (const f of repo.files) {
    if (lastSegment(f.path) !== "SKILL.md") continue;
    const dir = skillDirOf(f.path);
    if (dir) skillDirs.push(dir);
    else hasRootSkill = true;
  }
  if (hasRootSkill) return [];
  const underSkillDir = (p: string): boolean => skillDirs.some((d) => p === d || p.startsWith(`${d}/`));

  const out: SkillFile[] = [];
  for (const f of repo.files) {
    if (lastSegment(f.path) === "SKILL.md") continue;
    if (underSkillDir(f.path)) continue;
    if (isRepoMetadata(f.path)) continue;
    if (isExcludedPath(f.path, config?.exclude)) continue;
    if (f.binary) continue;
    let safe: string;
    try {
      safe = safeSkillFilePath(f.path);
    } catch {
      continue;
    }
    out.push({ path: safe, content: f.text });
  }
  return out.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
}

export interface IngestContext {
  config?: PackConfig;
  nativeNames: Set<string>;
}

export function planIngest(repo: FetchedRepo, ctx: IngestContext): IngestPlan {
  const cfg = ctx.config;
  const counts = { total: 0, eligible: 0, scope: 0, private: 0, collision: 0, "binary-asset": 0, malformed: 0 };
  const candidates: IngestCandidate[] = [];

  for (const f of repo.files) {
    if (lastSegment(f.path) !== "SKILL.md") continue;
    const skillDir = skillDirOf(f.path);
    if (cfg?.skillGlobs && !matchesAny(skillDir, cfg.skillGlobs)) continue;
    if (matchesAny(skillDir, cfg?.exclude)) continue;

    counts.total++;
    const upstreamName = lastSegment(skillDir) || lastSegment(f.path);
    const norm = normalizeSkill(f.text, f.path, cfg);
    if ("skip" in norm) {
      counts.malformed++;
      candidates.push({ upstreamName, skillPath: f.path, eligible: false, excludeReason: "malformed" });
      continue;
    }

    let reason: ExcludeReason | undefined;
    if (norm.private) reason = "private";
    else if (!isOrgEligibleScope(norm.scopeHint)) reason = "scope";
    else if (ctx.nativeNames.has(norm.manifest.name)) reason = "collision";
    else if (collectAssets(repo, skillDir) === null) reason = "binary-asset";

    if (reason) counts[reason]++;
    else counts.eligible++;
    candidates.push({
      upstreamName,
      skillPath: f.path,
      normalized: norm,
      eligible: !reason,
      ...(reason ? { excludeReason: reason } : {}),
    });
  }

  return { candidates, counts };
}

export interface ImportResult {
  imported: string[];
  updated: string[];
  skipped: string[];
  archived: string[];
  counts: Record<string, number>;
}

const PACK_REVIEWER = "system:pack-reviewer";

export async function importPack(
  repo: FetchedRepo,
  store: SkillStore,
  ctx: {
    pack: SkillPack;
    selected: "all" | string[];
    nativeNames: Set<string>;
    targetScopeId?: ScopeId;
    claimedPaths?: Map<string, string>;
    claimedBundlePaths?: Map<string, string>;
    bundleFiles?: SkillFile[];
  },
): Promise<ImportResult & { kept: string[] }> {
  const plan = planIngest(repo, { config: ctx.pack.config, nativeNames: ctx.nativeNames });
  const result: ImportResult = { imported: [], updated: [], skipped: [], archived: [], counts: plan.counts };
  const wanted = (name: string): boolean =>
    (ctx.selected === "all" || ctx.selected.includes(name)) &&
    (ctx.pack.subset === "all" || ctx.pack.subset.includes(name));

  const toWrite: Array<{ upstreamName: string; manifest: SkillManifest }> = [];
  for (const c of plan.candidates) {
    if (!c.eligible || !c.normalized || !wanted(c.upstreamName)) continue;
    const assets = collectAssets(repo, skillDirOf(c.skillPath)) ?? [];
    toWrite.push({ upstreamName: c.upstreamName, manifest: { ...c.normalized.manifest, files: assets } });
  }

  const incomingSkillPaths = toWrite.flatMap((w) => skillRecordPaths(w.manifest.name, w.manifest.files));
  const incomingBundlePaths = bundleFilePaths(ctx.bundleFiles ?? []);
  const controlCollisions = materializationControlPathCollisions(incomingBundlePaths);
  if (controlCollisions.length) throw new SkillPackCollisionError(controlCollisions);
  if (ctx.claimedPaths) {
    const incoming = [...incomingSkillPaths, ...incomingBundlePaths];
    const collisions = detectPathCollisions(incoming, ctx.claimedPaths);
    if (collisions.length) throw new SkillPackCollisionError(collisions);
  }
  if (ctx.claimedBundlePaths) {
    const claimed = new Map(ctx.claimedBundlePaths);
    for (const path of incomingSkillPaths) claimed.set(path, "incoming skill");
    const collisions = detectPathCollisions(incomingBundlePaths, claimed);
    if (collisions.length) throw new SkillPackCollisionError(collisions);
  }

  for (const { upstreamName, manifest } of toWrite) {
    const outcome: UpsertOutcome = await upsertSeedSkill(store, {
      scopeId: ctx.targetScopeId ?? ctx.pack.targetScopeId,
      manifest,
      createdBy: `pack:${ctx.pack.id}`,
      reviewer: PACK_REVIEWER,
      pack: { packId: ctx.pack.id, commit: repo.commit, upstreamName },
    });
    if (outcome === "installed") result.imported.push(manifest.name);
    else if (outcome === "updated") result.updated.push(manifest.name);
    else result.skipped.push(manifest.name);
  }
  return { ...result, kept: toWrite.map((w) => w.upstreamName) };
}
