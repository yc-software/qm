import { createPgPool, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { typedColumns, type ColumnCast, type TypedColumns } from "../persistence/typed-columns.ts";
import { jsonBackfill, upsertStatement } from "../persistence/typed-statements.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import type { SecretDropRecord } from "../credentials/secret-drop.ts";
import type { McpServer } from "../mcp/mcp-server-store.ts";
import type { ConsentLinkRecord } from "./consent-link.ts";
import type { OAuthState } from "./oauth.ts";
import type { StoredBrowserSession } from "./browser-session-store.ts";

export interface OneTimeRows<T> {
  insert(id: string, rec: T): Promise<void>;
  get(id: string): Promise<T | null>;
  take(id: string): Promise<T | null>;
}

export interface SecretDropRows extends OneTimeRows<SecretDropRecord> {
  siblings(rec: SecretDropRecord, createdSince: number): Promise<SecretDropRecord[]>;
  deleteCreatedBefore(cutoff: number): Promise<void>;
}

export interface ComposioReturn {
  url: string | null;
  toolkit: string;
  expiresAt: number;
}

export interface ComposioReturnRows {
  put(id: string, rec: ComposioReturn): Promise<void>;
  take(id: string): Promise<ComposioReturn | null>;
  deleteExpired(now: number): Promise<void>;
}

export interface BrowserSessionRows {
  get(principalId: string): Promise<StoredBrowserSession | null>;
  put(rec: StoredBrowserSession): Promise<void>;
}

export interface McpServerRows {
  list(): Promise<McpServer[]>;
  get(id: string): Promise<McpServer | null>;
  put(server: McpServer): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface LinkTables {
  oauthFlows: OneTimeRows<Omit<OAuthState, "tenant">>;
  consentLinks: OneTimeRows<ConsentLinkRecord>;
  secretDrops: SecretDropRows;
  composioReturns: ComposioReturnRows;
  browserSessions: BrowserSessionRows;
  mcpServers: McpServerRows;
}

type Spec<T> = { readonly [K in keyof T & string]-?: ColumnCast };
type OAuthFlowRow = Omit<OAuthState, "orgId" | "nonce" | "tenant"> & { id: string };
type ConsentLinkRow = Omit<ConsentLinkRecord, "orgId"> & { id: string };
type SecretDropRow = Omit<SecretDropRecord, "orgId"> & { id: string };
type ComposioReturnRow = ComposioReturn & { id: string };

const OAUTH_FLOW_SPEC: Spec<OAuthFlowRow> = {
  id: "text",
  provider: "text",
  principalId: "text",
  redirectUri: "text",
  issuedAt: "bigint",
  returnTo: "text",
  accountType: "text",
  clientRef: "text",
  codeVerifier: "text",
  consentLinkId: "text",
};

const CONSENT_LINK_SPEC: Spec<ConsentLinkRow> = {
  id: "text",
  principalId: "text",
  provider: "text",
  accountType: "text",
  redirectUri: "text",
  returnTo: "text",
  createdAt: "bigint",
};

const SECRET_DROP_SPEC: Spec<SecretDropRow> = {
  id: "text",
  ownerId: "text",
  service: "text",
  envKey: "text",
  host: "text",
  fields: "jsonb",
  purpose: "text",
  requestedBy: "text",
  audienceScopeId: "text",
  scopeVersion: "text",
  grantMode: "text",
  destination: "jsonb",
  threadRef: "text",
  requiresToken: "boolean",
  createdAt: "bigint",
};

const COMPOSIO_RETURN_SPEC: Spec<ComposioReturnRow> = {
  id: "text",
  url: "text",
  toolkit: "text",
  expiresAt: "bigint",
};

const BROWSER_SESSION_SPEC: Spec<StoredBrowserSession> = {
  principalId: "text",
  stateEnc: "text",
  updatedAt: "bigint",
};

const MCP_SERVER_SPEC: Spec<McpServer> = {
  id: "text",
  name: "text",
  url: "text",
  auth: "text",
  credentialScope: "text",
  credentialHost: "text",
  credentialAccountType: "text",
  bearerToken: "text",
  clientId: "text",
  clientSecret: "text",
  oauthAuthorizeUrl: "text",
  oauthTokenUrl: "text",
  oauthScopes: "text[]",
  tools: "jsonb",
  about: "text",
  approval: "text",
  catalog: "boolean",
  attestActor: "boolean",
  readOnly: "boolean",
  enabled: "boolean",
  updatedAt: "bigint",
  updatedBy: "text",
};

const OAUTH_FLOW = typedColumns<OAuthFlowRow>(OAUTH_FLOW_SPEC);
const CONSENT_LINK = typedColumns<ConsentLinkRow>(CONSENT_LINK_SPEC);
const SECRET_DROP = typedColumns<SecretDropRow>(SECRET_DROP_SPEC);
const COMPOSIO_RETURN = typedColumns<ComposioReturnRow>(COMPOSIO_RETURN_SPEC);
const BROWSER_SESSION = typedColumns<StoredBrowserSession>(BROWSER_SESSION_SPEC);
const MCP_SERVER = typedColumns<McpServer>(MCP_SERVER_SPEC);

const linkIdIndex = (table: string) => `CREATE UNIQUE INDEX ${table}_by_link_id ON ${table}(id)`;
const timestamp = (field: string) => `COALESCE((json->>'${field}')::numeric::bigint, 0)`;

const LINK_TABLE_MIGRATIONS: readonly PgMigrationDefinition[] = [
  typedTableMigration({
    table: "oauth_flows",
    columns: [
      "id TEXT NOT NULL",
      "provider TEXT NOT NULL",
      "principal_id TEXT NOT NULL",
      "redirect_uri TEXT NOT NULL",
      "issued_at BIGINT NOT NULL",
      "return_to TEXT",
      "account_type TEXT",
      "client_ref TEXT",
      "code_verifier TEXT",
      "consent_link_id TEXT",
    ],
    primaryKey: ["id"],
    backfill: { ...jsonBackfill("oauth_flows", OAUTH_FLOW_SPEC), issued_at: timestamp("issuedAt") },
    where: "json->>'provider' IS NOT NULL AND json->>'principalId' IS NOT NULL AND json->>'redirectUri' IS NOT NULL",
    indexes: [linkIdIndex("oauth_flows")],
  }),
  typedTableMigration({
    table: "consent_links",
    columns: [
      "id TEXT NOT NULL",
      "principal_id TEXT NOT NULL",
      "provider TEXT NOT NULL",
      "account_type TEXT NOT NULL",
      "redirect_uri TEXT NOT NULL",
      "return_to TEXT",
      "created_at BIGINT NOT NULL",
    ],
    primaryKey: ["id"],
    backfill: {
      ...jsonBackfill("consent_links", CONSENT_LINK_SPEC),
      account_type: "COALESCE(json->>'accountType', 'default')",
      created_at: timestamp("createdAt"),
    },
    where: "json->>'principalId' IS NOT NULL AND json->>'provider' IS NOT NULL AND json->>'redirectUri' IS NOT NULL",
    indexes: [linkIdIndex("consent_links")],
  }),
  typedTableMigration({
    table: "secret_drops",
    columns: [
      "id TEXT NOT NULL",
      "owner_id TEXT NOT NULL",
      "service TEXT NOT NULL",
      "env_key TEXT",
      "host TEXT",
      "fields JSONB",
      "purpose TEXT NOT NULL",
      "requested_by TEXT NOT NULL",
      "audience_scope_id TEXT",
      "scope_version TEXT",
      "grant_mode TEXT CHECK (grant_mode IN ('once', 'standing'))",
      "destination JSONB",
      "thread_ref TEXT",
      "requires_token BOOLEAN",
      "created_at BIGINT NOT NULL",
    ],
    primaryKey: ["id"],
    backfill: {
      ...jsonBackfill("secret_drops", SECRET_DROP_SPEC),
      purpose: "COALESCE(json->>'purpose', '')",
      requested_by: "COALESCE(json->>'requestedBy', json->>'ownerId')",
      created_at: timestamp("createdAt"),
    },
    where:
      "json->>'ownerId' IS NOT NULL AND json->>'service' IS NOT NULL" +
      " AND COALESCE(json->>'grantMode', 'once') IN ('once', 'standing')",
    indexes: [
      linkIdIndex("secret_drops"),
      "CREATE INDEX secret_drops_by_thread ON secret_drops(tenant_id, audience_scope_id, thread_ref)",
      "CREATE INDEX secret_drops_by_created ON secret_drops(tenant_id, created_at)",
    ],
  }),
  typedTableMigration({
    table: "composio_returns",
    columns: ["id TEXT NOT NULL", "url TEXT", "toolkit TEXT NOT NULL", "expires_at BIGINT NOT NULL"],
    primaryKey: ["id"],
    backfill: { ...jsonBackfill("composio_returns", COMPOSIO_RETURN_SPEC), expires_at: timestamp("expiresAt") },
    where: "json->>'toolkit' IS NOT NULL",
    indexes: ["CREATE INDEX composio_returns_by_expiry ON composio_returns(tenant_id, expires_at)"],
  }),
  typedTableMigration({
    table: "browser_sessions",
    columns: ["principal_id TEXT NOT NULL", "state_enc TEXT NOT NULL", "updated_at BIGINT NOT NULL"],
    primaryKey: ["principal_id"],
    backfill: {
      ...jsonBackfill("browser_sessions", BROWSER_SESSION_SPEC),
      principal_id: "id",
      updated_at: timestamp("updatedAt"),
    },
    where: "json->>'stateEnc' IS NOT NULL",
  }),
  typedTableMigration({
    table: "mcp_servers",
    columns: [
      "id TEXT NOT NULL",
      "name TEXT NOT NULL",
      "url TEXT NOT NULL",
      "auth TEXT NOT NULL CHECK (auth IN ('none', 'bearer', 'client-credentials', 'oauth-user'))",
      "credential_scope TEXT CHECK (credential_scope IN ('shared', 'per-user'))",
      "credential_host TEXT",
      "credential_account_type TEXT",
      "bearer_token TEXT",
      "client_id TEXT",
      "client_secret TEXT",
      "oauth_authorize_url TEXT",
      "oauth_token_url TEXT",
      "oauth_scopes TEXT[]",
      "tools JSONB",
      "about TEXT",
      "approval TEXT CHECK (approval IN ('annotations', 'all', 'none'))",
      "catalog BOOLEAN",
      "attest_actor BOOLEAN",
      "read_only BOOLEAN NOT NULL",
      "enabled BOOLEAN NOT NULL",
      "updated_at BIGINT NOT NULL",
      "updated_by TEXT NOT NULL",
    ],
    primaryKey: ["id"],
    backfill: {
      ...jsonBackfill("mcp_servers", MCP_SERVER_SPEC),
      id: "id",
      name: "COALESCE(json->>'name', id)",
      auth: "COALESCE(json->>'auth', 'none')",
      read_only: "COALESCE((json->>'readOnly')::boolean, false)",
      enabled: "COALESCE((json->>'enabled')::boolean, false)",
      updated_at: timestamp("updatedAt"),
      updated_by: "COALESCE(json->>'updatedBy', '')",
    },
    where:
      "json->>'url' IS NOT NULL AND COALESCE(json->>'auth', 'none') IN ('none', 'bearer', 'client-credentials', 'oauth-user')" +
      " AND COALESCE(json->>'credentialScope', 'shared') IN ('shared', 'per-user')" +
      " AND COALESCE(json->>'approval', 'none') IN ('annotations', 'all', 'none')",
  }),
];

const MINE = `tenant_id = ${TENANT}`;

export function createPostgresLinkTables(connectionString: string): LinkTables & { close(): Promise<void> } {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, ...LINK_TABLE_MIGRATIONS]);

  function oneTime<R extends { id: string }, T>(
    table: string,
    columns: TypedColumns<R>,
    toRecord: (row: R) => T,
    toRow: (id: string, rec: T) => R,
  ): OneTimeRows<T> {
    const decode = (found: Record<string, unknown> | undefined) => (found ? toRecord(columns.fromRow(found)) : null);
    return {
      async insert(id, rec) {
        await q(
          `INSERT INTO ${table}(${columns.names}) VALUES (${columns.placeholders})`,
          columns.params(toRow(id, rec)),
        );
      },
      async get(id) {
        return decode((await q(`SELECT ${columns.names} FROM ${table} WHERE ${MINE} AND id = $1`, [id]))[0]);
      },
      async take(id) {
        return decode((await q(`DELETE FROM ${table} WHERE ${MINE} AND id = $1 RETURNING ${columns.names}`, [id]))[0]);
      },
    };
  }

  const withId = <T>(id: string, rec: T) => ({ ...rec, id });
  const withoutId = <T extends { id: string }>({ id: _id, ...rec }: T) => rec;
  const drops = oneTime("secret_drops", SECRET_DROP, withoutId, withId);
  const composioReturn = (row: ComposioReturnRow): ComposioReturn => ({
    url: row.url ?? null,
    toolkit: row.toolkit,
    expiresAt: row.expiresAt,
  });

  return {
    close,
    oauthFlows: oneTime("oauth_flows", OAUTH_FLOW, ({ id, ...state }) => ({ ...state, nonce: id }), withId),
    consentLinks: oneTime("consent_links", CONSENT_LINK, withoutId, withId),
    secretDrops: {
      ...drops,
      async siblings(rec, createdSince) {
        const found = await q(
          `SELECT ${SECRET_DROP.names} FROM secret_drops
           WHERE ${MINE} AND audience_scope_id IS NOT DISTINCT FROM $1 AND thread_ref IS NOT DISTINCT FROM $2
             AND service <> $3 AND created_at >= $4
           ORDER BY id`,
          [rec.audienceScopeId ?? null, rec.threadRef ?? null, rec.service, createdSince],
        );
        return found.map((row) => withoutId(SECRET_DROP.fromRow(row)));
      },
      async deleteCreatedBefore(cutoff) {
        await q(`DELETE FROM secret_drops WHERE ${MINE} AND created_at < $1`, [cutoff]);
      },
    },
    composioReturns: {
      async put(id, rec) {
        await q(upsertStatement("composio_returns", COMPOSIO_RETURN, "id"), COMPOSIO_RETURN.params({ ...rec, id }));
      },
      async take(id) {
        const [found] = await q(
          `DELETE FROM composio_returns WHERE ${MINE} AND id = $1 RETURNING ${COMPOSIO_RETURN.names}`,
          [id],
        );
        return found ? composioReturn(COMPOSIO_RETURN.fromRow(found)) : null;
      },
      async deleteExpired(now) {
        await q(`DELETE FROM composio_returns WHERE ${MINE} AND expires_at <= $1`, [now]);
      },
    },
    browserSessions: {
      async get(principalId) {
        const [found] = await q(
          `SELECT ${BROWSER_SESSION.names} FROM browser_sessions WHERE ${MINE} AND principal_id = $1`,
          [principalId],
        );
        return found ? BROWSER_SESSION.fromRow(found) : null;
      },
      async put(rec) {
        await q(upsertStatement("browser_sessions", BROWSER_SESSION, "principal_id"), BROWSER_SESSION.params(rec));
      },
    },
    mcpServers: {
      async list() {
        return (await q(`SELECT ${MCP_SERVER.names} FROM mcp_servers WHERE ${MINE} ORDER BY id`)).map((row) =>
          MCP_SERVER.fromRow(row),
        );
      },
      async get(id) {
        const [found] = await q(`SELECT ${MCP_SERVER.names} FROM mcp_servers WHERE ${MINE} AND id = $1`, [id]);
        return found ? MCP_SERVER.fromRow(found) : null;
      },
      async put(server) {
        await q(upsertStatement("mcp_servers", MCP_SERVER, "id"), MCP_SERVER.params(server));
      },
      async delete(id) {
        await q(`DELETE FROM mcp_servers WHERE ${MINE} AND id = $1`, [id]);
      },
    },
  };
}
