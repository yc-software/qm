import type { DeployAccessErrorCode } from "../deploy/deploy-service.ts";
import type { AppInvitation } from "../deploy/email-access.ts";
import { validEmail } from "../identity/external-members.ts";
import { orgId as configOrgId } from "../config.ts";
import {
  canonicalScopeId,
  isSharedScope,
  parseScopeId,
  scopeId,
  scopeLabel,
  type Permission,
  type ScopeId,
  type ScopeKind,
} from "../types.ts";
import type { ResourceKind } from "../acl/resource-ref.ts";
import type { RecipientResolution } from "../directory/directory-store.ts";

export const SHARED_SKILL_REFUSAL =
  "a skill in a shared scope can only be changed on a turn that carries a person's authority";

export function isMultiMemberSkillScope(scope: ScopeId): boolean {
  return isSharedScope(scope) || parseScopeId(scope).kind === "team";
}

const AUTHOR_PUBLISHED_SKILL_KINDS: Record<ScopeKind, boolean> = {
  personal: true,
  channel: true,
  group: true,
  persona: true,
  org: false,
  team: false,
};

export function authorPublishesSkill(scope: ScopeId): boolean {
  const { kind } = parseScopeId(scope);
  return kind !== null && AUTHOR_PUBLISHED_SKILL_KINDS[kind];
}

export interface SkillEditor {
  personAuthority?: boolean;
  botActor?: boolean;
}

export function sharedSkillRefused(homeScope: ScopeId, editor: SkillEditor | undefined): boolean {
  return isMultiMemberSkillScope(homeScope) && !carriesPersonAuthority(editor);
}

export function carriesPersonAuthority(c: { personAuthority?: boolean; botActor?: boolean } | undefined): boolean {
  return c?.botActor !== true && c?.personAuthority === true;
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
  input: { scope?: string; recipient?: string; email?: string },
  hints: { invalidScope: (scope: string) => string; targetRequired: string; allowEmail?: boolean },
): Promise<ResolvedShareTarget> {
  if (input.email !== undefined) {
    if (!hints.allowEmail) return { kind: "invalid", message: "email grants are only supported for app sharing" };
    if (input.scope !== undefined || input.recipient !== undefined)
      return { kind: "invalid", message: "pass only one of email, scope, or recipient" };
    const email = input.email.trim().toLowerCase();
    if (!validEmail(email)) return { kind: "invalid", message: "a valid email address is required" };
    return { kind: "ok", scope: scopeId("personal", email), label: email };
  }
  const scope = (input.scope ?? "").trim();
  const recipient = (input.recipient ?? "").trim();
  if (scope && recipient) return { kind: "invalid", message: "pass either scope or recipient, not both" };
  if (scope) {
    if (scope === "org") return { kind: "ok", scope: scopeId("org", configOrgId()), label: "everyone in the org" };
    if (parseScopeId(scope).kind === null) return { kind: "invalid", message: hints.invalidScope(scope) };
    return { kind: "ok", scope: canonicalScopeId(scope), label: scopeLabel(scope) };
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
  email?: string;
  permission?: Permission | "none";
  move?: boolean;
  notify?: boolean;
}

export interface ShareAccess {
  scope: ScopeId;
  permission: Permission;
  status?: "pending" | "on" | "edited";
}

export interface ShareOffers {
  org: boolean;
  manage: boolean;
  email: boolean;
  public: boolean;
}

export function shareOffers(type: ArtifactType, home: ArtifactHome): ShareOffers {
  return {
    org: type !== "skill",
    manage: type !== "cron" || !home.ownerScopeId.startsWith("personal:"),
    email: type === "deploy",
    public: type === "deploy",
  };
}

export type ShareAccessResult =
  | { ok: true; type: ArtifactType; id: string; owner: ScopeId; offers: ShareOffers; access: ShareAccess[] }
  | { ok: false; code: "not_found" | "forbidden"; message: string };

export type ShareArtifactResult =
  | {
      ok: true;
      verb: "share" | "unshare" | "move" | "promote";
      type: ArtifactType;
      id: string;
      target: { scope: ScopeId; label: string };
      permission: Permission;
      invitation?: AppInvitation;
      copy?: { id: string; enabled: boolean; existed: boolean; note?: string };
    }
  | {
      ok: false;
      code:
        | "bad_request"
        | "recipient_not_found"
        | "ambiguous_recipient"
        | "share_failed"
        | "approval_required"
        | DeployAccessErrorCode;
      message: string;
      candidates?: Array<{ id: string; label: string }>;
    };
