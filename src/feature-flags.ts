import type { DurableMap } from "./persistence/durable-map.ts";
import { orgId as configOrgId } from "./config.ts";
import { parseScopeId, scopeId, type ScopeId } from "./types.ts";

export const FEATURES = {
  app_annotations: {
    label: "App annotations",
    personalOnly: true,
    hint: "Enables app text comments and annotation tools for the selected people. Applies on the next app page load; app management permission is still required.",
  },
  personas: {
    label: "Bots",
    hint: "Lets the selected people create, share and chat with bots: reusable agents with their own instructions, skills and credentials.",
  },
  inbox_loops: { label: "Inbox Loops" },
  company_welcome: {
    label: "Company welcome",
    hint: "Shows the selected people their organization's activity seeds: the seeded welcome screen and the company's starting suggestions. Seeds can be stored while this is off.",
  },
  next_prompt_suggestions: {
    label: "Next-message suggestions (experimental)",
    personalOnly: true,
    hint: "After each reply in the web app, predicts the selected people's likely next message and shows it in their empty composer; Tab fills it in. Each suggestion is one extra model call on their conversation. Turning it on applies on their next page load.",
  },
  wake_reply_rewrite: {
    label: "Rewrite the last reply on subagent wakes (experimental)",
    personalOnly: true,
    hint: "In web conversations, when a subagent or another conversation starts a turn on behalf of one of the selected people, the agent's reply replaces the latest reply it wrote for that person since anyone last typed, instead of adding another message. In a shared chat, such as a project chat, a reply written for someone else is never replaced, and everyone there sees the result. Reports from crons and webhooks and replies to watch fires are never replaced. The replaced reply stays in the transcript; the iOS app and shared links still show every version. Applies from the next such turn.",
  },
  web_dm_spine: {
    label: "Web DM post and edit (experimental)",
    personalOnly: true,
    hint: "Runs the selected people's web DMs the way Slack threads run: the agent speaks only by posting, delegates substantial work to subagents, and edits its latest message when a subagent or another conversation brings news instead of adding a message below it. Edited versions stay in the transcript. Applies from their next turn.",
  },
  external_app_sharing: { label: "External app sharing (public links, outside emails)" },
  loop_triage: { label: "Loop triage (prioritize and consolidate)" },
  team_scopes: { label: "Team scopes" },
  ui_canvas: {
    label: "UI canvas and UI state (agent code runs in the page)",
    personalOnly: true,
    hint: "Lets the agent read the selected people's whole web UI and place live HTML/CSS/JS panels in their conversations. Canvas code runs unsandboxed in their page with their full session: it can do anything they can, including answering approvals. Personal scopes only. Turning it off stops canvases from loading on the next page load.",
  },
  web_notifications: {
    label: "Reply notifications (experimental)",
    personalOnly: true,
    hint: "Offers the selected people browser and desktop notifications for replies in web conversations they aren't viewing. Turning it off stops their notifications at the next reply; the prompt and setting disappear on their next page load.",
  },
} as const satisfies Record<string, { label: string; personalOnly?: boolean; hint?: string }>;
export type FeatureName = keyof typeof FEATURES;
export const FEATURE_NAMES = Object.keys(FEATURES) as FeatureName[];

export interface FeatureFlagRecord {
  featureName: FeatureName;
  enabledScopes: ScopeId[];
  updatedAt: number;
  updatedBy: string;
}

export interface FeatureFlagStore {
  list(): Promise<FeatureFlagRecord[]>;
  get(featureName: FeatureName): Promise<FeatureFlagRecord | null>;
  enabled(featureName: FeatureName, scope: ScopeId): Promise<boolean>;
  enabledFor(scope: ScopeId): Promise<ReadonlySet<FeatureName>>;
  setEnabled(featureName: FeatureName, scope: ScopeId, on: boolean, updatedBy: string): Promise<FeatureFlagRecord>;
}

export function createFeatureFlagStore(
  backing: DurableMap<FeatureFlagRecord>,
  opts: { now?: () => number } = {},
): FeatureFlagStore {
  const orgScope = scopeId("org", configOrgId());
  const now = opts.now ?? Date.now;
  const key = (featureName: FeatureName) => featureName;
  const list = async () => (await backing.all()).filter((row) => FEATURE_NAMES.includes(row.featureName));
  const enabledFor = async (scope: ScopeId): Promise<ReadonlySet<FeatureName>> =>
    new Set(
      (await list())
        .filter((row) => row.enabledScopes.includes(orgScope) || row.enabledScopes.includes(scope))
        .map((row) => row.featureName),
    );
  return {
    list,
    get: (featureName) => backing.get(key(featureName)),
    enabled: async (featureName, scope) => (await enabledFor(scope)).has(featureName),
    enabledFor,
    async setEnabled(featureName, scope, on, updatedBy) {
      if (!updatedBy.trim()) throw new Error("feature flag updater must not be empty");
      const current = await backing.get(key(featureName));
      const scopes = new Set(current?.enabledScopes ?? []);
      if (on) scopes.add(scope);
      else scopes.delete(scope);
      const record = {
        featureName,
        enabledScopes: [...scopes].sort(),
        updatedAt: now(),
        updatedBy,
      };
      await backing.put(key(featureName), record);
      return record;
    },
  };
}

export async function enabledPeople(
  flags: Pick<FeatureFlagStore, "get">,
  featureName: FeatureName,
): Promise<readonly string[] | "everyone"> {
  const scopes = (await flags.get(featureName))?.enabledScopes ?? [];
  if (scopes.includes(scopeId("org", configOrgId()))) return "everyone";
  return scopes.flatMap((scope) => {
    const parsed = parseScopeId(scope);
    return parsed.kind === "personal" ? [parsed.ref] : [];
  });
}

export const EXTERNAL_APP_SHARING_OFF =
  "sharing apps outside the organization is turned off; an org admin can enable the external_app_sharing flag";

export function externalAppSharingAllowed(
  flags: FeatureFlagStore | undefined,
  ownerScopeId: ScopeId,
): Promise<boolean> {
  return flags ? flags.enabled("external_app_sharing", ownerScopeId) : Promise.resolve(false);
}
