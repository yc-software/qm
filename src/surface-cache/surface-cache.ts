import { orgId as configOrgId } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import type {
  ActiveThread,
  CachedFile,
  CachedMessage,
  ContainerState,
  ContainerSummary,
  LiveFallback,
  IngestEvent,
  SurfaceCache,
} from "./types.ts";

export type {
  ActiveThread,
  CachedMessage,
  ContainerSummary,
  IngestEvent,
  LiveFallback,
  ReadMessagesOpts,
  SearchOpts,
  SurfaceCache,
} from "./types.ts";

const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_THREADS_LIMIT = 50;

function normalizeEvent(event: IngestEvent): IngestEvent {
  return JSON.parse(
    JSON.stringify(event, (_key, value) => (typeof value === "string" ? value.replace(/\u0000/g, "") : value)),
  ) as IngestEvent;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(MAX_READ_LIMIT, Math.floor(limit ?? fallback)));
}

const REVISION_SCAN_LIMIT = 500;

function revisedAt(m: { editedAt?: number; deletedAt?: number }): number {
  return Math.max(m.editedAt ?? 0, m.deletedAt ?? 0);
}

function compareTs(a: { ts: string }, b: { ts: string }): number {
  if (a.ts < b.ts) return -1;
  if (a.ts > b.ts) return 1;
  return 0;
}

