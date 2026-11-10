import { likeEscape } from "../persistence/like.ts";
import { orgId as configOrgId } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import type { PrincipalType } from "../types.ts";
import { foldPrincipalId, rosterIds } from "./person.ts";
import {
  MAX_CANDIDATES,
  groupParticipantsKey,
  normDirectoryQuery,
  type DirectoryChannel,
  type DirectoryMember,
  type DirectoryStore,
} from "./directory-store.ts";
import { createDirectorySync } from "./directory-sync.ts";
import {
  EMAIL_USER_TENANTS,
  PRINCIPAL_ADMIN_TENANTS,
  PRINCIPAL_TENANTS,
  PRINCIPAL_USER_TENANTS,
} from "../tenants/lookup.ts";
import { tenantTables } from "../tenants/migrations.ts";
import { withTenant } from "../tenants/context.ts";

const PREVIOUS_SCHEMA = "directory/store/0005";

const BASE_SCHEMA = `DO $base_schema$
BEGIN
  IF EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = '${PREVIOUS_SCHEMA}') THEN
    RETURN;
  END IF;
  IF to_regclass('directory_members') IS NOT NULL THEN
    RAISE EXCEPTION 'This database has directory tables from a release older than ${PREVIOUS_SCHEMA}. Start a release that applies ${PREVIOUS_SCHEMA} but predates the base schema, then upgrade.';
  END IF;

  CREATE TABLE directory_members(
    org_id          TEXT NOT NULL,
    principal_id    TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    display_name_lc TEXT NOT NULL,
    type            TEXT NOT NULL,
    slack_id        TEXT,
    avatar_url      TEXT,
    PRIMARY KEY (org_id, principal_id)
  );
  CREATE INDEX directory_members_name ON directory_members (org_id, display_name_lc);
  CREATE INDEX directory_members_lower_pid ON directory_members (org_id, lower(principal_id));

  CREATE TABLE directory_channels(
    org_id       TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    name         TEXT NOT NULL,
    name_lc      TEXT NOT NULL,
    is_private   BOOLEAN NOT NULL DEFAULT FALSE,
    is_external  BOOLEAN NOT NULL DEFAULT FALSE,
    roster_known BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at  BIGINT,
    PRIMARY KEY (org_id, channel_id)
  );
  CREATE INDEX directory_channels_name ON directory_channels (org_id, name_lc);
  CREATE INDEX directory_channels_lower_cid ON directory_channels (org_id, lower(channel_id));

  CREATE TABLE directory_channel_members(
    org_id       TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    PRIMARY KEY (org_id, channel_id, principal_id)
  );

  CREATE TABLE directory_groups(
    org_id       TEXT NOT NULL,
    group_id     TEXT NOT NULL,
    roster_known BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (org_id, group_id)
  );

  CREATE TABLE directory_group_members(
    org_id       TEXT NOT NULL,
    group_id     TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    PRIMARY KEY (org_id, group_id, principal_id)
  );
  CREATE INDEX directory_group_members_principal ON directory_group_members (org_id, principal_id, group_id);

  CREATE TABLE directory_sync(
    org_id             TEXT PRIMARY KEY,
    members_hash       TEXT,
    channels_hash      TEXT,
    groups_hash        TEXT,
    updated_at         BIGINT NOT NULL,
    members_synced_at  BIGINT,
    channels_synced_at BIGINT,
    groups_synced_at   BIGINT
  );

  CREATE TABLE directory_meta(
    org_id        TEXT PRIMARY KEY,
    workspace_url TEXT,
    updated_at    BIGINT NOT NULL
  );
END
$base_schema$`;

function memberRow(r: Record<string, unknown>): DirectoryMember {
  return {
    principalId: r.principal_id as string,
    displayName: r.display_name as string,
    type: r.type as PrincipalType,
    ...(r.slack_id ? { slackId: r.slack_id as string } : {}),
    ...(r.avatar_url ? { avatarUrl: r.avatar_url as string } : {}),
  };
}
const MEMBER_COLS = "principal_id, display_name, type, slack_id, avatar_url";
function channelRow(r: Record<string, unknown>): DirectoryChannel {
  return {
    channelId: r.channel_id as string,
    name: r.name as string,
    isPrivate: r.is_private as boolean,
    ...(r.is_external ? { isExternal: true } : {}),
  };
}

