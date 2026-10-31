import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { tenantPolicies } from "../tenants/migrations.ts";

const TENANT_COLUMN = "tenant_id UUID NOT NULL DEFAULT qm_tenant_id() REFERENCES tenants";
const STAMP = "(SELECT id FROM tenants)";

const texts = (json: string) =>
  `CASE WHEN jsonb_typeof(${json}) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(${json})) END`;
const flag = (text = "json->>'on'") => `(${text})::boolean`;
const at = (text: string) => `to_timestamp(COALESCE((${text})::double precision, 0) / 1000)`;

const SCOPE_SOURCES: Array<[string, Record<string, string>]> = [
  ["command_policies", { command_mode: "json->'policy'->>'mode'", command_rules: "json->'policy'->'rules'" }],
  ["security_postures", { security_posture: "json->>'posture'" }],
  ["sharing_postures", { sharing_posture: "json->>'posture'" }],
  [
    "approval_grant_modes",
    { approval_session: flag("json->'modes'->>'session'"), approval_always: flag("json->'modes'->>'always'") },
  ],
  [
    "egress_policies",
    {
      egress_allowed_hosts: `COALESCE(${texts("json->'policy'->'allowedHosts'")}, '{}')`,
      egress_denied_hosts: texts("json->'policy'->'deniedHosts'"),
      egress_deny_private_networks: flag("json->'policy'->>'denyPrivateNetworks'"),
      egress_private_network_allowed_hosts: texts("json->'policy'->'privateNetworkAllowedHosts'"),
    },
  ],
  ["unfulfilled_insights_flag", { unfulfilled_insights: flag() }],
  ["external_slack_participants_flag", { external_slack_participants: flag() }],
  ["channel_header_pin_flag", { channel_header_pin: flag() }],
  ["webui_model_configs", { webui_models: texts("json->'ids'") }],
  ["ack_emoji", { ack_emoji: texts("json->'names'") }],
  [
    "branding_configs",
    {
      brand_accent: "json->'branding'->>'accent'",
      brand_mark: "json->'branding'->>'mark'",
      brand_mark_url: "json->'branding'->>'markUrl'",
      brand_self_label: "json->'branding'->>'selfLabel'",
      brand_org_name: "json->'branding'->>'orgName'",
    },
  ],
  ["browse_max_steps_configs", { browse_max_steps: "(json->>'steps')::integer" }],
  ["browse_model_configs", { browse_model: "json->>'modelId'" }],
  ["org_ambient_flag", { org_ambient: flag() }],
  ["interactive_fast_mode_flag", { interactive_fast_mode: flag() }],
  [
    "individual_model_auth_flag",
    {
      individual_model_auth: `CASE WHEN id LIKE 'org:%' THEN ${flag()} END`,
      model_account: `CASE WHEN id NOT LIKE 'org:%' AND ${flag()} THEN COALESCE(json->>'provider', 'personal') END`,
    },
  ],
  [
    "base_model_configs",
    {
      model_id: "json->>'modelId'",
      harness_id: "json->>'harnessId'",
      effort_level: "json->>'effortLevel'",
      fast_mode: flag("json->>'fastMode'"),
      runtime_revision: "(json->>'revision')::integer",
      org_revision: "(json->>'orgRevision')::integer",
    },
  ],
];

const OTHER_SOURCES = ["soul_configs", "soul_history", "approved_harness_configs", "auto_flagger_configs"];

const scopeBackfill = ([table, columns]: [string, Record<string, string>]) => {
  const names = Object.keys(columns);
  return `INSERT INTO scope_settings(tenant_id, scope_id, ${names.join(", ")})
    SELECT ${STAMP}, id, ${Object.values(columns).join(", ")} FROM ${table}
    ON CONFLICT (tenant_id, scope_id) DO UPDATE SET ${names.map((n) => `${n} = EXCLUDED.${n}`).join(", ")}`;
};

