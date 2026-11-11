import { definePgMigration, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { TENANCY, tenantTables } from "../tenants/migrations.ts";

export const fold = (expr: string): string =>
  `CASE WHEN position('@' IN btrim(${expr})) > 0 THEN lower(btrim(${expr})) ELSE btrim(${expr}) END`;

export const ts = (param: string): string => `to_timestamp(${param}::double precision / 1000)`;

export const USERS_SCHEMA = `CREATE TABLE IF NOT EXISTS users(
           id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           primary_alias TEXT NOT NULL UNIQUE,
           kind          TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'app')),
           first_seen_at TIMESTAMPTZ,
           source        TEXT CHECK (source IN ('turn', 'invite', 'admin')),
           offboarded_at TIMESTAMPTZ,
           offboarded_by UUID REFERENCES users(id) ON DELETE SET NULL,
           CHECK ((first_seen_at IS NULL) = (source IS NULL)),
           CHECK (offboarded_at IS NOT NULL OR offboarded_by IS NULL)
         );
         CREATE TABLE IF NOT EXISTS user_links(
           alias_id   TEXT PRIMARY KEY CHECK (alias_id <> ''),
           user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           evidence   TEXT NOT NULL,
           linked_by  UUID REFERENCES users(id) ON DELETE SET NULL,
           created_at TIMESTAMPTZ NOT NULL,
           UNIQUE (user_id, alias_id)
         );
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_primary_alias_link') THEN
           ALTER TABLE users ADD CONSTRAINT users_primary_alias_link FOREIGN KEY (id, primary_alias)
             REFERENCES user_links(user_id, alias_id) DEFERRABLE INITIALLY DEFERRED;
         END IF;`;

const SOURCES = ["principal_links", "admin_grants", "items", "sessions", "directory_members", "external_members"];

const userOf = (tenant: string, alias: string): string =>
  `(SELECT l.user_id FROM user_links l WHERE l.tenant_id = ${tenant} AND l.alias_id = ${alias})`;

const ensureUsers = (rows: string): string => `
  INSERT INTO users(tenant_id, primary_alias)
    SELECT DISTINCT s.t, s.a FROM (${rows}) AS s(t, a)
     WHERE coalesce(s.a, '') <> '' AND NOT EXISTS (SELECT 1 FROM user_links l WHERE l.tenant_id = s.t AND l.alias_id = s.a)
  ON CONFLICT (tenant_id, primary_alias) DO NOTHING;
  INSERT INTO user_links(tenant_id, alias_id, user_id, evidence, created_at)
    SELECT u.tenant_id, u.primary_alias, u.id, 'primary', now() FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM user_links l WHERE l.tenant_id = u.tenant_id AND l.alias_id = u.primary_alias);`;

const knownPerson = (tenant: string, alias: string): string =>
  `(EXISTS (SELECT 1 FROM user_links k WHERE k.tenant_id = ${tenant} AND k.alias_id = ${alias})
    OR EXISTS (SELECT 1 FROM admins a WHERE a.t = ${tenant} AND a.alias = ${alias})
    OR ${alias} LIKE '%@%' OR ${alias} LIKE 'oidc:%')`;

const seenAs = (rows: string, source: string, onlyUnseen = false): string => `
  UPDATE users u SET first_seen_at = s.at, source = '${source}'
    FROM (SELECT r.t, ${userOf("r.t", "r.alias")} AS id, MIN(r.at) AS at FROM (${rows}) AS r(t, alias, at) GROUP BY 1, 2) s
   WHERE u.tenant_id = s.t AND u.id = s.id
     AND ${onlyUnseen ? "u.first_seen_at IS NULL" : "(u.first_seen_at IS NULL OR s.at < u.first_seen_at)"};`;

const STAGE = `
  CREATE TEMP TABLE staged_users(t UUID, alias TEXT, kind TEXT, first_seen_at TIMESTAMPTZ, source TEXT,
                                 offboarded_at TIMESTAMPTZ, offboarded_by TEXT) ON COMMIT DROP;
  CREATE TEMP TABLE staged_links(t UUID, alias TEXT, canonical TEXT, evidence TEXT, linked_by TEXT,
                                 created_at TIMESTAMPTZ) ON COMMIT DROP;
  IF to_regclass('users_text_ids') IS NOT NULL THEN
    SELECT id INTO first_tenant FROM tenants ORDER BY created_at, id LIMIT 1;
    IF first_tenant IS NULL AND (EXISTS (SELECT 1 FROM users_text_ids) OR EXISTS (SELECT 1 FROM user_links_text_ids)) THEN
      INSERT INTO tenants DEFAULT VALUES RETURNING id INTO first_tenant;
    END IF;
    INSERT INTO staged_users
      SELECT first_tenant, j->>'id', coalesce(j->>'kind', 'person'), (j->>'first_seen_at')::timestamptz, j->>'source',
             (j->>'offboarded_at')::timestamptz, j->>'offboarded_by'
        FROM (SELECT to_jsonb(u) AS j FROM users_text_ids u) x;
    INSERT INTO staged_links
      SELECT first_tenant, j->>'alias_id', j->>'user_id', j->>'evidence', j->>'linked_by', (j->>'created_at')::timestamptz
        FROM (SELECT to_jsonb(l) AS j FROM user_links_text_ids l) x;
    DROP TABLE users_text_ids, user_links_text_ids;
  END IF;
  IF to_regclass('principal_links') IS NOT NULL THEN
    INSERT INTO staged_links
      SELECT tenant_id, ${fold("id")}, ${fold("json->>'canonicalId'")}, coalesce(json->>'evidence', ''),
             coalesce(json->>'linkedBy', ''), to_timestamp(coalesce((json->>'createdAt')::double precision, 0) / 1000)
        FROM principal_links;
    DROP TABLE principal_links;
    DROP FUNCTION IF EXISTS claim_principal_links(), claim_principal_links_tenants();
    IF to_regclass('durable_map_versions') IS NOT NULL THEN
      DELETE FROM durable_map_versions WHERE tbl = 'principal_links';
    END IF;
  END IF;
  CREATE TEMP TABLE admins(t UUID, alias TEXT) ON COMMIT DROP;
  IF to_regclass('admin_grants') IS NOT NULL THEN
    INSERT INTO admins SELECT tenant_id, ${fold("principal_id")} FROM admin_grants;
  END IF;`;

const LINKS = `
  DELETE FROM staged_links WHERE coalesce(alias, '') = '' OR coalesce(canonical, '') = '' OR alias = canonical;
  ${ensureUsers("SELECT t, canonical FROM staged_links")}
  INSERT INTO user_links(tenant_id, alias_id, user_id, evidence, created_at)
    SELECT DISTINCT ON (s.t, s.alias) s.t, s.alias, ${userOf("s.t", "s.canonical")}, s.evidence, s.created_at
      FROM staged_links s
     ORDER BY s.t, s.alias, s.created_at
  ON CONFLICT (tenant_id, alias_id) DO NOTHING;
  ${ensureUsers("SELECT t, alias FROM staged_users")}
  UPDATE users u SET kind = 'app' FROM staged_users s
   WHERE u.tenant_id = s.t AND u.id = ${userOf("s.t", "s.alias")} AND s.kind = 'app';
  ${seenAs("SELECT t, alias, first_seen_at FROM staged_users WHERE first_seen_at IS NOT NULL AND source = 'turn'", "turn")}
  ${seenAs("SELECT t, alias, first_seen_at FROM staged_users WHERE first_seen_at IS NOT NULL AND source = 'invite'", "invite")}
  ${seenAs("SELECT t, alias, first_seen_at FROM staged_users WHERE first_seen_at IS NOT NULL AND source = 'admin'", "admin")}
  UPDATE staged_links SET linked_by = ${fold("linked_by")};
  UPDATE staged_users SET offboarded_by = ${fold("offboarded_by")};
  ${ensureUsers(`SELECT t, linked_by FROM staged_links WHERE ${knownPerson("staged_links.t", "staged_links.linked_by")}`)}
  ${ensureUsers(`SELECT t, offboarded_by FROM staged_users WHERE offboarded_at IS NOT NULL AND ${knownPerson("staged_users.t", "staged_users.offboarded_by")}`)}
  UPDATE user_links l SET linked_by = ${userOf("s.t", "s.linked_by")},
         evidence = CASE WHEN ${userOf("s.t", "s.linked_by")} IS NULL
                         THEN l.evidence || ' (linked by ' || s.linked_by || ')' ELSE l.evidence END
    FROM staged_links s
   WHERE s.t = l.tenant_id AND s.alias = l.alias_id AND l.evidence <> 'primary'
     AND coalesce(s.linked_by, '') NOT IN ('', 'migration');
  UPDATE users u SET offboarded_at = s.offboarded_at, offboarded_by = ${userOf("s.t", "s.offboarded_by")}
    FROM staged_users s
   WHERE u.tenant_id = s.t AND u.id = ${userOf("s.t", "s.alias")} AND s.offboarded_at IS NOT NULL
     AND (u.offboarded_at IS NULL OR s.offboarded_at < u.offboarded_at);`;

const HISTORY = `
  IF to_regclass('items') IS NOT NULL AND to_regclass('sessions') IS NOT NULL THEN
    CREATE TEMP TABLE turn_authors ON COMMIT DROP AS
    SELECT s.tenant_id AS t, ${fold("e.author")} AS author, MIN(e.created_at) AS at
      FROM items e
      JOIN sessions s ON s.tenant_id = e.tenant_id AND s.id = e.session_id
     WHERE e.author IS NOT NULL AND e.author NOT LIKE 'system:%'
       AND e.kind IN ('UserMessage', 'SteeringMessage')
       AND NOT (e.body @> '{"overheard":true}')
       AND s.origin = 'conversation' AND s.parent_session_id IS NULL
       AND coalesce(s.spawn_meta::jsonb -> 'surfaceOrigin' ->> 'audience', '') <> 'external'
       AND coalesce(s.spawn_meta::jsonb -> 'origin' ->> 'kind', '') <> 'automation'
     GROUP BY 1, 2;
    IF to_regclass('directory_members') IS NOT NULL THEN
      CREATE TEMP TABLE slack_authors ON COMMIT DROP AS
      SELECT DISTINCT ON (a.t, a.author) a.t, a.author, ${fold("d.principal_id")} AS person
        FROM turn_authors a
        JOIN directory_members d
          ON d.tenant_id = a.t AND d.slack_id = a.author AND ${fold("d.principal_id")} <> a.author
       WHERE NOT EXISTS (SELECT 1 FROM user_links l WHERE l.tenant_id = a.t AND l.alias_id = a.author)
       ORDER BY a.t, a.author, d.principal_id;
      ${ensureUsers("SELECT t, person FROM slack_authors")}
      INSERT INTO user_links(tenant_id, alias_id, user_id, evidence, created_at)
        SELECT t, author, ${userOf("t", "person")}, 'slack directory: slack_id→principal_id', now() FROM slack_authors
      ON CONFLICT (tenant_id, alias_id) DO NOTHING;
    END IF;
    ${ensureUsers("SELECT t, author FROM turn_authors")}
    ${seenAs("SELECT t, author, at FROM turn_authors", "turn")}
  END IF;`;

const GRANTS_AND_INVITES = `
  IF to_regclass('admin_grants') IS NOT NULL THEN
    CREATE TEMP TABLE granted ON COMMIT DROP AS
      SELECT tenant_id AS t, ${fold("principal_id")} AS alias,
             CASE WHEN coalesce(created_at, 0) > 0 THEN ${ts("created_at")} ELSE now() END AS at
        FROM admin_grants;
    ${ensureUsers("SELECT t, alias FROM granted")}
    ${seenAs("SELECT t, alias, at FROM granted", "admin", true)}
  END IF;
  IF to_regclass('external_members') IS NOT NULL THEN
    CREATE TEMP TABLE invited ON COMMIT DROP AS
      SELECT tenant_id AS t, ${fold("json->>'email'")} AS alias, ${ts("(json->>'createdAt')::bigint")} AS at
        FROM external_members
       WHERE json->>'kind' = 'teammate' AND coalesce(json->>'email', '') <> '';
    ${ensureUsers("SELECT t, alias FROM invited")}
    ${seenAs("SELECT t, alias, at FROM invited", "invite", true)}
  END IF;`;

export const MANUAL_DEACTIVATIONS: PgMigrationDefinition = {
  id: "users/v2/0009-manual-deactivations",
  statements: [
    `DO $$
     BEGIN
       IF to_regclass('deactivated_principals') IS NULL THEN RETURN; END IF;
       CREATE TEMP TABLE manual ON COMMIT DROP AS
         SELECT tenant_id AS t, id AS alias, ${ts("(json->>'at')::bigint")} AS at
           FROM deactivated_principals WHERE json->>'source' = 'manual';
       ${ensureUsers("SELECT t, alias FROM manual")}
       UPDATE users u SET offboarded_at = s.at
         FROM (SELECT t, ${userOf("t", "alias")} AS id, MIN(at) AS at FROM manual GROUP BY 1, 2) s
        WHERE u.tenant_id = s.t AND u.id = s.id AND u.offboarded_at IS NULL;
       DELETE FROM deactivated_principals WHERE json->>'source' = 'manual';
     END $$`,
  ],
};

const USERS_TENANT_KEYS = tenantTables(
  "users/v2/0004-tenants",
  [
    {
      table: "users",
      primaryKey: "id",
      unique: [{ name: "users_primary_alias_key", columns: "primary_alias", constraint: true }],
    },
    {
      table: "user_links",
      primaryKey: "alias_id",
      unique: [{ name: "user_links_user_id_alias_id_key", columns: "user_id, alias_id", constraint: true }],
    },
    { table: "personas", primaryKey: "id" },
    { table: "persona_access", primaryKey: "persona_id, grantee_scope_id" },
  ],
  {
    references: [
      {
        table: "users",
        name: "users_offboarded_by_fkey",
        columns: "offboarded_by",
        references: "users(tenant_id, id)",
        onDelete: "SET NULL",
      },
      {
        table: "users",
        name: "users_primary_alias_link",
        columns: "id, primary_alias",
        references: "user_links(tenant_id, user_id, alias_id)",
        deferrable: true,
      },
      {
        table: "user_links",
        name: "user_links_user_id_fkey",
        columns: "user_id",
        references: "users(tenant_id, id)",
        onDelete: "CASCADE",
      },
      {
        table: "user_links",
        name: "user_links_linked_by_fkey",
        columns: "linked_by",
        references: "users(tenant_id, id)",
        onDelete: "SET NULL",
      },
      {
        table: "personas",
        name: "personas_created_by_fkey",
        columns: "created_by",
        references: "users(tenant_id, id)",
      },
      {
        table: "persona_access",
        name: "persona_access_persona_id_fkey",
        columns: "persona_id",
        references: "personas(tenant_id, id)",
        onDelete: "CASCADE",
      },
      {
        table: "persona_access",
        name: "persona_access_granted_by_fkey",
        columns: "granted_by",
        references: "users(tenant_id, id)",
      },
    ],
  },
);

function tenantedStart(untenanted: readonly PgMigrationDefinition[]): PgMigrationDefinition {
  const ledger = untenanted
    .map((migration) => `('${migration.id}', '${definePgMigration(migration).checksum}')`)
    .join(", ");
  return {
    id: "users/v2/0000-tenanted-start",
    statements: [
      `DO $users_tenanted_start$
       BEGIN
         IF EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = '${untenanted[0]!.id}') THEN RETURN; END IF;
         IF EXISTS (SELECT 1 FROM unnest(ARRAY['${SOURCES.join("', '")}']) AS s(name)
                     WHERE to_regclass(s.name) IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                                        WHERE c.table_schema = current_schema() AND c.table_name = s.name
                                          AND c.column_name = 'tenant_id')) THEN
           IF (SELECT count(*) FROM tenants) > 1 THEN
             RAISE EXCEPTION 'users: several tenants exist but some tables they read have no tenant column yet';
           END IF;
           RETURN;
         END IF;
         IF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'users'
                       AND column_name = 'id' AND data_type = 'text') THEN
           CREATE TABLE users_text_ids AS SELECT * FROM users;
           CREATE TABLE user_links_text_ids(alias_id TEXT, user_id TEXT, evidence TEXT, linked_by TEXT,
                                            created_at TIMESTAMPTZ);
           IF to_regclass('user_links') IS NOT NULL THEN
             INSERT INTO user_links_text_ids
               SELECT j->>'alias_id', j->>'user_id', j->>'evidence', j->>'linked_by', (j->>'created_at')::timestamptz
                 FROM (SELECT to_jsonb(l) AS j FROM user_links l) x;
             DROP TABLE user_links;
           END IF;
           DROP TABLE users;
         END IF;
         ${USERS_SCHEMA}
         INSERT INTO qm_schema_migrations(id, checksum) VALUES ${ledger};
       END $users_tenanted_start$`,
    ],
  };
}

const TENANTED_BACKFILL: PgMigrationDefinition = {
  id: "users/v2/0005-tenanted-backfill",
  statements: [
    `DO $users_tenanted_backfill$
     DECLARE
       first_tenant UUID;
     BEGIN
       IF EXISTS (SELECT 1 FROM users) THEN RETURN; END IF;
       ${STAGE}
       ${LINKS}
       ${HISTORY}
       ${GRANTS_AND_INVITES}
     END $users_tenanted_backfill$`,
  ],
};

export function tenantedUsers(untenanted: readonly PgMigrationDefinition[]): {
  before: PgMigrationDefinition[];
  after: PgMigrationDefinition[];
} {
  return { before: [...TENANCY, tenantedStart(untenanted)], after: [...USERS_TENANT_KEYS, TENANTED_BACKFILL] };
}
