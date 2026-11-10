import { createHash } from "node:crypto";
import type { PgPool, PoolClient } from "../persistence/pg-pool.ts";
import type { Tenant } from "../tenants/context.ts";
import {
  normDirectoryQuery,
  type ChannelMembership,
  type DirectoryChannel,
  type DirectoryMember,
  type DirectoryStore,
} from "./directory-store.ts";

function hashRoster(rows: string[]): string {
  return createHash("sha256").update(rows.slice().sort().join("\n")).digest("hex");
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

export function createDirectorySync(deps: {
  pg: Pick<PgPool, "forTenant">;
  orgId: string;
}): Pick<DirectoryStore, "replace" | "replaceChannels" | "setWorkspaceUrl" | "replaceGroups" | "upsertGroup"> {
  const { pg, orgId } = deps;

  async function swapIfChanged(
    tenant: Tenant,
    hashCol: string,
    hash: string,
    syncedAt: number | undefined,
    write: (client: PoolClient) => Promise<boolean | void>,
    partial = false,
  ): Promise<boolean> {
    const syncedAtCol = hashCol.replace(/_hash$/, "_synced_at");
    return pg.forTenant(tenant).transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('directory'), hashtext($1))", [orgId]);
      const sync = await client.query(
        `SELECT ${hashCol}, ${syncedAtCol} FROM directory_sync WHERE tenant_id = $1 AND org_id = $2`,
        [tenant.id, orgId],
      );
      const row = sync.rows[0];
      if (
        syncedAt !== undefined &&
        row?.[syncedAtCol] != null &&
        (partial ? Number(row[syncedAtCol]) >= syncedAt : Number(row[syncedAtCol]) > syncedAt)
      ) {
        console.warn(
          `[directory] refused stale ${hashCol.replace(/_hash$/, "")} swap for ${orgId}: stamped ${Number(row[syncedAtCol]) - syncedAt}ms behind`,
        );
        return false;
      }
      if (!partial && row?.[hashCol] === hash) {
        if (syncedAt !== undefined) {
          await client.query(
            `UPDATE directory_sync SET ${syncedAtCol} = GREATEST(COALESCE(${syncedAtCol}, 0), $3)
             WHERE tenant_id = $1 AND org_id = $2`,
            [tenant.id, orgId, syncedAt],
          );
        }
        return true;
      }
      const complete = await write(client);
      if (partial && complete === false) return false;
      await client.query(
        `INSERT INTO directory_sync (tenant_id, org_id, ${hashCol}, ${syncedAtCol}, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, org_id) DO UPDATE SET ${hashCol} = EXCLUDED.${hashCol},
           ${syncedAtCol} = COALESCE(EXCLUDED.${syncedAtCol}, directory_sync.${syncedAtCol}),
           updated_at = EXCLUDED.updated_at`,
        [
          tenant.id,
          orgId,
          partial || complete === false ? null : hash,
          partial ? null : (syncedAt ?? null),
          Date.now(),
        ],
      );
      return true;
    });
  }

  return {
    async replace(tenant, members, syncedAt) {
      const byId = new Map<string, DirectoryMember>();
      for (const m of members) if (m.principalId && m.type === "internal") byId.set(m.principalId, m);
      const internal = [...byId.values()];

      const hash = hashRoster(
        internal.map((m) => `${m.principalId}|${m.displayName}|${m.type}|${m.slackId ?? ""}|${m.avatarUrl ?? ""}`),
      );

      return swapIfChanged(tenant, "members_hash", hash, syncedAt, async (client) => {
        await client.query("DELETE FROM directory_members WHERE tenant_id = $1 AND org_id = $2", [tenant.id, orgId]);
        if (internal.length) {
          await client.query(
            `INSERT INTO directory_members (tenant_id, org_id, principal_id, display_name, display_name_lc, type, slack_id, avatar_url)
             SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])`,
            [
              tenant.id,
              orgId,
              internal.map((m) => m.principalId),
              internal.map((m) => m.displayName),
              internal.map((m) => normDirectoryQuery(m.displayName)),
              internal.map((m) => m.type),
              internal.map((m) => m.slackId ?? null),
              internal.map((m) => m.avatarUrl ?? null),
            ],
          );
        }
      });
    },

    async replaceChannels(
      tenant,
      channels,
      channelMembers,
      syncedAt,
      channelRosterIds,
      revocations = [],
      partial = false,
    ) {
      if (partial && (syncedAt === undefined || !Number.isFinite(syncedAt) || channelMembers === undefined))
        return false;
      const byId = new Map<string, DirectoryChannel>();
      for (const c of channels) if (c.channelId && c.name) byId.set(c.channelId, c);
      let list = [...byId.values()];
      const listedIds = new Set(list.map((channel) => channel.channelId));

      let rosterIds =
        channelMembers === undefined
          ? undefined
          : new Set((channelRosterIds ?? [...listedIds]).filter((channelId) => listedIds.has(channelId)));
      let membershipRows =
        channelMembers === undefined
          ? undefined
          : dedupMemberships(channelMembers).filter((member) => rosterIds!.has(member.channelId));
      let revokedRows = dedupMemberships(revocations).filter((member) => listedIds.has(member.channelId));
      const channelsPart = list.map((c) => `${c.channelId}|${c.name}|${c.isPrivate ? 1 : 0}|${c.isExternal ? 1 : 0}`);
      const membersPart =
        membershipRows === undefined
          ? []
          : [
              ...[...rosterIds!].map((channelId) => `r:${channelId}`),
              ...membershipRows.map((m) => `m:${m.channelId}|${m.principalId}`),
              ...revokedRows.map((m) => `x:${m.channelId}|${m.principalId}`),
            ];
      const hash = hashRoster([...channelsPart, ...membersPart]);

      return swapIfChanged(
        tenant,
        "channels_hash",
        hash,
        syncedAt,
        async (client) => {
          const protectedRows = await client.query(
            `SELECT channel_id FROM directory_channels
             WHERE tenant_id = $1 AND org_id = $2 AND (observed_at > $3 OR ($4 AND observed_at = $3))`,
            [tenant.id, orgId, syncedAt ?? null, partial],
          );
          const protectedIds = new Set(protectedRows.rows.map((row) => row.channel_id as string));
          if (partial && list.some((channel) => protectedIds.has(channel.channelId))) return false;
          list = list.filter((channel) => !protectedIds.has(channel.channelId));
          rosterIds = rosterIds && new Set([...rosterIds].filter((id) => !protectedIds.has(id)));
          membershipRows = membershipRows?.filter((member) => !protectedIds.has(member.channelId));
          revokedRows = revokedRows.filter((member) => !protectedIds.has(member.channelId));
          const retainedIds = [...listedIds, ...protectedIds];
          const channelIds = list.map((channel) => channel.channelId);
          if (!partial) {
            await client.query(
              "DELETE FROM directory_channels WHERE tenant_id = $1 AND org_id = $2 AND NOT (channel_id = ANY($3::text[]))",
              [tenant.id, orgId, retainedIds],
            );
            await client.query(
              `DELETE FROM directory_channel_members
               WHERE tenant_id = $1 AND org_id = $2 AND NOT (channel_id = ANY($3::text[]))`,
              [tenant.id, orgId, retainedIds],
            );
          }
          if (list.length) {
            await client.query(
              `INSERT INTO directory_channels (tenant_id, org_id, channel_id, name, name_lc, is_private, is_external, roster_known, observed_at)
             SELECT $1, $2, rows.*, $9::bigint FROM unnest($3::text[], $4::text[], $5::text[], $6::boolean[], $7::boolean[], $8::boolean[]) AS rows
             ON CONFLICT (tenant_id, org_id, channel_id) DO UPDATE SET
               name = EXCLUDED.name,
               name_lc = EXCLUDED.name_lc,
               is_private = EXCLUDED.is_private,
               is_external = EXCLUDED.is_external,
               roster_known = directory_channels.roster_known OR EXCLUDED.roster_known,
               observed_at = EXCLUDED.observed_at`,
              [
                tenant.id,
                orgId,
                channelIds,
                list.map((c) => c.name),
                list.map((c) => normDirectoryQuery(c.name)),
                list.map((c) => !!c.isPrivate),
                list.map((c) => !!c.isExternal),
                list.map((c) => rosterIds?.has(c.channelId) ?? false),
                partial ? syncedAt : null,
              ],
            );
          }
          if (membershipRows !== undefined) {
            await client.query(
              "DELETE FROM directory_channel_members WHERE tenant_id = $1 AND org_id = $2 AND channel_id = ANY($3::text[])",
              [tenant.id, orgId, [...rosterIds!]],
            );
            if (membershipRows.length) {
              await client.query(
                `INSERT INTO directory_channel_members (tenant_id, org_id, channel_id, principal_id)
               SELECT $1, $2, * FROM unnest($3::text[], $4::text[])`,
                [tenant.id, orgId, membershipRows.map((m) => m.channelId), membershipRows.map((m) => m.principalId)],
              );
            }
          }
          if (revokedRows.length) {
            await client.query(
              `DELETE FROM directory_channel_members member
             USING unnest($3::text[], $4::text[]) AS revoked(channel_id, principal_id)
             WHERE member.tenant_id = $1 AND member.org_id = $2 AND member.channel_id = revoked.channel_id
               AND member.principal_id = revoked.principal_id`,
              [tenant.id, orgId, revokedRows.map((m) => m.channelId), revokedRows.map((m) => m.principalId)],
            );
          }
          return partial || protectedIds.size === 0;
        },
        partial,
      );
    },

    async setWorkspaceUrl(tenant, url) {
      await pg.forTenant(tenant).q(
        `INSERT INTO directory_meta (tenant_id, org_id, workspace_url, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, org_id) DO UPDATE SET workspace_url = EXCLUDED.workspace_url, updated_at = EXCLUDED.updated_at`,
        [tenant.id, orgId, url, Date.now()],
      );
    },

    async replaceGroups(tenant, groupMembers, syncedAt, groupIds, groupRosterIds) {
      const allRows = dedupPairs(
        groupMembers,
        (m) => m.groupId,
        (m) => m.principalId,
      );
      const listedIds = [...new Set((groupIds ?? allRows.map((member) => member.groupId)).filter(Boolean))];
      const listed = new Set(listedIds);
      const rosterIds = [...new Set((groupRosterIds ?? listedIds).filter((groupId) => listed.has(groupId)))];
      const rostered = new Set(rosterIds);
      const rows = allRows.filter((member) => rostered.has(member.groupId));
      const hash = hashRoster([
        ...listedIds.map((groupId) => `g:${groupId}`),
        ...rosterIds.map((groupId) => `r:${groupId}`),
        ...rows.map((member) => `m:${member.groupId}|${member.principalId}`),
      ]);

      return swapIfChanged(tenant, "groups_hash", hash, syncedAt, async (client) => {
        await client.query(
          "DELETE FROM directory_group_members WHERE tenant_id = $1 AND org_id = $2 AND NOT (group_id = ANY($3::text[]))",
          [tenant.id, orgId, listedIds],
        );
        await client.query(
          "DELETE FROM directory_groups WHERE tenant_id = $1 AND org_id = $2 AND NOT (group_id = ANY($3::text[]))",
          [tenant.id, orgId, listedIds],
        );
        if (listedIds.length) {
          await client.query(
            `INSERT INTO directory_groups (tenant_id, org_id, group_id, roster_known)
             SELECT $1, $2, * FROM unnest($3::text[], $4::boolean[])
             ON CONFLICT (tenant_id, org_id, group_id) DO UPDATE SET
               roster_known = directory_groups.roster_known OR EXCLUDED.roster_known`,
            [tenant.id, orgId, listedIds, listedIds.map((groupId) => rostered.has(groupId))],
          );
        }
        await client.query(
          "DELETE FROM directory_group_members WHERE tenant_id = $1 AND org_id = $2 AND group_id = ANY($3::text[])",
          [tenant.id, orgId, rosterIds],
        );
        if (rows.length) {
          await client.query(
            `INSERT INTO directory_group_members (tenant_id, org_id, group_id, principal_id)
             SELECT $1, $2, * FROM unnest($3::text[], $4::text[])`,
            [tenant.id, orgId, rows.map((m) => m.groupId), rows.map((m) => m.principalId)],
          );
        }
      });
    },

    async upsertGroup(tenant, groupId, principalIds) {
      const ids = [...new Set(principalIds.filter(Boolean))];
      if (!groupId || !ids.length) return;
      await pg.forTenant(tenant).transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('directory'), hashtext($1))", [orgId]);
        await client.query(
          `INSERT INTO directory_groups (tenant_id, org_id, group_id, roster_known) VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (tenant_id, org_id, group_id) DO UPDATE SET roster_known = TRUE`,
          [tenant.id, orgId, groupId],
        );
        await client.query(
          "DELETE FROM directory_group_members WHERE tenant_id = $1 AND org_id = $2 AND group_id = $3",
          [tenant.id, orgId, groupId],
        );
        await client.query(
          `INSERT INTO directory_group_members (tenant_id, org_id, group_id, principal_id)
           SELECT $1, $2, $3, * FROM unnest($4::text[])`,
          [tenant.id, orgId, groupId, ids],
        );
        const all = await client.query(
          "SELECT group_id, principal_id FROM directory_group_members WHERE tenant_id = $1 AND org_id = $2",
          [tenant.id, orgId],
        );
        await client.query(
          "UPDATE directory_sync SET groups_hash = $3, updated_at = $4 WHERE tenant_id = $1 AND org_id = $2 AND groups_hash IS NOT NULL",
          [tenant.id, orgId, hashRoster(all.rows.map((r) => `${r.group_id}|${r.principal_id}`)), Date.now()],
        );
      });
    },
  };
}
