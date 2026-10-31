import type { DurableMap } from "./persistence/durable-map.ts";
import { type ScopeId } from "./types.ts";
import { tenantRootScope } from "./tenants/context.ts";

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
  web_ui: {
    label: "Web UI sign-in",
    hint: "Lets the selected people sign in to the web UI. Enable it for the organization to let every member in. Turning it off signs them out on their next request.",
  },
  loops: {
    label: "Loops workspace (web UI)",
    personalOnly: true,
    hint: "Shows the full Loops workspace in the web UI. People also need Inbox Loops; without this flag they get Inbox and the loop ledger only.",
  },
  voice: {
    label: "Voice and dictation (web UI)",
    hint: "Turns on live voice and dictation in the web UI. The web UI also needs an OpenAI API key, and impersonated sessions never get voice.",
  },
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
  enabledFor(scope: ScopeId): Promise<ReadonlySet<FeatureName>>;
  setEnabled(featureName: FeatureName, scope: ScopeId, on: boolean, updatedBy: string): Promise<FeatureFlagRecord>;
}

function flagScope(scope: ScopeId): ScopeId {
  return scope.startsWith("personal:") && scope.includes("@") ? (scope.toLowerCase() as ScopeId) : scope;
}

export function createFeatureFlagStore(
  backing: DurableMap<FeatureFlagRecord>,
  opts: { now?: () => number } = {},
): FeatureFlagStore {
  const now = opts.now ?? Date.now;
  const key = (featureName: FeatureName) => featureName;
  const list = async () => (await backing.all()).filter((row) => FEATURE_NAMES.includes(row.featureName));
  const enabledFor = async (scope: ScopeId): Promise<ReadonlySet<FeatureName>> => {
    const wanted = flagScope(scope);
    return new Set(
      (await list())
        .filter((row) => row.enabledScopes.some((enabled) => enabled === tenantRootScope() || flagScope(enabled) === wanted))
        .map((row) => row.featureName),
    );
  };
  return {
    list,
    get: (featureName) => backing.get(key(featureName)),
    enabled: async (featureName, scope) => (await enabledFor(scope)).has(featureName),
    enabledFor,
    async setEnabled(featureName, scope, on, updatedBy) {
      if (!updatedBy.trim()) throw new Error("feature flag updater must not be empty");
      const current = await backing.get(key(featureName));
      const scopes = new Set((current?.enabledScopes ?? []).map(flagScope));
      if (on) scopes.add(flagScope(scope));
      else scopes.delete(flagScope(scope));
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
