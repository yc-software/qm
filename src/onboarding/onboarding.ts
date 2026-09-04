import type { SkillResolution } from "../skills/skill-store.ts";

const ONBOARDING_SKILL_NAME = "onboarding";
const ONBOARDING_VERSION = "v2";

export const PROACTIVE_OPENER_PROMPT =
  "The user just opened the app for the first time and hasn't typed anything yet. You already know who they are from their sign-in (see \"Who you're talking to\") — open the conversation yourself: greet them by name as their AI teammate, briefly say what you can do, and start onboarding by walking them through connecting their accounts. Don't ask their name or role, and don't research them in this opening turn — the hello is just a hello; you'll learn their role from connected tools and the people directory later, once their accounts are connecting.";

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
    "Before ordinary work in this personal DM, read `skills/onboarding/SKILL.md` and follow its complete ordered flow. Keep each turn light, but do not confuse a greeting or existing profile data with completion.",
    "",
    `Use the \`memory\` tool as the source of truth. On completion or an explicit stop, preserve the notebook and add \`- Onboarding: completed ${version} on YYYY-MM-DD.\` so onboarding does not recur.`,
  ].join("\n");
}