export const DIRECTORY_MIGRATIONS = [
  {
    id: "directory/store/0006-base-schema",
    expectedChecksum: "e8dcd5c2a3a8fcba7b1c14db1d1aceb57ca7ef6e1c7366ace6df65043f731198",
    statements: [BASE_SCHEMA],
  },
  ...tenantTables("directory/store/0007-tenants", [
    { table: "directory_members", primaryKey: "org_id, principal_id" },
    { table: "directory_channels", primaryKey: "org_id, channel_id" },
    { table: "directory_channel_members", primaryKey: "org_id, channel_id, principal_id" },
    { table: "directory_group_members", primaryKey: "org_id, group_id, principal_id" },
    { table: "directory_groups", primaryKey: "org_id, group_id" },
    { table: "directory_sync", primaryKey: "org_id" },
    { table: "directory_meta", primaryKey: "org_id" },
  ]),
  {
    id: "directory/store/0008-tenants-for-email",
    statements: [
      `DO $tenants_for_email$
BEGIN
  EXECUTE format(
    $function$CREATE OR REPLACE FUNCTION qm_tenants_for_email(email text) RETURNS TABLE(tenant_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $body$
      SELECT DISTINCT m.tenant_id FROM directory_members m
       WHERE lower(m.principal_id) = lower(email) AND m.type = 'internal'
    $body$$function$,
    current_schema());
END $tenants_for_email$`,
    ],
  },
  PRINCIPAL_TENANTS,
  PRINCIPAL_ADMIN_TENANTS,
  {
    id: "directory/store/0009-tenants-for-email-admins",
    statements: [
      `DO $tenants_for_email$
BEGIN
  EXECUTE format(
    $function$CREATE OR REPLACE FUNCTION qm_tenants_for_email(email text) RETURNS TABLE(tenant_id uuid)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = %I, pg_temp AS $body$ BEGIN
      RETURN QUERY
        SELECT m.tenant_id FROM directory_members m
         WHERE lower(m.principal_id) = lower(email) AND m.type = 'internal'
        UNION
        SELECT g.tenant_id FROM admin_grants g WHERE lower(g.principal_id) = lower(email);
    END $body$$function$,
    current_schema());
END $tenants_for_email$`,
    ],
  },
  PRINCIPAL_USER_TENANTS,
  EMAIL_USER_TENANTS,
];

const rosterCoversAudience = (channel: { is_external?: unknown }) => channel.is_external !== true;

