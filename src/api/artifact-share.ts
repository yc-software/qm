import { orgId as configOrgId } from "../config.ts";
import { isSharedScope, parseScopeId, scopeId, type Permission, type ScopeId } from "../types.ts";
import type { ResourceKind } from "../acl/resource-ref.ts";
import type { RecipientResolution } from "../directory/directory-store.ts";

export const SHARED_SKILL_TRIGGER_REFUSAL =
  "a skill in a shared scope can only be changed by a person, not an automated trigger";

export function triggerBlocksSharedSkill(homeScope: ScopeId, liveActor: boolean): boolean {
  return isSharedScope(homeScope) && !liveActor;
}

export function livePersonCapability(c: { liveActor?: boolean; liveAuthor?: boolean } | undefined): boolean {
  return c?.liveAuthor === true || c?.liveActor === true;
}

export const ARTIFACT_TYPES = ["file", "skill", "deploy", "cron"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number] & ResourceKind;

export function isArtifactType(s: string): s is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(s);
}

export type ResolvedShareTarget =
  | { kind: "ok"; scope: ScopeId; label: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: Array<{ principalId: string; displayName: string }> }
  | { kind: "invalid"; message: string };

export async function resolveShareTarget(
  app: { resolveRecipient(recipient: string): Promise<RecipientResolution> },
  input: { scope?: string; recipient?: string },
  hints: { invalidScope: (scope: string) => string; targetRequired: string },
): Promise<ResolvedShareTarget> {
  const scope = (input.scope ?? "").trim();
  const recipient = (input.recipient ?? "").trim();
  if (scope && recipient) return { kind: "invalid", message: "pass either scope or recipient, not both" };
  if (scope) {
    if (scope === "org") return { kind: "ok", scope: scopeId("org", configOrgId()), label: "everyone in the org" };
    if (parseScopeId(scope).kind === null) return { kind: "invalid", message: hints.invalidScope(scope) };
    return { kind: "ok", scope, label: scope };
  }
  if (recipient) {
    const r = await app.resolveRecipient(recipient);
    if (r.kind === "none") return { kind: "none" };
    if (r.kind === "ambiguous")
      return {
        kind: "ambiguous",
        candidates: r.candidates.map((c) => ({ principalId: c.principalId, displayName: c.displayName })),
      };
    return { kind: "ok", scope: scopeId("personal", r.member.principalId), label: r.member.displayName };
  }
  return { kind: "invalid", message: hints.targetRequired };
}

export function splitToScope(toScope: string): { scope: string } | { recipient: string } {
  const t = toScope.trim();
  return t === "org" || parseScopeId(t).kind !== null ? { scope: t } : { recipient: t };
}

export interface ArtifactHome {
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  grantRef: string;
}

export interface ShareArtifactRequest {
  type: ArtifactType;
  id: string;
  scope?: string;
  recipient?: string;
  permission?: Permission;
  move?: boolean;
}

export type ShareArtifactResult =
  | {
      ok: true;
      verb: "share" | "move" | "promote";
      type: ArtifactType;
      id: string;
      target: { scope: ScopeId; label: string };
      permission: Permission;
    }
  | {
      ok: false;
      code: "bad_request" | "not_found" | "forbidden" | "recipient_not_found" | "ambiguous_recipient" | "share_failed";
      message: string;
      candidates?: Array<{ id: string; label: string }>;
    };
