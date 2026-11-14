import { orgId as configOrgId } from "../config.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { jsonbStringify } from "../util/text.ts";
import type {
  CachedMessage,
  ContainerState,
  LiveFallback,
  IngestEvent,
  SurfaceCache,
  SurfaceKey,
  SurfaceSource,
} from "./types.ts";
import { tenantTables } from "../tenants/migrations.ts";

export type {
  ActiveThread,
  CachedMessage,
  ContainerSummary,
  IngestEvent,
  LiveFallback,
  ReadMessagesOpts,
  SearchOpts,
  SurfaceCache,
  SurfaceSource,
} from "./types.ts";

const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_THREADS_LIMIT = 50;

function normalizeEvent(event: IngestEvent): IngestEvent {
  return JSON.parse(jsonbStringify(event)) as IngestEvent;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(MAX_READ_LIMIT, Math.floor(limit ?? fallback)));
}

const REVISION_SCAN_LIMIT = 500;

const DEFAULT_SURFACE = "slack";

function keyOf(key: SurfaceKey | undefined): [string, string] {
  return [key?.surface ?? DEFAULT_SURFACE, key?.account ?? ""];
}

const MESSAGE_COLUMNS =
  "container, ts, sub, subtype, broadcast, bot_id, author_id, author_name, text, mentions, self, bot, mentions_self, edited_at, deleted, deleted_at, handled, created_at, surface, account";

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
    {
      id: "surface-cache/store/0007",
      statements: [`ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS raw JSONB`],
    },
    {
      id: "surface-cache/store/0008",
      statements: [
        `SET LOCAL lock_timeout = '3s'`,
        `ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'slack'`,
        `ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS account TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE channel_state ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'slack'`,
        `ALTER TABLE channel_state ADD COLUMN IF NOT EXISTS account TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE channel_files ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'slack'`,
        `ALTER TABLE channel_files ADD COLUMN IF NOT EXISTS account TEXT NOT NULL DEFAULT ''`,
      ],
    },
    {
      id: "surface-cache/store/0009",
      statements: [
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS channel_messages_surface_key
            ON channel_messages(org_id, surface, account, container, ts)`,
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS channel_state_surface_key
            ON channel_state(org_id, surface, account, container)`,
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS channel_files_surface_key
            ON channel_files(org_id, surface, account, container, ts, file_id)`,
      ],
    },
    ...tenantTables("surface-cache/store/0010-tenants", [
      {
        table: "channel_messages",
        primaryKey: "org_id, container, ts",
        unique: [{ name: "channel_messages_surface_key", columns: "org_id, surface, account, container, ts" }],
      },
      {
        table: "channel_state",
        primaryKey: "org_id, container",
        unique: [{ name: "channel_state_surface_key", columns: "org_id, surface, account, container" }],
      },
      {
        table: "channel_files",
        primaryKey: "org_id, container, ts, file_id",
        unique: [{ name: "channel_files_surface_key", columns: "org_id, surface, account, container, ts, file_id" }],
      },
    ]),
    {
      id: "surface-cache/store/0011-source",
      statements: [`ALTER TABLE channel_state ADD COLUMN IF NOT EXISTS source JSONB`],
    },
    {
      id: "surface-cache/store/0012-surface-primary-keys",
      statements: [
        `SET LOCAL lock_timeout = '5s'`,
        ...["channel_messages", "channel_state", "channel_files"].map(
          (table) =>
            `ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey,
               ADD CONSTRAINT ${table}_pkey PRIMARY KEY USING INDEX ${table}_surface_key`,
        ),
      ],
    },
  ]);

  const liveFallback = opts.liveFallback;

  function rowToMessage(r: Record<string, unknown>): CachedMessage {
    return {
      ...(r.surface !== DEFAULT_SURFACE ? { surface: r.surface as string } : {}),
      ...(r.account ? { account: r.account as string } : {}),
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
      let upserted = 0;
      await withPgTransaction(await pool(), async (client) => {
        for (const event of events) {
          const e = normalizeEvent(event);
          if (!e.container || !e.ts) continue;
          const [surface, account] = keyOf(e);
          const res = await client.query(
            `INSERT INTO channel_messages(org_id, container, ts, sub, author_id, author_name, text, mentions, self, bot, mentions_self, edited_at, deleted, handled, created_at, deleted_at, broadcast, subtype, bot_id, raw, surface, account)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($18::boolean, FALSE),$19,$20,$21::jsonb,$22,$23)
             ON CONFLICT (tenant_id, org_id, surface, account, container, ts) DO UPDATE SET
               sub = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) OR NOT $17 THEN channel_messages.sub ELSE EXCLUDED.sub END,
               subtype = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.subtype ELSE COALESCE(EXCLUDED.subtype, channel_messages.subtype) END,
               broadcast = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) OR $18::boolean IS NULL THEN channel_messages.broadcast ELSE EXCLUDED.broadcast END,
               bot_id = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.bot_id ELSE COALESCE(EXCLUDED.bot_id, channel_messages.bot_id) END,
               author_id = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.author_id ELSE COALESCE(EXCLUDED.author_id, channel_messages.author_id) END,
               author_name = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.author_name ELSE COALESCE(EXCLUDED.author_name, channel_messages.author_name) END,
               text = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.text ELSE EXCLUDED.text END,
               raw = CASE WHEN EXCLUDED.deleted OR channel_messages.deleted OR COALESCE(EXCLUDED.edited_at, 0) < COALESCE(channel_messages.edited_at, 0) THEN channel_messages.raw ELSE EXCLUDED.raw END,
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
              e.raw ? JSON.stringify(e.raw) : null,
              surface,
              account,
            ],
          );
          upserted += res.rowCount ?? 0;
          if (res.rows[0]?.content_accepted && e.files !== undefined) {
            await client.query(
              "DELETE FROM channel_files WHERE org_id = $1 AND container = $2 AND ts = $3 AND surface = $4 AND account = $5",
              [orgId, e.container, e.ts, surface, account],
            );
            for (const f of e.files) {
              if (!f.fileId) continue;
              await client.query(
                `INSERT INTO channel_files(org_id, container, ts, file_id, name, mimetype, created_at, title, size, surface, account)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT (tenant_id, org_id, surface, account, container, ts, file_id) DO UPDATE SET name = EXCLUDED.name, mimetype = EXCLUDED.mimetype, title = EXCLUDED.title, size = EXCLUDED.size`,
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
                  surface,
                  account,
                ],
              );
            }
          }
          await client.query(
            `INSERT INTO channel_state(org_id, container, last_ts, oldest_ts, name, kind, members, updated_at, surface, account, source)
             VALUES ($1,$2,$3,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb)
             ON CONFLICT (tenant_id, org_id, surface, account, container) DO UPDATE SET
               last_ts = GREATEST(channel_state.last_ts, EXCLUDED.last_ts),
               oldest_ts = CASE
                 WHEN channel_state.oldest_ts IS NULL OR EXCLUDED.oldest_ts::numeric < channel_state.oldest_ts::numeric
                 THEN EXCLUDED.oldest_ts ELSE channel_state.oldest_ts END,
               name = COALESCE(EXCLUDED.name, channel_state.name),
               kind = COALESCE(EXCLUDED.kind, channel_state.kind),
               members = CASE WHEN EXCLUDED.members = '[]'::jsonb THEN channel_state.members ELSE EXCLUDED.members END,
               source = COALESCE(EXCLUDED.source, channel_state.source),
               updated_at = EXCLUDED.updated_at`,
            [
              orgId,
              e.container,
              e.ts,
              e.containerName ?? null,
              e.kind ?? null,
              JSON.stringify(e.members ?? []),
              now,
              surface,
              account,
              e.source ? JSON.stringify(e.source) : null,
            ],
          );
        }
      });
      return { upserted };
    },

    async markHandled(container, ts, key) {
      await q(
        `INSERT INTO channel_messages(org_id, container, ts, created_at, handled, surface, account)
         VALUES ($1,$2,$3,$4,TRUE,$5,$6)
         ON CONFLICT (tenant_id, org_id, surface, account, container, ts) DO UPDATE SET handled = TRUE`,
        [orgId, container, ts, Date.now(), ...keyOf(key)],
      );
    },

    async readMessages(container, opts = {}) {
      const limit = clampLimit(opts.limit, DEFAULT_READ_LIMIT);
      const conds = ["org_id = $1", "container = $2", "surface = $3", "account = $4"];
      const args: unknown[] = [orgId, container, ...keyOf(opts)];
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
      if (opts.tsSuffix !== undefined) {
        if (!opts.tsSuffix) throw new RangeError("tsSuffix must not be empty");
        args.push(opts.tsSuffix);
        conds.push(`right(ts, char_length($${args.length}::text)) = $${args.length}`);
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
      if (opts.self !== undefined) {
        args.push(opts.self);
        conds.push(`self = $${args.length}`);
      }
      args.push(limit);
      const rows = await q(
        `SELECT ${MESSAGE_COLUMNS}, (SELECT COUNT(*) FROM channel_messages replies WHERE replies.org_id = channel_messages.org_id AND replies.surface = channel_messages.surface AND replies.account = channel_messages.account AND replies.container = channel_messages.container AND replies.sub = channel_messages.ts AND replies.ts <> channel_messages.ts AND replies.deleted = FALSE) AS reply_count, (SELECT json_agg(json_build_object('fileId', f.file_id, 'name', f.name, 'mimetype', f.mimetype, 'title', f.title, 'size', f.size)) FROM channel_files f WHERE f.org_id = channel_messages.org_id AND f.surface = channel_messages.surface AND f.account = channel_messages.account AND f.container = channel_messages.container AND f.ts = channel_messages.ts) AS files FROM channel_messages WHERE ${conds.join(" AND ")} ORDER BY ts ${opts.oldestFirst ? "ASC" : "DESC"} LIMIT $${args.length}`,
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
        "surface = $4",
        "account = $5",
      ];
      const args: unknown[] = [orgId, container, since, ...keyOf(opts)];
      if (opts.thread) {
        args.push(opts.thread);
        conds.push(`(sub = $${args.length} OR ts = $${args.length})`);
      }
      args.push(REVISION_SCAN_LIMIT);
      const rows = await q(
        `SELECT ${MESSAGE_COLUMNS} FROM channel_messages WHERE ${conds.join(" AND ")}
          ORDER BY GREATEST(COALESCE(edited_at, 0), COALESCE(deleted_at, 0)) DESC, ts DESC LIMIT $${args.length}`,
        args,
      );
      return rows.map(rowToMessage);
    },

    async search(queryText, opts = {}) {
      const term = queryText.trim();
      if (!term) return [];
      const limit = clampLimit(opts.limit, DEFAULT_SEARCH_LIMIT);
      const conds = [
        "org_id = $1",
        "deleted = FALSE",
        "tsv @@ plainto_tsquery('english', $2)",
        "surface = $3",
        "account = $4",
      ];
      const args: unknown[] = [orgId, term, ...keyOf(opts)];
      if (opts.container) {
        args.push(opts.container);
        conds.push(`container = $${args.length}`);
      }
      args.push(limit);
      const rows = await q(
        `SELECT ${MESSAGE_COLUMNS} FROM channel_messages WHERE ${conds.join(" AND ")}
         ORDER BY ts_rank(tsv, plainto_tsquery('english', $2)) DESC, ts DESC LIMIT $${args.length}`,
        args,
      );
      return rows.map(rowToMessage);
    },

    async activeThreads(o = {}) {
      const limit = clampLimit(o.limit, DEFAULT_THREADS_LIMIT);
      const conds = ["org_id = $1", "sub IS NOT NULL", "deleted = FALSE", "surface = $2", "account = $3"];
      const args: unknown[] = [orgId, ...keyOf(o)];
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

    async members(container, key) {
      const rows = await q(
        "SELECT members FROM channel_state WHERE org_id = $1 AND container = $2 AND surface = $3 AND account = $4",
        [orgId, container, ...keyOf(key)],
      );
      const raw = rows[0]?.members;
      if (Array.isArray(raw)) return raw as string[];
      if (typeof raw === "string") return JSON.parse(raw) as string[];
      return [];
    },

    async isMember(container, principalId, key) {
      const rows = await q(
        "SELECT 1 FROM channel_state WHERE org_id = $1 AND container = $2 AND members ? $3 AND surface = $4 AND account = $5",
        [orgId, container, principalId, ...keyOf(key)],
      );
      return rows.length > 0;
    },

    async containerState(container, key) {
      const rows = await q(
        "SELECT * FROM channel_state WHERE org_id = $1 AND container = $2 AND surface = $3 AND account = $4",
        [orgId, container, ...keyOf(key)],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        container: r.container as string,
        ...(r.last_ts != null ? { lastTs: r.last_ts as string } : {}),
        ...(r.oldest_ts != null ? { oldestTs: r.oldest_ts as string } : {}),
        ...(r.name != null ? { name: r.name as string } : {}),
        ...(r.kind != null ? { kind: r.kind as ContainerState["kind"] } : {}),
        ...(r.source != null ? { source: r.source as SurfaceSource } : {}),
        updatedAt: Number(r.updated_at),
      };
    },

    async listContainers(opts = {}) {
      const limit = clampLimit(opts.limit, MAX_READ_LIMIT);
      const rows = await q(
        `SELECT s.*, COALESCE(m.n, 0) AS message_count
           FROM channel_state s
           LEFT JOIN (SELECT container, COUNT(*)::int AS n FROM channel_messages
                       WHERE org_id = $1 AND deleted = FALSE AND surface = $3 AND account = $4 GROUP BY container) m
             ON m.container = s.container
          WHERE s.org_id = $1 AND s.surface = $3 AND s.account = $4
          ORDER BY s.updated_at DESC
          LIMIT $2`,
        [orgId, limit, ...keyOf(opts)],
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
