import type { SkillResolution } from "../skills/skill-store.ts";

const ONBOARDING_SKILL_NAME = "onboarding";
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

export function onboardingSkillVisible(skills: SkillResolution[]): boolean {
  return skills.some((r) => r.skill?.manifest.name === ONBOARDING_SKILL_NAME);
}

export function renderPendingOnboardingPrompt(status: OnboardingStatus, version = ONBOARDING_VERSION): string {
  if (status === "completed" || status === "dismissed") return "";
  const marker =
    status === "pending"
      ? `Memory says onboarding is pending for ${version}.`
      : `Memory has no onboarding completion marker for ${version}.`;
  return [
    "## Pending Onboarding",
    marker,
    "",
    "Onboarding is a high-priority setup task; already knowing who they are is no reason to skip it.",
    "",
    "Before ordinary work in this personal DM, read `skill://onboarding/SKILL.md` and follow its complete ordered flow. Keep each turn light, but do not confuse a greeting or existing profile data with completion.",
    "",
    `Use the \`memory\` tool as the source of truth. On completion or an explicit stop, preserve the notebook and add \`- Onboarding: completed ${version} on YYYY-MM-DD.\` so onboarding does not recur.`,
  ].join("\n");
}
