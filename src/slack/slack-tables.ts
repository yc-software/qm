import {
  createPgPool,
  withPgTransaction,
  type PgPool,
  type PgMigrationDefinition,
  type Rows,
} from "../persistence/pg-pool.ts";
import { jsonbStringify } from "../util/text.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, tenantPolicies } from "../tenants/migrations.ts";
import { claimAcrossTenants } from "../tenants/claim.ts";
import type { StagedEnvelopeRows } from "./envelope-staging.ts";
import type { SlackSessionStatusRows, SlackSessionStatusState } from "./session-status.ts";
import type { TaskAckRows, TaskAckState } from "./task-ack.ts";
import type { SlackAccountRows } from "../api/routes/composio.ts";

const SLACK_TABLE_MIGRATIONS: readonly PgMigrationDefinition[] = [
  TENANCY_BASE,
  {
    id: "tenancy/slack_installation/0001-typed",
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      `CREATE TABLE IF NOT EXISTS slack_installation(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
      `ALTER TABLE slack_installation RENAME TO slack_installation_kv`,
      `ALTER INDEX slack_installation_pkey RENAME TO slack_installation_kv_pkey`,
      `SELECT qm_tenant_column('slack_installation_kv')`,
      `CREATE TABLE slack_installation(
         tenant_id UUID PRIMARY KEY DEFAULT qm_bound_tenant() REFERENCES tenants,
         disabled BOOLEAN NOT NULL,
         service_blocked BOOLEAN NOT NULL DEFAULT false,
         bot_token_enc TEXT,
         app_token_enc TEXT,
         app_id TEXT,
         install_id TEXT,
         installed_at BIGINT,
         team_id TEXT,
         team_name TEXT,
         updated_at BIGINT NOT NULL,
         updated_by TEXT NOT NULL,
         version TEXT NOT NULL,
         CHECK (disabled OR bot_token_enc IS NOT NULL)
       )`,
      `INSERT INTO slack_installation(tenant_id, disabled, service_blocked, bot_token_enc, app_token_enc, app_id,
         install_id, installed_at, team_id, team_name, updated_at, updated_by, version)
       SELECT tenant_id, COALESCE((json->>'disabled')::boolean, true),
         COALESCE((json->>'serviceBlocked')::boolean, false), json->>'botTokenEnc', json->>'appTokenEnc', json->>'appId',
         json->>'installId', (json->>'installedAt')::bigint, json->>'teamId', json->>'teamName',
         COALESCE((json->>'updatedAt')::bigint, 0), COALESCE(json->>'updatedBy', 'migration'),
         COALESCE(json->>'version', 'migrated')
       FROM slack_installation_kv`,
      `DROP TABLE slack_installation_kv`,
      `DO $drop_version$ BEGIN
         IF to_regclass('durable_map_versions') IS NOT NULL THEN
           DELETE FROM durable_map_versions WHERE tbl = 'slack_installation';
         END IF;
       END $drop_version$`,
      ...tenantPolicies("slack_installation"),
    ],
  },
  typedTableMigration({
    table: "slack_accounts",
    columns: [
      "principal_id TEXT NOT NULL",
      "account_id TEXT NOT NULL",
      "member_id TEXT NOT NULL",
      "user_id TEXT NOT NULL",
      "team_id TEXT NOT NULL",
      "user_name TEXT NOT NULL",
      "workspace TEXT NOT NULL",
    ],
    primaryKey: ["principal_id"],
    backfill: {
      principal_id: "id",
      account_id: "json->>'accountId'",
      member_id: "json->>'memberId'",
      user_id: "json->>'userId'",
      team_id: "json->>'teamId'",
      user_name: "json->>'user'",
      workspace: "json->>'workspace'",
    },
  }),
  typedTableMigration({
    table: "slack_staged_envelopes",
    columns: [
      "key TEXT NOT NULL",
      "body JSONB NOT NULL",
      "account TEXT NOT NULL",
      "received_at BIGINT NOT NULL",
      "attempts INTEGER NOT NULL DEFAULT 0",
      "claimed_until BIGINT NOT NULL DEFAULT 0",
    ],
    primaryKey: ["key"],
    backfill: {
      key: "id",
      body: "json->'body'",
      account: "json->>'account'",
      received_at: "(json->>'receivedAt')::bigint",
      attempts: "COALESCE((json->>'attempts')::int, 0)",
      claimed_until: "COALESCE((json->>'claimedUntil')::bigint, 0)",
    },
    indexes: ["CREATE INDEX slack_staged_envelopes_due ON slack_staged_envelopes(received_at)"],
  }),
  typedTableMigration({
    table: "slack_session_status",
    columns: [
      "account TEXT NOT NULL",
      "channel TEXT NOT NULL",
      "thread_ts TEXT NOT NULL",
      "writer TEXT",
      "anchor_run_id TEXT NOT NULL",
      "started_at BIGINT",
      "card_id TEXT",
      "card_ts TEXT",
      "card_content TEXT",
      "follow_url TEXT",
    ],
    primaryKey: ["account", "channel", "thread_ts"],
    backfill: {
      account: "json->>'account'",
      channel: "json->>'channel'",
      thread_ts: "json->>'threadTs'",
      writer: "json->>'writer'",
      anchor_run_id: "json->>'anchorRunId'",
      started_at: "(json->>'startedAt')::bigint",
      card_id: "json->>'cardId'",
      card_ts: "json->>'cardTs'",
      card_content: "json->>'cardContent'",
      follow_url: "json->>'followUrl'",
    },
  }),
  typedTableMigration({
    table: "slack_task_acknowledgements",
    columns: [
      "run_id TEXT NOT NULL",
      "channel TEXT NOT NULL",
      "emoji TEXT NOT NULL",
      "target TEXT NOT NULL",
      "previous TEXT[] NOT NULL DEFAULT '{}'",
      "finished BOOLEAN NOT NULL",
      "synced BOOLEAN NOT NULL DEFAULT false",
    ],
    primaryKey: ["run_id"],
    backfill: {
      run_id: "id",
      channel: "COALESCE(json->>'channel', '')",
      emoji: "COALESCE(json->>'emoji', 'eyes')",
      target: "COALESCE(json->>'target', '')",
      previous: "ARRAY(SELECT jsonb_array_elements_text(COALESCE(json->'previous', '[]'::jsonb)))",
      finished: "COALESCE((json->>'finished')::boolean, false)",
      synced: "COALESCE((json->>'synced')::boolean, false)",
    },
    indexes: [
      `CREATE INDEX slack_task_acknowledgements_unsettled ON slack_task_acknowledgements(tenant_id, run_id)
         WHERE NOT synced OR NOT finished`,
    ],
  }),
  {
    id: "tenancy/slack_install_states/0001-create",
    statements: [
      `CREATE TABLE slack_install_states(
         tenant_id UUID NOT NULL DEFAULT qm_bound_tenant() REFERENCES tenants,
         nonce TEXT NOT NULL,
         expires_at BIGINT NOT NULL,
         PRIMARY KEY (tenant_id, nonce)
       )`,
      ...tenantPolicies("slack_install_states"),
    ],
  },
];

type Row = Rows[number];

function text(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function num(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function defined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

async function locked<T>(pg: PgPool, key: string, fn: (client: PoolQuery) => Promise<T>): Promise<T> {
  return withPgTransaction(await pg.pool(), async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || qm_bound_tenant()::text))", [key]);
    return fn(client);
  });
}

type PoolQuery = { query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> };

export interface StoredSlackInstallation {
  disabled: boolean;
  serviceBlocked?: boolean;
  botTokenEnc?: string;
  appTokenEnc?: string;
  appId?: string;
  installId?: string;
  installedAt?: number;
  teamId?: string;
  teamName?: string;
  updatedAt: number;
  updatedBy: string;
  version: string;
}

export interface SlackInstallationRows {
  read(): Promise<StoredSlackInstallation | null>;
  mutate(
    fn: (current: StoredSlackInstallation | null) => StoredSlackInstallation | null,
  ): Promise<StoredSlackInstallation | null>;
  consumeState(nonce: string, expiresAt: number, now: number): Promise<boolean>;
}

const INSTALLATION_COLUMNS = `disabled, service_blocked, bot_token_enc, app_token_enc, app_id, install_id, installed_at,
  team_id, team_name, updated_at, updated_by, version`;

function installationRecord(row: Row): StoredSlackInstallation {
  return defined({
    disabled: Boolean(row.disabled),
    serviceBlocked: row.service_blocked ? true : undefined,
    botTokenEnc: text(row.bot_token_enc),
    appTokenEnc: text(row.app_token_enc),
    appId: text(row.app_id),
    installId: text(row.install_id),
    installedAt: num(row.installed_at),
    teamId: text(row.team_id),
    teamName: text(row.team_name),
    updatedAt: Number(row.updated_at),
    updatedBy: String(row.updated_by),
    version: String(row.version),
  });
}

function pgSlackInstallationRows(pg: PgPool): SlackInstallationRows {
  const select = `SELECT ${INSTALLATION_COLUMNS} FROM slack_installation WHERE tenant_id = qm_bound_tenant()`;
  return {
    async read() {
      const row = (await pg.q(select))[0];
      return row ? installationRecord(row) : null;
    },
    async consumeState(nonce, expiresAt, now) {
      await pg.q(`DELETE FROM slack_install_states WHERE tenant_id = qm_bound_tenant() AND expires_at < $1`, [now]);
      const inserted = await pg.q(
        `INSERT INTO slack_install_states(nonce, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING nonce`,
        [nonce, expiresAt],
      );
      return inserted.length === 1;
    },
    mutate: (fn) =>
      locked(pg, "slack_installation:", async (client) => {
        const row = (await client.query(select)).rows[0];
        const current = row ? installationRecord(row) : null;
        const next = fn(current);
        if (!next || next === current) return next;
        await client.query(
          `INSERT INTO slack_installation(${INSTALLATION_COLUMNS})
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (tenant_id) DO UPDATE SET (${INSTALLATION_COLUMNS}) = (
             EXCLUDED.disabled, EXCLUDED.service_blocked, EXCLUDED.bot_token_enc, EXCLUDED.app_token_enc,
             EXCLUDED.app_id, EXCLUDED.install_id, EXCLUDED.installed_at, EXCLUDED.team_id, EXCLUDED.team_name,
             EXCLUDED.updated_at, EXCLUDED.updated_by, EXCLUDED.version)`,
          [
            next.disabled,
            next.serviceBlocked ?? false,
            next.botTokenEnc ?? null,
            next.appTokenEnc ?? null,
            next.appId ?? null,
            next.installId ?? null,
            next.installedAt ?? null,
            next.teamId ?? null,
            next.teamName ?? null,
            next.updatedAt,
            next.updatedBy,
            next.version,
          ],
        );
        return next;
      }),
  };
}

export function installedSlackTenants(pg: PgPool): Promise<Array<{ tenant_id: string; version: string }>> {
  return claimAcrossTenants<{ version: string }>(
    pg,
    "SELECT tenant_id::text AS tenant_id, version FROM slack_installation WHERE NOT disabled",
  );
}

export interface DueEnvelope {
  tenantId: string;
  key: string;
  body: Record<string, unknown>;
  account: string;
  attempts: number;
}

function pgStagedEnvelopeRows(pg: PgPool): StagedEnvelopeRows {
  return {
    async putIfAbsent(key, row) {
      await pg.q(
        `INSERT INTO slack_staged_envelopes(key, body, account, received_at, attempts) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [key, jsonbStringify(row.body), row.account, row.receivedAt, row.attempts],
      );
      return row;
    },
    async delete(key) {
      await pg.q("DELETE FROM slack_staged_envelopes WHERE tenant_id = qm_bound_tenant() AND key = $1", [key]);
    },
  };
}

