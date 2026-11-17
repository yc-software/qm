import { createHash } from "node:crypto";
import { type PgPool, type PoolClient, withPgTransaction } from "../persistence/pg-pool.ts";
import { SLACK } from "../surfaces/registry.ts";
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

function dedupMemberships(rows: ChannelMembership[]): ChannelMembership[] {
  const seen = new Set<string>();
  return rows.filter((m) => {
    const key = `${m.channelId}|${m.principalId}`;
    if (!m.channelId || !m.principalId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createDirectorySync(deps: {
  q: PgPool["q"];
  pool: PgPool["pool"];
  orgId: string;
}): Pick<DirectoryStore, "replace" | "replaceChannels" | "setWorkspace"> {
  const { q, pool, orgId } = deps;

  async function swapIfChanged(
    hashCol: string,
    hash: string,
    syncedAt: number | undefined,
    write: (client: PoolClient) => Promise<boolean | void>,
    partial = false,
  ): Promise<boolean> {
    const syncedAtCol = hashCol.replace(/_hash$/, "_synced_at");
    return withPgTransaction(await pool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('directory'), hashtext($1))", [orgId]);
      const sync = await client.query(`SELECT ${hashCol}, ${syncedAtCol} FROM directory_sync WHERE org_id = $1`, [
        orgId,
      ]);
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
            `UPDATE directory_sync SET ${syncedAtCol} = GREATEST(COALESCE(${syncedAtCol}, 0), $2) WHERE org_id = $1`,
            [orgId, syncedAt],
          );
        }
        return true;
      }
      const complete = await write(client);
      if (partial && complete === false) return false;
      await client.query(
        `INSERT INTO directory_sync (org_id, ${hashCol}, ${syncedAtCol}, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, org_id) DO UPDATE SET ${hashCol} = EXCLUDED.${hashCol},
           ${syncedAtCol} = COALESCE(EXCLUDED.${syncedAtCol}, directory_sync.${syncedAtCol}),
           updated_at = EXCLUDED.updated_at`,
        [orgId, partial || complete === false ? null : hash, partial ? null : (syncedAt ?? null), Date.now()],
      );
      return true;
    });
  }

  return {
    async replace(members, syncedAt) {
      const byId = new Map<string, DirectoryMember>();
      for (const m of members) if (m.principalId && m.type === "internal") byId.set(m.principalId, m);
      const internal = [...byId.values()];

      const hash = hashRoster(
        internal.map(
          (m) => `${m.principalId}|${m.displayName}|${m.type}|${m.slackId ?? ""}|${m.avatarUrl ?? ""}|${m.isBot ?? ""}`,
        ),
      );

      return swapIfChanged("members_hash", hash, syncedAt, async (client) => {
        await client.query("DELETE FROM directory_members WHERE org_id = $1", [orgId]);
        if (internal.length) {
          await client.query(
            `INSERT INTO directory_members (org_id, principal_id, display_name, display_name_lc, type, slack_id, avatar_url, is_bot)
             SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[])`,
            [
              orgId,
              internal.map((m) => m.principalId),
              internal.map((m) => m.displayName),
              internal.map((m) => normDirectoryQuery(m.displayName)),
              internal.map((m) => m.type),
              internal.map((m) => m.slackId ?? null),
              internal.map((m) => m.avatarUrl ?? null),
              internal.map((m) => m.isBot ?? null),
            ],
          );
        }
      });
    },

    async replaceChannels(
      channels,
      channelMembers,
      syncedAt,
      channelRosterIds,
      revocations = [],
      partial = false,
      surface = SLACK,
    ) {
      if (partial && (syncedAt === undefined || !Number.isFinite(syncedAt) || channelMembers === undefined))
        return false;
      const byId = new Map<string, DirectoryChannel>();
      for (const c of channels) {
        if (c.kind === "group" && c.channelId) byId.set(c.channelId, { ...c, name: "", isPrivate: true });
        else if (c.channelId && c.name) byId.set(c.channelId, { ...c, kind: "channel" });
      }
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
      const channelsPart = list.map(
        (c) => `${surface}|${c.kind}|${c.channelId}|${c.name}|${c.isPrivate ? 1 : 0}|${c.isExternal ? 1 : 0}`,
      );
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
        "channels_hash",
        hash,
        syncedAt,
        async (client) => {
          const protectedRows = await client.query(
            `SELECT channel_id FROM directory_channels
             WHERE org_id = $1 AND surface = $4 AND (observed_at > $2 OR ($3 AND observed_at = $2))`,
            [orgId, syncedAt ?? null, partial, surface],
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
              "DELETE FROM directory_channels WHERE org_id = $1 AND surface = $3 AND NOT (channel_id = ANY($2::text[]))",
              [orgId, retainedIds, surface],
            );
            await client.query(
              "DELETE FROM directory_channel_members WHERE org_id = $1 AND surface = $3 AND NOT (channel_id = ANY($2::text[]))",
              [orgId, retainedIds, surface],
            );
          }
          if (list.length) {
            await client.query(
              `INSERT INTO directory_channels (org_id, surface, channel_id, kind, name, name_lc, is_private, is_external, roster_known, observed_at)
             SELECT $1, $10, rows.*, $9::bigint FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::boolean[], $7::boolean[], $8::boolean[]) AS rows
             ON CONFLICT (tenant_id, org_id, surface, channel_id) DO UPDATE SET
               kind = EXCLUDED.kind,
               name = EXCLUDED.name,
               name_lc = EXCLUDED.name_lc,
               is_private = EXCLUDED.is_private,
               is_external = EXCLUDED.is_external,
               roster_known = directory_channels.roster_known OR EXCLUDED.roster_known,
               observed_at = EXCLUDED.observed_at`,
              [
                orgId,
                channelIds,
                list.map((c) => c.kind),
                list.map((c) => c.name),
                list.map((c) => normDirectoryQuery(c.name)),
                list.map((c) => !!c.isPrivate),
                list.map((c) => !!c.isExternal),
                list.map((c) => rosterIds?.has(c.channelId) ?? false),
                partial ? syncedAt : null,
                surface,
              ],
            );
          }
          if (membershipRows !== undefined) {
            await client.query(
              "DELETE FROM directory_channel_members WHERE org_id = $1 AND surface = $3 AND channel_id = ANY($2::text[])",
              [orgId, [...rosterIds!], surface],
            );
            if (membershipRows.length) {
              await client.query(
                `INSERT INTO directory_channel_members (org_id, surface, channel_id, principal_id)
               SELECT $1, $4, * FROM unnest($2::text[], $3::text[])`,
                [orgId, membershipRows.map((m) => m.channelId), membershipRows.map((m) => m.principalId), surface],
              );
            }
          }
          if (revokedRows.length) {
            await client.query(
              `DELETE FROM directory_channel_members member
             USING unnest($2::text[], $3::text[]) AS revoked(channel_id, principal_id)
             WHERE member.org_id = $1 AND member.surface = $4 AND member.channel_id = revoked.channel_id
               AND member.principal_id = revoked.principal_id`,
              [orgId, revokedRows.map((m) => m.channelId), revokedRows.map((m) => m.principalId), surface],
            );
          }
          return partial || protectedIds.size === 0;
        },
        partial,
      );
    },

    async setWorkspace(meta) {
      await q(
        `INSERT INTO directory_meta (org_id, workspace_url, app_icon_url, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, org_id) DO UPDATE SET workspace_url = EXCLUDED.workspace_url,
           app_icon_url = COALESCE(EXCLUDED.app_icon_url, directory_meta.app_icon_url), updated_at = EXCLUDED.updated_at`,
        [orgId, meta.workspaceUrl, meta.appIconUrl, Date.now()],
      );
    },
  };
}
