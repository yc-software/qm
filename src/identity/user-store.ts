import type { PoolClient } from "pg";
import { createPgPool, withPgTransaction, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { DIRECTORY_MIGRATIONS } from "../directory/postgres-directory-store.ts";
import { SESSION_MIGRATIONS } from "../sessions/session-schema.ts";
import { msOf } from "../sessions/items.ts";
import { foldPrincipalId } from "../directory/person.ts";

type UserSource = "turn" | "invite" | "admin";

interface UserRecord {
  id: string;
  firstSeenAt?: number;
  source?: UserSource;
  offboardedAt?: number;
  offboardedBy?: string;
}

export interface UserLink {
  principalId: string;
  canonicalId: string;
  evidence: string;
  linkedBy: string;
  createdAt: number;
}

export interface UserLinkStore {
  links(): Promise<UserLink[]>;
  link(link: UserLink): Promise<UserLink>;
  unlink(aliasId: string): Promise<UserLink | null>;
}

interface SeenPerson {
  id: string;
  source: UserSource;
  at: number;
}

export interface UserStore extends UserLinkStore {
  list(): Promise<UserRecord[]>;
  get(id: string): Promise<UserRecord | null>;
  record(person: SeenPerson): Promise<boolean>;
  markOffboarded(id: string, by: string): Promise<UserRecord>;
  markReactivated(id: string): Promise<UserRecord | null>;
}

export const fold = (expr: string): string =>
  `CASE WHEN position('@' IN btrim(${expr})) > 0 THEN lower(btrim(${expr})) ELSE btrim(${expr}) END`;

const person = (expr: string): string =>
  `coalesce((SELECT l.user_id FROM user_links l WHERE l.alias_id = ${expr}), ${expr})`;

const ts = (param: string): string => `to_timestamp(${param}::double precision / 1000)`;

export const USER_MIGRATIONS: PgMigrationDefinition[] = [
  {
    id: "users/0001",
    statements: [
      `CREATE TABLE IF NOT EXISTS users(
        id            TEXT PRIMARY KEY CHECK (id <> ''),
        first_seen_at TIMESTAMPTZ,
        source        TEXT CHECK (source IN ('turn', 'invite', 'admin')),
        offboarded_at TIMESTAMPTZ,
        offboarded_by TEXT,
        CHECK ((first_seen_at IS NULL) = (source IS NULL)),
        CHECK ((offboarded_at IS NULL) = (offboarded_by IS NULL))
      )`,
      `CREATE TABLE IF NOT EXISTS user_links(
        alias_id   TEXT PRIMARY KEY CHECK (alias_id <> ''),
        user_id    TEXT NOT NULL REFERENCES users(id),
        evidence   TEXT NOT NULL,
        linked_by  TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CHECK (alias_id <> user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS user_links_user_id ON user_links(user_id)`,
    ],
  },
  {
    id: "users/0002-copy-principal-links",
    statements: [
      `DO $$
       DECLARE skipped bigint; skipped_ids text;
       BEGIN
         IF to_regclass('principal_links') IS NULL OR to_regclass('users') IS NULL THEN RETURN; END IF;
         INSERT INTO users(id)
           SELECT DISTINCT ${fold("json->>'canonicalId'")} FROM principal_links
          WHERE coalesce(btrim(json->>'canonicalId'), '') <> ''
         ON CONFLICT (id) DO NOTHING;
         INSERT INTO user_links(alias_id, user_id, evidence, linked_by, created_at)
           SELECT ${fold("id")}, ${fold("json->>'canonicalId'")}, coalesce(json->>'evidence', ''),
                  coalesce(json->>'linkedBy', ''), to_timestamp(coalesce((json->>'createdAt')::double precision, 0) / 1000)
             FROM principal_links
            WHERE coalesce(btrim(json->>'canonicalId'), '') <> ''
              AND ${fold("id")} <> ${fold("json->>'canonicalId'")}
         ON CONFLICT (alias_id) DO NOTHING;
         SELECT count(*), string_agg(p.id, ', ') INTO skipped, skipped_ids FROM principal_links p
          WHERE NOT EXISTS (SELECT 1 FROM user_links l
                             WHERE l.alias_id = ${fold("p.id")} AND l.user_id = ${fold("p.json->>'canonicalId'")});
         IF skipped > 0 THEN
           RAISE EXCEPTION 'users/0002: % principal_links rows cannot be copied (empty canonical, self-link or collision): %',
             skipped, skipped_ids;
         END IF;
         DROP TABLE principal_links;
         IF to_regclass('durable_map_versions') IS NOT NULL THEN
           DELETE FROM durable_map_versions WHERE tbl = 'principal_links';
         END IF;
       END $$`,
    ],
  },
  {
    id: "users/0003-turn-backfill",
    statements: [
      `DO $$
       BEGIN
         IF to_regclass('users') IS NULL THEN RETURN; END IF;
         CREATE TEMP TABLE turn_authors ON COMMIT DROP AS
         SELECT ${fold("e.author")} AS author, MIN(e.created_at) AS at
           FROM items e
           JOIN sessions s ON s.id = e.session_id
          WHERE e.author IS NOT NULL AND e.author NOT LIKE 'system:%'
            AND e.kind IN ('UserMessage', 'SteeringMessage')
            AND NOT (e.body @> '{"overheard":true}')
            AND s.origin = 'conversation' AND s.parent_session_id IS NULL
            AND coalesce(s.spawn_meta::jsonb -> 'surfaceOrigin' ->> 'audience', '') <> 'external'
            AND coalesce(s.spawn_meta::jsonb -> 'origin' ->> 'kind', '') <> 'automation'
          GROUP BY 1;
         IF to_regclass('directory_members') IS NOT NULL THEN
           CREATE TEMP TABLE slack_authors ON COMMIT DROP AS
           SELECT DISTINCT ON (a.author) a.author, ${person(fold("d.principal_id"))} AS user_id
             FROM turn_authors a
             JOIN directory_members d ON d.slack_id = a.author AND d.principal_id <> a.author
            WHERE NOT EXISTS (SELECT 1 FROM user_links l WHERE l.alias_id = a.author)
              AND NOT EXISTS (SELECT 1 FROM user_links l WHERE l.user_id = a.author)
            ORDER BY a.author, d.principal_id;
           INSERT INTO users(id)
             SELECT DISTINCT user_id FROM slack_authors WHERE user_id <> author
           ON CONFLICT (id) DO NOTHING;
           INSERT INTO user_links(alias_id, user_id, evidence, linked_by, created_at)
             SELECT author, user_id, 'slack directory: slack_id→principal_id', 'migration', now()
               FROM slack_authors WHERE user_id <> author
           ON CONFLICT (alias_id) DO NOTHING;
         END IF;
         INSERT INTO users AS u(id, first_seen_at, source)
         SELECT ${person("a.author")}, MIN(a.at), 'turn'
           FROM turn_authors a
          GROUP BY 1
         ON CONFLICT (id) DO UPDATE SET first_seen_at = EXCLUDED.first_seen_at, source = EXCLUDED.source
           WHERE u.first_seen_at IS NULL;
       END $$`,
    ],
  },
  {
    id: "users/0004-grant-and-invite-backfill",
    statements: [
      `DO $$
       BEGIN
         IF to_regclass('users') IS NULL THEN RETURN; END IF;
         IF to_regclass('admin_grants') IS NOT NULL THEN
           INSERT INTO users AS u(id, first_seen_at, source)
           SELECT ${person(fold("g.principal_id"))},
                  MIN(CASE WHEN coalesce(g.created_at, 0) > 0 THEN ${ts("g.created_at")} ELSE now() END), 'admin'
             FROM admin_grants g
            GROUP BY 1
           ON CONFLICT (id) DO UPDATE SET first_seen_at = EXCLUDED.first_seen_at, source = EXCLUDED.source
             WHERE u.first_seen_at IS NULL;
         END IF;
         IF to_regclass('external_members') IS NOT NULL THEN
           INSERT INTO users AS u(id, first_seen_at, source)
           SELECT ${person(fold("m.json->>'email'"))},
                  MIN(${ts("(m.json->>'createdAt')::bigint")}), 'invite'
             FROM external_members m
            WHERE m.json->>'kind' = 'teammate' AND coalesce(m.json->>'email', '') <> ''
            GROUP BY 1
           ON CONFLICT (id) DO UPDATE SET first_seen_at = EXCLUDED.first_seen_at, source = EXCLUDED.source
             WHERE u.first_seen_at IS NULL;
         END IF;
       END $$`,
    ],
  },
];

const COLUMNS = `id, ${msOf("first_seen_at")} AS first_seen_at, source, ${msOf("offboarded_at")} AS offboarded_at, offboarded_by`;
const LINK_COLUMNS = `alias_id, user_id, evidence, linked_by, ${msOf("created_at")} AS created_at`;
function toRecord(r: Record<string, unknown>): UserRecord {
  return {
    id: r.id as string,
    ...(r.first_seen_at != null ? { firstSeenAt: Number(r.first_seen_at), source: r.source as UserSource } : {}),
    ...(r.offboarded_at != null
      ? { offboardedAt: Number(r.offboarded_at), offboardedBy: r.offboarded_by as string }
      : {}),
  };
}

function toLink(r: Record<string, unknown>): UserLink {
  return {
    principalId: r.alias_id as string,
    canonicalId: r.user_id as string,
    evidence: r.evidence as string,
    linkedBy: r.linked_by as string,
    createdAt: Number(r.created_at),
  };
}

async function linkInTransaction(client: PoolClient, link: UserLink): Promise<UserLink> {
  await client.query(`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`);
  const existing = await client.query(`SELECT ${LINK_COLUMNS} FROM user_links WHERE alias_id = $1`, [link.principalId]);
  if (existing.rows[0]) return toLink(existing.rows[0]);
  await client.query(`INSERT INTO users(id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [link.canonicalId]);
  await client.query(
    `UPDATE users c SET
       first_seen_at = least(c.first_seen_at, a.first_seen_at),
       source = CASE WHEN a.first_seen_at < c.first_seen_at OR c.first_seen_at IS NULL THEN a.source ELSE c.source END,
       offboarded_at = least(c.offboarded_at, a.offboarded_at),
       offboarded_by = CASE WHEN a.offboarded_at < c.offboarded_at OR c.offboarded_at IS NULL
                            THEN a.offboarded_by ELSE c.offboarded_by END
     FROM users a WHERE c.id = $1 AND a.id = $2`,
    [link.canonicalId, link.principalId],
  );
  await client.query(`DELETE FROM users WHERE id = $1`, [link.principalId]);
  const inserted = await client.query(
    `INSERT INTO user_links(alias_id, user_id, evidence, linked_by, created_at) VALUES ($1, $2, $3, $4, ${ts("$5")})
     RETURNING ${LINK_COLUMNS}`,
    [link.principalId, link.canonicalId, link.evidence, link.linkedBy, link.createdAt],
  );
  return toLink(inserted.rows[0]);
}

export function createPostgresUserStore(connectionString: string): UserStore {
  const pg = createPgPool(connectionString, [...DIRECTORY_MIGRATIONS, ...SESSION_MIGRATIONS, ...USER_MIGRATIONS]);
  const { q } = pg;
  return {
    async list() {
      const rows = await q(`SELECT ${COLUMNS} FROM users WHERE first_seen_at IS NOT NULL OR offboarded_at IS NOT NULL`);
      return rows.map(toRecord);
    },
    async get(id) {
      const rows = await q(`SELECT ${COLUMNS} FROM users WHERE id = ${person("$1")}`, [foldPrincipalId(id)]);
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async record({ id, source, at }) {
      const rows = await q(
        `INSERT INTO users AS u(id, first_seen_at, source) VALUES (${person("$1")}, ${ts("$2")}, $3)
         ON CONFLICT (id) DO UPDATE SET first_seen_at = EXCLUDED.first_seen_at, source = EXCLUDED.source
           WHERE u.first_seen_at IS NULL
         RETURNING id`,
        [foldPrincipalId(id), at, source],
      );
      return rows.length > 0;
    },
    async markOffboarded(id, by) {
      const rows = await q(
        `INSERT INTO users AS u(id, offboarded_at, offboarded_by) VALUES (${person("$1")}, now(), $2)
         ON CONFLICT (id) DO UPDATE SET offboarded_at = coalesce(u.offboarded_at, EXCLUDED.offboarded_at),
           offboarded_by = CASE WHEN u.offboarded_at IS NULL THEN EXCLUDED.offboarded_by ELSE u.offboarded_by END
         RETURNING ${COLUMNS}`,
        [foldPrincipalId(id), by],
      );
      return toRecord(rows[0]!);
    },
    async markReactivated(id) {
      const rows = await q(
        `UPDATE users SET offboarded_at = NULL, offboarded_by = NULL WHERE id = ${person("$1")} RETURNING ${COLUMNS}`,
        [foldPrincipalId(id)],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async links() {
      return (await q(`SELECT ${LINK_COLUMNS} FROM user_links`)).map(toLink);
    },
    async link(link) {
      return withPgTransaction(await pg.pool(), (client) => linkInTransaction(client, link));
    },
    async unlink(aliasId) {
      const rows = await q(`DELETE FROM user_links WHERE alias_id = $1 RETURNING ${LINK_COLUMNS}`, [aliasId]);
      return rows[0] ? toLink(rows[0]) : null;
    },
  };
}
