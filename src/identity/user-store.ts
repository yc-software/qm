import type { PoolClient } from "pg";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { authoredUserTurn, msOf, TENANT } from "../sessions/items.ts";
import { foldPrincipalId } from "../directory/person.ts";
import { orgId } from "../config.ts";
import type { DirectoryMember } from "../directory/directory-store.ts";
import { APP_IS_NOT_A_PERSON, PrincipalLinkError } from "./principal-links.ts";
import { fold, ts } from "./user-tenancy.ts";
import { foundingUserId } from "../directory/person-refs.ts";
import { movePersonalScope } from "./personal-scopes.ts";
import { scopeId } from "../types.ts";
import { markBotWork, unlessSlackListsAPerson } from "../triggers/trigger-store.ts";
import { holdBotLoopShips } from "../loops/loop-store.ts";

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
  userId: string;
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
  ensure(alias: string): Promise<string>;
  link(link: Omit<UserLink, "userId">): Promise<UserLink>;
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
  applyDirectoryBots(members: readonly DirectoryMember[]): Promise<number>;
  botSignIns(aliases: readonly string[]): Promise<string[]>;
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

const COLUMNS = `u.id, u.primary_alias, u.kind,
  ARRAY(SELECT a.alias_id FROM user_links a WHERE a.user_id = u.id
         ORDER BY a.alias_id = u.primary_alias DESC, a.created_at, a.alias_id) AS aliases, ${msOf("u.first_seen_at")} AS first_seen_at, u.source,
  ${msOf("u.offboarded_at")} AS offboarded_at,
  (SELECT b.primary_alias FROM users b WHERE b.id = u.offboarded_by) AS offboarded_by, u.display_name`;
