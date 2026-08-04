import { orgId as configOrgId } from "../config.ts";
import { createHash } from "node:crypto";
import { createPgPool, type PoolClient, withPgTransaction } from "../persistence/pg-pool.ts";
import type { PrincipalType } from "../types.ts";
import { personKey } from "./person.ts";
import {
  MAX_CANDIDATES,
  groupParticipantsKey,
  normDirectoryQuery,
  type ChannelMembership,
  type DirectoryChannel,
  type DirectoryMember,
  type DirectoryStore,
} from "./directory-store.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS directory_members(
    org_id          TEXT NOT NULL,
    principal_id    TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    display_name_lc TEXT NOT NULL,
    type            TEXT NOT NULL,
    slack_id        TEXT,
    PRIMARY KEY (org_id, principal_id)
  )`,
  `CREATE INDEX IF NOT EXISTS directory_members_name
    ON directory_members (org_id, display_name_lc)`,
  `CREATE INDEX IF NOT EXISTS directory_members_lower_pid
    ON directory_members (org_id, lower(principal_id))`,
  `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'directory_members' AND column_name = 'slack_id'
    ) THEN
      ALTER TABLE directory_members ADD COLUMN slack_id TEXT;
    END IF;
  END $$`,
  `CREATE TABLE IF NOT EXISTS directory_channels(
    org_id     TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    name       TEXT NOT NULL,
    name_lc    TEXT NOT NULL,
    is_private BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (org_id, channel_id)
  )`,
  `CREATE INDEX IF NOT EXISTS directory_channels_name
    ON directory_channels (org_id, name_lc)`,
  `CREATE INDEX IF NOT EXISTS directory_channels_lower_cid
    ON directory_channels (org_id, lower(channel_id))`,
  `CREATE TABLE IF NOT EXISTS directory_channel_members(
    org_id       TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    PRIMARY KEY (org_id, channel_id, principal_id)
  )`,
  `CREATE TABLE IF NOT EXISTS directory_group_members(
    org_id       TEXT NOT NULL,
    group_id     TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    PRIMARY KEY (org_id, group_id, principal_id)
  )`,
  `CREATE INDEX IF NOT EXISTS directory_group_members_principal
    ON directory_group_members (org_id, principal_id, group_id)`,
  `CREATE TABLE IF NOT EXISTS directory_sync(
    org_id        TEXT PRIMARY KEY,
    members_hash  TEXT,
    channels_hash TEXT,
    groups_hash   TEXT,
    channel_members_synced BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at    BIGINT NOT NULL
  )`,
  `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'directory_sync' AND column_name = 'groups_hash'
    ) THEN
      ALTER TABLE directory_sync ADD COLUMN groups_hash TEXT;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'directory_sync' AND column_name = 'channel_members_synced'
    ) THEN
      ALTER TABLE directory_sync ADD COLUMN channel_members_synced BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
  END $$`,
  `ALTER TABLE directory_sync ADD COLUMN IF NOT EXISTS members_synced_at BIGINT`,
  `ALTER TABLE directory_sync ADD COLUMN IF NOT EXISTS channels_synced_at BIGINT`,
  `ALTER TABLE directory_sync ADD COLUMN IF NOT EXISTS groups_synced_at BIGINT`,
  `CREATE TABLE IF NOT EXISTS directory_meta(
    org_id        TEXT PRIMARY KEY,
    workspace_url TEXT,
    updated_at    BIGINT NOT NULL
  )`,
];

function memberRow(r: Record<string, unknown>): DirectoryMember {
  return {
    principalId: r.principal_id as string,
    displayName: r.display_name as string,
    type: r.type as PrincipalType,
    ...(r.slack_id ? { slackId: r.slack_id as string } : {}),
  };
}
const MEMBER_COLS = "principal_id, display_name, type, slack_id";
function channelRow(r: Record<string, unknown>): DirectoryChannel {
  return { channelId: r.channel_id as string, name: r.name as string, isPrivate: r.is_private as boolean };
}

function hashRoster(rows: string[]): string {
  return createHash("sha256").update(rows.slice().sort().join("\n")).digest("hex");
}

function likeEscape(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

function dedupPairs<T>(rows: T[], idOf: (r: T) => string, pidOf: (r: T) => string): T[] {
  const seen = new Map<string, Set<string>>();
  const out: T[] = [];
  for (const r of rows) {
    const id = idOf(r);
    const pid = pidOf(r);
    if (!id || !pid) continue;
    let principals = seen.get(id);
    if (!principals) seen.set(id, (principals = new Set()));
    if (!principals.has(pid)) {
      principals.add(pid);
      out.push(r);
    }
  }
  return out;
}
function dedupMemberships(rows: ChannelMembership[]): ChannelMembership[] {
  return dedupPairs(
    rows,
    (m) => m.channelId,
    (m) => m.principalId,
  );
}

export function createPostgresDirectoryStore(connectionString: string): DirectoryStore {
  const { q, pool } = createPgPool(connectionString, SCHEMA);
  const orgId = configOrgId();

  async function pick<T>(
    query: string,
    table: string,
    idCol: string,
    labelLcCol: string,
    cols: string,
    map: (r: Record<string, unknown>) => T,
  ): Promise<{ kind: "one"; item: T } | { kind: "ambiguous"; items: T[] } | { kind: "none" }> {
    const qn = normDirectoryQuery(query);
    if (!qn) return { kind: "none" };
    const from = `FROM ${table} WHERE org_id = $1`;

    const byId = await q(`SELECT ${cols} ${from} AND lower(${idCol}) = $2 LIMIT 1`, [orgId, qn]);
    if (byId.length) return { kind: "one", item: map(byId[0]!) };

    const exact = await q(
      `SELECT ${cols} ${from} AND ${labelLcCol} = $2 ORDER BY ${idCol} LIMIT ${MAX_CANDIDATES + 1}`,
      [orgId, qn],
    );
    if (exact.length === 1) return { kind: "one", item: map(exact[0]!) };
    if (exact.length > 1) return { kind: "ambiguous", items: exact.slice(0, MAX_CANDIDATES).map(map) };

    const esc = likeEscape(qn);
    let pool2 = await q(
      `SELECT ${cols} ${from} AND ${labelLcCol} LIKE $2 ESCAPE '\\' ORDER BY ${labelLcCol}, ${idCol} LIMIT ${MAX_CANDIDATES + 1}`,
      [orgId, `${esc}%`],
    );
    if (!pool2.length) {
      pool2 = await q(
        `SELECT ${cols} ${from} AND ${labelLcCol} LIKE $2 ESCAPE '\\' ORDER BY ${labelLcCol}, ${idCol} LIMIT ${MAX_CANDIDATES + 1}`,
        [orgId, `%${esc}%`],
      );
    }
    if (!pool2.length) return { kind: "none" };
    if (pool2.length === 1) return { kind: "one", item: map(pool2[0]!) };
    return { kind: "ambiguous", items: pool2.slice(0, MAX_CANDIDATES).map(map) };
  }

  async function swapIfChanged(
    hashCol: string,
    hash: string,
    syncedAt: number | undefined,
    write: (client: PoolClient) => Promise<void>,
  ): Promise<boolean> {
    const syncedAtCol = hashCol.replace(/_hash$/, "_synced_at");
    return withPgTransaction(await pool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('directory'), hashtext($1))", [orgId]);
      const sync = await client.query(`SELECT ${hashCol}, ${syncedAtCol} FROM directory_sync WHERE org_id = $1`, [
        orgId,
      ]);
      const row = sync.rows[0];
      if (syncedAt !== undefined && row?.[syncedAtCol] != null && Number(row[syncedAtCol]) > syncedAt) {
        console.warn(
          `[directory] refused stale ${hashCol.replace(/_hash$/, "")} swap for ${orgId}: stamped ${Number(row[syncedAtCol]) - syncedAt}ms behind`,
        );
        return false;
      }
      if (row?.[hashCol] === hash) {
        if (syncedAt !== undefined) {
          await client.query(
            `UPDATE directory_sync SET ${syncedAtCol} = GREATEST(COALESCE(${syncedAtCol}, 0), $2) WHERE org_id = $1`,
            [orgId, syncedAt],
          );
        }
        return true;
      }
      await write(client);
      await client.query(
        `INSERT INTO directory_sync (org_id, ${hashCol}, ${syncedAtCol}, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id) DO UPDATE SET ${hashCol} = EXCLUDED.${hashCol},
           ${syncedAtCol} = COALESCE(EXCLUDED.${syncedAtCol}, directory_sync.${syncedAtCol}),
           updated_at = EXCLUDED.updated_at`,
        [orgId, hash, syncedAt ?? null, Date.now()],
      );
      return true;
    });
  }

  return {
    async replace(members, syncedAt) {
      const byId = new Map<string, DirectoryMember>();
      for (const m of members) if (m.principalId && m.type === "internal") byId.set(m.principalId, m);
      const internal = [...byId.values()];

      const hash = hashRoster(internal.map((m) => `${m.principalId}|${m.displayName}|${m.type}|${m.slackId ?? ""}`));

      return swapIfChanged("members_hash", hash, syncedAt, async (client) => {
        await client.query("DELETE FROM directory_members WHERE org_id = $1", [orgId]);
        if (internal.length) {
          await client.query(
            `INSERT INTO directory_members (org_id, principal_id, display_name, display_name_lc, type, slack_id)
             SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])`,
            [
              orgId,
              internal.map((m) => m.principalId),
              internal.map((m) => m.displayName),
              internal.map((m) => normDirectoryQuery(m.displayName)),
              internal.map((m) => m.type),
              internal.map((m) => m.slackId ?? null),
            ],
          );
        }
      });
    },

    async replaceChannels(channels, channelMembers, syncedAt) {
      const byId = new Map<string, DirectoryChannel>();
      for (const c of channels) if (c.channelId && c.name) byId.set(c.channelId, c);
      const list = [...byId.values()];

      const membershipRows = channelMembers === undefined ? undefined : dedupMemberships(channelMembers);
      const channelsPart = list.map((c) => `${c.channelId}|${c.name}|${c.isPrivate ? 1 : 0}`);
      const membersPart =
        membershipRows === undefined
          ? []
          : ["members:known", ...membershipRows.map((m) => `m:${m.channelId}|${m.principalId}`)];
      const hash = hashRoster([...channelsPart, ...membersPart]);

      const applied = await swapIfChanged("channels_hash", hash, syncedAt, async (client) => {
        await client.query("DELETE FROM directory_channels WHERE org_id = $1", [orgId]);
        if (list.length) {
          await client.query(
            `INSERT INTO directory_channels (org_id, channel_id, name, name_lc, is_private)
             SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[])`,
            [
              orgId,
              list.map((c) => c.channelId),
              list.map((c) => c.name),
              list.map((c) => normDirectoryQuery(c.name)),
              list.map((c) => !!c.isPrivate),
            ],
          );
        }
        if (membershipRows !== undefined) {
          await client.query("DELETE FROM directory_channel_members WHERE org_id = $1", [orgId]);
          if (membershipRows.length) {
            await client.query(
              `INSERT INTO directory_channel_members (org_id, channel_id, principal_id)
               SELECT $1, * FROM unnest($2::text[], $3::text[])`,
              [orgId, membershipRows.map((m) => m.channelId), membershipRows.map((m) => m.principalId)],
            );
          }
        }
      });
      if (applied && membershipRows !== undefined) {
        await q("UPDATE directory_sync SET channel_members_synced = TRUE WHERE org_id = $1", [orgId]);
      }
      return applied;
    },

    async setWorkspaceUrl(url) {
      await q(
        `INSERT INTO directory_meta (org_id, workspace_url, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (org_id) DO UPDATE SET workspace_url = EXCLUDED.workspace_url, updated_at = EXCLUDED.updated_at`,
        [orgId, url, Date.now()],
      );
    },

    async meta() {
      const rows = await q("SELECT workspace_url FROM directory_meta WHERE org_id = $1", [orgId]);
      return { workspaceUrl: (rows[0]?.workspace_url as string | null) ?? null };
    },

    async channelMember(channelId, principalId) {
      const rows = await q(
        "SELECT 1 FROM directory_channel_members WHERE org_id = $1 AND channel_id = $2 AND principal_id = $3 LIMIT 1",
        [orgId, channelId, principalId],
      );
      return rows.length > 0;
    },

    async channelMembership(channelId, principalId) {
      const rows = await q(
        `SELECT EXISTS (
           SELECT 1 FROM directory_channel_members
           WHERE org_id = $1 AND channel_id = $2 AND principal_id = $3
         ) AS member,
         (SELECT is_private FROM directory_channels WHERE org_id = $1 AND channel_id = $2) AS is_private,
         (SELECT channel_members_synced FROM directory_sync WHERE org_id = $1) AS synced`,
        [orgId, channelId, principalId],
      );
      const member = rows[0]?.member === true;
      return member || (rows[0]?.is_private === true && rows[0]?.synced === true) ? member : undefined;
    },

    async channelPrivacy(channelId) {
      const rows = await q("SELECT is_private FROM directory_channels WHERE org_id = $1 AND channel_id = $2 LIMIT 1", [
        orgId,
        channelId,
      ]);
      return rows.length > 0 ? (rows[0]!.is_private as boolean) : undefined;
    },

    async replaceGroups(groupMembers, syncedAt) {
      const rows = dedupPairs(
        groupMembers,
        (m) => m.groupId,
        (m) => m.principalId,
      );
      const hash = hashRoster(rows.map((m) => `${m.groupId}|${m.principalId}`));

      return swapIfChanged("groups_hash", hash, syncedAt, async (client) => {
        await client.query("DELETE FROM directory_group_members WHERE org_id = $1", [orgId]);
        if (rows.length) {
          await client.query(
            `INSERT INTO directory_group_members (org_id, group_id, principal_id)
             SELECT $1, * FROM unnest($2::text[], $3::text[])`,
            [orgId, rows.map((m) => m.groupId), rows.map((m) => m.principalId)],
          );
        }
      });
    },

    async upsertGroup(groupId, principalIds) {
      const ids = [...new Set(principalIds.filter(Boolean))];
      if (!groupId || !ids.length) return;
      await withPgTransaction(await pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('directory'), hashtext($1))", [orgId]);
        await client.query("DELETE FROM directory_group_members WHERE org_id = $1 AND group_id = $2", [orgId, groupId]);
        await client.query(
          `INSERT INTO directory_group_members (org_id, group_id, principal_id)
           SELECT $1, $2, * FROM unnest($3::text[])`,
          [orgId, groupId, ids],
        );
        const all = await client.query("SELECT group_id, principal_id FROM directory_group_members WHERE org_id = $1", [
          orgId,
        ]);
        await client.query(
          `INSERT INTO directory_sync (org_id, groups_hash, groups_synced_at, updated_at) VALUES ($1, $2, $3, $3)
           ON CONFLICT (org_id) DO UPDATE SET groups_hash = EXCLUDED.groups_hash,
             groups_synced_at = GREATEST(COALESCE(directory_sync.groups_synced_at, 0), EXCLUDED.groups_synced_at),
             updated_at = EXCLUDED.updated_at`,
          [orgId, hashRoster(all.rows.map((r) => `${r.group_id}|${r.principal_id}`)), Date.now()],
        );
      });
    },

    async resolveGroupByParticipants(participants) {
      const key = groupParticipantsKey(participants);
      if (!key) return { kind: "none" };
      const rows = await q(
        `SELECT group_id FROM directory_group_members
         WHERE org_id = $1
         GROUP BY group_id
         HAVING string_agg(DISTINCT principal_id, ',' ORDER BY principal_id) = $2
         LIMIT 1`,
        [orgId, key],
      );
      return rows.length ? { kind: "one", groupId: rows[0]!.group_id as string } : { kind: "none" };
    },

    async groupMember(groupId, principalId) {
      const rows = await q(
        "SELECT 1 FROM directory_group_members WHERE org_id = $1 AND group_id = $2 AND principal_id = $3 LIMIT 1",
        [orgId, groupId, principalId],
      );
      return rows.length > 0;
    },

    async groupMembership(groupId, principalId) {
      const rows = await q(
        `SELECT EXISTS (
           SELECT 1 FROM directory_group_members
           WHERE org_id = $1 AND group_id = $2 AND principal_id = $3
         ) AS member,
         EXISTS (
           SELECT 1 FROM directory_sync WHERE org_id = $1 AND groups_hash IS NOT NULL
         ) AS known`,
        [orgId, groupId, principalId],
      );
      return rows[0]?.known === true ? rows[0]?.member === true : undefined;
    },

    async listGroupsFor(principalId) {
      const rows = await q(
        "SELECT group_id FROM directory_group_members WHERE org_id = $1 AND principal_id = $2 ORDER BY group_id",
        [orgId, principalId],
      );
      return rows.map((row) => row.group_id as string);
    },

    async listChannelsFor(principalId) {
      const rows = await q(
        `SELECT channel_id, name, is_private FROM directory_channels c
         WHERE org_id = $1 AND (is_private = FALSE OR EXISTS (
           SELECT 1 FROM directory_channel_members m
           WHERE m.org_id = c.org_id AND m.channel_id = c.channel_id AND m.principal_id = $2))
         ORDER BY name_lc`,
        [orgId, principalId],
      );
      return rows.map(channelRow);
    },

    async list() {
      const rows = await q(`SELECT ${MEMBER_COLS} FROM directory_members WHERE org_id = $1`, [orgId]);
      return rows.map(memberRow);
    },

    async listChannels() {
      const rows = await q("SELECT channel_id, name, is_private FROM directory_channels WHERE org_id = $1", [orgId]);
      return rows.map(channelRow);
    },

    async get(principalId) {
      const key = personKey(principalId);
      const rows = await q(
        `SELECT ${MEMBER_COLS} FROM directory_members
         WHERE org_id = $1 AND (principal_id = $2 OR ($3 AND lower(principal_id) = $4))
         ORDER BY (principal_id = $2) DESC LIMIT 1`,
        [orgId, principalId, key.includes("@"), key],
      );
      return rows.length ? memberRow(rows[0]!) : null;
    },

    async resolve(query) {
      const bySlackId = await q(
        `SELECT ${MEMBER_COLS} FROM directory_members WHERE org_id = $1 AND slack_id = $2 LIMIT 1`,
        [orgId, query.trim()],
      );
      if (bySlackId.length) return { kind: "one", member: memberRow(bySlackId[0]!) };
      const m = await pick(query, "directory_members", "principal_id", "display_name_lc", MEMBER_COLS, memberRow);
      if (m.kind === "one") return { kind: "one", member: m.item };
      if (m.kind === "ambiguous") return { kind: "ambiguous", candidates: m.items };
      return { kind: "none" };
    },

    async resolveChannel(query) {
      const m = await pick(
        query,
        "directory_channels",
        "channel_id",
        "name_lc",
        "channel_id, name, is_private",
        channelRow,
      );
      if (m.kind === "one") return { kind: "one", channel: m.item };
      if (m.kind === "ambiguous") return { kind: "ambiguous", candidates: m.items };
      return { kind: "none" };
    },
  };
}
