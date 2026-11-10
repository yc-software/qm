import type { PoolClient } from "pg";
import { createPgPool, withPgTransaction, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { DIRECTORY_MIGRATIONS } from "../directory/postgres-directory-store.ts";
import { SESSION_MIGRATIONS } from "../sessions/session-schema.ts";
import { authoredUserTurn, msOf, TENANT } from "../sessions/items.ts";
import { foldPrincipalId } from "../directory/person.ts";
import { PERSONA_MIGRATIONS } from "../personas/persona-schema.ts";
import { PERSONA_TENANCY } from "../personas/persona-tenancy.ts";
import { fold, tenantedUsers, ts, USERS_SCHEMA } from "./user-tenancy.ts";

export { fold };

type UserSource = "turn" | "invite" | "admin";
type UserKind = "person" | "app";

export interface UserRecord {
  id: string;
  principalId: string;
  aliases: string[];
  kind: UserKind;
  firstSeenAt?: number;
  source?: UserSource;
  offboardedAt?: number;
  offboardedBy?: string;
  displayName?: string;
}

export interface UserLink {
  principalId: string;
  canonicalId: string;
  evidence: string;
  linkedBy: string;
  createdAt: number;
}

export interface UserActivity {
  userId: string | null;
  principalId: string;
  kind: UserKind;
  sessions: number;
  turns: number;
  lastSeenAt: number | null;
  days: number[];
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
  get(idOrAlias: string): Promise<UserRecord | null>;
  resolve(aliases: readonly string[]): Promise<Map<string, UserRecord>>;
  activity(): Promise<UserActivity[]>;
  record(person: SeenPerson): Promise<boolean>;
  markOffboarded(id: string, by: string): Promise<UserRecord>;
  markReactivated(id: string): Promise<UserRecord | null>;
  markApps(ids: readonly string[]): Promise<number>;
  setDisplayName(alias: string, name: string): Promise<boolean>;
}

const DISPLAY_NAME_MAX = 200;

export function cleanDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DISPLAY_NAME_MAX)
    .trim();
  return name || undefined;
}

const userOf = (expr: string): string => `(SELECT l.user_id FROM user_links l WHERE l.alias_id = ${expr})`;

const ensureUsers = (aliases: string): string => `
  INSERT INTO users(primary_alias)
    SELECT DISTINCT s.a FROM (${aliases}) AS s(a)
     WHERE coalesce(s.a, '') <> '' AND NOT EXISTS (SELECT 1 FROM user_links l WHERE l.alias_id = s.a)
  ON CONFLICT (primary_alias) DO NOTHING;
  INSERT INTO user_links(alias_id, user_id, evidence, created_at)
    SELECT u.primary_alias, u.id, 'primary', now() FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM user_links l WHERE l.alias_id = u.primary_alias);`;

const knownPerson = (expr: string): string =>
  `(EXISTS (SELECT 1 FROM user_links k WHERE k.alias_id = ${expr}) OR ${expr} IN (SELECT alias FROM admins)
    OR ${expr} LIKE '%@%' OR ${expr} LIKE 'oidc:%')`;

const TURN_AUTHORS = `
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
   GROUP BY 1;`;

const seenAs = (rows: string, source: string): string => `
  UPDATE users u SET first_seen_at = s.at, source = '${source}'
    FROM (SELECT ${userOf("r.alias")} AS id, MIN(r.at) AS at FROM (${rows}) AS r(alias, at) GROUP BY 1) s
   WHERE u.id = s.id AND (u.first_seen_at IS NULL OR s.at < u.first_seen_at);`;

