import type { TurnRequest } from "../types.ts";

const ONBOARDING_VERSION = "v2";

export const PROACTIVE_OPENER_PROMPT =
  "The user just opened the app for the first time and has not typed yet. Greet them by their sign-in name as their AI teammate; do not ask their name or role or research their work yet. Follow the onboarding skill. Do not mention Slack bot setup in this automatic greeting; wait for their reply before reading admin-only status. On that human-started turn, offer setup only to a verified org admin with a confirmed missing bot; silently skip existing, disabled, deferred, or unknown setup. For personal connections, discover authorized access using its existing skill and reuse connected accounts. An empty direct OAuth list does not rule out Composio. If no source is available or setup is deferred, skip connections and continue onboarding; do not ask them to create OAuth apps or supply project keys.";

export type OnboardingStatus = "completed" | "dismissed" | "pending" | "not_started";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markerRe(state: "completed" | "dismissed" | "pending", version: string): RegExp {
  return new RegExp(
    `(?:^|\\n)\\s*[-*]?\\s*(?:\\(\\d{4}-\\d\\d-\\d\\d\\)\\s*)?Onboarding:\\s*${state}\\s+${escapeRegExp(version)}\\b`,
    "i",
  );
}

export function detectOnboardingStatus(memory: string, version = ONBOARDING_VERSION): OnboardingStatus {
  if (markerRe("completed", version).test(memory)) return "completed";
  if (markerRe("dismissed", version).test(memory)) return "dismissed";
  if (markerRe("pending", version).test(memory)) return "pending";
  return "not_started";
}

function markerLineRe(version: string): RegExp {
  return new RegExp(
    `^[ \\t]*[-*]?[ \\t]*(?:\\(\\d{4}-\\d\\d-\\d\\d\\)\\s*)?Onboarding:\\s*(?:completed|dismissed|pending)\\s+${escapeRegExp(version)}\\b.*$`,
    "gim",
  );
}

export function setOnboardingStatus(
  memory: string,
  status: OnboardingStatus,
  today: string,
  version = ONBOARDING_VERSION,
): string {
  const base = memory
    .replace(markerLineRe(version), "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
  if (status === "not_started") return base ? base + "\n" : "";
  const line =
    status === "pending"
      ? `- Onboarding: pending ${version} since ${today}.`
      : `- Onboarding: ${status} ${version} on ${today}.`;
  return (base ? `${base}\n${line}` : line) + "\n";
}

export function isIdeasConversation(input: {
  surface?: string;
  conversation: Pick<TurnRequest["conversation"], "kind" | "threadRef">;
}): boolean {
  return (
    input.surface === "web" &&
    input.conversation.kind === "dm" &&
    /^web:.+:ideas:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.conversation.threadRef,
    )
  );
}
