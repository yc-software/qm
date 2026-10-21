import { CapabilityUnsupportedError, type Sandbox, type SandboxHandle } from "../sandbox/sandbox.ts";
import { safeSkillFilePath, type SkillFile, type SkillResolution } from "./skill-store.ts";
import type { SkillBundle } from "./skill-bundle-store.ts";
import { swallow } from "../util/errors.ts";
import { assertSafeSkillName, isSafeSkillName } from "./skill-name.ts";
import type { ListSection, ScopeId } from "../types.ts";

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

export function rankedSkills(
  resolved: SkillResolution[],
  query = "",
  usedNames: readonly string[] = [],
  onlyMatches = false,
): SkillResolution[] {
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
        used: usedNames.includes(skill.manifest.name) ? 1 : 0,
      };
    })
    .filter(({ relevance }) => !onlyMatches || relevance > 0)
    .sort(
      (a, b) =>
        b.relevance - a.relevance ||
        b.used - a.used ||
        a.entry.skill!.manifest.name.localeCompare(b.entry.skill!.manifest.name),
    )
    .map(({ entry }) => entry);
}

const SHORTLIST_SIZE = 12;
const MAX_PINNED_SKILLS = SHORTLIST_SIZE / 2;

export function parsePinnedSkills(raw: unknown): { value: string[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.every((name) => typeof name === "string"))
    return { error: "pinned skills require { names: string[] } (an empty list clears them)" };
  const names = [...new Set(raw.map((name) => name.trim()).filter(Boolean))];
  const bad = names.find((name) => !isSafeSkillName(name));
  if (bad) return { error: `not a valid skill name: ${bad}` };
  if (names.length > MAX_PINNED_SKILLS) return { error: `at most ${MAX_PINNED_SKILLS} skills can be pinned` };
  return { value: names };
}

export function skillsIndex(
  resolved: SkillResolution[],
  provenanceScopes: readonly ScopeId[] = [],
  query = "",
  usedNames: readonly string[] = [],
  pinnedNames: readonly string[] = [],
): ListSection | undefined {
  const provenance = new Set(provenanceScopes);
  const ranked = rankedSkills(resolved, query, usedNames);
  const byName = new Map(ranked.map((r) => [r.skill!.manifest.name, r]));
  const pinned = pinnedNames.flatMap((name) => byName.get(name) ?? []);
  const items = [...new Set([...pinned, ...ranked])].slice(0, SHORTLIST_SIZE);
  if (!items.length) return undefined;
  return {
    head: [
      "## Skills",
      `Showing ${items.length} of ${ranked.length} available skills. Use skills action list or search for the rest.`,
    ].join("\n"),
    entries: new Map(
      items.map((r) => {
        const m = r.skill!.manifest;
        const source = provenance.has(r.skill!.scopeId) ? ` [from ${r.skill!.scopeId}]` : "";
        return [m.name, `- **${m.name}**${source} — ${m.description}`];
      }),
    ),
  };
}
