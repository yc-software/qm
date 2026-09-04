import type { ConversationKind, Principal, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";

export type PublishAudienceKind = "org" | "members" | "owner";

export interface PublishAudience {
  kind: PublishAudienceKind;
  grantees: ScopeId[];
  memberCount?: number;
  incomplete?: boolean;
  reason?: string;
}

export interface DefaultPublishAudienceArgs {
  kind: ConversationKind;
  isPrivate?: boolean;
  isMpim?: boolean;
  members?: Principal[];
  orgScopeId: ScopeId;
  ownerId: string;
}

export function defaultPublishAudience(a: DefaultPublishAudienceArgs): PublishAudience {
  if (a.kind === "dm") return { kind: "owner", grantees: [], reason: "owner-only (direct message)" };
  if (a.kind === "group" || a.isMpim) {
    return { kind: "owner", grantees: [], reason: "owner-only (group DM — auto-share deferred)" };
  }

  if (a.isPrivate === false) {
    return { kind: "org", grantees: [a.orgScopeId], reason: "everyone in the org" };
  }
  if (a.isPrivate === undefined) {
    return {
      kind: "owner",
      grantees: [],
      incomplete: true,
      reason:
        "owner-only (couldn't read the channel's public/private status — leaving reach unchanged; share manually if needed)",
    };
  }

  if (a.members === undefined) {
    return {
      kind: "owner",
      grantees: [],
      incomplete: true,
      reason: "owner-only (couldn't enumerate the channel's members to auto-share — share manually)",
    };
  }
  const grantees: ScopeId[] = [];
  const seen = new Set<string>();
  for (const m of a.members) {
    if (m.type !== "internal") continue;
    if (m.id === a.ownerId) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    grantees.push(scopeId("personal", m.id));
  }
  if (grantees.length === 0) {
    return { kind: "owner", grantees: [], reason: "owner-only (no other current members)" };
  }
  return {
    kind: "members",
    grantees,
    memberCount: grantees.length,
    reason: `${grantees.length} channel member${grantees.length === 1 ? "" : "s"}`,
  };
}
