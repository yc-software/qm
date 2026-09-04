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
const PRIVATE_FLAGS = ["private", "agent_only"];

function isTruthy(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "string") return ["true", "yes", "1"].includes(v.trim().toLowerCase());
  return false;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v))
    return v
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

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

  const body = parsed.body;
  const name = typeof attrs.name === "string" && attrs.name.trim() ? attrs.name.trim() : dirNameFromPath(path);
  if (!body.trim()) return { skip: true, reason: "malformed" };
  const fmDescription = typeof attrs.description === "string" ? attrs.description.trim() : "";
  const description = fmDescription || deriveDescription(body, name);

  let requiredCapabilities = asStringArray(attrs.requiredCapabilities);
  if (requiredCapabilities.length === 0 && attrs.egress !== undefined) {
    requiredCapabilities = asStringArray(attrs.egress).map((h) => (h.includes(":") ? h : `egress:${h}`));
  }

  let scopeRaw: string | undefined;
  if (typeof attrs.scope === "string") scopeRaw = attrs.scope;
  else if (typeof attrs.visibility === "string") scopeRaw = attrs.visibility;
  const scopeHint = scopeRaw?.trim().toLowerCase() || undefined;

  const isPrivate = PRIVATE_FLAGS.some((k) => isTruthy(attrs[k])) || /THE-AGENT-ONLY/.test(body);

  let declaredCreds = asStringArray(attrs.declaredCreds);
  if (declaredCreds.length === 0) declaredCreds = extractEnvRefs(body);

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
