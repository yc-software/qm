export const SCOPE_KINDS = ["personal", "channel", "team", "org", "group", "persona"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

function isScopeKind(s: string): s is ScopeKind {
  return (SCOPE_KINDS as readonly string[]).includes(s);
}

export function parseScopeId(id: string): { kind: ScopeKind | null; ref: string } {
  const sep = id.indexOf(":");
  if (sep < 0) return { kind: null, ref: "" };
  const raw = id.slice(0, sep);
  return { kind: isScopeKind(raw) ? raw : null, ref: id.slice(sep + 1) };
}
