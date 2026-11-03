import { z } from "zod";
import { createPgPool, withPgTransaction, type Rows } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { StoredConnectorClient } from "../connectors/connector-client-store.ts";
import { SECURITY_POSTURES } from "../security/security-posture.ts";
import { SHARING_POSTURES } from "./sharing-posture.ts";
import {
  definedOnly,
  type ConfigTables,
  type RuntimePurpose,
  type RuntimeSelection,
  type ScopeSettings,
  type SoulRevision,
} from "./config-tables.ts";
import { CONFIG_TABLE_MIGRATIONS } from "./config-tables-migrations.ts";
import { TENANCY_BASE } from "../tenants/migrations.ts";

type Row = Rows[number];

const TENANT = "tenant_id = qm_bound_tenant()";

const SCOPE_COLUMNS = [
  "command_mode",
  "command_rules",
  "security_posture",
  "sharing_posture",
  "approval_session",
  "approval_always",
  "egress_allowed_hosts",
  "egress_denied_hosts",
  "egress_deny_private_networks",
  "egress_private_network_allowed_hosts",
  "unfulfilled_insights",
  "external_slack_participants",
  "channel_header_pin",
  "webui_models",
  "ack_emoji",
  "brand_accent",
  "brand_mark",
  "brand_mark_url",
  "brand_self_label",
  "brand_org_name",
  "browse_max_steps",
  "spend_daily_usd",
  "spend_monthly_usd",
  "browse_model",
  "model_account",
  "model_id",
  "effort_level",
  "fast_mode",
  "runtime_revision",
  "org_revision",
  "org_ambient",
  "interactive_fast_mode",
  "individual_model_auth",
  "embedding_model_id",
] as const;

const cell = <T extends z.ZodType>(type: T) => type.nullish().transform((v) => v ?? undefined);
const strings = cell(z.array(z.string()));
const flag = cell(z.boolean());
const int = cell(z.number());
const text = cell(z.string());

const SCOPE_ROW = z.object({
  scope_id: z.string(),
  command_mode: cell(z.enum(["denylist", "allowlist"])),
  command_rules: cell(
    z.array(
      z.object({
        pattern: z.string(),
        decision: z.enum(["allow", "deny", "require_approval"]),
        reason: z.string().optional(),
      }),
    ),
  ),
  security_posture: cell(z.enum(SECURITY_POSTURES)),
  sharing_posture: cell(z.enum(SHARING_POSTURES)),
  approval_session: flag,
  approval_always: flag,
  egress_allowed_hosts: strings,
  egress_denied_hosts: strings,
  egress_deny_private_networks: flag,
  egress_private_network_allowed_hosts: strings,
  unfulfilled_insights: flag,
  external_slack_participants: flag,
  channel_header_pin: flag,
  webui_models: strings,
  ack_emoji: strings,
  brand_accent: text,
  brand_mark: text,
  brand_mark_url: text,
  brand_self_label: text,
  brand_org_name: text,
  browse_max_steps: int,
  spend_daily_usd: int,
  spend_monthly_usd: int,
  browse_model: text,
  model_account: cell(z.enum(["personal", "anthropic", "openai"])),
  model_id: text,
  effort_level: text,
  fast_mode: flag,
  runtime_revision: int,
  org_revision: int,
  org_ambient: flag,
  interactive_fast_mode: flag,
  individual_model_auth: flag,
  embedding_model_id: text,
});

