import {
  generalAccessOf,
  orgAccessNote,
  orgDisplayName,
  PUBLIC_ACCESS_NOTE,
} from "../../plugins/chassis/src/app-access.ts";
import { parseScopeId, personalScope, type ScopeKind } from "../types.ts";

export function canEditAppPermissions(ownerScopeId: string, principalId: string): boolean {
  return ownerScopeId === personalScope(principalId);
}

export type AppAccess = {
  level: "private" | "shared" | "org" | "public";
  label: string;
  detail: string;
  canEdit: boolean;
};

const NOUNS: Record<ScopeKind, [one: string, many: string]> = {
  personal: ["person", "people"],
  channel: ["channel", "channels"],
  group: ["group chat", "group chats"],
  team: ["team", "teams"],
  org: ["organization", "organizations"],
  persona: ["persona", "personas"],
};

export function appAccess(opts: {
  ownerScopeId: string;
  public: boolean;
  grantees: ReadonlyArray<{ scope: string }>;
  viewer: string;
  orgName?: string | undefined;
}): AppAccess {
  const canEdit = canEditAppPermissions(opts.ownerScopeId, opts.viewer);
  const general = generalAccessOf(opts);
  if (general === "public") return { level: "public", label: "Public", detail: PUBLIC_ACCESS_NOTE, canEdit };
  if (general === "org") {
    const org = orgDisplayName(opts.orgName);
    return { level: "org", label: org, detail: orgAccessNote(org), canEdit };
  }
  const owner = parseScopeId(opts.ownerScopeId).kind === "personal" ? [] : [opts.ownerScopeId];
  const kinds = [...new Set([...owner, ...opts.grantees.map((g) => g.scope)])].flatMap(
    (scope) => parseScopeId(scope).kind ?? [],
  );
  if (!kinds.length)
    return {
      level: "private",
      label: "Private",
      detail: canEdit ? "Only you can open" : "Only the owner can open",
      canEdit,
    };
  const counts = new Map<ScopeKind, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const words = [...counts].map(([kind, n]) => `${n} ${NOUNS[kind][n === 1 ? 0 : 1]}`);
  const [only] = counts;
  let label = only && counts.size === 1 ? words[0]! : "Shared";
  if (only && counts.size === 1 && only[1] === 1 && only[0] !== "personal") {
    const noun = NOUNS[only[0]][0];
    label = noun[0]!.toUpperCase() + noun.slice(1);
  }
  return {
    level: "shared",
    label,
    detail: `Shared with ${new Intl.ListFormat("en", { type: "conjunction" }).format(words)}`,
    canEdit,
  };
}