const soulRevisionsFrom = (source: string, scope: string, revision: string, where: string) =>
  `INSERT INTO soul_revisions(tenant_id, scope_id, version, content, updated_at, updated_by)
    SELECT ${STAMP}, ${scope}, (${revision}->>'version')::integer, ${revision}->>'content',
      ${at(`${revision}->>'updatedAt'`)}, ${revision}->>'updatedBy'
    ${source} WHERE ${where} ON CONFLICT DO NOTHING`;

const ORG_ROW = (table: string) => `(SELECT json FROM ${table} WHERE id LIKE 'org:%' LIMIT 1)`;

const CREATE_TABLES = [
  `CREATE TABLE scope_settings(
     ${TENANT_COLUMN},
     scope_id TEXT NOT NULL,
     command_mode TEXT,
     command_rules JSONB,
     security_posture TEXT,
     sharing_posture TEXT,
     approval_session BOOLEAN,
     approval_always BOOLEAN,
     egress_allowed_hosts TEXT[],
     egress_denied_hosts TEXT[],
     egress_deny_private_networks BOOLEAN,
     egress_private_network_allowed_hosts TEXT[],
     unfulfilled_insights BOOLEAN,
     external_slack_participants BOOLEAN,
     channel_header_pin BOOLEAN,
     webui_models TEXT[],
     ack_emoji TEXT[],
     brand_accent TEXT,
     brand_mark TEXT,
     brand_mark_url TEXT,
     brand_self_label TEXT,
     brand_org_name TEXT,
     browse_max_steps INTEGER,
     browse_model TEXT,
     model_account TEXT CHECK (model_account IN ('personal', 'anthropic', 'openai')),
     model_id TEXT,
     harness_id TEXT,
     effort_level TEXT,
     fast_mode BOOLEAN,
     runtime_revision INTEGER,
     org_revision INTEGER,
     org_ambient BOOLEAN,
     interactive_fast_mode BOOLEAN,
     individual_model_auth BOOLEAN,
     PRIMARY KEY (tenant_id, scope_id)
   )`,
  ...tenantPolicies("scope_settings"),
  `CREATE TABLE soul_revisions(
     ${TENANT_COLUMN},
     scope_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     content TEXT NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_by TEXT,
     PRIMARY KEY (tenant_id, scope_id, version)
   )`,
  ...tenantPolicies("soul_revisions"),
  `CREATE TABLE purpose_runtimes(
     ${TENANT_COLUMN},
     purpose TEXT NOT NULL CHECK (purpose IN ('cron', 'subagent', 'fallback')),
     harness_id TEXT NOT NULL,
     model_id TEXT NOT NULL,
     effort_level TEXT,
     fast_mode BOOLEAN,
     PRIMARY KEY (tenant_id, purpose)
   )`,
  ...tenantPolicies("purpose_runtimes"),
  `CREATE TABLE operator_settings(
     singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
     embedding_model_id TEXT,
     approved_harness_ids TEXT[],
     auto_flagger_harness_id TEXT,
     auto_flagger_model_id TEXT,
     auto_flagger_rubric TEXT,
     CHECK ((auto_flagger_harness_id IS NULL) = (auto_flagger_model_id IS NULL)
       AND (auto_flagger_model_id IS NULL) = (auto_flagger_rubric IS NULL))
   )`,
];

