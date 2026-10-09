import { parseScopeId, scopeId, type Principal, type ScopeId } from "../types.ts";
import type { ScopedConfigStore } from "./config-store.ts";

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
  "In this Slack channel you cannot use another person's private setup (their logins, keys, personal computer or files). " +
  'When a task needs it, ask that person\'s personal agent: POST /v1/ask-agent with {person: "U123", task}, using their Slack id from the People here line. ' +
  "Say exactly what to try and what result is safe to share back here; never ask for secrets. " +
  "They get a DM to approve, their agent runs only if they approve, and the result posts back in this thread. " +
  "Tell people you've asked only after the call returns ok; if it fails, say what failed. " +
  "Another agent in the channel is a colleague: @mention it instead.";

interface AskAgentConversation {
  surface?: string | undefined;
  scopeId: ScopeId;
  external: boolean;
}

export function askAgentConversation(c: AskAgentConversation): boolean {
  return c.surface === "slack" && !c.external && parseScopeId(c.scopeId).kind === "channel";
}

export async function askAgentAvailable(
  config: Pick<ScopedConfigStore, "resolveSharingPostureDurable"> | undefined,
  c: AskAgentConversation & { actorId: string },
): Promise<boolean> {
  if (!askAgentConversation(c)) return false;
  return (await config?.resolveSharingPostureDurable(scopeId("personal", c.actorId), c.scopeId)) !== "open";
}
