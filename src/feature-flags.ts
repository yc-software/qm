import { createPgPool, tenantCols } from "./persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "./persistence/typed-table.ts";
import type { ScopeId } from "./types.ts";
import { tenant } from "./tenant.ts";

export const FEATURES = {
  app_annotations: {
    label: "App annotations",
    personalOnly: true,
    hint: "Enables app text comments and annotation tools for the selected people. Applies on the next app page load; app management permission is still required.",
  },
  responsive_spine: { label: "Responsive spine (delegation)", personalOnly: true },
  inbox_loops: { label: "Inbox" },
  slack_loading_indicator: {
    label: "Slack loading indicator (experimental)",
    hint: "Shows an activity card in Slack threads, including background work and monitors. After five minutes, the card links to the web conversation. Everyone in a shared thread can see it. Top-level DMs stay unchanged. Turning this off leaves existing cards.",
  },
  external_app_sharing: { label: "External app sharing (public links, outside emails)" },
  team_scopes: { label: "Team scopes" },
  ui_canvas: {
    label: "UI canvas and UI state (agent code runs in the page)",
    personalOnly: true,
    hint: "Lets the agent read the selected people's whole web UI and place live HTML/CSS/JS panels in their conversations. Canvas code runs unsandboxed in their page with their full session: it can do anything they can, including answering approvals. Personal scopes only. Turning it off stops canvases from loading on the next page load.",
  },
} as const satisfies Record<string, { label: string; personalOnly?: boolean; hint?: string }>;
export type FeatureName = keyof typeof FEATURES;
export const FEATURE_NAMES = Object.keys(FEATURES) as FeatureName[];

interface FeatureFlagRecord {
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

const FEATURE_FLAGS: TableSpec = {
  table: "feature_flags",
  key: "featureName",
  keyIsField: true,
  columns: cols(`enabledScopes text[]!, updatedAt bigint!, updatedBy text!`),
};

const FEATURE_FLAGS_MIGRATION = mapToTableMigration("feature-flags/store/0001-typed", FEATURE_FLAGS);

export function createFeatureFlagStore(databaseUrl: string, opts: { now?: () => number } = {}): FeatureFlagStore {
  const now = opts.now ?? Date.now;
  const pg = createPgPool(databaseUrl, [FEATURE_FLAGS_MIGRATION]);
  const { codec, ...table } = typedTable<FeatureFlagRecord>(pg, FEATURE_FLAGS);
  return {
    list: async () => (await table.all()).filter((row) => FEATURE_NAMES.includes(row.featureName)),
    get: table.get,
    async enabled(featureName, scope) {
      const row = await table.get(featureName);
      return row?.enabledScopes.includes(tenant().orgScope) === true || row?.enabledScopes.includes(scope) === true;
    },
    async setEnabled(featureName, scope, on, updatedBy) {
      if (!updatedBy.trim()) throw new Error("feature flag updater must not be empty");
      const rows = await pg.q(
        `INSERT INTO feature_flags (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols("feature_name")}) DO UPDATE SET
           enabled_scopes = ARRAY(SELECT s FROM unnest(array_remove(feature_flags.enabled_scopes, $5) || EXCLUDED.enabled_scopes) s
             GROUP BY s ORDER BY s COLLATE "C"),
           updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
         RETURNING ${codec.columns}`,
        [
          ...codec.values(featureName, {
            featureName,
            enabledScopes: on ? [scope] : [],
            updatedAt: now(),
            updatedBy,
          }),
          scope,
        ],
      );
      return codec.row(rows[0]!);
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
