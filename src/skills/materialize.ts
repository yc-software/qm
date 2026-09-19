import { CapabilityUnsupportedError, type Sandbox, type SandboxHandle } from "../sandbox/sandbox.ts";
import { safeSkillFilePath, type SkillFile, type SkillResolution } from "./skill-store.ts";
import type { SkillBundle } from "./skill-bundle-store.ts";
import { swallow } from "../util/errors.ts";
import { assertSafeSkillName } from "./skill-name.ts";
import type { ScopeId } from "../types.ts";

export const SKILLS_DIR = "skills";

export function safeSkillDirName(name: string): string {
  return assertSafeSkillName(name);
}

export function skillDir(root: string, resolution: SkillResolution): string {
  return `${root}/${safeSkillDirName(resolution.skill!.manifest.name)}`;
}

export function packRoot(root: string, resolution: SkillResolution): string | null {
  return resolution.skill?.pack ? `${root}/.packs/${safeSkillDirName(resolution.skill.pack.packId)}` : null;
}

export function rehomeSkillPaths(resolution: SkillResolution, text: string, root: string): string {
  const name = safeSkillDirName(resolution.skill!.manifest.name);
  return text.split(`${SKILLS_DIR}/${name}/`).join(`${root}/${name}/`);
}

export function renderSkillBody(resolution: SkillResolution, root = SKILLS_DIR): string {
  const body = rehomeSkillPaths(resolution, resolution.skill!.manifest.body, root);
  const pack = packRoot(root, resolution);
  return pack
    ? `${body}\n\n## Pack files\nResolve repository-relative shared-file paths against \`${pack}/\`; pack files never overwrite the workspace root.`
    : body;
}

interface LayEntry {
  path: string;
  content: string;
}

function entriesUnder(
  dir: string,
  files: SkillFile[],
  label: string,
  content: (f: SkillFile) => string = (f) => f.content,
  skip: (rel: string) => boolean = () => false,
): LayEntry[] {
  const entries: LayEntry[] = [];
  for (const f of files) {
    try {
      const rel = safeSkillFilePath(f.path);
      if (!skip(rel)) entries.push({ path: `${dir}/${rel}`, content: content(f) });
    } catch (e) {
      swallow(`skills: bad ${label} path ${f.path}`, e);
    }
  }
  return entries;
}

export async function materializeSkillTree(
  sandbox: Sandbox,
  handle: SandboxHandle,
  root: string,
  resolution: SkillResolution,
  bundles: SkillBundle[] = [],
): Promise<void> {
  if (!resolution.skill) return;
  const dir = skillDir(root, resolution);
  const entries: LayEntry[] = [
    { path: `${dir}/SKILL.md`, content: renderSkillBody(resolution, root) },
    ...entriesUnder(
      dir,
      resolution.skill.manifest.files ?? [],
      "asset",
      (f) => rehomeSkillPaths(resolution, f.content, root),
      (rel) => rel === "SKILL.md",
    ),
  ];
  for (const b of bundles)
    entries.push(...entriesUnder(`${root}/.packs/${safeSkillDirName(b.packId)}`, b.files, "bundle"));
  if (sandbox.importFiles) {
    try {
      await sandbox.importFiles(
        handle,
        entries.map((e) => ({ path: e.path, data: Buffer.from(e.content, "utf8") })),
      );
      return;
    } catch (err) {
      if (!(err instanceof CapabilityUnsupportedError)) throw err;
    }
  }
  for (const e of entries) await sandbox.writeFile(handle, e.path, e.content);
}

export function skillsIndex(resolved: SkillResolution[], provenanceScopes: readonly ScopeId[] = []): string {
  const provenance = new Set(provenanceScopes);
  const items = resolved
    .filter((r) => r.skill)
    .sort((a, b) => {
      const [x, y] = [a.skill!.manifest.name, b.skill!.manifest.name];
      if (x < y) return -1;
      if (x > y) return 1;
      return 0;
    });
  if (!items.length) return "";
  const lines = items.map((r) => {
    const m = r.skill!.manifest;
    const shadow = r.shadowed.length ? " (shadows a broader-scope skill of the same name)" : "";
    const source = provenance.has(r.skill!.scopeId) ? ` [from ${r.skill!.scopeId}]` : "";
    return `- **${m.name}**${source} — ${m.description}${shadow}`;
  });
  return [
    "## Skills",
    "Load a skill with the skill tool before relying on it: skill({ name }) returns its instructions without starting a sandbox. When a skill ships scripts or supporting files, the same call syncs them into a directory that lives for this turn and names it; run and read them there.",
    ...lines,
  ].join("\n");
}