export const USER_MIGRATIONS: PgMigrationDefinition[] = [
  {
    id: "users/v2/0001-uuid-users",
    statements: [
      `DO $$
       BEGIN
         CREATE TEMP TABLE staged_users(alias TEXT, kind TEXT, first_seen_at TIMESTAMPTZ, source TEXT,
                                        offboarded_at TIMESTAMPTZ, offboarded_by TEXT) ON COMMIT DROP;
         CREATE TEMP TABLE staged_links(alias TEXT, canonical TEXT, evidence TEXT, linked_by TEXT,
                                        created_at TIMESTAMPTZ) ON COMMIT DROP;
         IF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'users'
                       AND column_name = 'id' AND data_type = 'text') THEN
           INSERT INTO staged_users
             SELECT j->>'id', coalesce(j->>'kind', 'person'), (j->>'first_seen_at')::timestamptz, j->>'source',
                    (j->>'offboarded_at')::timestamptz, j->>'offboarded_by'
               FROM (SELECT to_jsonb(u) AS j FROM users u) x;
           IF to_regclass('user_links') IS NOT NULL THEN
             INSERT INTO staged_links
               SELECT j->>'alias_id', j->>'user_id', j->>'evidence', j->>'linked_by', (j->>'created_at')::timestamptz
                 FROM (SELECT to_jsonb(l) AS j FROM user_links l) x;
             DROP TABLE user_links;
           END IF;
           DROP TABLE users;
         END IF;
         IF to_regclass('principal_links') IS NOT NULL THEN
           INSERT INTO staged_links
             SELECT ${fold("id")}, ${fold("json->>'canonicalId'")}, coalesce(json->>'evidence', ''),
                    coalesce(json->>'linkedBy', ''),
                    to_timestamp(coalesce((json->>'createdAt')::double precision, 0) / 1000)
               FROM principal_links;
           DROP TABLE principal_links;
           IF to_regclass('durable_map_versions') IS NOT NULL THEN
             DELETE FROM durable_map_versions WHERE tbl = 'principal_links';
           END IF;
         END IF;

         ${USERS_SCHEMA}

         DELETE FROM staged_links WHERE coalesce(alias, '') = '' OR coalesce(canonical, '') = '' OR alias = canonical;
         ${ensureUsers("SELECT canonical FROM staged_links")}
         INSERT INTO user_links(alias_id, user_id, evidence, created_at)
           SELECT DISTINCT ON (s.alias) s.alias, ${userOf("s.canonical")}, s.evidence, s.created_at
             FROM staged_links s
            ORDER BY s.alias, s.created_at
         ON CONFLICT (alias_id) DO NOTHING;

         ${ensureUsers("SELECT alias FROM staged_users")}
         UPDATE users u SET kind = 'app' FROM staged_users s WHERE u.id = ${userOf("s.alias")} AND s.kind = 'app';
         ${seenAs("SELECT alias, first_seen_at FROM staged_users WHERE first_seen_at IS NOT NULL AND source = 'turn'", "turn")}
         ${seenAs("SELECT alias, first_seen_at FROM staged_users WHERE first_seen_at IS NOT NULL AND source = 'invite'", "invite")}
         ${seenAs("SELECT alias, first_seen_at FROM staged_users WHERE first_seen_at IS NOT NULL AND source = 'admin'", "admin")}
         CREATE TEMP TABLE admins(alias TEXT) ON COMMIT DROP;
         IF to_regclass('admin_grants') IS NOT NULL THEN
           INSERT INTO admins SELECT ${fold("principal_id")} FROM admin_grants;
         END IF;
         UPDATE staged_links SET linked_by = ${fold("linked_by")};
         UPDATE staged_users SET offboarded_by = ${fold("offboarded_by")};
         ${ensureUsers(`SELECT linked_by FROM staged_links WHERE ${knownPerson("staged_links.linked_by")}`)}
         ${ensureUsers(`SELECT offboarded_by FROM staged_users WHERE offboarded_at IS NOT NULL AND ${knownPerson("staged_users.offboarded_by")}`)}
         UPDATE user_links l SET linked_by = ${userOf("s.linked_by")},
                evidence = CASE WHEN ${userOf("s.linked_by")} IS NULL
                                THEN l.evidence || ' (linked by ' || s.linked_by || ')' ELSE l.evidence END
           FROM staged_links s
          WHERE s.alias = l.alias_id AND l.evidence <> 'primary' AND coalesce(s.linked_by, '') NOT IN ('', 'migration');
         UPDATE users u SET offboarded_at = s.offboarded_at, offboarded_by = ${userOf("s.offboarded_by")}
           FROM staged_users s
          WHERE u.id = ${userOf("s.alias")} AND s.offboarded_at IS NOT NULL
            AND (u.offboarded_at IS NULL OR s.offboarded_at < u.offboarded_at);
       END $$`,
    ],
  },
  {
    id: "users/v2/0002-history",
    statements: [
      `DO $$
       BEGIN
         IF to_regclass('items') IS NULL OR to_regclass('sessions') IS NULL THEN RETURN; END IF;
         ${TURN_AUTHORS}
         IF to_regclass('directory_members') IS NOT NULL THEN
           CREATE TEMP TABLE slack_authors ON COMMIT DROP AS
           SELECT DISTINCT ON (a.author) a.author, ${fold("d.principal_id")} AS person
             FROM turn_authors a
             JOIN directory_members d ON d.slack_id = a.author AND ${fold("d.principal_id")} <> a.author
            WHERE NOT EXISTS (SELECT 1 FROM user_links l WHERE l.alias_id = a.author)
            ORDER BY a.author, d.principal_id;
           ${ensureUsers("SELECT person FROM slack_authors")}
           INSERT INTO user_links(alias_id, user_id, evidence, created_at)
             SELECT author, ${userOf("person")}, 'slack directory: slack_id→principal_id', now() FROM slack_authors
           ON CONFLICT (alias_id) DO NOTHING;
         END IF;
         ${ensureUsers("SELECT author FROM turn_authors")}
         ${seenAs("SELECT author, at FROM turn_authors", "turn")}
       END $$`,
    ],
  },
  {
    id: "users/v2/0003-grants-and-invites",
    statements: [
      `DO $$
       BEGIN
         IF to_regclass('admin_grants') IS NOT NULL THEN
           CREATE TEMP TABLE granted ON COMMIT DROP AS
             SELECT ${fold("principal_id")} AS alias,
                    CASE WHEN coalesce(created_at, 0) > 0 THEN ${ts("created_at")} ELSE now() END AS at
               FROM admin_grants;
           ${ensureUsers("SELECT alias FROM granted")}
           UPDATE users u SET first_seen_at = s.at, source = 'admin'
             FROM (SELECT ${userOf("alias")} AS id, MIN(at) AS at FROM granted GROUP BY 1) s
            WHERE u.id = s.id AND u.first_seen_at IS NULL;
         END IF;
         IF to_regclass('external_members') IS NOT NULL THEN
           CREATE TEMP TABLE invited ON COMMIT DROP AS
             SELECT ${fold("json->>'email'")} AS alias, ${ts("(json->>'createdAt')::bigint")} AS at
               FROM external_members
              WHERE json->>'kind' = 'teammate' AND coalesce(json->>'email', '') <> '';
           ${ensureUsers("SELECT alias FROM invited")}
           UPDATE users u SET first_seen_at = s.at, source = 'invite'
             FROM (SELECT ${userOf("alias")} AS id, MIN(at) AS at FROM invited GROUP BY 1) s
            WHERE u.id = s.id AND u.first_seen_at IS NULL;
         END IF;
       END $$`,
    ],
  },
  ...PERSONA_MIGRATIONS,
];

