import { z } from "zod";
import { parseFrontmatter } from "./frontmatter.ts";
import type { SkillManifest } from "./skill-store.ts";

export interface PackConfig {
  skillGlobs?: string[];
  exclude?: string[];
  fieldOverrides?: Record<string, string>;
}

export interface NormalizedSkill {
  manifest: SkillManifest;
  scopeHint?: string;
  private: boolean;
  declaredCreds: string[];
  meta: Record<string, unknown>;
}

export type NormalizeResult = NormalizedSkill | { skip: true; reason: "malformed" };

const RECOGNIZED = new Set([
  "name",
  "description",
  "requiredCapabilities",
  "egress",
  "allowed-tools",
  "scope",
  "visibility",
  "private",
  "agent_only",
  "declaredCreds",
]);
const text = z.string().trim().optional().catch(undefined);
const list = z
  .preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.unknown()))
  .transform((items) => items.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : [])))
  .catch([]);
const flag = z
  .string()
  .transform((v) => ["true", "yes", "1"].includes(v.trim().toLowerCase()))
  .catch(false);
const skillAttrs = z.object({
  name: text,
  description: text,
  requiredCapabilities: list,
  egress: list,
  scope: text,
  visibility: text,
  private: flag,
  agent_only: flag,
  declaredCreds: list,
});

function dirNameFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2 && parts.at(-1)!.toLowerCase() === "skill.md") return parts.at(-2)!;
  return (parts.at(-1) ?? "skill").replace(/\.md$/i, "");
}

function deriveDescription(body: string, name: string): string {
  const lines = body.split("\n").map((l) => l.trim());
  const prose = lines.find(
    (l) => l && !l.startsWith("#") && !l.startsWith(">") && !l.startsWith("---") && !l.startsWith("```"),
  );
  const heading = lines
    .find((l) => l.startsWith("#"))
    ?.replace(/^#+\s*/, "")
    .trim();
  const text = (prose || heading || name).replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function extractEnvRefs(body: string): string[] {
  const out = new Set<string>();
  const re = /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out.add(m[1]!);
  return [...out];
}

export function normalizeSkill(raw: string, path: string, cfg?: PackConfig): NormalizeResult {
  let parsed: { attrs: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(raw);
  } catch {
    return { skip: true, reason: "malformed" };
  }

  const attrs: Record<string, unknown> = { ...parsed.attrs };
  for (const [from, to] of Object.entries(cfg?.fieldOverrides ?? {})) {
    if (attrs[from] !== undefined && attrs[to] === undefined) attrs[to] = attrs[from];
  }

  const fields = skillAttrs.parse(attrs);
  const body = parsed.body;
  const name = fields.name || dirNameFromPath(path);
  if (!body.trim()) return { skip: true, reason: "malformed" };
  const description = fields.description || deriveDescription(body, name);
  const requiredCapabilities = fields.requiredCapabilities.length
    ? fields.requiredCapabilities
    : fields.egress.map((h) => (h.includes(":") ? h : `egress:${h}`));
  const scopeHint = (fields.scope ?? fields.visibility)?.toLowerCase() || undefined;
  const isPrivate = fields.private || fields.agent_only || body.includes("THE-AGENT-ONLY");
  const declaredCreds = fields.declaredCreds.length ? fields.declaredCreds : extractEnvRefs(body);

  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.attrs)) if (!RECOGNIZED.has(k)) meta[k] = v;

  return {
    manifest: { name, description, requiredCapabilities, body },
    ...(scopeHint ? { scopeHint } : {}),
    private: isPrivate,
    declaredCreds,
    meta,
  };
}

const PERSONAL_SCOPES = new Set(["personal", "person", "private", "owner", "me", "self", "individual"]);
export function isOrgEligibleScope(scopeHint: string | undefined): boolean {
  return scopeHint === undefined || !PERSONAL_SCOPES.has(scopeHint);
}
