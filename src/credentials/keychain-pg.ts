import {
  createPgPool,
  withPgTransaction,
  type PgMigrationDefinition,
  type PoolClient,
} from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { typedColumns, type ColumnCast, type TypedColumns } from "../persistence/typed-columns.ts";
import { jsonBackfill, upsertStatement } from "../persistence/typed-statements.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import type { ScopeId } from "../types.ts";
import type { KeychainAsk, KeychainCredential, KeychainGrant } from "./keychain.ts";
import { askMatches, matchesOwner, ownerKeys, type KeychainAskFilter, type KeychainRows } from "./keychain-rows.ts";

const NON_ASCII = `'[^\\x01-\\x7f]'`;

type Row = Record<string, unknown>;
type Stored<T> = Omit<T, "orgId">;

const CREDENTIAL_SPEC: { readonly [K in keyof Stored<KeychainCredential>]-?: ColumnCast } = {
  id: "text",
  ownerId: "text",
  service: "text",
  kind: "text",
  envKey: "text",
  target: "text",
  targets: "text[]",
  host: "text",
  accountLabel: "text",
  username: "text",
  fields: "jsonb",
  broker: "jsonb",
  refresh: "jsonb",
  managed: "text",
  secretEnc: "text",
  fingerprint: "text",
  origin: "text",
  expiresAt: "bigint",
  createdAt: "bigint",
  updatedAt: "bigint",
};

const GRANT_SPEC: { readonly [K in keyof Stored<KeychainGrant>]-?: ColumnCast } = {
  id: "text",
  credentialId: "text",
  ownerId: "text",
  audienceScopeId: "text",
  mode: "text",
  purpose: "text",
  status: "text",
  createdAt: "bigint",
  expiresAt: "bigint",
  revokedAt: "bigint",
  usedAt: "bigint",
  usedBy: "text",
  askId: "text",
};

const ASK_SPEC: { readonly [K in keyof Stored<KeychainAsk>]-?: ColumnCast } = {
  id: "text",
  credentialId: "text",
  ownerId: "text",
  requesterId: "text",
  requesterScopeId: "text",
  requesterDestination: "jsonb",
  requesterThreadRef: "text",
  requesterSeq: "bigint",
  requesterMessageTs: "text",
  purpose: "text",
  requestedMode: "text",
  status: "text",
  createdAt: "bigint",
  expiresAt: "bigint",
  resolvedAt: "bigint",
  grantId: "text",
  note: "text",
  notifiedAt: "bigint",
};

const CREDENTIAL = typedColumns<Stored<KeychainCredential>>(CREDENTIAL_SPEC);
const GRANT = typedColumns<Stored<KeychainGrant>>(GRANT_SPEC);
const ASK = typedColumns<Stored<KeychainAsk>>(ASK_SPEC);

const ownerIndexes = (table: string) => [
  `CREATE INDEX ${table}_by_owner ON ${table}(tenant_id, lower(owner_id))`,
  `CREATE INDEX ${table}_by_unicode_owner ON ${table}(tenant_id) WHERE owner_id ~ ${NON_ASCII}`,
];

