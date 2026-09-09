import type { Principal, ScopeId } from "../types.ts";

export const SHARING_POSTURES = ["isolated", "open"] as const;
export type SharingPosture = (typeof SHARING_POSTURES)[number];

export function parseSharingPosture(value: unknown): SharingPosture | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (SHARING_POSTURES as readonly string[]).includes(normalized) ? (normalized as SharingPosture) : null;
}

export function composeSharingPosture(ceiling: SharingPosture, narrower?: SharingPosture | null): SharingPosture {
  return ceiling === "isolated" || narrower === "isolated" ? "isolated" : "open";
}

export function composeSharingPostures(
  ceiling: SharingPosture,
  narrower: readonly (SharingPosture | null | undefined)[],
): SharingPosture {
  return narrower.reduce<SharingPosture>(composeSharingPosture, ceiling);
}

export function renderSharingPosturePrompt(actor: Principal, sourceScopes: readonly ScopeId[]): string {
  if (sourceScopes.length === 0) return "";
  const actorLabel = actor.displayName?.trim() || actor.id;
  return `## Sharing posture: Open\nThis live request can read ${actorLabel}'s personally entitled resources from outside this conversation. Those sources are labelled by origin: ${sourceScopes.join(", ")}. Open access can reveal private information in a shared reply. Use only what this request needs, do not volunteer or repeat unrelated private information, and prefer this conversation's own sources when they are sufficient. File discovery is limited to 200 files and 25 shared contexts from the 100 most recent sessions. Files not listed, and binary files, require an explicit share. Access is read-only; writes, message history, credentials, approvals, security screening, and egress remain scoped normally.`;
}