const BACKFILL = [
  ...SCOPE_SOURCES.map(scopeBackfill),
  `INSERT INTO purpose_runtimes(tenant_id, purpose, harness_id, model_id, effort_level, fast_mode)
    SELECT ${STAMP}, p.purpose, p.r->>'harnessId', p.r->>'modelId', p.r->>'effortLevel', ${flag("p.r->>'fastMode'")}
    FROM base_model_configs b
    CROSS JOIN LATERAL (VALUES ('cron', b.json->'cronRuntime'), ('subagent', b.json->'subagentRuntime'),
      ('fallback', b.json->'fallbackRuntime')) AS p(purpose, r)
    WHERE b.id LIKE 'org:%' AND p.r->>'harnessId' IS NOT NULL AND p.r->>'modelId' IS NOT NULL`,
  soulRevisionsFrom("FROM soul_configs s", "s.id", "s.json", "s.json->>'version' IS NOT NULL"),
  soulRevisionsFrom(
    `FROM soul_configs s CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(s.json->'history') = 'array' THEN s.json->'history' ELSE '[]' END) AS h(json)`,
    "s.id",
    "h.json",
    "(h.json->>'version')::integer < (s.json->>'version')::integer",
  ),
  soulRevisionsFrom(
    "FROM soul_history h JOIN soul_configs s ON s.id = h.json->>'scopeId'",
    "s.id",
    "h.json",
    "(h.json->>'version')::integer < (s.json->>'version')::integer",
  ),
  `INSERT INTO operator_settings(embedding_model_id, approved_harness_ids, auto_flagger_harness_id,
     auto_flagger_model_id, auto_flagger_rubric)
    SELECT ${ORG_ROW("base_model_configs")}->>'embeddingModelId', ${texts(`${ORG_ROW("approved_harness_configs")}->'ids'`)},
      f.json->>'harnessId', f.json->>'modelId', f.json->>'rubric'
    FROM (SELECT NULL) AS seed
    LEFT JOIN (SELECT json FROM auto_flagger_configs
      WHERE id LIKE 'org:%' AND json ?& ARRAY['harnessId', 'modelId', 'rubric'] LIMIT 1) AS f ON TRUE`,
];

const SOURCES = [...SCOPE_SOURCES.map(([table]) => table), ...OTHER_SOURCES];

export const CONFIG_TABLE_MIGRATIONS: readonly PgMigrationDefinition[] = [
  {
    id: "tenancy/config-store/0001-typed",
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      ...SOURCES.map((table) => `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, json JSONB NOT NULL)`),
      ...CREATE_TABLES,
      ...BACKFILL,
      ...SOURCES.map((table) => `DROP TABLE ${table}`),
      `DO $drop_versions$ BEGIN
         IF to_regclass('durable_map_versions') IS NOT NULL THEN
           DELETE FROM durable_map_versions WHERE tbl IN (${SOURCES.map((table) => `'${table}'`).join(", ")});
         END IF;
       END $drop_versions$`,
    ],
  },
  typedTableMigration({
    table: "connector_clients",
    columns: [
      "scope_id TEXT NOT NULL",
      "provider TEXT NOT NULL",
      "client_id TEXT NOT NULL",
      "secret_enc TEXT NOT NULL",
      "scopes TEXT[]",
      "redirect_allowlist TEXT[]",
      "consent_mode TEXT",
      "hosted_domain TEXT",
      "enabled BOOLEAN NOT NULL",
      "updated_by TEXT",
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()",
    ],
    primaryKey: ["scope_id", "provider"],
    backfill: {
      scope_id: "json->>'scopeId'",
      provider: "json->>'provider'",
      client_id: "json->>'clientId'",
      secret_enc: "json->>'secretEnc'",
      scopes: texts("json->'scopes'"),
      redirect_allowlist: texts("json->'redirectAllowlist'"),
      consent_mode: "json->>'consentMode'",
      hosted_domain: "json->>'hostedDomain'",
      enabled: `COALESCE(${flag("json->>'enabled'")}, TRUE)`,
      updated_by: "json->>'updatedBy'",
      updated_at: at("json->>'updatedAt'"),
    },
    where: "json ?& ARRAY['scopeId', 'provider', 'clientId', 'secretEnc']",
  }),
  typedTableMigration({
    table: "slack_emoji_catalog",
    columns: ["scope_id TEXT NOT NULL", "emoji JSONB NOT NULL", "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()"],
    primaryKey: ["scope_id"],
    backfill: { scope_id: "id", emoji: "COALESCE(json->'emoji', '{}')", updated_at: at("json->>'updatedAt'") },
  }),
];
