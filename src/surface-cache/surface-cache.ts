import { orgId as configOrgId } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import type {
  ActiveThread,
  CachedFile,
  CachedMessage,
  ContainerState,
  ContainerSummary,
  LiveFallback,
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

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(MAX_READ_LIMIT, Math.floor(limit ?? fallback)));
}

const REFRESH_ACTIVE_THREADS = "REFRESH MATERIALIZED VIEW surface_active_threads";

export function createPostgresSurfaceCache(
  connectionString: string,
  opts: { liveFallback?: LiveFallback } = {},
): SurfaceCache {
  const orgId = configOrgId();
  const { q, query, pool, close } = createPgPool(connectionString, [
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
  ]);

  const liveFallback = opts.liveFallback;

  function rowToMessage(r: Record<string, unknown>): CachedMessage {
    return {
      container: r.container as string,
      ts: r.ts as string,
      ...(r.sub != null ? { sub: r.sub as string } : {}),
      ...(r.author_id != null ? { authorId: r.author_id as string } : {}),
      ...(r.author_name != null ? { authorName: r.author_name as string } : {}),
      text: (r.text as string) ?? "",
      ...(r.mentions != null ? { mentions: r.mentions as Record<string, string> } : {}),
      ...(r.self ? { self: true } : {}),
      ...(r.bot ? { bot: true } : {}),
      ...(r.mentions_self ? { mentionsSelf: true } : {}),
      ...(r.edited_at != null ? { editedAt: Number(r.edited_at) } : {}),
      ...(r.deleted ? { deleted: true } : {}),
      ...(r.handled ? { handled: true } : {}),
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
        for (const e of events) {
          if (!e.container || !e.ts) continue;
          const res = await client.query(
            `INSERT INTO channel_messages(org_id, container, ts, sub, author_id, author_name, text, mentions, self, bot, mentions_self, edited_at, deleted, handled, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (org_id, container, ts) DO UPDATE SET
               sub = COALESCE(EXCLUDED.sub, channel_messages.sub),
               author_id = COALESCE(EXCLUDED.author_id, channel_messages.author_id),
               author_name = COALESCE(EXCLUDED.author_name, channel_messages.author_name),
               text = CASE WHEN EXCLUDED.deleted THEN channel_messages.text ELSE EXCLUDED.text END,
               mentions = CASE WHEN EXCLUDED.deleted THEN channel_messages.mentions ELSE COALESCE(EXCLUDED.mentions, channel_messages.mentions) END,
               self = channel_messages.self OR EXCLUDED.self,
               bot = channel_messages.bot OR EXCLUDED.bot,
               mentions_self = channel_messages.mentions_self OR EXCLUDED.mentions_self,
               edited_at = GREATEST(COALESCE(EXCLUDED.edited_at, 0), COALESCE(channel_messages.edited_at, 0)),
               deleted = channel_messages.deleted OR EXCLUDED.deleted,
               handled = channel_messages.handled OR EXCLUDED.handled
             WHERE EXCLUDED.deleted
                OR COALESCE(EXCLUDED.edited_at, 0) >= COALESCE(channel_messages.edited_at, 0)
                OR EXCLUDED.handled`,
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
            ],
          );
          upserted += res.rowCount ?? 0;
          for (const f of e.files ?? []) {
            if (!f.fileId) continue;
            await client.query(
              `INSERT INTO channel_files(org_id, container, ts, file_id, name, mimetype, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (org_id, container, ts, file_id) DO UPDATE SET name = EXCLUDED.name, mimetype = EXCLUDED.mimetype`,
              [orgId, e.container, e.ts, f.fileId, f.name ?? null, f.mimetype ?? null, e.createdAt ?? now],
            );
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
      await query(REFRESH_ACTIVE_THREADS).catch(() => undefined);
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
      if (opts.sub) {
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
        `SELECT * FROM channel_messages WHERE ${conds.join(" AND ")} ORDER BY ts DESC LIMIT $${args.length}`,
        args,
      );
      const hit = rows.map(rowToMessage).reverse();
      if (hit.length === 0 && liveFallback && !opts.noFallback && !opts.before) {
        const live = await liveFallback(container, opts);
        if (live) return live;
      }
      return hit;
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
      const conds = ["org_id = $1"];
      const args: unknown[] = [orgId];
      if (o.container) {
        args.push(o.container);
        conds.push(`container = $${args.length}`);
      }
      args.push(limit);
      const rows = await q(
        `SELECT * FROM surface_active_threads WHERE ${conds.join(" AND ")} ORDER BY last_activity_at DESC LIMIT $${args.length}`,
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
      for (const e of events) {
        if (!e.container || !e.ts) continue;
        const m = containerMsgs(e.container);
        const existing = m.get(e.ts);
        const deleted = (existing?.deleted ?? false) || (e.deleted ?? false);
        if (!existing || e.deleted || (e.editedAt ?? 0) >= (existing.editedAt ?? 0)) {
          m.set(e.ts, {
            container: e.container,
            ts: e.ts,
            ...((e.sub ?? existing?.sub) ? { sub: (e.sub ?? existing?.sub) as string } : {}),
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
            ...(deleted ? { deleted: true } : {}),
            ...((e.handled ?? false) || existing?.handled ? { handled: true } : {}),
            createdAt: existing?.createdAt ?? e.createdAt ?? now,
          });
          upserted++;
        }
        if (e.files?.length) {
          const k = key(e.container);
          const arr = files.get(k) ?? [];
          for (const f of e.files) {
            if (!f.fileId) continue;
            if (!arr.some((x) => x.ts === e.ts && x.fileId === f.fileId)) {
              arr.push({
                container: e.container,
                ts: e.ts,
                fileId: f.fileId,
                ...(f.name ? { name: f.name } : {}),
                ...(f.mimetype ? { mimetype: f.mimetype } : {}),
                createdAt: e.createdAt ?? now,
              });
            }
          }
          files.set(k, arr);
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
      if (o.sub) all = all.filter((x) => x.sub === o.sub);
      if (o.after) all = all.filter((x) => x.ts > o.after!);
      if (o.before) all = all.filter((x) => x.ts < o.before!);
      if (!o.includeDeleted) all = all.filter((x) => !x.deleted);
      all.sort((a, b) => {
        if (a.ts < b.ts) return -1;
        if (a.ts > b.ts) return 1;
        return 0;
      });
      const hit = all.slice(-limit);
      if (hit.length === 0 && liveFallback && !o.noFallback && !o.before) {
        const live = await liveFallback(container, o);
        if (live) return live;
      }
      return hit;
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