export async function claimStagedEnvelopes(
  pg: PgPool,
  opts: {
    now: number;
    staleAfterMs: number;
    claimMs: number;
    maxAttempts: number;
    abandonAfterMs: number;
    accounts: ReadonlyArray<{ tenantId: string; account: string }>;
  },
): Promise<DueEnvelope[]> {
  await claimAcrossTenants(
    pg,
    "DELETE FROM slack_staged_envelopes WHERE received_at < $1 RETURNING tenant_id::text AS tenant_id",
    [opts.now - opts.abandonAfterMs],
  );
  if (!opts.accounts.length) return [];
  const rows = await claimAcrossTenants<{
    key: string;
    body: Record<string, unknown>;
    account: string;
    attempts: number;
  }>(
    pg,
    `WITH due AS (
       SELECT s.tenant_id, s.key FROM slack_staged_envelopes s
       JOIN unnest($4::uuid[], $5::text[]) AS a(tenant_id, account) ON a.tenant_id = s.tenant_id AND a.account = s.account
       WHERE s.received_at <= $1 AND s.claimed_until <= $2 AND s.attempts < $3
       ORDER BY s.received_at LIMIT 100 FOR UPDATE OF s SKIP LOCKED)
     UPDATE slack_staged_envelopes e SET attempts = e.attempts + 1, claimed_until = $6
     FROM due WHERE e.tenant_id = due.tenant_id AND e.key = due.key
     RETURNING e.tenant_id::text AS tenant_id, e.key, e.body, e.account, e.attempts`,
    [
      opts.now - opts.staleAfterMs,
      opts.now,
      opts.maxAttempts,
      opts.accounts.map((a) => a.tenantId),
      opts.accounts.map((a) => a.account),
      opts.now + opts.claimMs,
    ],
  );
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    key: row.key,
    body: row.body,
    account: row.account,
    attempts: Number(row.attempts),
  }));
}

