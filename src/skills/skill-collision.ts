import { safeSkillDirName } from "./materialize.ts";
import { isSkillMaterializationControlPath, SKILLS_DIR, SKILL_TREE_MARKER } from "./materialization-paths.ts";
import { safeSkillFilePath, type SkillFile } from "./skill-store.ts";
import { isSafeSkillName } from "./skill-name.ts";

export const SKILL_MATERIALIZATION_LOCK = "skills:materialization";

export function skillRecordPaths(name: string, files: SkillFile[] | undefined): string[] {
  const dir = `${SKILLS_DIR}/${safeSkillDirName(name)}`;
  const out = [`${dir}/SKILL.md`, `${dir}/${SKILL_TREE_MARKER}`];
  for (const f of files ?? []) {
    let rel: string;
    try {
      rel = safeSkillFilePath(f.path);
    } catch {
      continue;
    }
    const path = `${dir}/${rel}`;
    if (!isSkillMaterializationControlPath(path)) out.push(path);
  }
  return out;
}

export function materializationControlPathCollisions(paths: string[]): PathCollision[] {
  return paths
    .filter(isSkillMaterializationControlPath)
    .map((path) => ({ path, owner: "core skill materialization metadata" }));
}

export function persistedSkillRecordPaths(name: string, files: SkillFile[] | undefined): string[] {
  return isSafeSkillName(name) ? skillRecordPaths(name, files) : [];
}

export function bundleFilePaths(files: SkillFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    try {
      out.push(safeSkillFilePath(f.path));
    } catch {
      continue;
    }
  }
  return out;
}

export interface PathCollision {
  path: string;
  owner: string;
}

export function detectPathCollisions(incoming: string[], claimed: Map<string, string>): PathCollision[] {
  const seen = new Set<string>();
  const collisions: PathCollision[] = [];
  for (const p of incoming) {
    const owner = claimed.get(p);
    if (owner !== undefined && !seen.has(p)) {
      collisions.push({ path: p, owner });
      seen.add(p);
    }
  }
  return collisions;
}

export class SkillPackCollisionError extends Error {
  readonly collisions: PathCollision[];
  constructor(collisions: PathCollision[]) {
    const head = collisions
      .slice(0, 5)
      .map((c) => `${c.path} (owned by ${c.owner})`)
      .join("; ");
    super(
      `skill pack import would clobber ${collisions.length} existing path(s): ${head}${collisions.length > 5 ? " …" : ""}`,
    );
    this.name = "SkillPackCollisionError";
    this.collisions = collisions;
  }
}
