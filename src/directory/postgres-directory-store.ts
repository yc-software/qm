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
import { type Tenant, withTenant } from "../tenants/context.ts";

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
  const pg = createPgPool(connectionString, DIRECTORY_MIGRATIONS);

  async function pick<T>(
    tenant: Tenant,
    query: string,
    table: string,
    idCol: string,
    labelLcCol: string,
    cols: string,
    map: (r: Record<string, unknown>) => T,
  ): Promise<{ kind: "one"; item: T } | { kind: "ambiguous"; items: T[] } | { kind: "none" }> {
    const qn = normDirectoryQuery(query);
    if (!qn) return { kind: "none" };
    const db = pg.forTenant(tenant);
    const from = `FROM ${table} WHERE tenant_id = $1 AND org_id = $2`;

    const byId = await db.q(`SELECT ${cols} ${from} AND lower(${idCol}) = $3 LIMIT 1`, [tenant.id, orgId, qn]);
    if (byId.length) return { kind: "one", item: map(byId[0]!) };

    const exact = await db.q(
      `SELECT ${cols} ${from} AND ${labelLcCol} = $3 ORDER BY ${idCol} LIMIT ${MAX_CANDIDATES + 1}`,
      [tenant.id, orgId, qn],
    );
    if (exact.length === 1) return { kind: "one", item: map(exact[0]!) };
    if (exact.length > 1) return { kind: "ambiguous", items: exact.slice(0, MAX_CANDIDATES).map(map) };

    const esc = likeEscape(qn);
    let pool2 = await db.q(
      `SELECT ${cols} ${from} AND ${labelLcCol} LIKE $3 ESCAPE '\\' ORDER BY ${labelLcCol}, ${idCol} LIMIT ${MAX_CANDIDATES + 1}`,
      [tenant.id, orgId, `${esc}%`],
    );
    if (!pool2.length) {
      pool2 = await db.q(
        `SELECT ${cols} ${from} AND ${labelLcCol} LIKE $3 ESCAPE '\\' ORDER BY ${labelLcCol}, ${idCol} LIMIT ${MAX_CANDIDATES + 1}`,
        [tenant.id, orgId, `%${esc}%`],
      );
    }
    if (!pool2.length) return { kind: "none" };
    if (pool2.length === 1) return { kind: "one", item: map(pool2[0]!) };
    return { kind: "ambiguous", items: pool2.slice(0, MAX_CANDIDATES).map(map) };
  }

  async function readGroupRosters(
    tenant: Tenant,
    groupIds: readonly string[],
  ): Promise<Map<string, DirectoryMember[]>> {
    const rosters = new Map<string, DirectoryMember[]>();
    if (!groupIds.length) return rosters;
    const rows = await pg.forTenant(tenant).q(
      `SELECT group_row.group_id, roster.principal_id AS roster_principal_id,
              member.principal_id, member.display_name, member.type, member.slack_id, member.avatar_url
       FROM directory_groups group_row
       JOIN directory_group_members roster
         ON roster.tenant_id = group_row.tenant_id AND roster.org_id = group_row.org_id
        AND roster.group_id = group_row.group_id
       LEFT JOIN directory_members member
         ON member.tenant_id = roster.tenant_id AND member.org_id = roster.org_id
        AND member.principal_id = roster.principal_id
       WHERE group_row.tenant_id = $1 AND group_row.org_id = $2 AND group_row.group_id = ANY($3::text[])
         AND group_row.roster_known = TRUE
       ORDER BY group_row.group_id, roster.principal_id`,
      [tenant.id, orgId, [...groupIds]],
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
        withTenant(String(id), async (tenant) => {
          const [row] = await pg.forTenant(tenant).q(
            `SELECT settings->>'brandName' AS brand, qm_tenant_handle(settings) AS handle,
                    id IN (SELECT qm_serving_tenants()) AS serving
               FROM tenants WHERE id = $1`,
            [tenant.id],
          );
          if (row?.serving !== true) return [];
          return [
            {
              id: tenant.id,
              ...(typeof row.brand === "string" ? { brandName: row.brand } : {}),
              ...(typeof row.handle === "string" ? { handle: row.handle } : {}),
            },
          ];
        }),
      ),
    );
    return found.flat();
  }

  return {
    ...createDirectorySync({ pg, orgId }),
    async meta(tenant) {
      const rows = await pg
        .forTenant(tenant)
        .q("SELECT workspace_url FROM directory_meta WHERE tenant_id = $1 AND org_id = $2", [tenant.id, orgId]);
      return { workspaceUrl: (rows[0]?.workspace_url as string | null) ?? null };
    },

    async tenantsForEmail(email) {
      const rows = await pg.q("SELECT tenant_id::text AS id FROM qm_tenants_for_email($1) ORDER BY tenant_id", [email]);
      return branded(rows);
    },

    async tenantsForPrincipal(principal) {
      const rows = await pg.q("SELECT tenant::text AS id FROM qm_tenants_for_principal($1) tenant ORDER BY tenant", [
        principal,
      ]);
      return branded(rows);
    },

    async tenantForAppHandle(handle) {
      const rows = await pg.q("SELECT qm_tenant_for_app_handle($1)::text AS id", [handle]);
      return typeof rows[0]?.id === "string" ? rows[0].id : undefined;
    },

    async setAppHandle(tenant, handle) {
      try {
        await pg.forTenant(tenant).q("SELECT qm_set_tenant_handle($1)", [handle]);
        return "ok";
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return "taken";
        throw error;
      }
    },

    async trustedClientFor(id) {
      const [row] = await withTenant(id, (tenant) =>
        pg.forTenant(tenant).q("SELECT settings->'oidcClient' AS client FROM tenants WHERE id = $1", [tenant.id]),
      );
      const client = row?.client as { clientId?: unknown; clientSecret?: unknown } | null | undefined;
      return typeof client?.clientId === "string" && typeof client.clientSecret === "string"
        ? { clientId: client.clientId, clientSecret: client.clientSecret }
        : undefined;
    },

    async channelMember(tenant, channelId, principalId) {
      const rows = await pg.forTenant(tenant).q(
        `SELECT 1 FROM directory_channel_members
         WHERE tenant_id = $1 AND org_id = $2 AND channel_id = $3 AND principal_id = ANY($4::text[]) LIMIT 1`,
        [tenant.id, orgId, channelId, rosterIds(principalId)],
      );
      return rows.length > 0;
    },

    async rosterCoversAudience(tenant, channelId) {
      const rows = await pg
        .forTenant(tenant)
        .q("SELECT is_external FROM directory_channels WHERE tenant_id = $1 AND org_id = $2 AND channel_id = $3", [
          tenant.id,
          orgId,
          channelId,
        ]);
      return rows.length ? rosterCoversAudience(rows[0]!) : undefined;
    },

    async channelMemberIds(tenant, channelId) {
      const db = pg.forTenant(tenant);
      const known = await db.q(
        "SELECT roster_known FROM directory_channels WHERE tenant_id = $1 AND org_id = $2 AND channel_id = $3",
        [tenant.id, orgId, channelId],
      );
      if (known[0]?.roster_known !== true) return undefined;
      const rows = await db.q(
        `SELECT principal_id FROM directory_channel_members
         WHERE tenant_id = $1 AND org_id = $2 AND channel_id = $3 ORDER BY principal_id`,
        [tenant.id, orgId, channelId],
      );
      return rows.map((row) => row.principal_id as string);
    },

    async channelMembership(tenant, channelId, principalId) {
      const rows = await pg.forTenant(tenant).q(
        `SELECT EXISTS (
           SELECT 1 FROM directory_channel_members
           WHERE tenant_id = $1 AND org_id = $2 AND channel_id = $3 AND principal_id = ANY($4::text[])
         ) AS member,
         (SELECT is_private FROM directory_channels WHERE tenant_id = $1 AND org_id = $2 AND channel_id = $3) AS is_private,
         (SELECT roster_known FROM directory_channels WHERE tenant_id = $1 AND org_id = $2 AND channel_id = $3) AS roster_known`,
        [tenant.id, orgId, channelId, rosterIds(principalId)],
      );
      const member = rows[0]?.member === true;
      if (rows[0]?.roster_known !== true) return undefined;
      return member || rows[0]?.is_private === true ? member : undefined;
    },

    async channelPrivacy(tenant, channelId) {
      const rows = await pg
        .forTenant(tenant)
        .q(
          "SELECT is_private FROM directory_channels WHERE tenant_id = $1 AND org_id = $2 AND channel_id = $3 LIMIT 1",
          [tenant.id, orgId, channelId],
        );
      return rows.length > 0 ? (rows[0]!.is_private as boolean) : undefined;
    },

    async resolveGroupByParticipants(tenant, participants) {
      const key = groupParticipantsKey(participants);
      if (!key) return { kind: "none" };
      const rows = await pg.forTenant(tenant).q(
        `SELECT group_id FROM directory_group_members
         WHERE tenant_id = $1 AND org_id = $2
         GROUP BY group_id
         HAVING string_agg(DISTINCT principal_id, ',' ORDER BY principal_id) = $3
         LIMIT 1`,
        [tenant.id, orgId, key],
      );
      return rows.length ? { kind: "one", groupId: rows[0]!.group_id as string } : { kind: "none" };
    },

    async groupMember(tenant, groupId, principalId) {
      const rows = await pg.forTenant(tenant).q(
        `SELECT 1 FROM directory_group_members
         WHERE tenant_id = $1 AND org_id = $2 AND group_id = $3 AND principal_id = ANY($4::text[]) LIMIT 1`,
        [tenant.id, orgId, groupId, rosterIds(principalId)],
      );
      return rows.length > 0;
    },

    async groupMembership(tenant, groupId, principalId) {
      const rows = await pg.forTenant(tenant).q(
        `SELECT EXISTS (
           SELECT 1 FROM directory_group_members
           WHERE tenant_id = $1 AND org_id = $2 AND group_id = $3 AND principal_id = ANY($4::text[])
         ) AS member,
         EXISTS (
           SELECT 1 FROM directory_groups WHERE tenant_id = $1 AND org_id = $2 AND group_id = $3
         ) AS listed,
         COALESCE((
           SELECT roster_known FROM directory_groups WHERE tenant_id = $1 AND org_id = $2 AND group_id = $3
         ), FALSE) AS roster_known,
         EXISTS (
           SELECT 1 FROM directory_sync WHERE tenant_id = $1 AND org_id = $2 AND groups_hash IS NOT NULL
         ) AS synced`,
        [tenant.id, orgId, groupId, rosterIds(principalId)],
      );
      if (rows[0]?.member === true) return true;
      if (rows[0]?.listed !== true) return rows[0]?.synced === true ? false : undefined;
      return rows[0]?.roster_known === true ? rows[0]?.member === true : undefined;
    },

    async listGroupsFor(tenant, principalId) {
      const rows = await pg.forTenant(tenant).q(
        `SELECT DISTINCT group_id FROM directory_group_members
         WHERE tenant_id = $1 AND org_id = $2 AND principal_id = ANY($3::text[]) ORDER BY group_id`,
        [tenant.id, orgId, rosterIds(principalId)],
      );
      return rows.map((row) => row.group_id as string);
    },

    async conversationMembers(tenant, kind, id) {
      if (kind === "group") return (await readGroupRosters(tenant, [id])).get(id);
      const rows = await pg.forTenant(tenant).q(
        `SELECT channel.roster_known, channel.is_external, roster.principal_id AS roster_principal_id,
                member.principal_id, member.display_name, member.type, member.slack_id
         FROM directory_channels channel
         LEFT JOIN directory_channel_members roster
           ON roster.tenant_id = channel.tenant_id AND roster.org_id = channel.org_id
          AND roster.channel_id = channel.channel_id
         LEFT JOIN directory_members member
           ON member.tenant_id = roster.tenant_id AND member.org_id = roster.org_id
          AND member.principal_id = roster.principal_id
         WHERE channel.tenant_id = $1 AND channel.org_id = $2 AND channel.channel_id = $3
         ORDER BY roster.principal_id`,
        [tenant.id, orgId, id],
      );
      if (!rows.length || rows[0]?.roster_known !== true || !rosterCoversAudience(rows[0])) return undefined;
      if (rows.some((row) => !row.roster_principal_id || !row.principal_id)) return undefined;
      return rows.map(memberRow);
    },

    groupRosters: readGroupRosters,

    async listChannelsFor(tenant, principalId) {
      const rows = await pg.forTenant(tenant).q(
        `SELECT channel_id, name, is_private, is_external FROM directory_channels c
         WHERE tenant_id = $1 AND org_id = $2 AND (is_private = FALSE OR EXISTS (
           SELECT 1 FROM directory_channel_members m
           WHERE m.tenant_id = c.tenant_id AND m.org_id = c.org_id AND m.channel_id = c.channel_id
             AND m.principal_id = ANY($3::text[])))
         ORDER BY name_lc`,
        [tenant.id, orgId, rosterIds(principalId)],
      );
      return rows.map(channelRow);
    },

    async list(tenant) {
      const rows = await pg
        .forTenant(tenant)
        .q(`SELECT ${MEMBER_COLS} FROM directory_members WHERE tenant_id = $1 AND org_id = $2`, [tenant.id, orgId]);
      return rows.map(memberRow);
    },

    async listChannels(tenant) {
      const rows = await pg
        .forTenant(tenant)
        .q(
          "SELECT channel_id, name, is_private, is_external FROM directory_channels WHERE tenant_id = $1 AND org_id = $2",
          [tenant.id, orgId],
        );
      return rows.map(channelRow);
    },

    async get(tenant, principalId) {
      const key = foldPrincipalId(principalId);
      const rows = await pg.forTenant(tenant).q(
        `SELECT ${MEMBER_COLS} FROM directory_members
         WHERE tenant_id = $1 AND org_id = $2 AND (principal_id = $3 OR ($4 AND lower(principal_id) = $5))
         ORDER BY (principal_id = $3) DESC LIMIT 1`,
        [tenant.id, orgId, principalId, key.includes("@"), key],
      );
      return rows.length ? memberRow(rows[0]!) : null;
    },

    async getBySlackId(tenant, slackId) {
      const rows = await pg.forTenant(tenant).q(
        `SELECT ${MEMBER_COLS} FROM directory_members
         WHERE tenant_id = $1 AND org_id = $2 AND (slack_id = $3 OR (slack_id IS NULL AND principal_id = $3)) LIMIT 1`,
        [tenant.id, orgId, slackId],
      );
      return rows.length ? memberRow(rows[0]!) : null;
    },

    async resolve(tenant, query) {
      const bySlackId = await pg
        .forTenant(tenant)
        .q(
          `SELECT ${MEMBER_COLS} FROM directory_members WHERE tenant_id = $1 AND org_id = $2 AND slack_id = $3 LIMIT 1`,
          [tenant.id, orgId, query.trim()],
        );
      if (bySlackId.length) return { kind: "one", member: memberRow(bySlackId[0]!) };
      const m = await pick(
        tenant,
        query,
        "directory_members",
        "principal_id",
        "display_name_lc",
        MEMBER_COLS,
        memberRow,
      );
      if (m.kind === "one") return { kind: "one", member: m.item };
      if (m.kind === "ambiguous") return { kind: "ambiguous", candidates: m.items };
      return { kind: "none" };
    },

    async resolveChannel(tenant, query) {
      const m = await pick(
        tenant,
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