async function forUpdate<T>(
  pg: PgPool,
  select: string,
  params: unknown[],
  record: (row: Row) => T,
  fn: (current: T, client: PoolQuery) => Promise<T | null>,
): Promise<T | null> {
  return withPgTransaction(await pg.pool(), async (client) => {
    const row = (await client.query(`${select} FOR UPDATE`, params)).rows[0];
    return row ? fn(record(row), client) : null;
  });
}

const STATUS_COLUMNS =
  "account, channel, thread_ts, writer, anchor_run_id, started_at, card_id, card_ts, card_content, follow_url";
const STATUS_SELECT = `SELECT ${STATUS_COLUMNS} FROM slack_session_status
  WHERE tenant_id = qm_bound_tenant() AND account = $1 AND channel = $2 AND thread_ts = $3`;

function statusRecord(row: Row): SlackSessionStatusState {
  return defined({
    account: String(row.account),
    channel: String(row.channel),
    threadTs: String(row.thread_ts),
    writer: text(row.writer),
    anchorRunId: String(row.anchor_run_id),
    startedAt: num(row.started_at),
    cardId: text(row.card_id),
    cardTs: text(row.card_ts),
    cardContent: text(row.card_content),
    followUrl: text(row.follow_url),
  });
}

function statusKey(id: string): [string, string, string] {
  const key = JSON.parse(id) as unknown;
  if (!Array.isArray(key) || key.length !== 3 || !key.every((part) => typeof part === "string"))
    throw new Error("Invalid Slack session status key");
  return key as [string, string, string];
}

