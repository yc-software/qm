import { orgId as configOrgId } from "./config.ts";
import { createPgPool } from "./persistence/pg-pool.ts";
import { currentTenant } from "./tenants/context.ts";
import { FEATURE_FLAGS_MIGRATION, TENANCY_BASE, TENANT } from "./tenants/migrations.ts";
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
  enabledFor(scope: ScopeId): Promise<ReadonlySet<FeatureName>>;
  setEnabled(featureName: FeatureName, scope: ScopeId, on: boolean, updatedBy: string): Promise<FeatureFlagRecord>;
}

export interface FeatureFlagBacking {
  all(): Promise<FeatureFlagRecord[]>;
  get(featureName: string): Promise<FeatureFlagRecord | null>;
  put(featureName: string, record: FeatureFlagRecord): Promise<void>;
}

const FLAG_CACHE_MS = 2_000;

export function postgresFeatureFlags(databaseUrl: string, now: () => number = Date.now): FeatureFlagBacking {
  const db = createPgPool(databaseUrl, [TENANCY_BASE, FEATURE_FLAGS_MIGRATION]);
  const cached = new Map<string, { at: number; rows: Promise<FeatureFlagRecord[]> }>();
  const load = async (): Promise<FeatureFlagRecord[]> =>
    (
      await db.q(
        `SELECT feature_name, enabled_scopes, (extract(epoch FROM updated_at) * 1000)::bigint AS updated_at, updated_by
         FROM feature_flags WHERE tenant_id = ${TENANT} ORDER BY feature_name`,
      )
    ).map((row) => ({
      featureName: row.feature_name as FeatureName,
      enabledScopes: row.enabled_scopes as ScopeId[],
      updatedAt: Number(row.updated_at),
      updatedBy: String(row.updated_by),
    }));
  const all = (): Promise<FeatureFlagRecord[]> => {
    const tenant = currentTenant();
    const hit = cached.get(tenant);
    if (hit && now() - hit.at < FLAG_CACHE_MS) return hit.rows;
    const entry = { at: now(), rows: load() };
    cached.set(tenant, entry);
    entry.rows.catch(() => {
      if (cached.get(tenant) === entry) cached.delete(tenant);
    });
    return entry.rows;
  };
  return {
    all,
    get: async (featureName) => (await all()).find((row) => row.featureName === featureName) ?? null,
    async put(featureName, record) {
      const tenant = currentTenant();
      cached.delete(tenant);
      await db.q(
        `INSERT INTO feature_flags(tenant_id, feature_name, enabled_scopes, updated_at, updated_by)
         VALUES (${TENANT}, $1, $2, to_timestamp($3::double precision / 1000), $4)
         ON CONFLICT (tenant_id, feature_name) DO UPDATE
           SET enabled_scopes = EXCLUDED.enabled_scopes, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [featureName, record.enabledScopes, record.updatedAt, record.updatedBy],
      );
      cached.delete(tenant);
    },
  };
}

export function createFeatureFlagStore(
  backing: FeatureFlagBacking,
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

export const EXTERNAL_APP_SHARING_OFF =
  "sharing apps outside the organization is turned off; an org admin can enable the external_app_sharing flag";

export function externalAppSharingAllowed(
  flags: FeatureFlagStore | undefined,
  ownerScopeId: ScopeId,
): Promise<boolean> {
  return flags ? flags.enabled("external_app_sharing", ownerScopeId) : Promise.resolve(false);
}