function scopeFromRow(row: Row): [ScopeId, ScopeSettings] {
  const r = SCOPE_ROW.parse(row);
  const branded = [r.brand_accent, r.brand_mark, r.brand_mark_url, r.brand_self_label, r.brand_org_name];
  return [
    r.scope_id,
    definedOnly<ScopeSettings>({
      commandPolicy: r.command_mode ? { mode: r.command_mode, rules: r.command_rules ?? [] } : undefined,
      securityPosture: r.security_posture,
      sharingPosture: r.sharing_posture,
      approvalGrantModes:
        r.approval_session === undefined
          ? undefined
          : { session: r.approval_session, always: r.approval_always === true },
      egress: r.egress_allowed_hosts
        ? definedOnly({
            allowedHosts: r.egress_allowed_hosts,
            deniedHosts: r.egress_denied_hosts,
            denyPrivateNetworks: r.egress_deny_private_networks,
            privateNetworkAllowedHosts: r.egress_private_network_allowed_hosts,
          })
        : undefined,
      unfulfilledInsights: r.unfulfilled_insights,
      externalSlackParticipants: r.external_slack_participants,
      channelHeaderPin: r.channel_header_pin,
      webuiModels: r.webui_models,
      ackEmoji: r.ack_emoji,
      branding: branded.some((v) => v !== undefined)
        ? definedOnly({
            accent: r.brand_accent,
            mark: r.brand_mark,
            markUrl: r.brand_mark_url,
            selfLabel: r.brand_self_label,
            orgName: r.brand_org_name,
          })
        : undefined,
      browseMaxSteps: r.browse_max_steps,
      spendLimit:
        r.spend_daily_usd === undefined && r.spend_monthly_usd === undefined
          ? undefined
          : definedOnly({ dailyUsd: r.spend_daily_usd, monthlyUsd: r.spend_monthly_usd }),
      browseModel: r.browse_model,
      modelAccount: r.model_account,
      modelId: r.model_id,
      effortLevel: r.effort_level,
      fastMode: r.fast_mode,
      revision: r.runtime_revision,
      orgRevision: r.org_revision,
      orgAmbient: r.org_ambient,
      interactiveFastMode: r.interactive_fast_mode,
      individualModelAuth: r.individual_model_auth,
      embeddingModelId: r.embedding_model_id,
    }),
  ];
}

function scopeToColumns(s: ScopeSettings): unknown[] {
  return [
    s.commandPolicy?.mode,
    s.commandPolicy ? JSON.stringify(s.commandPolicy.rules) : undefined,
    s.securityPosture,
    s.sharingPosture,
    s.approvalGrantModes?.session,
    s.approvalGrantModes?.always,
    s.egress?.allowedHosts,
    s.egress?.deniedHosts,
    s.egress?.denyPrivateNetworks,
    s.egress?.privateNetworkAllowedHosts,
    s.unfulfilledInsights,
    s.externalSlackParticipants,
    s.channelHeaderPin,
    s.webuiModels,
    s.ackEmoji,
    s.branding?.accent,
    s.branding?.mark,
    s.branding?.markUrl,
    s.branding?.selfLabel,
    s.branding?.orgName,
    s.browseMaxSteps,
    s.spendLimit?.dailyUsd,
    s.spendLimit?.monthlyUsd,
    s.browseModel,
    s.modelAccount,
    s.modelId,
    s.effortLevel,
    s.fastMode,
    s.revision,
    s.orgRevision,
    s.orgAmbient,
    s.interactiveFastMode,
    s.individualModelAuth,
    s.embeddingModelId,
  ].map((cell) => cell ?? null);
}

const SOUL_ROW = z.object({
  scope_id: z.string(),
  content: z.string(),
  version: z.number(),
  updated_at: z.date(),
  updated_by: text,
  session_id: text,
});

const soulFromRow = (row: Row): SoulRevision => {
  const r = SOUL_ROW.parse(row);
  return definedOnly({
    scopeId: r.scope_id,
    content: r.content,
    version: r.version,
    updatedAt: r.updated_at.getTime(),
    updatedBy: r.updated_by,
    sessionId: r.session_id,
  });
};

const CONNECTOR_ROW = z.object({
  scope_id: z.string(),
  provider: z.string(),
  client_id: z.string(),
  secret_enc: z.string(),
  scopes: strings,
  redirect_allowlist: strings,
  consent_mode: cell(z.enum(["standard", "admin", "github_app"])),
  hosted_domain: text,
  enabled: z.boolean(),
  updated_by: text,
  updated_at: z.date(),
});

