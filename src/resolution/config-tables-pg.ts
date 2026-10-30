import { createPgPool, withPgTransaction, type Rows } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { StoredConnectorClient } from "../connectors/connector-client-store.ts";
import type { SecurityPosture } from "../security/security-posture.ts";
import type { SharingPosture } from "./sharing-posture.ts";
import {
  definedOnly,
  type ConfigTables,
  type OperatorSettings,
  type RuntimePurpose,
  type RuntimeSelection,
  type ScopeSettings,
  type SoulRevision,
} from "./config-tables.ts";
import { CONFIG_TABLE_MIGRATIONS } from "./config-tables-migrations.ts";
import { TENANCY_BASE } from "../tenants/migrations.ts";

type Row = Rows[number];

const TENANT = "tenant_id = qm_tenant_id()";

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
  "browse_model",
  "model_account",
  "model_id",
  "harness_id",
  "effort_level",
  "fast_mode",
  "runtime_revision",
  "org_revision",
  "org_ambient",
  "interactive_fast_mode",
  "individual_model_auth",
] as const;

const value = <T>(cell: unknown): T | undefined => (cell === null || cell === undefined ? undefined : (cell as T));
const millis = (cell: unknown): number => (cell instanceof Date ? cell.getTime() : Number(cell));

function scopeFromRow(r: Row): ScopeSettings {
  const has = (...names: string[]) => names.some((name) => r[name] !== null && r[name] !== undefined);
  return definedOnly<ScopeSettings>({
    commandPolicy: has("command_mode")
      ? { mode: r.command_mode as never, rules: (r.command_rules ?? []) as never }
      : undefined,
    securityPosture: value<SecurityPosture>(r.security_posture),
    sharingPosture: value<SharingPosture>(r.sharing_posture),
    approvalGrantModes: has("approval_session")
      ? { session: r.approval_session === true, always: r.approval_always === true }
      : undefined,
    egress: has("egress_allowed_hosts")
      ? definedOnly({
          allowedHosts: r.egress_allowed_hosts as string[],
          deniedHosts: value<string[]>(r.egress_denied_hosts),
          denyPrivateNetworks: value<boolean>(r.egress_deny_private_networks),
          privateNetworkAllowedHosts: value<string[]>(r.egress_private_network_allowed_hosts),
        })
      : undefined,
    unfulfilledInsights: value(r.unfulfilled_insights),
    externalSlackParticipants: value(r.external_slack_participants),
    channelHeaderPin: value(r.channel_header_pin),
    webuiModels: value(r.webui_models),
    ackEmoji: value(r.ack_emoji),
    branding: has("brand_accent", "brand_mark", "brand_mark_url", "brand_self_label", "brand_org_name")
      ? definedOnly({
          accent: value<string>(r.brand_accent),
          mark: value<string>(r.brand_mark),
          markUrl: value<string>(r.brand_mark_url),
          selfLabel: value<string>(r.brand_self_label),
          orgName: value<string>(r.brand_org_name),
        })
      : undefined,
    browseMaxSteps: value(r.browse_max_steps),
    browseModel: value(r.browse_model),
    modelAccount: value(r.model_account),
    modelId: value(r.model_id),
    harnessId: value(r.harness_id),
    effortLevel: value(r.effort_level),
    fastMode: value(r.fast_mode),
    revision: value(r.runtime_revision),
    orgRevision: value(r.org_revision),
    orgAmbient: value(r.org_ambient),
    interactiveFastMode: value(r.interactive_fast_mode),
    individualModelAuth: value(r.individual_model_auth),
  });
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
    s.browseModel,
    s.modelAccount,
    s.modelId,
    s.harnessId,
    s.effortLevel,
    s.fastMode,
    s.revision,
    s.orgRevision,
    s.orgAmbient,
    s.interactiveFastMode,
    s.individualModelAuth,
  ].map((cell) => cell ?? null);
}

const soulFromRow = (r: Row): SoulRevision =>
  definedOnly({
    scopeId: r.scope_id as ScopeId,
    content: String(r.content),
    version: Number(r.version),
    updatedAt: millis(r.updated_at),
    updatedBy: value<string>(r.updated_by),
  });

const connectorFromRow = (r: Row): StoredConnectorClient =>
  definedOnly({
    scopeId: String(r.scope_id),
    provider: String(r.provider),
    clientId: String(r.client_id),
    secretEnc: String(r.secret_enc),
    scopes: value<string[]>(r.scopes),
    redirectAllowlist: value<string[]>(r.redirect_allowlist),
    consentMode: value<StoredConnectorClient["consentMode"]>(r.consent_mode),
    hostedDomain: value<string>(r.hosted_domain),
    enabled: r.enabled === true,
    updatedBy: value<string>(r.updated_by),
    updatedAt: millis(r.updated_at),
  });

const operatorFromRow = (r: Row | undefined): OperatorSettings =>
  definedOnly({
    embeddingModelId: value<string>(r?.embedding_model_id),
    approvedHarnesses: value<string[]>(r?.approved_harness_ids),
    autoFlagger:
      r?.auto_flagger_harness_id != null
        ? {
            harnessId: String(r.auto_flagger_harness_id),
            modelId: String(r.auto_flagger_model_id),
            rubric: String(r.auto_flagger_rubric),
          }
        : undefined,
  });

const selectionFromRow = (r: Row): RuntimeSelection =>
  definedOnly({
    harnessId: String(r.harness_id),
    modelId: String(r.model_id),
    effortLevel: value<string>(r.effort_level),
    fastMode: value<boolean>(r.fast_mode),
  });