export function createPostgresDirectoryStore(connectionString: string): DirectoryStore {
  const orgId = configOrgId();
  const { q, pool } = createPgPool(connectionString, DIRECTORY_MIGRATIONS);

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

  async function readGroupRosters(groupIds: readonly string[]): Promise<Map<string, DirectoryMember[]>> {
    const rosters = new Map<string, DirectoryMember[]>();
    if (!groupIds.length) return rosters;
    const rows = await q(
      `SELECT group_row.group_id, roster.principal_id AS roster_principal_id,
              member.principal_id, member.display_name, member.type, member.slack_id, member.avatar_url
       FROM directory_groups group_row
       JOIN directory_group_members roster
         ON roster.org_id = group_row.org_id AND roster.group_id = group_row.group_id
       LEFT JOIN directory_members member
         ON member.org_id = roster.org_id AND member.principal_id = roster.principal_id
       WHERE group_row.org_id = $1 AND group_row.group_id = ANY($2::text[]) AND group_row.roster_known = TRUE
       ORDER BY group_row.group_id, roster.principal_id`,
      [orgId, [...groupIds]],
    );
    const incomplete = new Set<string>();
    for (const row of rows) {
      const groupId = row.group_id as string;
      if (!row.principal_id) incomplete.add(groupId);
      else rosters.set(groupId, [...(rosters.get(groupId) ?? []), memberRow(row)]);
    }
    for (const groupId of incomplete) rosters.delete(groupId);
    return rosters;
  }

  async function branded(rows: Record<string, unknown>[]) {
    const found = await Promise.all(
      rows.map(({ id }) =>
        withTenant(String(id), async () => {
          const [tenant] = await q(
            `SELECT settings->>'brandName' AS brand, qm_tenant_handle(settings) AS handle,
                    id IN (SELECT qm_serving_tenants()) AS serving
               FROM tenants WHERE id = $1`,
            [id],
          );
          if (tenant?.serving !== true) return [];
          return [
            {
              id: String(id),
              ...(typeof tenant.brand === "string" ? { brandName: tenant.brand } : {}),
              ...(typeof tenant.handle === "string" ? { handle: tenant.handle } : {}),
            },
          ];
        }),
      ),
    );
    return found.flat();
  }

  return {
    ...createDirectorySync({ q, pool, orgId }),
    async meta() {
      const rows = await q("SELECT workspace_url FROM directory_meta WHERE org_id = $1", [orgId]);
      return { workspaceUrl: (rows[0]?.workspace_url as string | null) ?? null };
    },

    async tenantsForEmail(email) {
      const rows = await q("SELECT tenant_id::text AS id FROM qm_tenants_for_email($1) ORDER BY tenant_id", [email]);
      return branded(rows);
    },

    async tenantsForPrincipal(principal) {
      const rows = await q("SELECT tenant::text AS id FROM qm_tenants_for_principal($1) tenant ORDER BY tenant", [
        principal,
      ]);
      return branded(rows);
    },

    async tenantForAppHandle(handle) {
      const rows = await q("SELECT qm_tenant_for_app_handle($1)::text AS id", [handle]);
      return typeof rows[0]?.id === "string" ? rows[0].id : undefined;
    },

    async setAppHandle(handle) {
      try {
        await q("SELECT qm_set_tenant_handle($1)", [handle]);
        return "ok";
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return "taken";
        throw error;
      }
    },

    async trustedClientFor(tenant) {
      const [row] = await withTenant(tenant, () =>
        q("SELECT settings->'oidcClient' AS client FROM tenants WHERE id = $1", [tenant]),
      );
      const client = row?.client as { clientId?: unknown; clientSecret?: unknown } | null | undefined;
      return typeof client?.clientId === "string" && typeof client.clientSecret === "string"
        ? { clientId: client.clientId, clientSecret: client.clientSecret }
        : undefined;
    },

    async channelMember(channelId, principalId) {
      const rows = await q(
        `SELECT 1 FROM directory_channel_members
         WHERE org_id = $1 AND channel_id = $2 AND principal_id = ANY($3::text[]) LIMIT 1`,
        [orgId, channelId, rosterIds(principalId)],
      );
      return rows.length > 0;
    },

    async rosterCoversAudience(channelId) {
      const rows = await q("SELECT is_external FROM directory_channels WHERE org_id = $1 AND channel_id = $2", [
        orgId,
        channelId,
      ]);
      return rows.length ? rosterCoversAudience(rows[0]!) : undefined;
    },

    async channelMemberIds(channelId) {
      const known = await q("SELECT roster_known FROM directory_channels WHERE org_id = $1 AND channel_id = $2", [
        orgId,
        channelId,
      ]);
      if (known[0]?.roster_known !== true) return undefined;
      const rows = await q(
        "SELECT principal_id FROM directory_channel_members WHERE org_id = $1 AND channel_id = $2 ORDER BY principal_id",
        [orgId, channelId],
      );
      return rows.map((row) => row.principal_id as string);
    },

    async channelMembership(channelId, principalId) {
      const rows = await q(
        `SELECT EXISTS (
           SELECT 1 FROM directory_channel_members
           WHERE org_id = $1 AND channel_id = $2 AND principal_id = ANY($3::text[])
         ) AS member,
         (SELECT is_private FROM directory_channels WHERE org_id = $1 AND channel_id = $2) AS is_private,
         (SELECT roster_known FROM directory_channels WHERE org_id = $1 AND channel_id = $2) AS roster_known`,
        [orgId, channelId, rosterIds(principalId)],
      );
      const member = rows[0]?.member === true;
      if (rows[0]?.roster_known !== true) return undefined;
      return member || rows[0]?.is_private === true ? member : undefined;
    },

    async channelPrivacy(channelId) {
      const rows = await q("SELECT is_private FROM directory_channels WHERE org_id = $1 AND channel_id = $2 LIMIT 1", [
        orgId,
        channelId,
      ]);
      return rows.length > 0 ? (rows[0]!.is_private as boolean) : undefined;
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
        "SELECT 1 FROM directory_group_members WHERE org_id = $1 AND group_id = $2 AND principal_id = ANY($3::text[]) LIMIT 1",
        [orgId, groupId, rosterIds(principalId)],
      );
      return rows.length > 0;
    },

    async groupMembership(groupId, principalId) {
      const rows = await q(
        `SELECT EXISTS (
           SELECT 1 FROM directory_group_members
           WHERE org_id = $1 AND group_id = $2 AND principal_id = ANY($3::text[])
         ) AS member,
         EXISTS (
           SELECT 1 FROM directory_groups WHERE org_id = $1 AND group_id = $2
         ) AS listed,
         COALESCE((
           SELECT roster_known FROM directory_groups WHERE org_id = $1 AND group_id = $2
         ), FALSE) AS roster_known,
         EXISTS (
           SELECT 1 FROM directory_sync WHERE org_id = $1 AND groups_hash IS NOT NULL
         ) AS synced`,
        [orgId, groupId, rosterIds(principalId)],
      );
      if (rows[0]?.member === true) return true;
      if (rows[0]?.listed !== true) return rows[0]?.synced === true ? false : undefined;
      return rows[0]?.roster_known === true ? rows[0]?.member === true : undefined;
    },

    async listGroupsFor(principalId) {
      const rows = await q(
        "SELECT DISTINCT group_id FROM directory_group_members WHERE org_id = $1 AND principal_id = ANY($2::text[]) ORDER BY group_id",
        [orgId, rosterIds(principalId)],
      );
      return rows.map((row) => row.group_id as string);
    },

    async conversationMembers(kind, id) {
      if (kind === "group") return (await readGroupRosters([id])).get(id);
      const rows = await q(
        `SELECT channel.roster_known, channel.is_external, roster.principal_id AS roster_principal_id,
                member.principal_id, member.display_name, member.type, member.slack_id
         FROM directory_channels channel
         LEFT JOIN directory_channel_members roster
           ON roster.org_id = channel.org_id AND roster.channel_id = channel.channel_id
         LEFT JOIN directory_members member
           ON member.org_id = roster.org_id AND member.principal_id = roster.principal_id
         WHERE channel.org_id = $1 AND channel.channel_id = $2
         ORDER BY roster.principal_id`,
        [orgId, id],
      );
      if (!rows.length || rows[0]?.roster_known !== true || !rosterCoversAudience(rows[0])) return undefined;
      if (rows.some((row) => !row.roster_principal_id || !row.principal_id)) return undefined;
      return rows.map(memberRow);
    },

    groupRosters: readGroupRosters,

    async listChannelsFor(principalId) {
      const rows = await q(
        `SELECT channel_id, name, is_private, is_external FROM directory_channels c
         WHERE org_id = $1 AND (is_private = FALSE OR EXISTS (
           SELECT 1 FROM directory_channel_members m
           WHERE m.org_id = c.org_id AND m.channel_id = c.channel_id AND m.principal_id = ANY($2::text[])))
         ORDER BY name_lc`,
        [orgId, rosterIds(principalId)],
      );
      return rows.map(channelRow);
    },

    async list() {
      const rows = await q(`SELECT ${MEMBER_COLS} FROM directory_members WHERE org_id = $1`, [orgId]);
      return rows.map(memberRow);
    },

    async listChannels() {
      const rows = await q(
        "SELECT channel_id, name, is_private, is_external FROM directory_channels WHERE org_id = $1",
        [orgId],
      );
      return rows.map(channelRow);
    },

    async get(principalId) {
      const key = foldPrincipalId(principalId);
      const rows = await q(
        `SELECT ${MEMBER_COLS} FROM directory_members
         WHERE org_id = $1 AND (principal_id = $2 OR ($3 AND lower(principal_id) = $4))
         ORDER BY (principal_id = $2) DESC LIMIT 1`,
        [orgId, principalId, key.includes("@"), key],
      );
      return rows.length ? memberRow(rows[0]!) : null;
    },

    async getBySlackId(slackId) {
      const rows = await q(
        `SELECT ${MEMBER_COLS} FROM directory_members
         WHERE org_id = $1 AND (slack_id = $2 OR (slack_id IS NULL AND principal_id = $2)) LIMIT 1`,
        [orgId, slackId],
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
        "channel_id, name, is_private, is_external",
        channelRow,
      );
      if (m.kind === "one") return { kind: "one", channel: m.item };
      if (m.kind === "ambiguous") return { kind: "ambiguous", candidates: m.items };
      return { kind: "none" };
    },
  };
}
