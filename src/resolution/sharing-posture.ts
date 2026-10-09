import { parseScopeId, type Principal, type ScopeId } from "../types.ts";

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
  return `## Sharing posture: Open\nThis live request can read ${actorLabel}'s personally entitled resources from outside this conversation. Those sources are labelled by origin: ${sourceScopes.toSorted().join(", ")}. Open access can reveal private information in a shared reply. Use only what this request needs, do not volunteer or repeat unrelated private information, and prefer this conversation's own sources when they are sufficient. File discovery is limited to 200 files and 25 shared contexts from the 100 most recent sessions. Files not listed, and binary files, require an explicit share. Carried context is read-only. In Open shared conversations the authenticated live speaker can use their own keychain on a separate disposable computer; other people's credentials and background jobs remain grant-gated. Writes, message history, approvals, security screening, and egress remain scoped normally.`;
}

export const ASK_AGENT_PROMPT =
  "For another person's private logins, keys or files, POST /v1/ask-agent {person: their Slack id, task}; they approve by DM. " +
  "Say you've asked only after it returns ok.";

interface AskAgentConversation {
  surface?: string | undefined;
  scopeId: ScopeId;
  external: boolean;
}

export function askAgentConversation(c: AskAgentConversation): boolean {
  return c.surface === "slack" && !c.external && parseScopeId(c.scopeId).kind === "channel";
}

export function askAgentAvailable(c: AskAgentConversation & { posture: SharingPosture | undefined }): boolean {
  return askAgentConversation(c) && c.posture !== "open";
}
