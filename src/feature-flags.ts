import { currentTenant } from "./tenants/context.ts";
import { createPgPool } from "./persistence/pg-pool.ts";
import { typedTableMigration } from "./persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "./tenants/migrations.ts";
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
  enabled(featureName: FeatureName, scope: ScopeId): Promise<boolean>;
  enabledFor(scope: ScopeId): Promise<ReadonlySet<FeatureName>>;
  setEnabled(featureName: FeatureName, scope: ScopeId, on: boolean, updatedBy: string): Promise<FeatureFlagRecord>;
  close?(): Promise<void>;
}

const FEATURE_FLAGS_MIGRATION = typedTableMigration({
  table: "feature_flags",
  columns: [
    "feature_name TEXT NOT NULL",
    "enabled_scopes TEXT[] NOT NULL",
    "updated_at BIGINT NOT NULL",
    "updated_by TEXT NOT NULL",
  ],
  primaryKey: ["feature_name"],
  backfill: {
    feature_name: "id",
    enabled_scopes: "ARRAY(SELECT jsonb_array_elements_text(json->'enabledScopes'))",
    updated_at: "(json->>'updatedAt')::bigint",
    updated_by: "json->>'updatedBy'",
  },
  where:
    "jsonb_typeof(json->'enabledScopes') = 'array' AND json->>'updatedAt' IS NOT NULL AND json->>'updatedBy' IS NOT NULL",
});

function validUpdater(updatedBy: string): void {
  if (!updatedBy.trim()) throw new Error("feature flag updater must not be empty");
}

function flagRecord(row: Record<string, unknown>): FeatureFlagRecord {
  return {
    featureName: row.feature_name as FeatureName,
    enabledScopes: row.enabled_scopes as ScopeId[],
    updatedAt: Number(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

export function createFeatureFlagStore(opts: { now?: () => number } = {}): FeatureFlagStore {
  const orgScope = scopeId("org", configOrgId());
  const now = opts.now ?? Date.now;
  const tenants = new Map<string, Map<string, FeatureFlagRecord>>();
  const rows = () => {
    const tenant = currentTenant();
    return tenants.get(tenant) ?? tenants.set(tenant, new Map()).get(tenant)!;
  };
  const current = () => [...rows().values()].filter((row) => FEATURE_NAMES.includes(row.featureName));
  const enabledFor = (scope: ScopeId): ReadonlySet<FeatureName> =>
    new Set(
      current()
        .filter((row) => row.enabledScopes.includes(orgScope) || row.enabledScopes.includes(scope))
        .map((row) => row.featureName),
    );
  return {
    list: async () => current(),
    enabled: async (featureName, scope) => enabledFor(scope).has(featureName),
    enabledFor: async (scope) => enabledFor(scope),
    async setEnabled(featureName, scope, on, updatedBy) {
      validUpdater(updatedBy);
      const scopes = new Set(rows().get(featureName)?.enabledScopes ?? []);
      if (on) scopes.add(scope);
      else scopes.delete(scope);
      const record = { featureName, enabledScopes: [...scopes].sort(), updatedAt: now(), updatedBy };
      rows().set(featureName, record);
      return record;
    },
  };
}

export function createPostgresFeatureFlagStore(
  connectionString: string,
  opts: { now?: () => number } = {},
): FeatureFlagStore {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, FEATURE_FLAGS_MIGRATION]);
  const orgScope = scopeId("org", configOrgId());
  const now = opts.now ?? Date.now;
  return {
    async list() {
      const rows = await q(
        `SELECT feature_name, enabled_scopes, updated_at, updated_by FROM feature_flags
          WHERE tenant_id = ${TENANT} AND feature_name = ANY($1) ORDER BY feature_name`,
        [FEATURE_NAMES],
      );
      return rows.map(flagRecord);
    },
    async enabled(featureName, scope) {
      const rows = await q(
        `SELECT 1 FROM feature_flags
          WHERE tenant_id = ${TENANT} AND feature_name = $1 AND enabled_scopes && ARRAY[$2, $3]::text[]`,
        [featureName, orgScope, scope],
      );
      return rows.length > 0;
    },
    async enabledFor(scope) {
      const rows = await q(
        `SELECT feature_name FROM feature_flags
          WHERE tenant_id = ${TENANT} AND feature_name = ANY($1) AND enabled_scopes && ARRAY[$2, $3]::text[]`,
        [FEATURE_NAMES, orgScope, scope],
      );
      return new Set(rows.map((row) => row.feature_name as FeatureName));
    },
    async setEnabled(featureName, scope, on, updatedBy) {
      validUpdater(updatedBy);
      const rows = await q(
        `INSERT INTO feature_flags(feature_name, enabled_scopes, updated_at, updated_by)
         VALUES ($1, CASE WHEN $3 THEN ARRAY[$2]::text[] ELSE ARRAY[]::text[] END, $4, $5)
         ON CONFLICT (tenant_id, feature_name) DO UPDATE SET
           enabled_scopes = ARRAY(
             SELECT s FROM (
               SELECT DISTINCT s FROM unnest(
                 CASE WHEN $3 THEN array_append(feature_flags.enabled_scopes, $2)
                      ELSE array_remove(feature_flags.enabled_scopes, $2) END
               ) AS s
             ) AS scopes ORDER BY s COLLATE "C"),
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by
         RETURNING feature_name, enabled_scopes, updated_at, updated_by`,
        [featureName, scope, on, now(), updatedBy],
      );
      return flagRecord(rows[0]!);
    },
    close,
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
