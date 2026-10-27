import { createPgPool, type PgPool, tenantCols, withPgTransaction } from "../persistence/pg-pool.ts";
import type { CachedMessage, ContainerState, LiveFallback, IngestEvent, SurfaceCache } from "./types.ts";
import { tenant } from "../tenant.ts";
import { jsonbSafeStringify } from "../util/text.ts";

export type {
  CachedMessage,
  ContainerSummary,
  IngestEvent,
  LiveFallback,
  ReadMessagesOpts,
  SearchOpts,
  SurfaceCache,
} from "./types.ts";

const SLACK = "slack";
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 50;

function normalizeEvent(event: IngestEvent): IngestEvent {
  return JSON.parse(jsonbSafeStringify(event)) as IngestEvent;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(MAX_READ_LIMIT, Math.floor(limit ?? fallback)));
}

function rowToMessage(r: Record<string, unknown>): CachedMessage {
  return {
    container: r.container as string,
    ts: r.ts as string,
    ...(r.surface != null && r.surface !== SLACK ? { surface: r.surface as string } : {}),
    ...(r.sub != null ? { sub: r.sub as string } : {}),
    ...(r.subtype != null ? { subtype: r.subtype as string } : {}),
    ...(r.broadcast ? { broadcast: true } : {}),
    ...(r.bot_id != null ? { botId: r.bot_id as string } : {}),
    ...(r.author_id != null ? { authorId: r.author_id as string } : {}),
    ...(r.author_name != null ? { authorName: r.author_name as string } : {}),
    text: (r.text as string) ?? "",
    ...(r.reply_count != null ? { replyCount: Number(r.reply_count) } : {}),
    ...(r.mentions != null ? { mentions: r.mentions as Record<string, string> } : {}),
    ...(r.self ? { self: true } : {}),
    ...(r.bot ? { bot: true } : {}),
    ...(r.mentions_self ? { mentionsSelf: true } : {}),
    ...(r.edited_at != null ? { editedAt: Number(r.edited_at) } : {}),
    ...(r.deleted ? { deleted: true } : {}),
    ...(r.deleted_at != null ? { deletedAt: Number(r.deleted_at) } : {}),
    ...(r.handled ? { handled: true } : {}),
    ...(Array.isArray(r.files) && r.files.length ? { files: r.files as CachedMessage["files"] } : {}),
    createdAt: Number(r.created_at),
  };
}