const LINK_SELECT = `SELECT l.user_id, l.alias_id, u.primary_alias AS canonical_id, l.evidence,
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
    userId: r.user_id as string,
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
  const insert = `INSERT INTO users(id, primary_alias) VALUES (coalesce($2::uuid, gen_random_uuid()), $1)
                  ON CONFLICT DO NOTHING RETURNING id`;
  const created = ((await q(insert, [alias, foundingUserId(alias)]))[0]?.id ??
    (await q(insert, [alias, null]))[0]?.id) as string | undefined;
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

const MARKED = "string_to_array(current_setting('qm.marked_apps'), ',')::uuid[]";
const BOT_WORK = [markBotWork(unlessSlackListsAPerson("l"), MARKED), holdBotLoopShips("system", MARKED)];

async function markBotWorkOf(client: PoolClient, apps: readonly Record<string, unknown>[]): Promise<void> {
  if (!apps.length) return;
  await client.query(`SELECT set_config('qm.marked_apps', $1, true)`, [apps.map((app) => app.id).join(",")]);
  for (const statement of BOT_WORK) await client.query(statement);
}

async function markAppsIn(client: PoolClient, aliases: readonly string[]): Promise<number> {
  const { rows } = await client.query(
    `UPDATE users SET kind = 'app' WHERE kind <> 'app' AND primary_alias = ANY($1::text[]) RETURNING id`,
    [aliases],
  );
  await markBotWorkOf(client, rows);
  return rows.length;
}

async function findBotSignIns(q: Query, aliases: readonly string[]): Promise<string[]> {
  const rows = await q(
    `SELECT s.alias FROM unnest($1::text[]) AS s(alias)
      WHERE coalesce(
        (SELECT bool_or(m.is_bot) FROM directory_members m
          WHERE m.org_id = $2 AND (lower(m.principal_id) = lower(s.alias) OR m.slack_id = s.alias)),
        EXISTS (SELECT 1 FROM user_links l JOIN users u ON u.id = l.user_id
                 WHERE l.alias_id = s.alias AND u.kind = 'app'))`,
    [aliases.map(foldPrincipalId), orgId()],
  );
  return rows.map((r) => r.alias as string);
}

async function linkInTransaction(client: PoolClient, link: Omit<UserLink, "userId">): Promise<UserLink> {
  const q = onClient(client);
  await q(`LOCK TABLE user_links IN SHARE ROW EXCLUSIVE MODE`);
  if ((await findBotSignIns(q, [link.principalId, link.canonicalId])).length)
    throw new PrincipalLinkError(400, APP_IS_NOT_A_PERSON);
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
    await movePersonalScope(client, source, scopeId("personal", target));
  }
  const linkedBy = link.linkedBy ? await ensureUserIn(client, foldPrincipalId(link.linkedBy)) : null;
  await q(
    `INSERT INTO user_links(alias_id, user_id, evidence, linked_by, created_at) VALUES ($1, $2, $3, $4, ${ts("$5")})`,
    [link.principalId, target, link.evidence, linkedBy, link.createdAt],
  );
  const joined = (await q(`SELECT id, kind FROM users WHERE id = $1 FOR SHARE`, [target]))[0]!;
  if (joined.kind === "app") await markBotWorkOf(client, [joined]);
  return toLink((await q(`${LINK_SELECT} WHERE l.alias_id = $1`, [link.principalId]))[0]!);
}

export function createPostgresUserStore(connectionString: string): UserStore {
  const pg = createPgPool(connectionString);
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
           FROM unnest($1::text[], $2::text[]) AS s(alias, folded)
           JOIN user_links l ON l.alias_id = s.folded
           JOIN users u ON u.id = l.user_id`,
        [wanted, wanted.map(foldPrincipalId)],
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
      return transaction((client) => markAppsIn(client, ids.map(foldPrincipalId)));
    },
    async applyDirectoryBots(members) {
      const signIns = (isBot: boolean | undefined) =>
        members
          .filter((m) => m.isBot === isBot)
          .flatMap((m) => [m.principalId, m.slackId].map(foldPrincipalId).filter(Boolean));
      const bots = signIns(true);
      return transaction(async (client) => {
        const split = await client.query(
          `WITH moving AS (
             SELECT l.alias_id, l.user_id, l.evidence, l.linked_by FROM user_links l JOIN users u ON u.id = l.user_id
              WHERE l.alias_id = ANY($1::text[]) AND u.primary_alias <> l.alias_id
           ), created AS (
             INSERT INTO users(primary_alias) SELECT alias_id FROM moving RETURNING id, primary_alias
           ), moved AS (
             UPDATE user_links l SET user_id = c.id, evidence = 'primary', linked_by = NULL
               FROM moving m JOIN created c ON c.primary_alias = m.alias_id
              WHERE l.alias_id = m.alias_id
             RETURNING m.user_id AS from_user, c.id AS to_user, m.alias_id, m.evidence, m.linked_by
           )
           INSERT INTO audit_log(at, principal_id, action, resource, scope_label, detail)
           SELECT $2::bigint, 'system:directory-sync', 'user_sign_in_split', from_user::text, 'users',
                  jsonb_build_object('movedSignIns', jsonb_agg(jsonb_build_object(
                    'alias', alias_id, 'userId', to_user, 'evidence', evidence, 'linkedBy', linked_by)
                    ORDER BY alias_id))::text
             FROM moved GROUP BY from_user`,
          [bots, Date.now()],
        );
        await markAppsIn(client, bots);
        await client.query(
          `WITH app_sign_ins AS (
             SELECT l.user_id, l.alias_id, l.evidence, l.alias_id = u.primary_alias AS is_primary,
                    CASE WHEN l.alias_id = ANY($1::text[]) THEN 'bot'
                         WHEN l.alias_id = ANY($2::text[]) THEN 'none'
                         WHEN l.alias_id = ANY($3::text[]) THEN 'person' ELSE 'none' END AS signal
               FROM user_links l JOIN users u ON u.id = l.user_id
              WHERE u.kind = 'app'
           ), people AS (
             UPDATE users u SET kind = 'person'
               FROM (SELECT user_id FROM app_sign_ins GROUP BY user_id HAVING bool_and(signal = 'person')) p
              WHERE u.id = p.user_id
           )
           INSERT INTO audit_log(at, principal_id, action, resource, scope_label, detail, idempotency_key)
           SELECT $4::bigint, 'system:directory-sync', 'user_sign_in_review', user_id::text, 'users', detail,
                  'user_sign_in_review:' || user_id || ':' || md5(detail)
             FROM (SELECT user_id, jsonb_build_object(
                            'reason', CASE WHEN bool_or(signal = 'none') THEN 'some sign-ins have no certain signal'
                                           ELSE 'the primary sign-in is not a person' END,
                            'signIns', jsonb_agg(jsonb_build_object('alias', alias_id, 'evidence', evidence, 'signal', signal)
                                                 ORDER BY is_primary DESC, alias_id))::text AS detail
                     FROM app_sign_ins GROUP BY user_id
                    HAVING count(*) > 1 AND NOT bool_and(signal = 'bot') AND NOT bool_and(signal = 'person')) r
           ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
          [bots, signIns(undefined), signIns(false), Date.now()],
        );
        return split.rowCount ?? 0;
      });
    },
    botSignIns: (aliases) => findBotSignIns(q, aliases),
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
    ensure: ensureUser,
    async links() {
      return (await q(LINK_SELECT)).map(toLink);
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
