// Where to point someone who signed in on the shared host but belongs to no workspace here.
// A deployment may map a value of one identity-provider claim (for example the person's
// organisation) to the address of that organisation's current assistant, via
// PORTAL_NO_WORKSPACE_LINKS = {"claim": "<claim name>", "links": {"<claim value>": "https://…"}}.
// Nothing here knows any provider or organisation; without the setting no link is offered.

export interface NoWorkspaceLinks {
  claim: string;
  links: ReadonlyMap<string, string>;
}

export const NO_WORKSPACE_LINKS_MAX = 3;

export function parseNoWorkspaceLinks(raw: string | undefined): { config: NoWorkspaceLinks | null; problem?: string } {
  if (!raw?.trim()) return { config: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: null, problem: "PORTAL_NO_WORKSPACE_LINKS is not valid JSON" };
  }
  const o = parsed as { claim?: unknown; links?: unknown };
  if (
    !o ||
    typeof o !== "object" ||
    typeof o.claim !== "string" ||
    !o.claim.trim() ||
    !o.links ||
    typeof o.links !== "object"
  )
    return {
      config: null,
      problem: 'PORTAL_NO_WORKSPACE_LINKS must be {"claim": "<name>", "links": {"<value>": "https://…"}}',
    };
  const links = new Map<string, string>();
  for (const [value, url] of Object.entries(o.links as Record<string, unknown>)) {
    if (typeof url !== "string" || !isHttpsUrl(url))
      return { config: null, problem: `PORTAL_NO_WORKSPACE_LINKS link for "${value}" must be an https URL` };
    links.set(value, url);
  }
  return { config: { claim: o.claim.trim(), links } };
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The configured addresses for the claim's value(s) in this sign-in's profile, first ones first. */
export function noWorkspaceLinksFor(
  config: NoWorkspaceLinks | null,
  profile: Record<string, unknown> | undefined,
): string[] {
  if (!config || !profile) return [];
  const raw = profile[config.claim];
  const values = (Array.isArray(raw) ? raw : [raw]).filter(
    (v): v is string | number => typeof v === "string" || typeof v === "number",
  );
  const found: string[] = [];
  for (const value of values) {
    const url = config.links.get(String(value));
    if (url && !found.includes(url)) found.push(url);
    if (found.length >= NO_WORKSPACE_LINKS_MAX) break;
  }
  return found;
}