const connectorFromRow = (row: Row): StoredConnectorClient => {
  const r = CONNECTOR_ROW.parse(row);
  return definedOnly({
    scopeId: r.scope_id,
    provider: r.provider,
    clientId: r.client_id,
    secretEnc: r.secret_enc,
    scopes: r.scopes,
    redirectAllowlist: r.redirect_allowlist,
    consentMode: r.consent_mode,
    hostedDomain: r.hosted_domain,
    enabled: r.enabled,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at.getTime(),
  });
};

const PURPOSE_ROW = z.object({
  purpose: z.enum(["cron", "subagent", "fallback"]),
  model_id: z.string(),
  effort_level: text,
  fast_mode: flag,
});

const purposeFromRow = (row: Row): [RuntimePurpose, RuntimeSelection] => {
  const r = PURPOSE_ROW.parse(row);
  return [r.purpose, definedOnly({ modelId: r.model_id, effortLevel: r.effort_level, fastMode: r.fast_mode })];
};

const EMOJI_ROW = z.object({ emoji: z.record(z.string(), z.string()), updated_at: z.date() });

const SCOPE_SELECT = `SELECT scope_id, ${SCOPE_COLUMNS.join(", ")} FROM scope_settings WHERE ${TENANT}`;
const SCOPE_UPDATE = `UPDATE scope_settings SET ${SCOPE_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(", ")}
  WHERE ${TENANT} AND scope_id = $1`;
const soulSelect = (scoped: boolean) => `SELECT scope_id, version, content, updated_at, updated_by, session_id FROM (
    SELECT *, row_number() OVER (PARTITION BY scope_id ORDER BY version DESC) AS rank
    FROM soul_revisions WHERE ${TENANT}${scoped ? " AND scope_id = ANY($2)" : ""}
  ) ranked WHERE rank <= $1 ORDER BY scope_id, version DESC`;
const SOUL_APPEND = `INSERT INTO soul_revisions(scope_id, version, content, updated_at, updated_by, session_id)
  SELECT $1, $2, $3, to_timestamp($4::double precision / 1000), $5, $8
  WHERE GREATEST(COALESCE((SELECT max(version) FROM soul_revisions WHERE ${TENANT} AND scope_id = $1), 0), $7) = $6
  ON CONFLICT DO NOTHING RETURNING version`;
const CONNECTOR_COLUMNS = `scope_id, provider, client_id, secret_enc, scopes, redirect_allowlist, consent_mode,
  hosted_domain, enabled, updated_by, updated_at`;