const KEYCHAIN_MIGRATIONS: readonly PgMigrationDefinition[] = [
  typedTableMigration({
    table: "keychain_credentials",
    columns: [
      "id TEXT NOT NULL",
      "owner_id TEXT NOT NULL",
      "service TEXT NOT NULL",
      "kind TEXT NOT NULL CHECK (kind IN ('env', 'file', 'broker'))",
      "env_key TEXT",
      "target TEXT",
      "targets TEXT[]",
      "host TEXT",
      "account_label TEXT",
      "username TEXT",
      "fields JSONB",
      "broker JSONB",
      "refresh JSONB",
      "managed TEXT CHECK (managed = 'connector')",
      "secret_enc TEXT NOT NULL",
      "fingerprint TEXT NOT NULL",
      "origin TEXT",
      "expires_at BIGINT",
      "created_at BIGINT NOT NULL",
      "updated_at BIGINT NOT NULL",
    ],
    primaryKey: ["id"],
    backfill: {
      ...jsonBackfill("keychain_credentials", CREDENTIAL_SPEC),
      kind: "COALESCE(json->>'kind', 'env')",
      secret_enc: "COALESCE(json->>'secretEnc', '')",
      fingerprint: "COALESCE(json->>'fingerprint', '')",
      created_at: "COALESCE((json->>'createdAt')::numeric::bigint, (json->>'updatedAt')::numeric::bigint, 0)",
      updated_at: "COALESCE((json->>'updatedAt')::numeric::bigint, 0)",
    },
    where:
      "json->>'ownerId' IS NOT NULL AND json->>'service' IS NOT NULL" +
      " AND COALESCE(json->>'kind', 'env') IN ('env', 'file', 'broker')" +
      " AND COALESCE(json->>'managed', 'connector') = 'connector'",
    indexes: ownerIndexes("keychain_credentials"),
  }),
  typedTableMigration({
    table: "keychain_grants",
    columns: [
      "id TEXT NOT NULL",
      "credential_id TEXT NOT NULL",
      "owner_id TEXT NOT NULL",
      "audience_scope_id TEXT NOT NULL",
      "mode TEXT NOT NULL CHECK (mode IN ('once', 'standing'))",
      "purpose TEXT NOT NULL",
      "status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'used'))",
      "created_at BIGINT NOT NULL",
      "expires_at BIGINT",
      "revoked_at BIGINT",
      "used_at BIGINT",
      "used_by TEXT",
      "ask_id TEXT",
    ],
    primaryKey: ["id"],
    backfill: {
      ...jsonBackfill("keychain_grants", GRANT_SPEC),
      purpose: "COALESCE(json->>'purpose', '')",
      created_at: "COALESCE((json->>'createdAt')::numeric::bigint, 0)",
    },
    where:
      "json->>'credentialId' IS NOT NULL AND json->>'ownerId' IS NOT NULL AND json->>'audienceScopeId' IS NOT NULL" +
      " AND json->>'mode' IN ('once', 'standing') AND json->>'status' IN ('active', 'revoked', 'used')",
    indexes: [
      ...ownerIndexes("keychain_grants"),
      "CREATE INDEX keychain_grants_by_audience ON keychain_grants(tenant_id, audience_scope_id) WHERE status = 'active'",
      "CREATE INDEX keychain_grants_by_credential ON keychain_grants(tenant_id, credential_id)",
    ],
  }),
  typedTableMigration({
    table: "keychain_asks",
    columns: [
      "id TEXT NOT NULL",
      "credential_id TEXT NOT NULL",
      "owner_id TEXT NOT NULL",
      "requester_id TEXT NOT NULL",
      "requester_scope_id TEXT NOT NULL",
      "requester_destination JSONB",
      "requester_thread_ref TEXT",
      "requester_seq BIGINT",
      "requester_message_ts TEXT",
      "purpose TEXT NOT NULL",
      "requested_mode TEXT CHECK (requested_mode IN ('once', 'standing'))",
      "status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'expired'))",
      "created_at BIGINT NOT NULL",
      "expires_at BIGINT NOT NULL",
      "resolved_at BIGINT",
      "grant_id TEXT",
      "note TEXT",
      "notified_at BIGINT",
    ],
    primaryKey: ["id"],
    backfill: {
      ...jsonBackfill("keychain_asks", ASK_SPEC),
      purpose: "COALESCE(json->>'purpose', '')",
      created_at: "COALESCE((json->>'createdAt')::numeric::bigint, 0)",
      expires_at: "COALESCE((json->>'expiresAt')::numeric::bigint, 0)",
    },
    where:
      "json->>'credentialId' IS NOT NULL AND json->>'ownerId' IS NOT NULL AND json->>'requesterId' IS NOT NULL" +
      " AND json->>'requesterScopeId' IS NOT NULL" +
      " AND COALESCE(json->>'requestedMode', 'once') IN ('once', 'standing')" +
      " AND json->>'status' IN ('pending', 'approved', 'declined', 'expired')",
    indexes: [
      ...ownerIndexes("keychain_asks"),
      "CREATE INDEX keychain_asks_by_created ON keychain_asks(tenant_id, created_at DESC, id DESC)",
      "CREATE INDEX keychain_asks_by_requester_scope ON keychain_asks(tenant_id, requester_scope_id)",
    ],
  }),
];

const MINE = `tenant_id = ${TENANT}`;

function ownedBy(column: string, param: number): string {
  return `(lower(${column}) = ANY($${param}::text[]) OR ${column} ~ ${NON_ASCII})`;
}

function askWhere(filter: KeychainAskFilter): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses = [MINE];
  const equal = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  };
  const person = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    params.push(ownerKeys([value]));
    clauses.push(ownedBy(column, params.length));
  };
  equal("credential_id", filter.credentialId);
  equal("requester_scope_id", filter.requesterScopeId);
  person("owner_id", filter.ownerId);
  person("requester_id", filter.requesterId);
  return { sql: clauses.join(" AND "), params };
}

interface Table<T> {
  name: string;
  columns: TypedColumns<Stored<T>>;
}

const CREDENTIALS: Table<KeychainCredential> = { name: "keychain_credentials", columns: CREDENTIAL };
const GRANTS: Table<KeychainGrant> = { name: "keychain_grants", columns: GRANT };
const ASKS: Table<KeychainAsk> = { name: "keychain_asks", columns: ASK };