const SCOPE_SELECT = `SELECT scope_id, ${SCOPE_COLUMNS.join(", ")} FROM scope_settings WHERE ${TENANT}`;
const SCOPE_UPDATE = `UPDATE scope_settings SET ${SCOPE_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(", ")}
  WHERE ${TENANT} AND scope_id = $1`;
const soulSelect = (scoped: boolean) => `SELECT scope_id, version, content, updated_at, updated_by FROM (
    SELECT *, row_number() OVER (PARTITION BY scope_id ORDER BY version DESC) AS rank
    FROM soul_revisions WHERE ${TENANT}${scoped ? " AND scope_id = ANY($2)" : ""}
  ) ranked WHERE rank <= $1 ORDER BY scope_id, version DESC`;
const SOUL_APPEND = `INSERT INTO soul_revisions(scope_id, version, content, updated_at, updated_by)
  SELECT $1, $2, $3, to_timestamp($4::double precision / 1000), $5
  WHERE GREATEST(COALESCE((SELECT max(version) FROM soul_revisions WHERE ${TENANT} AND scope_id = $1), 0), $7) = $6
  ON CONFLICT DO NOTHING RETURNING version`;
const CONNECTOR_COLUMNS = `scope_id, provider, client_id, secret_enc, scopes, redirect_allowlist, consent_mode,
  hosted_domain, enabled, updated_by, updated_at`;

export function createPostgresConfigTables(databaseUrl: string): ConfigTables {
  const db = createPgPool(databaseUrl, [TENANCY_BASE, ...CONFIG_TABLE_MIGRATIONS]);
  return {
    persistent: true,
    close: () => db.close(),
    scopeSettings: async (ids) =>
      (await (ids ? db.q(`${SCOPE_SELECT} AND scope_id = ANY($1)`, [ids]) : db.q(SCOPE_SELECT))).map(
        (r) => [r.scope_id as ScopeId, scopeFromRow(r)] as [ScopeId, ScopeSettings],
      ),
    async scopeSetting(id) {
      const [row] = await db.q(`${SCOPE_SELECT} AND scope_id = $1`, [id]);
      return row ? scopeFromRow(row) : null;
    },
    async updateScopeSetting(id, fn) {
      return withPgTransaction(await db.pool(), async (client) => {
        await client.query(`INSERT INTO scope_settings(scope_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
        const { rows } = await client.query(`${SCOPE_SELECT} AND scope_id = $1 FOR UPDATE`, [id]);
        const next = definedOnly(fn(scopeFromRow(rows[0]!)));
        await client.query(SCOPE_UPDATE, [id, ...scopeToColumns(next)]);
        return next;
      });
    },
    soulRevisions: async (perScope, ids) =>
      (await (ids ? db.q(soulSelect(true), [perScope, ids]) : db.q(soulSelect(false), [perScope]))).map(soulFromRow),
    async appendSoul(r, expectedVersion, baseVersion) {
      const params = [r.scopeId, r.version, r.content, r.updatedAt, r.updatedBy ?? null, expectedVersion, baseVersion];
      return (await db.q(SOUL_APPEND, params)).length === 1;
    },
    async purposeRuntimes() {
      const rows = await db.q(
        `SELECT purpose, harness_id, model_id, effort_level, fast_mode FROM purpose_runtimes WHERE ${TENANT}`,
      );
      return Object.fromEntries(rows.map((r) => [r.purpose as RuntimePurpose, selectionFromRow(r)]));
    },
    async setPurposeRuntime(purpose, s) {
      if (!s) {
        await db.q(`DELETE FROM purpose_runtimes WHERE ${TENANT} AND purpose = $1`, [purpose]);
        return;
      }
      await db.q(
        `INSERT INTO purpose_runtimes(purpose, harness_id, model_id, effort_level, fast_mode) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, purpose) DO UPDATE SET harness_id = EXCLUDED.harness_id, model_id = EXCLUDED.model_id,
           effort_level = EXCLUDED.effort_level, fast_mode = EXCLUDED.fast_mode`,
        [purpose, s.harnessId, s.modelId, s.effortLevel ?? null, s.fastMode ?? null],
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
      return row
        ? { scopeId: id, emoji: row.emoji as Record<string, string>, updatedAt: millis(row.updated_at) }
        : null;
    },
    async putSlackEmojiCatalog(c) {
      await db.q(
        `INSERT INTO slack_emoji_catalog(scope_id, emoji, updated_at) VALUES ($1, $2, to_timestamp($3::double precision / 1000))
         ON CONFLICT (tenant_id, scope_id) DO UPDATE SET emoji = EXCLUDED.emoji, updated_at = EXCLUDED.updated_at`,
        [c.scopeId, JSON.stringify(c.emoji), c.updatedAt],
      );
    },
    operatorSettings: async () => operatorFromRow((await db.q(`SELECT * FROM operator_settings`))[0]),
    async updateOperatorSettings(fn) {
      return withPgTransaction(await db.pool(), async (client) => {
        await client.query(`INSERT INTO operator_settings DEFAULT VALUES ON CONFLICT DO NOTHING`);
        const { rows } = await client.query(`SELECT * FROM operator_settings FOR UPDATE`);
        const next = definedOnly(fn(operatorFromRow(rows[0])));
        await client.query(
          `UPDATE operator_settings SET embedding_model_id = $1, approved_harness_ids = $2,
             auto_flagger_harness_id = $3, auto_flagger_model_id = $4, auto_flagger_rubric = $5`,
          [
            next.embeddingModelId ?? null,
            next.approvedHarnesses ?? null,
            next.autoFlagger?.harnessId ?? null,
            next.autoFlagger?.modelId ?? null,
            next.autoFlagger?.rubric ?? null,
          ],
        );
        return next;
      });
    },
  };
}
