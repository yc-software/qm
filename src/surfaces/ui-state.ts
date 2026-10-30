import { currentTenant } from "../tenants/context.ts";
import { createPgPool, withPgTransaction, type Rows } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { pgTextSafe } from "../util/text.ts";

export interface PersistedUiState {
  value: unknown;
  updatedAt: number;
}

export interface UiStateStore {
  get(principalId: string, key: string): Promise<PersistedUiState | null>;
  put(principalId: string, key: string, state: PersistedUiState): Promise<void>;
  putIfAbsent(principalId: string, key: string, state: PersistedUiState): Promise<PersistedUiState>;
  putNewer(principalId: string, key: string, state: PersistedUiState): Promise<{ ok: boolean; updatedAt: number }>;
  modify(
    principalId: string,
    key: string,
    apply: (current: PersistedUiState | null) => PersistedUiState,
  ): Promise<PersistedUiState>;
  take(principalId: string, key: string): Promise<PersistedUiState | null>;
  delete(principalId: string, key: string): Promise<void>;
  close?(): Promise<void>;
}

export const UI_STATE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const UI_STATE_MAX_BYTES = 65536;
export const UI_STATE_MAX_FUTURE_SKEW_MS = 300_000;

const WEB_UI_STATE_MIGRATION = typedTableMigration({
  table: "web_ui_state",
  columns: ["principal_id TEXT NOT NULL", "key TEXT NOT NULL", "value JSONB NOT NULL", "updated_at BIGINT NOT NULL"],
  primaryKey: ["principal_id", "key"],
  backfill: {
    principal_id: "substring(id FROM '^(.*)#[^#]*$')",
    key: "substring(id FROM '#([^#]*)$')",
    value: "COALESCE(json->'value', 'null'::jsonb)",
    updated_at: "(json->>'updatedAt')::bigint",
  },
  where: "id ~ '^.+#[^#]+$' AND json->>'updatedAt' IS NOT NULL",
});

const SELECT = `SELECT value, updated_at FROM web_ui_state WHERE tenant_id = ${TENANT} AND principal_id = $1 AND key = $2`;
const INSERT = `INSERT INTO web_ui_state(principal_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, $4)
  ON CONFLICT (tenant_id, principal_id, key)`;
const UPSERT = `${INSERT} DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;

const pgSafe = (_key: string, value: unknown) => (typeof value === "string" ? pgTextSafe(value) : value);
const jsonValue = (state: PersistedUiState) => JSON.stringify(state.value ?? null, pgSafe);

function uiState(rows: Rows): PersistedUiState | null {
  const row = rows[0];
  return row ? { value: row.value, updatedAt: Number(row.updated_at) } : null;
}

export function createUiStateStore(): UiStateStore {
  const tenants = new Map<string, Map<string, PersistedUiState>>();
  const rows = () => {
    const tenant = currentTenant();
    return tenants.get(tenant) ?? tenants.set(tenant, new Map()).get(tenant)!;
  };
  const id = (principalId: string, key: string) => `${principalId}#${key}`;
  const take = (principalId: string, key: string) => {
    const state = rows().get(id(principalId, key)) ?? null;
    rows().delete(id(principalId, key));
    return state;
  };
  return {
    get: async (principalId, key) => rows().get(id(principalId, key)) ?? null,
    put: async (principalId, key, state) => void rows().set(id(principalId, key), state),
    async putIfAbsent(principalId, key, state) {
      const existing = rows().get(id(principalId, key));
      if (existing) return existing;
      rows().set(id(principalId, key), state);
      return state;
    },
    async putNewer(principalId, key, state) {
      const existing = rows().get(id(principalId, key));
      if (existing && existing.updatedAt > state.updatedAt) return { ok: false, updatedAt: existing.updatedAt };
      rows().set(id(principalId, key), state);
      return { ok: true, updatedAt: state.updatedAt };
    },
    async modify(principalId, key, apply) {
      const next = apply(rows().get(id(principalId, key)) ?? null);
      rows().set(id(principalId, key), next);
      return next;
    },
    take: async (principalId, key) => take(principalId, key),
    delete: async (principalId, key) => void take(principalId, key),
  };
}

export function createPostgresUiStateStore(connectionString: string): UiStateStore {
  const { q, pool, close } = createPgPool(connectionString, [TENANCY_BASE, WEB_UI_STATE_MIGRATION]);
  return {
    get: async (principalId, key) => uiState(await q(SELECT, [principalId, key])),
    async put(principalId, key, state) {
      await q(UPSERT, [principalId, key, jsonValue(state), state.updatedAt]);
    },
    async putIfAbsent(principalId, key, state) {
      const inserted = await q(`${INSERT} DO NOTHING RETURNING value, updated_at`, [
        principalId,
        key,
        jsonValue(state),
        state.updatedAt,
      ]);
      return uiState(inserted) ?? uiState(await q(SELECT, [principalId, key])) ?? state;
    },
    async putNewer(principalId, key, state) {
      const written = await q(`${UPSERT} WHERE web_ui_state.updated_at <= EXCLUDED.updated_at RETURNING updated_at`, [
        principalId,
        key,
        jsonValue(state),
        state.updatedAt,
      ]);
      if (written.length) return { ok: true, updatedAt: state.updatedAt };
      return { ok: false, updatedAt: uiState(await q(SELECT, [principalId, key]))?.updatedAt ?? state.updatedAt };
    },
    async modify(principalId, key, apply) {
      return withPgTransaction(await pool(), async (client) => {
        for (;;) {
          const current = uiState((await client.query(`${SELECT} FOR UPDATE`, [principalId, key])).rows);
          const next = apply(current);
          const written = await client.query(`${current ? UPSERT : `${INSERT} DO NOTHING`} RETURNING updated_at`, [
            principalId,
            key,
            jsonValue(next),
            next.updatedAt,
          ]);
          if (written.rows.length) return next;
        }
      });
    },
    take: async (principalId, key) =>
      uiState(
        await q(
          `DELETE FROM web_ui_state WHERE tenant_id = ${TENANT} AND principal_id = $1 AND key = $2
           RETURNING value, updated_at`,
          [principalId, key],
        ),
      ),
    async delete(principalId, key) {
      await q(`DELETE FROM web_ui_state WHERE tenant_id = ${TENANT} AND principal_id = $1 AND key = $2`, [
        principalId,
        key,
      ]);
    },
    close,
  };
}