function pgSessionStatusRows(pg: PgPool): SlackSessionStatusRows {
  return {
    async entries() {
      const rows = await pg.q(
        `SELECT ${STATUS_COLUMNS} FROM slack_session_status WHERE tenant_id = qm_bound_tenant() ORDER BY account, channel, thread_ts`,
      );
      return rows.map((row) => [JSON.stringify([row.account, row.channel, row.thread_ts]), statusRecord(row)]);
    },
    async get(id) {
      const row = (await pg.q(STATUS_SELECT, statusKey(id)))[0];
      return row ? statusRecord(row) : null;
    },
    async putIfAbsent(id, state) {
      const [account, channel, threadTs] = statusKey(id);
      const rows = await pg.q(
        `INSERT INTO slack_session_status(${STATUS_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, account, channel, thread_ts) DO UPDATE SET account = slack_session_status.account
         RETURNING ${STATUS_COLUMNS}`,
        [
          account,
          channel,
          threadTs,
          state.writer ?? null,
          state.anchorRunId,
          state.startedAt ?? null,
          state.cardId ?? null,
          state.cardTs ?? null,
          state.cardContent ?? null,
          state.followUrl ?? null,
        ],
      );
      return statusRecord(rows[0]!);
    },
    update: (id, fn) =>
      forUpdate(pg, STATUS_SELECT, statusKey(id), statusRecord, async (current, client) => {
        const next = fn(current);
        await client.query(
          `UPDATE slack_session_status SET (writer, anchor_run_id, started_at, card_id, card_ts, card_content, follow_url)
             = ($4, $5, $6, $7, $8, $9, $10)
           WHERE tenant_id = qm_bound_tenant() AND account = $1 AND channel = $2 AND thread_ts = $3`,
          [
            ...statusKey(id),
            next.writer ?? null,
            next.anchorRunId,
            next.startedAt ?? null,
            next.cardId ?? null,
            next.cardTs ?? null,
            next.cardContent ?? null,
            next.followUrl ?? null,
          ],
        );
        return next;
      }),
    async deleteIf(id, predicate) {
      const deleted = await forUpdate(pg, STATUS_SELECT, statusKey(id), statusRecord, async (current, client) => {
        if (!predicate(current)) return null;
        await client.query(
          "DELETE FROM slack_session_status WHERE tenant_id = qm_bound_tenant() AND account = $1 AND channel = $2 AND thread_ts = $3",
          statusKey(id),
        );
        return current;
      });
      return deleted !== null;
    },
  };
}