async function ingestEvents(pool: PgPool["pool"], events: IngestEvent[]): Promise<{ upserted: number }> {
  if (!events.length) return { upserted: 0 };
  const now = Date.now();
  let upserted = 0;
  const files = new Map<string, { container: string; ts: string; rows: Array<Record<string, unknown>> }>();
  const states: Array<Record<string, unknown>> = [];
  await withPgTransaction(await pool(), async (client) => {
    for (const event of events) {
      const e = normalizeEvent(event);
      if (!e.container || !e.ts) continue;
      const res = await client.query(
        `INSERT INTO channel_messages(org_id, container, ts, sub, author_id, author_name, text, mentions, self, bot, mentions_self, edited_at, deleted, handled, created_at, deleted_at, broadcast, subtype, bot_id, surface)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($18::boolean, FALSE),$19,$20,$21)
             ON CONFLICT (${tenantCols("org_id, container, ts")}) DO UPDATE SET
               sub = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) OR NOT $17 THEN channel_messages.sub ELSE EXCLUDED.sub END,
               subtype = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.subtype ELSE COALESCE(EXCLUDED.subtype, channel_messages.subtype) END,
               broadcast = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) OR $18::boolean IS NULL THEN channel_messages.broadcast ELSE EXCLUDED.broadcast END,
               bot_id = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.bot_id ELSE COALESCE(EXCLUDED.bot_id, channel_messages.bot_id) END,
               author_id = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.author_id ELSE COALESCE(EXCLUDED.author_id, channel_messages.author_id) END,
               author_name = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.author_name ELSE COALESCE(EXCLUDED.author_name, channel_messages.author_name) END,
               text = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.text ELSE EXCLUDED.text END,
               mentions = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.mentions ELSE COALESCE(EXCLUDED.mentions, channel_messages.mentions) END,
               self = channel_messages.self OR (NOT (EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0)) AND EXCLUDED.self),
               bot = channel_messages.bot OR (NOT (EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0)) AND EXCLUDED.bot),
               mentions_self = channel_messages.mentions_self OR (NOT (EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0)) AND EXCLUDED.mentions_self),
               edited_at = CASE WHEN channel_messages.deleted OR EXCLUDED.deleted THEN channel_messages.edited_at ELSE GREATEST(COALESCE(EXCLUDED.edited_at, 0), COALESCE(channel_messages.edited_at, 0)) END,
               deleted = channel_messages.deleted OR EXCLUDED.deleted,
               deleted_at = COALESCE(channel_messages.deleted_at, EXCLUDED.deleted_at),
               handled = channel_messages.handled OR EXCLUDED.handled
             WHERE EXCLUDED.deleted
                OR COALESCE(EXCLUDED.edited_at, 0) >= COALESCE(channel_messages.edited_at, 0)
                OR EXCLUDED.handled
             RETURNING NOT deleted AND COALESCE(edited_at, 0) = COALESCE($12::bigint, 0) AS content_accepted`,
        [
          tenant().orgId,
          e.container,
          e.ts,
          e.sub ?? null,
          e.authorId ?? null,
          e.authorName ?? null,
          e.text ?? "",
          e.mentions ? JSON.stringify(e.mentions) : null,
          e.self ?? false,
          e.bot ?? false,
          e.mentionsSelf ?? false,
          e.editedAt ?? null,
          e.deleted ?? false,
          e.handled ?? false,
          e.createdAt ?? now,
          e.deleted ? now : null,
          e.sub !== undefined,
          e.broadcast ?? null,
          e.subtype ?? null,
          e.botId ?? null,
          e.surface ?? SLACK,
        ],
      );
      upserted += res.rowCount ?? 0;
      if (res.rows[0]?.content_accepted && e.files !== undefined) {
        const byId = new Map<string, Record<string, unknown>>();
        for (const f of e.files) {
          if (!f.fileId) continue;
          byId.set(f.fileId, {
            container: e.container,
            ts: e.ts,
            file_id: f.fileId,
            name: f.name ?? null,
            mimetype: f.mimetype ?? null,
            created_at: e.createdAt ?? now,
            title: f.title ?? null,
            size: f.size ?? null,
          });
        }
        files.set(`${e.container}\u0000${e.ts}`, { container: e.container, ts: e.ts, rows: [...byId.values()] });
      }
      states.push({
        container: e.container,
        ts: e.ts,
        name: e.containerName ?? null,
        kind: e.kind ?? null,
        members: e.members ?? [],
        surface: e.surface ?? SLACK,
      });
    }
    if (files.size) {
      const replaced = [...files.values()];
      await client.query(
        `DELETE FROM channel_files f USING unnest($2::text[], $3::text[]) AS m(container, ts)
             WHERE f.org_id = $1 AND f.container = m.container AND f.ts = m.ts`,
        [tenant().orgId, replaced.map((m) => m.container), replaced.map((m) => m.ts)],
      );
      const rows = replaced.flatMap((m) => m.rows);
      if (rows.length) {
        await client.query(
          `INSERT INTO channel_files(org_id, container, ts, file_id, name, mimetype, created_at, title, size)
               SELECT $1, container, ts, file_id, name, mimetype, created_at, title, size
                 FROM jsonb_to_recordset($2::jsonb)
                   AS b(container text, ts text, file_id text, name text, mimetype text, created_at bigint, title text, size bigint)`,
          [tenant().orgId, JSON.stringify(rows)],
        );
      }
    }
    if (states.length) {
      await client.query(
        `INSERT INTO channel_state(org_id, container, last_ts, oldest_ts, name, kind, members, updated_at, surface)
             SELECT $1, container, max(ts), (array_agg(ts ORDER BY ts::numeric))[1],
                    (array_agg(name ORDER BY ord DESC) FILTER (WHERE name IS NOT NULL))[1],
                    (array_agg(kind ORDER BY ord DESC) FILTER (WHERE kind IS NOT NULL))[1],
                    COALESCE((array_agg(members ORDER BY ord DESC) FILTER (WHERE members <> '[]'::jsonb))[1], '[]'::jsonb),
                    $3, (array_agg(surface ORDER BY ord))[1]
               FROM jsonb_to_recordset($2::jsonb)
                 AS b(ord int, container text, ts text, name text, kind text, members jsonb, surface text)
              GROUP BY container
             ON CONFLICT (${tenantCols("org_id, container")}) DO UPDATE SET
               last_ts = GREATEST(channel_state.last_ts, EXCLUDED.last_ts),
               oldest_ts = CASE
                 WHEN channel_state.oldest_ts IS NULL OR EXCLUDED.oldest_ts::numeric < channel_state.oldest_ts::numeric
                 THEN EXCLUDED.oldest_ts ELSE channel_state.oldest_ts END,
               name = COALESCE(EXCLUDED.name, channel_state.name),
               kind = COALESCE(EXCLUDED.kind, channel_state.kind),
               members = CASE WHEN EXCLUDED.members = '[]'::jsonb THEN channel_state.members ELSE EXCLUDED.members END,
               updated_at = EXCLUDED.updated_at`,
        [tenant().orgId, JSON.stringify(states.map((state, ord) => ({ ord, ...state }))), now],
      );
    }
  });
  return { upserted };
}

