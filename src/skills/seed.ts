import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ScopeId } from "../types.ts";
import { createKeyedQueue } from "../util/async.ts";
import { parseSeedSkillFrontmatter } from "./frontmatter.ts";
import { safeSkillFilePath, type Skill, type SkillFile, type SkillManifest, type SkillStore } from "./skill-store.ts";

export interface SeedInstallResult {
  installed: string[];
  updated: string[];
  skipped: string[];
}

export function isProbablyBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true;
  return !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

function canonicalFilesKey(files: SkillFile[] | undefined): string {
  return [...(files ?? [])]
    .map((f) => `${f.path}\0${f.content}\0${f.executable === true ? "1" : "0"}`)
    .sort()
    .join("");
}

export function sameManifest(a: SkillManifest, b: SkillManifest): boolean {
  return (
    a.description === b.description &&
    a.body === b.body &&
    [...a.requiredCapabilities].sort().join("\0") === [...b.requiredCapabilities].sort().join("\0") &&
    canonicalFilesKey(a.files) === canonicalFilesKey(b.files)
  );
}

function readSkillFiles(skillDir: string): SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const child = join(abs, name);
      const st = lstatSync(child);
      if (st.isSymbolicLink()) {
        console.warn(`skills-seed: skipping symlink asset ${relative(skillDir, child)} (not materialized)`);
        continue;
      }
      if (st.isDirectory()) {
        walk(child);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(skillDir, child).split(sep).join("/");
      if (rel === "SKILL.md") continue;
      const safe = safeSkillFilePath(rel);
      const bytes = readFileSync(child);
      if (isProbablyBinary(bytes)) {
        console.warn(`skills-seed: skipping binary asset ${safe} (v1 stores text only)`);
        continue;
      }
      out.push({ path: safe, content: bytes.toString("utf8"), executable: (st.mode & 0o111) !== 0 });
    }
  };
  walk(skillDir);
  return out.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
}

export function parseSeedSkill(raw: string): SkillManifest {
  return parseSeedSkillFrontmatter(raw);
}

export type UpsertOutcome = "installed" | "updated" | "skipped" | "foreign";

export function foreignSkillCollision(
  all: Skill[],
  scopeId: ScopeId,
  name: string,
  createdBy: string,
): Skill | undefined {
  return all.find(
    (s) => s.scopeId === scopeId && s.manifest.name === name && s.createdBy !== createdBy && s.status !== "archived",
  );
}

const upsertQueue = createKeyedQueue<string>();

export function upsertSeedSkill(
  skills: SkillStore,
  input: { scopeId: ScopeId; manifest: SkillManifest; createdBy: string; reviewer: string; pack?: Skill["pack"] },
): Promise<UpsertOutcome> {
  return upsertQueue(`${input.scopeId}\0${input.manifest.name}`, () => upsertSeedSkillUnsafe(skills, input));
}

async function upsertSeedSkillUnsafe(
  skills: SkillStore,
  input: { scopeId: ScopeId; manifest: SkillManifest; createdBy: string; reviewer: string; pack?: Skill["pack"] },
): Promise<UpsertOutcome> {
  const { scopeId, manifest, createdBy, reviewer, pack } = input;
  const all = await skills.list();
  const existing = all.find(
    (s) => s.scopeId === scopeId && s.manifest.name === manifest.name && s.createdBy === createdBy,
  );
  if (!existing && foreignSkillCollision(all, scopeId, manifest.name, createdBy)) return "foreign";
  if (existing) {
    const changed = !sameManifest(existing.manifest, manifest);
    if (!changed && existing.status === "published") return "skipped";
    if (changed) await skills.update(existing.id, manifest);
    await skills.review(existing.id, reviewer, manifest.requiredCapabilities);
    await skills.publish(existing.id);
    return "updated";
  }
  const skill = await skills.create({ scopeId, manifest, createdBy, ...(pack ? { pack } : {}) });
  await skills.review(skill.id, reviewer, manifest.requiredCapabilities);
  await skills.publish(skill.id);
  return "installed";
}

export async function installSeedSkills(
  skills: SkillStore,
  opts: { dir: string; scopeId: ScopeId; createdBy?: string; reviewer?: string },
): Promise<SeedInstallResult> {
  if (!existsSync(opts.dir)) return { installed: [], updated: [], skipped: [] };
  const createdBy = opts.createdBy ?? "system:skills-seed";
  const reviewer = opts.reviewer ?? "system:skills-reviewer";
  const result: SeedInstallResult = { installed: [], updated: [], skipped: [] };

  for (const entry of readdirSync(opts.dir).sort()) {
    const skillDir = join(opts.dir, entry);
    const skillPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillPath) || !statSync(skillPath).isFile()) continue;
    const manifest = parseSeedSkill(readFileSync(skillPath, "utf8"));
    manifest.files = readSkillFiles(skillDir);
    const outcome = await upsertSeedSkill(skills, { scopeId: opts.scopeId, manifest, createdBy, reviewer });
    result[outcome === "foreign" ? "skipped" : outcome].push(manifest.name);
  }

  return result;
}