const TENANTED = tenantedUsers(USER_MIGRATIONS.filter((migration) => !PERSONA_MIGRATIONS.includes(migration)));

export const USER_SCHEMA_MIGRATIONS: PgMigrationDefinition[] = [
  ...TENANTED.before,
  ...USER_MIGRATIONS,
  ...TENANTED.after,
  ...PERSONA_TENANCY,
  {
    id: "users/v2/0006-display-name",
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT
         CHECK (display_name IS NULL OR (display_name <> '' AND char_length(display_name) <= ${DISPLAY_NAME_MAX}))`,
    ],
  },
].sort((a, b) => Number(a.id > b.id) - Number(a.id < b.id));

const COLUMNS = `u.id, u.primary_alias, u.kind,
  ARRAY(SELECT a.alias_id FROM user_links a WHERE a.user_id = u.id
         ORDER BY a.alias_id = u.primary_alias DESC, a.created_at, a.alias_id) AS aliases, ${msOf("u.first_seen_at")} AS first_seen_at, u.source,
  ${msOf("u.offboarded_at")} AS offboarded_at,
  (SELECT b.primary_alias FROM users b WHERE b.id = u.offboarded_by) AS offboarded_by, u.display_name`;
const LINK_SELECT = `SELECT l.alias_id, u.primary_alias AS canonical_id, l.evidence,
    coalesce((SELECT b.primary_alias FROM users b WHERE b.id = l.linked_by), '') AS linked_by,
    ${msOf("l.created_at")} AS created_at
  FROM user_links l JOIN users u ON u.id = l.user_id`;

function toRecord(r: Record<string, unknown>): UserRecord {
  return {
    id: r.id as string,
    principalId: r.primary_alias as string,
    aliases: (r.aliases as string[] | null) ?? [r.primary_alias as string],
    kind: (r.kind as UserKind | undefined) ?? "person",
    ...(r.first_seen_at != null ? { firstSeenAt: Number(r.first_seen_at), source: r.source as UserSource } : {}),
    ...(r.offboarded_at != null ? { offboardedAt: Number(r.offboarded_at) } : {}),
    ...(r.offboarded_by != null ? { offboardedBy: r.offboarded_by as string } : {}),
    ...(r.display_name != null ? { displayName: r.display_name as string } : {}),
  };
}

function toLink(r: Record<string, unknown>): UserLink {
  return {
    principalId: r.alias_id as string,
    canonicalId: r.canonical_id as string,
    evidence: r.evidence as string,
    linkedBy: r.linked_by as string,
    createdAt: Number(r.created_at),
  };
}

const ACTIVITY = `
  WITH daily AS (
    SELECT ${fold("e.author")} AS alias, (${msOf("e.created_at")} / 86400000)::bigint AS day, COUNT(*) AS turns,
           ${msOf("MAX(e.created_at)")} AS last_at
      FROM items e
     WHERE e.tenant_id = ${TENANT} AND ${authoredUserTurn("e")}
     GROUP BY 1, 2
  ), turns AS (
    SELECT coalesce(l.user_id::text, d.alias) AS who, d.day, SUM(d.turns) AS turns, MAX(d.last_at) AS last_at
      FROM daily d LEFT JOIN user_links l ON l.alias_id = d.alias
     GROUP BY 1, 2
  ), per AS (
    SELECT who, SUM(turns) AS turns, MAX(last_at) AS last_at, array_agg(day ORDER BY day) AS days
      FROM turns GROUP BY who
  ), member AS (
    SELECT coalesce(l.user_id::text, ${fold("p.principal_id")}) AS who, l.user_id, COUNT(DISTINCT p.session_id) AS sessions
      FROM participants p LEFT JOIN user_links l ON l.alias_id = ${fold("p.principal_id")}
     WHERE coalesce(btrim(p.principal_id), '') <> ''
     GROUP BY 1, 2
  )
  SELECT m.user_id, coalesce(u.primary_alias, m.who) AS principal_id, coalesce(u.kind, 'person') AS kind,
         m.sessions, coalesce(per.turns, 0) AS turns, per.last_at, per.days
    FROM member m
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN per ON per.who = m.who`;

function toActivity(r: Record<string, unknown>): UserActivity {
  return {
    userId: (r.user_id as string | null) ?? null,
    principalId: r.principal_id as string,
    kind: r.kind as UserKind,
    sessions: Number(r.sessions),
    turns: Number(r.turns),
    lastSeenAt: r.last_at == null ? null : Number(r.last_at),
    days: ((r.days as (string | number)[] | null) ?? []).map(Number),
  };
}

type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const onClient =
  (client: PoolClient): Query =>
  async (text, params) =>
    (await client.query(text, params)).rows;

async function findUser(q: Query, alias: string): Promise<string | undefined> {
  return (await q(`SELECT user_id FROM user_links WHERE alias_id = $1`, [alias]))[0]?.user_id as string | undefined;
}

export async function ensureUserIn(client: PoolClient, alias: string): Promise<string> {
  const q = onClient(client);
  const found = await findUser(q, alias);
  if (found) return found;
  const created = (
    await q(
      `INSERT INTO users(primary_alias) VALUES ($1) ON CONFLICT (tenant_id, primary_alias) DO NOTHING RETURNING id`,
      [alias],
    )
  )[0]?.id as string | undefined;
  if (created) {
    const linked = await q(
      `INSERT INTO user_links(alias_id, user_id, evidence, created_at) VALUES ($1, $2, 'primary', now())
       ON CONFLICT (tenant_id, alias_id) DO NOTHING RETURNING alias_id`,
      [alias, created],
    );
    if (linked.length) return created;
    await q(`DELETE FROM users WHERE id = $1`, [created]);
  }
  const winner = await findUser(q, alias);
  if (!winner) throw new Error(`users: could not resolve or create a user for ${alias}`);
  return winner;
}

async function linkInTransaction(client: PoolClient, link: UserLink): Promise<UserLink> {
  const q = onClient(client);
  await q(`LOCK TABLE user_links IN SHARE ROW EXCLUSIVE MODE`);
  const target = await ensureUserIn(client, link.canonicalId);
  const current = (
    await q(
      `SELECT l.user_id, u.primary_alias = l.alias_id AS is_primary,
              (SELECT count(*) FROM user_links o WHERE o.user_id = l.user_id) AS aliases
         FROM user_links l JOIN users u ON u.id = l.user_id WHERE l.alias_id = $1`,
      [link.principalId],
    )
  )[0];
  if (current && (current.user_id === target || !current.is_primary || Number(current.aliases) > 1)) {
    return toLink((await q(`${LINK_SELECT} WHERE l.alias_id = $1`, [link.principalId]))[0]!);
  }
  if (current) {
    const source = current.user_id as string;
    await q(
      `UPDATE users c SET
         kind = CASE WHEN a.kind = 'app' THEN 'app' ELSE c.kind END,
         first_seen_at = least(c.first_seen_at, a.first_seen_at),
         source = CASE WHEN a.first_seen_at < c.first_seen_at OR c.first_seen_at IS NULL THEN a.source ELSE c.source END,
         offboarded_at = least(c.offboarded_at, a.offboarded_at),
         offboarded_by = CASE WHEN a.offboarded_at < c.offboarded_at OR c.offboarded_at IS NULL
                              THEN a.offboarded_by ELSE c.offboarded_by END,
         display_name = coalesce(c.display_name, a.display_name)
       FROM users a WHERE c.id = $1 AND a.id = $2`,
      [target, source],
    );
    await q(`UPDATE users SET offboarded_by = $1 WHERE offboarded_by = $2`, [target, source]);
    await q(`UPDATE user_links SET linked_by = $1 WHERE linked_by = $2`, [target, source]);
    await q(`UPDATE personas SET created_by = $1 WHERE created_by = $2`, [target, source]);
    await q(`UPDATE persona_access SET granted_by = $1 WHERE granted_by = $2`, [target, source]);
    await q(`UPDATE persona_versions SET edited_by = $1 WHERE edited_by = $2`, [target, source]);
    await q(`DELETE FROM users WHERE id = $1`, [source]);
  }
  const linkedBy = link.linkedBy ? await ensureUserIn(client, foldPrincipalId(link.linkedBy)) : null;
  await q(
    `INSERT INTO user_links(alias_id, user_id, evidence, linked_by, created_at) VALUES ($1, $2, $3, $4, ${ts("$5")})`,
    [link.principalId, target, link.evidence, linkedBy, link.createdAt],
  );
  return toLink((await q(`${LINK_SELECT} WHERE l.alias_id = $1`, [link.principalId]))[0]!);
}

export function createPostgresUserStore(connectionString: string): UserStore {
  const pg = createPgPool(connectionString, [
    ...DIRECTORY_MIGRATIONS,
    ...SESSION_MIGRATIONS,
    ...USER_SCHEMA_MIGRATIONS,
  ]);
  const { q } = pg;
  const transaction = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    withPgTransaction(await pg.pool(), fn);
  const ensureUser = async (alias: string): Promise<string> =>
    (await findUser(q, alias)) ?? transaction((client) => ensureUserIn(client, alias));
  return {
    async list() {
      const rows = await q(
        `SELECT ${COLUMNS} FROM users u WHERE u.first_seen_at IS NOT NULL OR u.offboarded_at IS NOT NULL`,
      );
      return rows.map(toRecord);
    },
    async get(idOrAlias) {
      const rows = await q(
        `SELECT ${COLUMNS} FROM users u WHERE u.id = ${userOf("$1")} OR u.id::text = lower($2)
          ORDER BY u.id = ${userOf("$1")} DESC LIMIT 1`,
        [foldPrincipalId(idOrAlias), idOrAlias.trim()],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async resolve(aliases) {
      const wanted = [...new Set(aliases.filter((a) => foldPrincipalId(a)))];
      if (!wanted.length) return new Map();
      const rows = await q(
        `SELECT s.alias AS requested, ${COLUMNS}
           FROM unnest($1::text[]) AS s(alias)
           JOIN user_links l ON l.alias_id = ${fold("s.alias")}
           JOIN users u ON u.id = l.user_id`,
        [wanted],
      );
      return new Map(rows.map((r) => [r.requested as string, toRecord(r)]));
    },
    async activity() {
      return (await q(ACTIVITY)).map(toActivity);
    },
    async record({ id, source, at }) {
      const alias = foldPrincipalId(id);
      const seen = `UPDATE users u SET first_seen_at = ${ts("$2")}, source = $3
                     WHERE u.id = $1 AND u.first_seen_at IS NULL RETURNING u.id`;
      const known = await findUser(q, alias);
      if (known) return (await q(seen, [known, at, source])).length > 0;
      return transaction(async (client) => {
        const user = await ensureUserIn(client, alias);
        return (await client.query(seen, [user, at, source])).rows.length > 0;
      });
    },
    async markOffboarded(id, by) {
      const user = await ensureUser(foldPrincipalId(id));
      const actor = await ensureUser(foldPrincipalId(by));
      const rows = await q(
        `UPDATE users u SET offboarded_at = coalesce(u.offboarded_at, now()),
           offboarded_by = CASE WHEN u.offboarded_at IS NULL THEN $2::uuid ELSE u.offboarded_by END
         WHERE u.id = $1 RETURNING ${COLUMNS}`,
        [user, actor],
      );
      return toRecord(rows[0]!);
    },
    async markApps(ids) {
      if (!ids.length) return 0;
      const rows = await q(
        `UPDATE users SET kind = 'app'
          WHERE kind <> 'app' AND id IN (SELECT user_id FROM user_links WHERE alias_id = ANY($1::text[]))
          RETURNING id`,
        [ids.map((id) => foldPrincipalId(id))],
      );
      return rows.length;
    },
    async setDisplayName(alias, raw) {
      const name = cleanDisplayName(raw);
      if (!name) return false;
      const user = await ensureUser(foldPrincipalId(alias));
      const rows = await q(
        `UPDATE users SET display_name = $2 WHERE id = $1 AND display_name IS DISTINCT FROM $2 RETURNING id`,
        [user, name],
      );
      return rows.length > 0;
    },
    async markReactivated(id) {
      const rows = await q(
        `UPDATE users u SET offboarded_at = NULL, offboarded_by = NULL WHERE u.id = ${userOf("$1")} RETURNING ${COLUMNS}`,
        [foldPrincipalId(id)],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async links() {
      return (await q(`${LINK_SELECT} WHERE l.alias_id <> u.primary_alias`)).map(toLink);
    },
    async link(link) {
      return transaction((client) => linkInTransaction(client, link));
    },
    async unlink(aliasId) {
      return transaction(async (client) => {
        const rows = (
          await client.query(`${LINK_SELECT} WHERE l.alias_id = $1 AND l.alias_id <> u.primary_alias`, [aliasId])
        ).rows;
        if (!rows[0]) return null;
        await client.query(`DELETE FROM user_links WHERE alias_id = $1`, [aliasId]);
        return toLink(rows[0]);
      });
    },
  };
}
