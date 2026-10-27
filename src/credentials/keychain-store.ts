import { createPgPool, type PgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { pgTextSafe } from "../util/text.ts";
import type { KeychainAsk, KeychainCredential, KeychainGrant } from "./keychain.ts";

const CREDENTIALS: TableSpec = {
  table: "keychain_credentials",
  key: "id",
  keyIsField: true,
  columns: cols(`ownerId text!, orgId text, service text!, kind text!, envKey text, targets text[], host text,
    accountLabel text, fields jsonb, broker jsonb, refresh jsonb, managed text, secretEnc text!,
    fingerprint text!, origin text, expiresAt bigint, createdAt bigint!, updatedAt bigint!,
    target text, username text`),
};

const GRANTS: TableSpec = {
  table: "keychain_grants",
  key: "id",
  keyIsField: true,
  columns: cols(`credentialId text!, ownerId text!, orgId text, audienceScopeId text!, mode text!,
    purpose text!, status text!, createdAt bigint!, expiresAt bigint, revokedAt bigint,
    usedAt bigint, usedBy text, askId text`),
};

const ASKS: TableSpec = {
  table: "keychain_asks",
  key: "id",
  keyIsField: true,
  columns: cols(`credentialId text!, ownerId text!, requesterId text!, orgId text, requesterScopeId text!,
    requesterDestination jsonb, requesterThreadRef text, requesterSeq bigint,
    requesterMessageTs text, purpose text!, requestedMode text, status text!, createdAt bigint!,
    expiresAt bigint!, resolvedAt bigint, grantId text, note text, notifiedAt bigint`),
};

export const KEYCHAIN_CREDENTIALS_MIGRATION = mapToTableMigration(
  "credentials/keychain/0001-typed-creds",
  CREDENTIALS,
  {
    statements: [
      `CREATE INDEX IF NOT EXISTS keychain_credentials_owner_fold ON keychain_credentials (lower(owner_id))`,
    ],
  },
);

const KEYCHAIN_GRANTS_MIGRATION = mapToTableMigration("credentials/keychain/0002-typed-grants", GRANTS, {
  statements: [
    `CREATE INDEX IF NOT EXISTS keychain_grants_owner_fold ON keychain_grants (lower(owner_id))`,
    `CREATE INDEX IF NOT EXISTS keychain_grants_audience ON keychain_grants (audience_scope_id)`,
    `CREATE INDEX IF NOT EXISTS keychain_grants_credential ON keychain_grants (credential_id)`,
  ],
});

const KEYCHAIN_ASKS_MIGRATION = mapToTableMigration("credentials/keychain/0003-typed-asks", ASKS);

const OWNED_BY = `(lower(owner_id) = ANY($1::text[]) OR owner_id ~ '[^\\x01-\\x7f]')`;

function rowTable<T>(spec: TableSpec, pg: PgPool) {
  const table = typedTable<T>(pg, spec);
  return {
    ...table,
    select: async (clause: string, params: unknown[] = []): Promise<T[]> =>
      table.codec.rows(await pg.q(`SELECT ${table.codec.columns} FROM ${spec.table} ${clause}`, params)),
  };
}

const folded = (ownerIds: string[]) => ownerIds.map((id) => id.toLowerCase());

function credentialTable(pg: PgPool) {
  const creds = rowTable<KeychainCredential>(CREDENTIALS, pg);
  return {
    ...creds,
    byOwners: (ownerIds: string[]) => creds.select(`WHERE ${OWNED_BY} ORDER BY id`, [folded(ownerIds)]),
    async deleteBrokerIfCurrent(id: string, ownerId: string, updatedAt: number): Promise<boolean> {
      const res = await pg.query(
        `DELETE FROM keychain_credentials WHERE id = $1 AND kind = 'broker' AND owner_id = $2 AND updated_at = $3`,
        [id, ownerId, updatedAt],
      );
      return res.rowCount > 0;
    },
    async markRefreshFailure(rec: KeychainCredential, at: number, message: string): Promise<void> {
      await pg.q(
        `UPDATE keychain_credentials
         SET refresh = COALESCE(refresh, '{}'::jsonb)
               || jsonb_build_object('refreshFailedAt', $4::bigint, 'refreshError', $5::text),
             updated_at = $4
         WHERE id = $1 AND updated_at = $2 AND fingerprint = $3`,
        [rec.id, rec.updatedAt, rec.fingerprint, at, pgTextSafe(message)],
      );
    },
  };
}

function grantTable(pg: PgPool) {
  const grants = rowTable<KeychainGrant>(GRANTS, pg);
  const revokeWhere = async (clause: string, params: unknown[]) => {
    await pg.q(`UPDATE keychain_grants SET status = 'revoked', revoked_at = $2 WHERE ${clause} AND status = 'active'`, [
      ...params,
    ]);
  };
  return {
    ...grants,
    list: (ownerIds?: string[]) =>
      ownerIds ? grants.select(`WHERE ${OWNED_BY} ORDER BY id`, [folded(ownerIds)]) : grants.all(),
    forAsks: (askIds: string[]) => grants.select(`WHERE ask_id = ANY($1::text[]) ORDER BY id`, [askIds]),
    activeFor: (scopeId: string, at: number) =>
      grants.select(
        `WHERE audience_scope_id = $1 AND status = 'active' AND NOT (mode = 'once' AND used_at IS NOT NULL)
           AND (expires_at IS NULL OR expires_at >= $2) ORDER BY id`,
        [scopeId, at],
      ),
    revoke: (id: string, at: number) => revokeWhere(`id = $1`, [id, at]),
    revokeForCredential: (credentialId: string, at: number) => revokeWhere(`credential_id = $1`, [credentialId, at]),
  };
}

export function createKeychainStore(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [
    KEYCHAIN_CREDENTIALS_MIGRATION,
    KEYCHAIN_GRANTS_MIGRATION,
    KEYCHAIN_ASKS_MIGRATION,
  ]);
  const asks = rowTable<KeychainAsk>(ASKS, pg);
  return {
    creds: credentialTable(pg),
    grants: grantTable(pg),
    asks: {
      ...asks,
      list: (newestFirst: boolean) =>
        asks.select(newestFirst ? `ORDER BY created_at DESC, id DESC` : `ORDER BY created_at, id`),
      merge: (id: string, patch: Partial<KeychainAsk>) => asks.update(id, (current) => ({ ...current, ...patch })),
    },
  };
}

export type KeychainStore = ReturnType<typeof createKeychainStore>;