export function createPostgresKeychainRows(connectionString: string): KeychainRows & { close(): Promise<void> } {
  const { q, query, pool, close } = createPgPool(connectionString, [TENANCY_BASE, ...KEYCHAIN_MIGRATIONS]);
  const select = <T>(table: Table<T>, where: string) =>
    `SELECT ${table.columns.names} FROM ${table.name} WHERE ${MINE}${where}`;

  async function rows<T>(table: Table<T>, where: string, params: unknown[] = []): Promise<T[]> {
    return (await q(`${select(table, where)} ORDER BY id`, params)).map((row) => table.columns.fromRow(row) as T);
  }

  async function one<T>(table: Table<T>, id: string): Promise<T | null> {
    const [row] = await q(select(table, " AND id = $1"), [id]);
    return row ? (table.columns.fromRow(row) as T) : null;
  }

  async function put<T>(table: Table<T>, value: T): Promise<void> {
    await q(upsertStatement(table.name, table.columns, "id"), table.columns.params(value));
  }

  async function locked<T, R>(
    table: Table<T>,
    id: string,
    apply: (current: T | null, client: PoolClient) => Promise<R>,
  ): Promise<R> {
    return withPgTransaction(await pool(), async (client) => {
      const found = await client.query(`${select(table, " AND id = $1")} FOR UPDATE`, [id]);
      return apply(found.rows[0] ? (table.columns.fromRow(found.rows[0] as Row) as T) : null, client);
    });
  }

  const update =
    <T extends { id: string }>(table: Table<T>) =>
    (id: string, fn: (current: T) => T) =>
      locked(table, id, async (current, client) => {
        if (current === null) return null;
        const next = { ...fn(current), id };
        await client.query(upsertStatement(table.name, table.columns, "id"), table.columns.params(next));
        return next;
      });

  async function remove(table: string, id: string): Promise<void> {
    await q(`DELETE FROM ${table} WHERE ${MINE} AND id = $1`, [id]);
  }

  return {
    close,
    creds: {
      get: (id) => one(CREDENTIALS, id),
      put: (rec) => put(CREDENTIALS, rec),
      async insertIfAbsent(rec) {
        const inserted = await query(
          upsertStatement(CREDENTIALS.name, CREDENTIAL, "id", "nothing"),
          CREDENTIAL.params(rec),
        );
        return inserted.rowCount > 0;
      },
      update: update(CREDENTIALS),
      deleteIf: (id, predicate) =>
        locked(CREDENTIALS, id, async (current, client) => {
          if (current === null || !predicate(current)) return false;
          await client.query(`DELETE FROM keychain_credentials WHERE ${MINE} AND id = $1`, [id]);
          return true;
        }),
      delete: (id) => remove(CREDENTIALS.name, id),
      async byOwners(ownerIds) {
        const found = await rows(CREDENTIALS, ` AND ${ownedBy("owner_id", 1)}`, [ownerKeys(ownerIds)]);
        return found.filter((rec) => matchesOwner(rec, ownerIds));
      },
      all: () => rows(CREDENTIALS, ""),
    },
    grants: {
      get: (id) => one(GRANTS, id),
      put: (grant) => put(GRANTS, grant),
      async putIfAbsent(grant) {
        await q(upsertStatement(GRANTS.name, GRANT, "id", "nothing"), GRANT.params(grant));
        return (await one(GRANTS, grant.id)) ?? grant;
      },
      update: update(GRANTS),
      async revokeActive(filter, revokedAt) {
        const [column, value] = "id" in filter ? ["id", filter.id] : ["credential_id", filter.credentialId];
        await q(
          `UPDATE keychain_grants SET status = 'revoked', revoked_at = $2
           WHERE ${MINE} AND ${column} = $1 AND status = 'active'`,
          [value, revokedAt],
        );
      },
      activeFor: (audienceScopeId: ScopeId) =>
        rows(GRANTS, " AND audience_scope_id = $1 AND status = 'active'", [audienceScopeId]),
      forCredential: (credentialId) => rows(GRANTS, " AND credential_id = $1", [credentialId]),
      async byOwners(ownerIds) {
        const found = await rows(GRANTS, ` AND ${ownedBy("owner_id", 1)}`, [ownerKeys(ownerIds)]);
        return found.filter((grant) => matchesOwner(grant, ownerIds));
      },
      all: () => rows(GRANTS, ""),
    },
    asks: {
      get: (id) => one(ASKS, id),
      put: (ask) => put(ASKS, ask),
      update: update(ASKS),
      delete: (id) => remove(ASKS.name, id),
      async newestFirst(filter) {
        const where = askWhere(filter);
        const found = await q(
          `SELECT ${ASK.names} FROM keychain_asks WHERE ${where.sql} ORDER BY created_at DESC, id DESC`,
          where.params,
        );
        return found.map((row) => ASK.fromRow(row) as KeychainAsk).filter((ask) => askMatches(ask, filter));
      },
    },
  };
}