export async function tenantsWithSessionStatus(pg: PgPool): Promise<Array<{ tenant_id: string; account: string }>> {
  return claimAcrossTenants<{ account: string }>(
    pg,
    "SELECT DISTINCT tenant_id::text AS tenant_id, account FROM slack_session_status",
  );
}

const ACK_COLUMNS = "channel, emoji, target, previous, finished, synced";
const ACK_SELECT = `SELECT ${ACK_COLUMNS} FROM slack_task_acknowledgements WHERE tenant_id = qm_bound_tenant() AND run_id = $1`;

function ackRecord(row: Row): TaskAckState {
  return defined({
    channel: String(row.channel),
    emoji: String(row.emoji),
    target: String(row.target),
    previous: (row.previous as string[] | null) ?? [],
    finished: Boolean(row.finished),
    synced: row.synced ? true : undefined,
  });
}

function ackValues(state: TaskAckState): unknown[] {
  return [state.channel, state.emoji, state.target, state.previous, state.finished, state.synced ?? false];
}

function pgTaskAckRows(pg: PgPool): TaskAckRows {
  return {
    async unsettled() {
      const rows = await pg.q(
        `SELECT run_id, ${ACK_COLUMNS} FROM slack_task_acknowledgements
         WHERE tenant_id = qm_bound_tenant() AND (NOT synced OR NOT finished) ORDER BY run_id`,
      );
      return rows.map((row) => [String(row.run_id), ackRecord(row)]);
    },
    async get(runId) {
      const row = (await pg.q(ACK_SELECT, [runId]))[0];
      return row ? ackRecord(row) : null;
    },
    async putIfAbsent(runId, state) {
      const rows = await pg.q(
        `INSERT INTO slack_task_acknowledgements(run_id, ${ACK_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, run_id) DO UPDATE SET run_id = slack_task_acknowledgements.run_id
         RETURNING ${ACK_COLUMNS}`,
        [runId, ...ackValues(state)],
      );
      return ackRecord(rows[0]!);
    },
    update: (runId, fn) =>
      forUpdate(pg, ACK_SELECT, [runId], ackRecord, async (current, client) => {
        const next = fn(current);
        await client.query(
          `UPDATE slack_task_acknowledgements SET (${ACK_COLUMNS}) = ($2, $3, $4, $5, $6, $7)
           WHERE tenant_id = qm_bound_tenant() AND run_id = $1`,
          [runId, ...ackValues(next)],
        );
        return next;
      }),
  };
}

export async function tenantsWithUnsettledAcks(pg: PgPool): Promise<Array<{ tenant_id: string }>> {
  return claimAcrossTenants(
    pg,
    "SELECT DISTINCT tenant_id::text AS tenant_id FROM slack_task_acknowledgements WHERE NOT synced OR NOT finished",
  );
}

function pgSlackAccountRows(pg: PgPool): SlackAccountRows {
  return {
    async get(principalId) {
      const row = (
        await pg.q(
          `SELECT principal_id, account_id, member_id, user_id, team_id, user_name, workspace FROM slack_accounts
           WHERE tenant_id = qm_bound_tenant() AND principal_id = $1`,
          [principalId],
        )
      )[0];
      return row
        ? {
            principalId: String(row.principal_id),
            accountId: String(row.account_id),
            memberId: String(row.member_id),
            userId: String(row.user_id),
            teamId: String(row.team_id),
            user: String(row.user_name),
            workspace: String(row.workspace),
          }
        : null;
    },
    async put(principalId, link) {
      await pg.q(
        `INSERT INTO slack_accounts(principal_id, account_id, member_id, user_id, team_id, user_name, workspace)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, principal_id) DO UPDATE SET
           (account_id, member_id, user_id, team_id, user_name, workspace) =
           (EXCLUDED.account_id, EXCLUDED.member_id, EXCLUDED.user_id, EXCLUDED.team_id, EXCLUDED.user_name, EXCLUDED.workspace)`,
        [principalId, link.accountId, link.memberId, link.userId, link.teamId, link.user, link.workspace],
      );
    },
  };
}

export function createSlackTables(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, SLACK_TABLE_MIGRATIONS);
  return {
    pool: pg,
    installation: pgSlackInstallationRows(pg),
    accounts: pgSlackAccountRows(pg),
    stagedEnvelopes: pgStagedEnvelopeRows(pg),
    sessionStatus: pgSessionStatusRows(pg),
    taskAcknowledgements: pgTaskAckRows(pg),
  };
}

export type SlackTables = ReturnType<typeof createSlackTables>;