function surfaceMessageReads(q: PgPool["q"], liveFallback: LiveFallback | undefined) {
  return {
    async markHandled(container, ts) {
      await q(
        `INSERT INTO channel_messages(org_id, container, ts, created_at, handled)
         VALUES ($1,$2,$3,$4,TRUE)
         ON CONFLICT (${tenantCols("org_id, container, ts")}) DO UPDATE SET handled = TRUE`,
        [tenant().orgId, container, ts, Date.now()],
      );
    },

    async readMessages(container, opts = {}) {
      const limit = clampLimit(opts.limit, DEFAULT_READ_LIMIT);
      const conds = ["org_id = $1", "container = $2"];
      const args: unknown[] = [tenant().orgId, container];
      if (opts.at) {
        args.push(opts.at);
        conds.push(`ts = $${args.length}`);
      }
      if (opts.timestamps !== undefined) {
        if (opts.timestamps.length > MAX_READ_LIMIT) throw new RangeError("At most 500 message timestamps are allowed");
        if (!opts.timestamps.length) return [];
        args.push(opts.timestamps);
        conds.push(`ts = ANY($${args.length}::text[])`);
      }
      if (opts.channelHistory) conds.push("(sub IS NULL OR broadcast = TRUE)");
      if (opts.sub === null) conds.push("sub IS NULL");
      else if (opts.sub !== undefined) {
        args.push(opts.sub);
        conds.push(`sub = $${args.length}`);
      }
      if (opts.after) {
        args.push(opts.after);
        conds.push(`ts > $${args.length}`);
      }
      if (opts.before) {
        args.push(opts.before);
        conds.push(`ts < $${args.length}`);
      }
      if (!opts.includeDeleted) conds.push("deleted = FALSE");
      args.push(limit);
      const rows = await q(
        `SELECT channel_messages.*, (SELECT COUNT(*) FROM channel_messages replies WHERE replies.org_id = channel_messages.org_id AND replies.container = channel_messages.container AND replies.sub = channel_messages.ts AND replies.ts <> channel_messages.ts AND replies.deleted = FALSE) AS reply_count, (SELECT json_agg(json_build_object('fileId', f.file_id, 'name', f.name, 'mimetype', f.mimetype, 'title', f.title, 'size', f.size)) FROM channel_files f WHERE f.org_id = channel_messages.org_id AND f.container = channel_messages.container AND f.ts = channel_messages.ts) AS files FROM channel_messages WHERE ${conds.join(" AND ")} ORDER BY ts ${opts.oldestFirst ? "ASC" : "DESC"} LIMIT $${args.length}`,
        args,
      );
      const hit = rows.map(rowToMessage);
      if (!opts.oldestFirst) hit.reverse();
      if (hit.length === 0 && liveFallback && !opts.noFallback && !opts.before) {
        const live = await liveFallback(container, opts);
        if (live) return live;
      }
      return hit;
    },

    async revisedSince(container, since, opts = {}) {
      const conds = [
        "org_id = $1",
        "container = $2",
        "((edited_at > 0 AND edited_at >= $3) OR (deleted_at > 0 AND deleted_at >= $3))",
      ];
      const args: unknown[] = [tenant().orgId, container, since];
      if (opts.thread) {
        args.push(opts.thread);
        conds.push(`(sub = $${args.length} OR ts = $${args.length})`);
      }
      if (opts.ts) {
        args.push(opts.ts);
        conds.push(`ts = ANY($${args.length}::text[])`);
      }
      const rows = await q(
        `SELECT * FROM channel_messages WHERE ${conds.join(" AND ")}
          ORDER BY GREATEST(COALESCE(edited_at, 0), COALESCE(deleted_at, 0)) DESC, ts DESC`,
        args,
      );
      return rows.map(rowToMessage);
    },

    async search(queryText, opts = {}) {
      const term = queryText.trim();
      if (!term) return [];
      const limit = clampLimit(opts.limit, DEFAULT_SEARCH_LIMIT);
      const conds = ["org_id = $1", "deleted = FALSE", "tsv @@ plainto_tsquery('english', $2)", "surface = $3"];
      const args: unknown[] = [tenant().orgId, term, opts.surface ?? SLACK];
      if (opts.container) {
        args.push(opts.container);
        conds.push(`container = $${args.length}`);
      }
      args.push(limit);
      const rows = await q(
        `SELECT * FROM channel_messages WHERE ${conds.join(" AND ")}
         ORDER BY ts_rank(tsv, plainto_tsquery('english', $2)) DESC, ts DESC LIMIT $${args.length}`,
        args,
      );
      return rows.map(rowToMessage);
    },
  } satisfies Partial<SurfaceCache>;
}