export function createPostgresConfigTables(databaseUrl: string): ConfigTables {
  const db = createPgPool(databaseUrl, [TENANCY_BASE, ...CONFIG_TABLE_MIGRATIONS]);
  return {
    close: () => db.close(),
    scopeSettings: async (ids) =>
      (await (ids ? db.q(`${SCOPE_SELECT} AND scope_id = ANY($1)`, [ids]) : db.q(SCOPE_SELECT))).map(scopeFromRow),
    async scopeSetting(id) {
      const [row] = await db.q(`${SCOPE_SELECT} AND scope_id = $1`, [id]);
      return row ? scopeFromRow(row)[1] : null;
    },
    async updateScopeSetting(id, fn) {
      return withPgTransaction(await db.pool(), async (client) => {
        await client.query(`INSERT INTO scope_settings(scope_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
        const { rows } = await client.query(`${SCOPE_SELECT} AND scope_id = $1 FOR UPDATE`, [id]);
        const next = definedOnly(fn(scopeFromRow(rows[0]!)[1]));
        await client.query(SCOPE_UPDATE, [id, ...scopeToColumns(next)]);
        return next;
      });
    },
    soulRevisions: async (perScope, ids) =>
      (await (ids ? db.q(soulSelect(true), [perScope, ids]) : db.q(soulSelect(false), [perScope]))).map(soulFromRow),
    async appendSoul(r, expectedVersion, baseVersion) {
      const params = [
        r.scopeId,
        r.version,
        r.content,
        r.updatedAt,
        r.updatedBy ?? null,
        expectedVersion,
        baseVersion,
        r.sessionId ?? null,
      ];
      return (await db.q(SOUL_APPEND, params)).length === 1;
    },
    async purposeRuntimes() {
      const rows = await db.q(
        `SELECT purpose, model_id, effort_level, fast_mode FROM purpose_runtimes WHERE ${TENANT}`,
      );
      return Object.fromEntries(rows.map(purposeFromRow));
    },
    async setPurposeRuntime(purpose, s) {
      if (!s) {
        await db.q(`DELETE FROM purpose_runtimes WHERE ${TENANT} AND purpose = $1`, [purpose]);
        return;
      }
      await db.q(
        `INSERT INTO purpose_runtimes(purpose, model_id, effort_level, fast_mode) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, purpose) DO UPDATE SET model_id = EXCLUDED.model_id,
           effort_level = EXCLUDED.effort_level, fast_mode = EXCLUDED.fast_mode`,
        [purpose, s.modelId, s.effortLevel ?? null, s.fastMode ?? null],
      );
    },
    connectorClients: async (id) =>
      (
        await db.q(
          `SELECT ${CONNECTOR_COLUMNS} FROM connector_clients WHERE ${TENANT} AND scope_id = $1 ORDER BY provider`,
          [id],
        )
      ).map(connectorFromRow),
    async connectorClient(id, provider) {
      const [row] = await db.q(
        `SELECT ${CONNECTOR_COLUMNS} FROM connector_clients WHERE ${TENANT} AND scope_id = $1 AND provider = $2`,
        [id, provider],
      );
      return row ? connectorFromRow(row) : null;
    },
    async putConnectorClient(c) {
      await db.q(
        `INSERT INTO connector_clients(${CONNECTOR_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11::double precision / 1000))
         ON CONFLICT (tenant_id, scope_id, provider) DO UPDATE SET client_id = EXCLUDED.client_id,
           secret_enc = EXCLUDED.secret_enc, scopes = EXCLUDED.scopes, redirect_allowlist = EXCLUDED.redirect_allowlist,
           consent_mode = EXCLUDED.consent_mode, hosted_domain = EXCLUDED.hosted_domain, enabled = EXCLUDED.enabled,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [
          c.scopeId,
          c.provider,
          c.clientId,
          c.secretEnc,
          c.scopes ?? null,
          c.redirectAllowlist ?? null,
          c.consentMode ?? null,
          c.hostedDomain ?? null,
          c.enabled,
          c.updatedBy ?? null,
          c.updatedAt,
        ],
      );
    },
    async deleteConnectorClient(id, provider) {
      await db.q(`DELETE FROM connector_clients WHERE ${TENANT} AND scope_id = $1 AND provider = $2`, [id, provider]);
    },
    async slackEmojiCatalog(id) {
      const [row] = await db.q(
        `SELECT scope_id, emoji, updated_at FROM slack_emoji_catalog WHERE ${TENANT} AND scope_id = $1`,
        [id],
      );
      if (!row) return null;
      const { emoji, updated_at } = EMOJI_ROW.parse(row);
      return { scopeId: id, emoji, updatedAt: updated_at.getTime() };
    },
    async claimOrg(orgId) {
      await db.q(`INSERT INTO deployment_identity(org_id) VALUES ($1) ON CONFLICT DO NOTHING`, [orgId]);
      const [row] = await db.q(`SELECT org_id FROM deployment_identity WHERE ${TENANT}`);
      return z.string().parse(row?.org_id);
    },
    async putSlackEmojiCatalog(c) {
      await db.q(
        `INSERT INTO slack_emoji_catalog(scope_id, emoji, updated_at) VALUES ($1, $2, to_timestamp($3::double precision / 1000))
         ON CONFLICT (tenant_id, scope_id) DO UPDATE SET emoji = EXCLUDED.emoji, updated_at = EXCLUDED.updated_at`,
        [c.scopeId, JSON.stringify(c.emoji), c.updatedAt],
      );
    },
  };
}
