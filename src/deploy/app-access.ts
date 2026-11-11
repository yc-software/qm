import { isOrgScope, orgAccessNote, PUBLIC_ACCESS_NOTE } from "../../plugins/chassis/src/app-access.ts";
import { parseScopeId, type ScopeKind } from "../types.ts";

export function canEditAppPermissions(ownerScopeId: string, principalId: string): boolean {
  return ownerScopeId === `personal:${principalId}`;
}

export type AppAccess = {
  level: "private" | "shared" | "org" | "public";
  label: string;
  detail: string;
  canEdit: boolean;
};

const NOUNS: Partial<Record<ScopeKind, [one: string, many: string]>> = {
  personal: ["person", "people"],
  channel: ["channel", "channels"],
  group: ["group chat", "group chats"],
  team: ["team", "teams"],
};
const OTHER_NOUN: [string, string] = ["project", "projects"];

export function appAccess(opts: {
  ownerScopeId: string;
  public: boolean;
  grantees: ReadonlyArray<{ scope: string }>;
  viewer: string;
}): AppAccess {
  const ownedByViewer = canEditAppPermissions(opts.ownerScopeId, opts.viewer);
  const canEdit = ownedByViewer;
  const kindOf = (scope: string) => parseScopeId(scope).kind;
  if (opts.public) return { level: "public", label: "Public", detail: PUBLIC_ACCESS_NOTE, canEdit };
  if (opts.grantees.some((g) => isOrgScope(g.scope)))
    return { level: "org", label: "Organization", detail: orgAccessNote("your organization"), canEdit };
  const owner = kindOf(opts.ownerScopeId) === "personal" ? [] : [opts.ownerScopeId];
  const reach = new Set([...owner, ...opts.grantees.map((g) => g.scope)]);
  if (!reach.size)
    return {
      level: "private",
      label: "Private",
      detail: ownedByViewer ? "Only you can open" : "Only the owner can open",
      canEdit,
    };
  const counts = new Map<[string, string], number>();
  for (const scope of reach) {
    const kind = kindOf(scope);
    const noun = (kind && NOUNS[kind]) || OTHER_NOUN;
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  const words = [...counts].map(([[one, many], n]) => `${n} ${n === 1 ? one : many}`);
  const onlyPeople = counts.size === 1 && counts.has(NOUNS.personal!);
  const [[[one], n] = [[""], 0]] = counts;
  let label = counts.size === 1 ? words[0]! : "Shared";
  if (counts.size === 1 && n === 1 && !onlyPeople) label = one[0]!.toUpperCase() + one.slice(1);
  return {
    level: "shared",
    label,
    detail: `Shared with ${new Intl.ListFormat("en", { type: "conjunction" }).format(words)}`,
    canEdit,
  };
}