function surfaceContainerReads(q: PgPool["q"]) {
  return {
    async members(container) {
      const rows = await q("SELECT members FROM channel_state WHERE org_id = $1 AND container = $2", [
        tenant().orgId,
        container,
      ]);
      const raw = rows[0]?.members;
      if (Array.isArray(raw)) return raw as string[];
      if (typeof raw === "string") return JSON.parse(raw) as string[];
      return [];
    },

    async isMember(container, principalId) {
      const rows = await q("SELECT 1 FROM channel_state WHERE org_id = $1 AND container = $2 AND members ? $3", [
        tenant().orgId,
        container,
        principalId,
      ]);
      return rows.length > 0;
    },

    async containerState(container) {
      const rows = await q("SELECT * FROM channel_state WHERE org_id = $1 AND container = $2", [
        tenant().orgId,
        container,
      ]);
      const r = rows[0];
      if (!r) return null;
      return {
        container: r.container as string,
        ...(r.last_ts != null ? { lastTs: r.last_ts as string } : {}),
        ...(r.oldest_ts != null ? { oldestTs: r.oldest_ts as string } : {}),
        ...(r.name != null ? { name: r.name as string } : {}),
        ...(r.kind != null ? { kind: r.kind as ContainerState["kind"] } : {}),
        updatedAt: Number(r.updated_at),
      };
    },

    async listContainers(opts = {}) {
      const limit = opts.limit === undefined ? null : Math.max(1, Math.floor(opts.limit));
      const rows = await q(
        `SELECT s.*,
                (SELECT COUNT(*)::int FROM channel_messages m
                  WHERE m.org_id = $1 AND m.container = s.container AND m.deleted = FALSE) AS message_count
           FROM (SELECT * FROM channel_state WHERE org_id = $1 AND surface = $3 ORDER BY updated_at DESC LIMIT $2) s
          ORDER BY s.updated_at DESC`,
        [tenant().orgId, limit, opts.surface ?? SLACK],
      );
      return rows.map((r) => {
        let members: string[] = [];
        if (Array.isArray(r.members)) members = r.members as string[];
        else if (typeof r.members === "string") members = JSON.parse(r.members) as string[];
        return {
          container: r.container as string,
          ...(r.last_ts != null ? { lastTs: r.last_ts as string } : {}),
          ...(r.oldest_ts != null ? { oldestTs: r.oldest_ts as string } : {}),
          ...(r.name != null ? { name: r.name as string } : {}),
          ...(r.kind != null ? { kind: r.kind as ContainerState["kind"] } : {}),
          members,
          messageCount: Number(r.message_count),
          updatedAt: Number(r.updated_at),
        };
      });
    },
  } satisfies Partial<SurfaceCache>;
}

export function createPostgresSurfaceCache(
  connectionString: string,
  opts: { liveFallback?: LiveFallback } = {},
): SurfaceCache {
  const { q, pool, close } = createPgPool(connectionString, [
    {
      id: "surface-cache/store/0007",
      acceptedChecksums: ["d56a4323978d8233aab8258422908b794bf960dc2059e252b3850e6da3902a36"],
      statements: [
        `SET LOCAL lock_timeout = '3s'`,
        `ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'slack'`,
        `ALTER TABLE channel_state ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'slack'`,
      ],
    },
  ]);

  return {
    ingest: (events) => ingestEvents(pool, events),
    ...surfaceMessageReads(q, opts.liveFallback),
    ...surfaceContainerReads(q),
    close,
  };
}