export function createPostgresSurfaceCache(
  connectionString: string,
  opts: { liveFallback?: LiveFallback } = {},
): SurfaceCache {
  const orgId = configOrgId();
  const { q, pool, close } = createPgPool(connectionString, [
    {
      id: "surface-cache/store/0001",
      statements: [
        `CREATE TABLE IF NOT EXISTS channel_messages(
        org_id TEXT NOT NULL, container TEXT NOT NULL, ts TEXT NOT NULL,
        sub TEXT, author_id TEXT, author_name TEXT, text TEXT NOT NULL DEFAULT '', mentions JSONB,
        self BOOLEAN NOT NULL DEFAULT FALSE, bot BOOLEAN NOT NULL DEFAULT FALSE,
        mentions_self BOOLEAN NOT NULL DEFAULT FALSE,
        edited_at BIGINT, deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_at BIGINT NOT NULL,
        PRIMARY KEY(org_id, container, ts)
      )`,
        `ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS mentions JSONB`,
        `ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS bot BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS mentions_self BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS handled BOOLEAN NOT NULL DEFAULT FALSE`,
        `CREATE INDEX IF NOT EXISTS channel_messages_by_container
        ON channel_messages(org_id, container, ts)`,
        `CREATE INDEX IF NOT EXISTS channel_messages_live_by_container
        ON channel_messages(org_id, container) WHERE deleted = FALSE`,
        `CREATE INDEX IF NOT EXISTS channel_messages_by_sub
        ON channel_messages(org_id, container, sub, ts)`,
        `ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED`,
        `CREATE INDEX IF NOT EXISTS channel_messages_tsv ON channel_messages USING GIN(tsv)`,
        `CREATE TABLE IF NOT EXISTS channel_state(
        org_id TEXT NOT NULL, container TEXT NOT NULL,
        last_ts TEXT, oldest_ts TEXT, name TEXT, kind TEXT, members JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(org_id, container)
      )`,
        `ALTER TABLE channel_state ADD COLUMN IF NOT EXISTS oldest_ts TEXT`,
        `ALTER TABLE channel_state ADD COLUMN IF NOT EXISTS kind TEXT`,
        `CREATE TABLE IF NOT EXISTS channel_files(
        org_id TEXT NOT NULL, container TEXT NOT NULL, ts TEXT NOT NULL, file_id TEXT NOT NULL,
        name TEXT, mimetype TEXT, created_at BIGINT NOT NULL,
        PRIMARY KEY(org_id, container, ts, file_id)
      )`,
        `CREATE MATERIALIZED VIEW IF NOT EXISTS surface_active_threads AS
        SELECT org_id, container, sub,
               MAX(ts) AS last_ts, COUNT(*) AS message_count, MAX(created_at) AS last_activity_at
          FROM channel_messages
         WHERE sub IS NOT NULL AND deleted = FALSE
         GROUP BY org_id, container, sub`,
      ],
    },
    {
      id: "surface-cache/store/0002",
      statements: [`DROP MATERIALIZED VIEW IF EXISTS surface_active_threads`],
    },
    {
      id: "surface-cache/store/0003",
      statements: [
        `ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS deleted_at BIGINT`,
        `CREATE INDEX IF NOT EXISTS channel_messages_edited_by_container
            ON channel_messages(org_id, container, edited_at) WHERE edited_at > 0`,
        `CREATE INDEX IF NOT EXISTS channel_messages_deleted_by_container
            ON channel_messages(org_id, container, deleted_at) WHERE deleted_at > 0`,
      ],
    },
    {
      id: "surface-cache/store/0004",
      statements: [`ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS broadcast BOOLEAN NOT NULL DEFAULT FALSE`],
    },
    {
      id: "surface-cache/store/0005",
      statements: [`ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS subtype TEXT`],
    },
    {
      id: "surface-cache/store/0006",
      statements: [
        `ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS bot_id TEXT`,
        `ALTER TABLE channel_files ADD COLUMN IF NOT EXISTS title TEXT`,
        `ALTER TABLE channel_files ADD COLUMN IF NOT EXISTS size BIGINT`,
      ],
    },
  ]);

  const liveFallback = opts.liveFallback;

  function rowToMessage(r: Record<string, unknown>): CachedMessage {
    return {
      container: r.container as string,
      ts: r.ts as string,
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

  return {
    async ingest(events) {
      if (!events.length) return { upserted: 0 };
      const now = Date.now();
      const client = await (await pool()).connect();
      let upserted = 0;
      try {
        await client.query("BEGIN");
        for (const event of events) {
          const e = normalizeEvent(event);
          if (!e.container || !e.ts) continue;
          const res = await client.query(
            `INSERT INTO channel_messages(org_id, container, ts, sub, author_id, author_name, text, mentions, self, bot, mentions_self, edited_at, deleted, handled, created_at, deleted_at, broadcast, subtype, bot_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($18::boolean, FALSE),$19,$20)
             ON CONFLICT (org_id, container, ts) DO UPDATE SET
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
              orgId,
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
            ],
          );
          upserted += res.rowCount ?? 0;
          if (res.rows[0]?.content_accepted && e.files !== undefined) {
            await client.query("DELETE FROM channel_files WHERE org_id = $1 AND container = $2 AND ts = $3", [
              orgId,
              e.container,
              e.ts,
            ]);
            for (const f of e.files) {
              if (!f.fileId) continue;
              await client.query(
                `INSERT INTO channel_files(org_id, container, ts, file_id, name, mimetype, created_at, title, size)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (org_id, container, ts, file_id) DO UPDATE SET name = EXCLUDED.name, mimetype = EXCLUDED.mimetype, title = EXCLUDED.title, size = EXCLUDED.size`,
                [
                  orgId,
                  e.container,
                  e.ts,
                  f.fileId,
                  f.name ?? null,
                  f.mimetype ?? null,
                  e.createdAt ?? now,
                  f.title ?? null,
                  f.size ?? null,
                ],
              );
            }
          }
          await client.query(
            `INSERT INTO channel_state(org_id, container, last_ts, oldest_ts, name, kind, members, updated_at)
             VALUES ($1,$2,$3,$3,$4,$5,$6::jsonb,$7)
             ON CONFLICT (org_id, container) DO UPDATE SET
               last_ts = GREATEST(channel_state.last_ts, EXCLUDED.last_ts),
               oldest_ts = CASE
                 WHEN channel_state.oldest_ts IS NULL OR EXCLUDED.oldest_ts::numeric < channel_state.oldest_ts::numeric
                 THEN EXCLUDED.oldest_ts ELSE channel_state.oldest_ts END,
               name = COALESCE(EXCLUDED.name, channel_state.name),
               kind = COALESCE(EXCLUDED.kind, channel_state.kind),
               members = CASE WHEN EXCLUDED.members = '[]'::jsonb THEN channel_state.members ELSE EXCLUDED.members END,
               updated_at = EXCLUDED.updated_at`,
            [orgId, e.container, e.ts, e.containerName ?? null, e.kind ?? null, JSON.stringify(e.members ?? []), now],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      return { upserted };
    },

    async markHandled(container, ts) {
      await q(
        `INSERT INTO channel_messages(org_id, container, ts, created_at, handled)
         VALUES ($1,$2,$3,$4,TRUE)
         ON CONFLICT (org_id, container, ts) DO UPDATE SET handled = TRUE`,
        [orgId, container, ts, Date.now()],
      );
    },

    async readMessages(container, opts = {}) {
      const limit = clampLimit(opts.limit, DEFAULT_READ_LIMIT);
      const conds = ["org_id = $1", "container = $2"];
      const args: unknown[] = [orgId, container];
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
        "self = FALSE",
        "((edited_at > 0 AND edited_at >= $3) OR (deleted_at > 0 AND deleted_at >= $3))",
      ];
      const args: unknown[] = [orgId, container, since];
      if (opts.thread) {
        args.push(opts.thread);
        conds.push(`(sub = $${args.length} OR ts = $${args.length})`);
      }
      args.push(REVISION_SCAN_LIMIT);
      const rows = await q(
        `SELECT * FROM channel_messages WHERE ${conds.join(" AND ")}
          ORDER BY GREATEST(COALESCE(edited_at, 0), COALESCE(deleted_at, 0)) DESC, ts DESC LIMIT $${args.length}`,
        args,
      );
      return rows.map(rowToMessage);
    },

    async search(queryText, opts = {}) {
      const term = queryText.trim();
      if (!term) return [];
      const limit = clampLimit(opts.limit, DEFAULT_SEARCH_LIMIT);
      const conds = ["org_id = $1", "deleted = FALSE", "tsv @@ plainto_tsquery('english', $2)"];
      const args: unknown[] = [orgId, term];
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

    async activeThreads(o = {}) {
      const limit = clampLimit(o.limit, DEFAULT_THREADS_LIMIT);
      const conds = ["org_id = $1", "sub IS NOT NULL", "deleted = FALSE"];
      const args: unknown[] = [orgId];
      if (o.container) {
        args.push(o.container);
        conds.push(`container = $${args.length}`);
      }
      args.push(limit);
      const rows = await q(
        `SELECT container, sub, MAX(ts) AS last_ts, COUNT(*) AS message_count, MAX(created_at) AS last_activity_at
           FROM channel_messages WHERE ${conds.join(" AND ")}
          GROUP BY container, sub
          ORDER BY last_activity_at DESC LIMIT $${args.length}`,
        args,
      );
      return rows.map((r) => ({
        container: r.container as string,
        sub: r.sub as string,
        lastTs: r.last_ts as string,
        messageCount: Number(r.message_count),
        lastActivityAt: Number(r.last_activity_at),
      }));
    },

    async members(container) {
      const rows = await q("SELECT members FROM channel_state WHERE org_id = $1 AND container = $2", [
        orgId,
        container,
      ]);
      const raw = rows[0]?.members;
      if (Array.isArray(raw)) return raw as string[];
      if (typeof raw === "string") return JSON.parse(raw) as string[];
      return [];
    },

    async isMember(container, principalId) {
      const rows = await q("SELECT 1 FROM channel_state WHERE org_id = $1 AND container = $2 AND members ? $3", [
        orgId,
        container,
        principalId,
      ]);
      return rows.length > 0;
    },

    async containerState(container) {
      const rows = await q("SELECT * FROM channel_state WHERE org_id = $1 AND container = $2", [orgId, container]);
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
      const limit = clampLimit(opts.limit, MAX_READ_LIMIT);
      const rows = await q(
        `SELECT s.*, COALESCE(m.n, 0) AS message_count
           FROM channel_state s
           LEFT JOIN (SELECT container, COUNT(*)::int AS n FROM channel_messages WHERE org_id = $1 AND deleted = FALSE GROUP BY container) m
             ON m.container = s.container
          WHERE s.org_id = $1
          ORDER BY s.updated_at DESC
          LIMIT $2`,
        [orgId, limit],
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

    close,
  };
}

export function createMemorySurfaceCache(opts: { liveFallback?: LiveFallback } = {}): SurfaceCache {
  const key = (container: string): string => container;
  const messages = new Map<string, Map<string, CachedMessage>>();
  const files = new Map<string, CachedFile[]>();
  const state = new Map<string, ContainerState & { members: string[] }>();
  const liveFallback = opts.liveFallback;

  const containerMsgs = (container: string): Map<string, CachedMessage> => {
    const k = key(container);
    let m = messages.get(k);
    if (!m) messages.set(k, (m = new Map()));
    return m;
  };

  return {
    async ingest(events) {
      const now = Date.now();
      let upserted = 0;
      for (const event of events) {
        const e = normalizeEvent(event);
        if (!e.container || !e.ts) continue;
        const m = containerMsgs(e.container);
        const existing = m.get(e.ts);
        const deleted = (existing?.deleted ?? false) || (e.deleted ?? false);
        const accepted = !existing?.deleted && !e.deleted && (e.editedAt ?? 0) >= (existing?.editedAt ?? 0);
        if (accepted || !existing) {
          m.set(e.ts, {
            container: e.container,
            ts: e.ts,
            ...((e.sub === undefined ? existing?.sub : e.sub)
              ? { sub: (e.sub === undefined ? existing?.sub : e.sub) as string }
              : {}),
            ...((e.subtype ?? existing?.subtype) !== undefined ? { subtype: e.subtype ?? existing?.subtype } : {}),
            ...((e.broadcast ?? existing?.broadcast) ? { broadcast: true } : {}),
            ...((e.botId ?? existing?.botId) ? { botId: e.botId ?? existing?.botId } : {}),
            ...((e.authorId ?? existing?.authorId) ? { authorId: (e.authorId ?? existing?.authorId) as string } : {}),
            ...((e.authorName ?? existing?.authorName)
              ? { authorName: (e.authorName ?? existing?.authorName) as string }
              : {}),
            text: e.deleted ? (existing?.text ?? "") : (e.text ?? ""),
            ...(() => {
              const mentions = e.deleted ? existing?.mentions : (e.mentions ?? existing?.mentions);
              return mentions ? { mentions } : {};
            })(),
            ...((e.self ?? false) || existing?.self ? { self: true } : {}),
            ...((e.bot ?? false) || existing?.bot ? { bot: true } : {}),
            ...((e.mentionsSelf ?? false) || existing?.mentionsSelf ? { mentionsSelf: true } : {}),
            ...(Math.max(e.editedAt ?? 0, existing?.editedAt ?? 0) > 0
              ? { editedAt: Math.max(e.editedAt ?? 0, existing?.editedAt ?? 0) }
              : {}),
            ...(deleted ? { deleted: true, deletedAt: existing?.deletedAt ?? now } : {}),
            ...((e.handled ?? false) || existing?.handled ? { handled: true } : {}),
            createdAt: existing?.createdAt ?? e.createdAt ?? now,
          });
          upserted++;
        }
        if (existing && e.deleted)
          m.set(e.ts, { ...m.get(e.ts)!, deleted: true, deletedAt: existing.deletedAt ?? now });
        if (existing && e.handled && !existing.handled) m.set(e.ts, { ...m.get(e.ts)!, handled: true });
        if (accepted && e.files !== undefined) {
          const k = key(e.container);
          const attached = new Map(
            e.files
              .filter((f) => f.fileId)
              .map((f) => [
                f.fileId,
                {
                  container: e.container,
                  ts: e.ts,
                  ...f,
                  createdAt: e.createdAt ?? now,
                },
              ]),
          );
          files.set(k, [...(files.get(k) ?? []).filter((f) => f.ts !== e.ts), ...attached.values()]);
        }
        const k = key(e.container);
        const st = state.get(k) ?? { container: e.container, members: [], updatedAt: now };
        if (!st.lastTs || e.ts > st.lastTs) st.lastTs = e.ts;
        if (!st.oldestTs || Number(e.ts) < Number(st.oldestTs)) st.oldestTs = e.ts;
        if (e.containerName) st.name = e.containerName;
        if (e.kind) st.kind = e.kind;
        if (e.members && e.members.length) st.members = [...new Set(e.members)];
        st.updatedAt = now;
        state.set(k, st);
      }
      return { upserted };
    },

    async markHandled(container, ts) {
      const m = containerMsgs(container);
      const existing = m.get(ts);
      if (existing) m.set(ts, { ...existing, handled: true });
      else m.set(ts, { container, ts, text: "", handled: true, createdAt: Date.now() });
    },

    async readMessages(container, o = {}) {
      const limit = clampLimit(o.limit, DEFAULT_READ_LIMIT);
      let all = [...containerMsgs(container).values()];
      if (o.at) all = all.filter((x) => x.ts === o.at);
      if (o.timestamps !== undefined) {
        if (o.timestamps.length > MAX_READ_LIMIT) throw new RangeError("At most 500 message timestamps are allowed");
        if (!o.timestamps.length) return [];
        const selected = new Set(o.timestamps);
        all = all.filter((x) => selected.has(x.ts));
      }
      if (o.channelHistory) all = all.filter((x) => x.sub === undefined || x.broadcast);
      if (o.sub === null) all = all.filter((x) => x.sub === undefined);
      else if (o.sub !== undefined) all = all.filter((x) => x.sub === o.sub);
      if (o.after) all = all.filter((x) => x.ts > o.after!);
      if (o.before) all = all.filter((x) => x.ts < o.before!);
      if (!o.includeDeleted) all = all.filter((x) => !x.deleted);
      all.sort(compareTs);
      const hit = (o.oldestFirst ? all.slice(0, limit) : all.slice(-limit)).map((m) => {
        const attached = (files.get(key(container)) ?? []).filter((f) => f.ts === m.ts);
        return {
          ...m,
          replyCount: [...containerMsgs(container).values()].filter(
            (reply) => reply.sub === m.ts && reply.ts !== m.ts && !reply.deleted,
          ).length,
          ...(attached.length
            ? {
                files: attached.map(({ fileId, name, title, size, mimetype }) => ({
                  fileId,
                  name,
                  ...(title !== undefined ? { title } : {}),
                  ...(size !== undefined ? { size } : {}),
                  mimetype,
                })),
              }
            : {}),
        };
      });
      if (hit.length === 0 && liveFallback && !o.noFallback && !o.before) {
        const live = await liveFallback(container, o);
        if (live) return live;
      }
      return hit;
    },

    async revisedSince(container, since, o = {}) {
      return [...containerMsgs(container).values()]
        .filter((m) => !m.self && revisedAt(m) > 0 && revisedAt(m) >= since)
        .filter((m) => !o.thread || m.sub === o.thread || m.ts === o.thread)
        .sort((a, b) => revisedAt(b) - revisedAt(a) || compareTs(b, a))
        .slice(0, REVISION_SCAN_LIMIT);
    },

    async search(queryText, o = {}) {
      const term = queryText.trim().toLowerCase();
      if (!term) return [];
      const limit = clampLimit(o.limit, DEFAULT_SEARCH_LIMIT);
      const out: CachedMessage[] = [];
      for (const m of messages.values()) {
        for (const msg of m.values()) {
          if (msg.deleted) continue;
          if (o.container && msg.container !== o.container) continue;
          if ((msg.text ?? "").toLowerCase().includes(term)) out.push(msg);
        }
      }
      out.sort((a, b) => {
        if (a.ts < b.ts) return 1;
        if (a.ts > b.ts) return -1;
        return 0;
      });
      return out.slice(0, limit);
    },

    async activeThreads(o = {}) {
      const limit = clampLimit(o.limit, DEFAULT_THREADS_LIMIT);
      const byThread = new Map<string, ActiveThread>();
      for (const m of messages.values()) {
        for (const msg of m.values()) {
          if (!msg.sub || msg.deleted) continue;
          if (o.container && msg.container !== o.container) continue;
          const tk = `${msg.container}\0${msg.sub}`;
          const cur = byThread.get(tk);
          if (!cur) {
            byThread.set(tk, {
              container: msg.container,
              sub: msg.sub,
              lastTs: msg.ts,
              messageCount: 1,
              lastActivityAt: msg.createdAt,
            });
          } else {
            cur.messageCount++;
            if (msg.ts > cur.lastTs) cur.lastTs = msg.ts;
            if (msg.createdAt > cur.lastActivityAt) cur.lastActivityAt = msg.createdAt;
          }
        }
      }
      return [...byThread.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, limit);
    },

    async members(container) {
      return state.get(key(container))?.members ?? [];
    },

    async isMember(container, principalId) {
      return (state.get(key(container))?.members ?? []).includes(principalId);
    },

    async containerState(container) {
      const st = state.get(key(container));
      if (!st) return null;
      return {
        container: st.container,
        ...(st.lastTs ? { lastTs: st.lastTs } : {}),
        ...(st.oldestTs ? { oldestTs: st.oldestTs } : {}),
        ...(st.name ? { name: st.name } : {}),
        ...(st.kind ? { kind: st.kind } : {}),
        updatedAt: st.updatedAt,
      };
    },

    async listContainers(o = {}) {
      const limit = clampLimit(o.limit, MAX_READ_LIMIT);
      const out: ContainerSummary[] = [];
      for (const [k, st] of state) {
        out.push({
          container: st.container,
          ...(st.lastTs ? { lastTs: st.lastTs } : {}),
          ...(st.oldestTs ? { oldestTs: st.oldestTs } : {}),
          ...(st.name ? { name: st.name } : {}),
          ...(st.kind ? { kind: st.kind } : {}),
          members: st.members,
          messageCount: [...(messages.get(k)?.values() ?? [])].filter((m) => !m.deleted).length,
          updatedAt: st.updatedAt,
        });
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    },

    async close() {},
  };
}
