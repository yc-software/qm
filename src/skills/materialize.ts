import { CapabilityUnsupportedError, type Sandbox, type SandboxHandle } from "../sandbox/sandbox.ts";
import { safeSkillFilePath, type SkillFile, type SkillResolution } from "./skill-store.ts";
import type { SkillBundle } from "./skill-bundle-store.ts";
import { swallow } from "../util/errors.ts";
import { assertSafeSkillName } from "./skill-name.ts";
import type { ScopeId } from "../types.ts";

export const SKILLS_DIR = "skills";
export const SKILLS_ROOT = ".agent-skills";

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

export function rankedSkills(resolved: SkillResolution[], query = "", onlyMatches = false): SkillResolution[] {
  const tokens = (text: string) =>
    new Set(
      [...new Intl.Segmenter("en", { granularity: "word" }).segment(text.toLowerCase())]
        .filter((part) => part.isWordLike)
        .map((part) => part.segment),
    );
  const ignored = new Set(
    "a an and are as at be by can do for from have help i in is it me my of on or please that the this to today use want what with you your".split(
      " ",
    ),
  );
  const words = [...tokens(query)].filter((word) => !ignored.has(word));
  const unique = new Map<string, SkillResolution>();
  for (const entry of resolved) {
    if (entry.skill && !unique.has(entry.skill.manifest.name)) unique.set(entry.skill.manifest.name, entry);
  }
  return [...unique.values()]
    .map((entry) => {
      const skill = entry.skill!;
      const text = tokens(`${skill.manifest.name} ${skill.manifest.description}`);
      return {
        entry,
        relevance: words.filter((word) => text.has(word)).length,
      };
    })
    .filter(({ relevance }) => !onlyMatches || relevance > 0)
    .sort(
      (a, b) => b.relevance - a.relevance || a.entry.skill!.manifest.name.localeCompare(b.entry.skill!.manifest.name),
    )
    .map(({ entry }) => entry);
}

const SKILLS_INDEX_BUDGET = 12_000;
const MIN_DESCRIPTION = 60;

function fitDescriptions(heads: string[], descriptions: string[], budget: number): number {
  const size = (cap: number) =>
    heads.reduce((sum, head, i) => sum + head.length + 1 + Math.min(descriptions[i]!.length, cap) + 4, 0);
  let low = 0;
  let high = Math.max(0, ...descriptions.map((d) => d.length));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(mid) <= budget) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function skillsIndex(resolved: SkillResolution[], budget = SKILLS_INDEX_BUDGET): string {
  const items = rankedSkills(resolved);
  if (!items.length) return "";
  const heads = items.map((r) => `- ${r.skill!.manifest.name}`);
  const descriptions = items.map((r) => r.skill!.manifest.description.trim());
  const cap = fitDescriptions(heads, descriptions, budget);
  let lines: string[];
  let note = "";
  const shortened = descriptions.filter((d) => d.length > cap).length;
  if (cap >= MIN_DESCRIPTION || !shortened) {
    lines = heads.map((head, i) => {
      const d = descriptions[i]!;
      return `${head} — ${d.length > cap ? `${d.slice(0, cap).trimEnd()}…` : d}`;
    });
    if (shortened) note = ` ${shortened} descriptions are shortened; skills action read shows the full text.`;
  } else {
    let used = 0;
    lines = heads.filter((head) => (used += head.length + 1) <= budget);
    const omitted = items.length - lines.length;
    note = ` Descriptions are omitted to fit the list${omitted ? `, and ${omitted} skills are left out; find them with skills action search` : ""}.`;
  }
  return [
    "## Skills",
    `If the task matches a skill's description, or uses a connected app or service a skill covers, read that skill in full with skills action read before acting.${note}`,
    ...lines,
  ].join("\n");
}
