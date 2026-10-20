import type { DurableMap } from "./persistence/durable-map.ts";
import { orgId as configOrgId } from "./config.ts";
import { scopeId, type ScopeId } from "./types.ts";

export const FEATURES = {
  app_annotations: {
    label: "App annotations",
    personalOnly: true,
    hint: "Enables app text comments and annotation tools for the selected people. Applies on the next app page load; app management permission is still required.",
  },
  persistent_subagents: {
    label: "Persistent subagents",
    personalOnly: true,
    hint: "Persistent subagents are available for personal scopes only.",
  },
  responsive_spine: { label: "Responsive spine (delegation)", personalOnly: true },
  inbox_loops: { label: "Inbox Loops" },
  slack_loading_indicator: {
    label: "Slack loading indicator (experimental)",
    hint: "Shows an activity card in Slack threads, including background work and monitors. After five minutes, the card links to the web conversation. Everyone in a shared thread can see it. Top-level DMs stay unchanged. Turning this off leaves existing cards.",
  },
  external_app_sharing: { label: "External app sharing (public links, outside emails)" },
  loop_triage: { label: "Loop triage (prioritize and consolidate)" },
  swarms: { label: "Swarms", personalOnly: true },
  team_scopes: { label: "Team scopes" },
  ui_canvas: {
    label: "UI canvas and UI state (agent code runs in the page)",
    personalOnly: true,
    hint: "Lets the agent read the selected people's whole web UI and place live HTML/CSS/JS panels in their conversations. Canvas code runs unsandboxed in their page with their full session: it can do anything they can, including answering approvals. Personal scopes only. Turning it off stops canvases from loading on the next page load.",
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
  setEnabled(featureName: FeatureName, scope: ScopeId, on: boolean, updatedBy: string): Promise<FeatureFlagRecord>;
}

export function createFeatureFlagStore(
  backing: DurableMap<FeatureFlagRecord>,
  opts: { now?: () => number } = {},
): FeatureFlagStore {
  const orgScope = scopeId("org", configOrgId());
  const now = opts.now ?? Date.now;
  const key = (featureName: FeatureName) => featureName;
  return {
    list: async () => (await backing.all()).filter((row) => FEATURE_NAMES.includes(row.featureName)),
    get: (featureName) => backing.get(key(featureName)),
    async enabled(featureName, scope) {
      const row = await backing.get(key(featureName));
      return row?.enabledScopes.includes(orgScope) === true || row?.enabledScopes.includes(scope) === true;
    },
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

export const EXTERNAL_APP_SHARING_OFF =
  "sharing apps outside the organization is turned off; an org admin can enable the external_app_sharing flag";

export function externalAppSharingAllowed(
  flags: FeatureFlagStore | undefined,
  ownerScopeId: ScopeId,
): Promise<boolean> {
  return flags ? flags.enabled("external_app_sharing", ownerScopeId) : Promise.resolve(false);
}
