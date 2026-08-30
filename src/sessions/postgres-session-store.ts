import { randomUUID } from "node:crypto";
import { createPgPool, type PoolClient, withPgTransaction } from "../persistence/pg-pool.ts";
import { jsonbSafeStringify } from "../util/text.ts";
import type { Session, SessionEntry, SessionType, ScopeId } from "../types.ts";
import type {
  AttributedTurn,
  EntrySearchHit,
  CronGroupSummary,
  DistinctScope,
  GetEntriesOptions,
  GetTapeOptions,
  Lease,
  LeaseAttempt,
  LeaseHolder,
  LlmRequestRecord,
  NewEntry,
  NewLlmRequest,
  NewTapeRecord,
  ParticipantWindow,
  ScopeSessionStats,
  SessionOrigin,
  SessionOriginFilter,
  SessionPage,
  SessionRef,
  SessionStore,
  SessionSummary,
  StoreOptions,
  TapeRecord,
} from "./session-store.ts";
import { tsPrefixQuery } from "./entry-search.ts";
import {
  LEGACY_CRON_ID_PATTERN,
  legacyOriginPattern,
  ORIGIN_ALTERNATION,
  promptEnvelopeBody,
  sessionOrigin,
  STABLE_CRON_ID_PATTERN,
  stableOriginPattern,
  userMessagePreview,
} from "./session-store.ts";

export const SESSION_ENTRIES_SEARCH_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_entries_search_tsv
  ON session_entries USING GIN (search_tsv)
  WHERE type IN ('user', 'assistant', 'text')`;

export function rowToSession(r: Record<string, unknown>): Session {
  return {
    id: r.id as string,
    type: r.type as SessionType,
    scopeId: r.scope_id as ScopeId,
    threadRef: r.thread_ref as string,
    ...(r.surface != null ? { surface: r.surface as string } : {}),
    createdAt: Number(r.created_at),
    ...(r.title != null ? { title: r.title as string } : {}),
    ...(r.channel_name != null ? { channelName: r.channel_name as string } : {}),
    ...(r.forked_from_session_id != null && r.fork_boundary_seq != null
      ? {
          forkedFrom: {
            sessionId: r.forked_from_session_id as string,
            ...(r.forked_from_title != null ? { title: r.forked_from_title as string } : {}),
          },
          forkBoundarySeq: Number(r.fork_boundary_seq),
        }
      : {}),
  };
}

function rowToParticipantSession(r: Record<string, unknown>): Session {
  const s = rowToSession(r);
  if (r.p_title != null) s.title = r.p_title as string;
  if (r.p_archived) s.archived = true;
  if (r.p_pinned) s.pinned = true;
  if (r.p_color != null) s.color = r.p_color as string;
  if (r.user_last_activity != null) s.lastActivityAt = Number(r.user_last_activity);
  if (r.has_entries != null) s.hasEntries = Boolean(r.has_entries);
  return s;
}

function rowToLlmRequest(r: Record<string, unknown>): LlmRequestRecord {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    turnSeq: r.turn_seq == null ? null : Number(r.turn_seq),
    step: Number(r.step),
    model: r.model as string,
    scopeLabel: r.scope_label as ScopeId,
    createdAt: Number(r.created_at),
    request: r.request != null ? JSON.parse(r.request as string) : null,
    promptHash: r.prompt_hash == null ? null : (r.prompt_hash as string),
    ...(r.prompt_body != null ? { promptEnvelope: JSON.parse(r.prompt_body as string) } : {}),
    truncated: Boolean(r.truncated),
    ttftMs: r.ttft_ms == null ? null : Number(r.ttft_ms),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    stepGapMs: r.step_gap_ms == null ? null : Number(r.step_gap_ms),
    toolWallMs: r.tool_wall_json != null ? (JSON.parse(r.tool_wall_json as string) as number[]) : null,
    gapPhases:
      r.gap_phases_json != null ? (JSON.parse(r.gap_phases_json as string) as LlmRequestRecord["gapPhases"]) : null,
    usage: r.usage_json != null ? (JSON.parse(r.usage_json as string) as LlmRequestRecord["usage"]) : null,
    transport:
      r.transport_json != null ? (JSON.parse(r.transport_json as string) as LlmRequestRecord["transport"]) : null,
  };
}

function rowToTape(r: Record<string, unknown>): TapeRecord {
  const meta = {
    ...(r.bare_text != null ? { bareText: r.bare_text as string } : {}),
    ...(r.ts != null ? { ts: r.ts as string } : {}),
    ...(r.change_time != null ? { changeTime: r.change_time as string } : {}),
    ...(r.hidden != null ? { hidden: Boolean(r.hidden) } : {}),
    ...(r.overheard != null ? { overheard: Boolean(r.overheard) } : {}),
    ...(r.author != null ? { author: r.author as string } : {}),
  };
  return {
    sessionId: r.session_id as string,
    seq: Number(r.seq),
    kind: r.kind as TapeRecord["kind"],
    payload: r.payload != null ? JSON.parse(r.payload as string) : null,
    scopeLabel: r.scope_label as ScopeId,
    createdAt: Number(r.created_at),
    ...(r.harness != null ? { harness: r.harness as string } : {}),
    ...(r.entry_seq != null ? { entrySeq: Number(r.entry_seq) } : {}),
    ...(r.covers_entry_seq != null ? { coversEntrySeq: Number(r.covers_entry_seq) } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

function rowToEntry(r: Record<string, unknown>): SessionEntry {
  return {
    sessionId: r.session_id as string,
    seq: Number(r.seq),
    parentSeq: r.parent_seq === null ? null : Number(r.parent_seq),
    type: r.type as SessionEntry["type"],
    payload: r.payload != null ? JSON.parse(r.payload as string) : null,
    scopeLabel: r.scope_label as ScopeId,
    createdAt: Number(r.created_at),
  };
}

export function createPostgresSessionStore(connectionString: string, opts: StoreOptions = {}): SessionStore {
  const now = opts.now ?? (() => Date.now());
  const leaseTtlMs = opts.leaseTtlMs ?? 5 * 60_000;

  const notOverheard = (col: string): string =>
    `(${col}.payload IS NULL OR ${col}.payload NOT LIKE '%"overheard":true%')`;
  const userTurn = (col: string): string => `${col}.type = 'user' AND ${notOverheard(col)}`;
  const lastActivityExpr = (col: string): string => `COALESCE(${col}.last_activity, ${col}.created_at)`;
  const withinParticipantWindow = (entry: string, participant: string): string =>
    `(((${participant}.valid_from_seq IS NOT NULL AND ${entry}.seq >= ${participant}.valid_from_seq)
       OR (${participant}.valid_from_seq IS NULL AND ${entry}.created_at >= ${participant}.valid_from))
      AND ((${participant}.valid_to_seq IS NOT NULL AND ${entry}.seq < ${participant}.valid_to_seq)
       OR (${participant}.valid_to_seq IS NULL AND (${participant}.valid_to IS NULL OR ${entry}.created_at < ${participant}.valid_to))))`;
  const backgroundThreadRef = (col: string): string =>
    `(${col} ~ '${stableOriginPattern(ORIGIN_ALTERNATION)}' OR ${col} ~ '${legacyOriginPattern(ORIGIN_ALTERNATION)}')`;
  const originThreadRef = (col: string, origin: SessionOrigin): string =>
    `(${col} ~ '${stableOriginPattern(origin)}' OR ${col} ~ '${legacyOriginPattern(origin)}')`;
  const originFilterClause = (col: string, origin: SessionOriginFilter): string =>
    origin === "other_background"
      ? `(${backgroundThreadRef(col)} AND NOT ${originThreadRef(col, "cron")})`
      : originThreadRef(col, origin);
  const cronIdExpr = (col: string): string =>
    `COALESCE(substring(${col} FROM '${STABLE_CRON_ID_PATTERN}'), substring(${col} FROM '${LEGACY_CRON_ID_PATTERN}'))`;
  const originExpr = (col: string): string =>
    `COALESCE(substring(${col} FROM '${stableOriginPattern(ORIGIN_ALTERNATION)}'), substring(${col} FROM '${legacyOriginPattern(ORIGIN_ALTERNATION)}'), 'conversation')`;
  const previewExpr = (col: string): string =>
    `(SELECT CASE WHEN json_typeof(j -> 'text') = 'string' THEN j ->> 'text'
                  WHEN json_typeof(j) = 'string' THEN j #>> '{}'
                  ELSE NULL END
        FROM (SELECT safe_json(replace(${col}, '\\u0000', '')) AS j) _)`;

  const { pool, q } = createPgPool(connectionString, [
    `CREATE OR REPLACE FUNCTION safe_json(t text) RETURNS json
        LANGUAGE plpgsql IMMUTABLE PARALLEL UNSAFE AS $safe_json$
        BEGIN RETURN t::json; EXCEPTION WHEN others THEN RETURN NULL; END $safe_json$`,
    `DO $safe_jsonb_parallel$
        BEGIN
          IF to_regprocedure('safe_jsonb(text)') IS NOT NULL THEN
            ALTER FUNCTION safe_jsonb(text) PARALLEL UNSAFE;
          END IF;
        END $safe_jsonb_parallel$`,
    `CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY, type TEXT NOT NULL, scope_id TEXT NOT NULL,
        thread_ref TEXT UNIQUE NOT NULL, created_at BIGINT NOT NULL, title TEXT, channel_name TEXT
      )`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS channel_name TEXT`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS surface TEXT`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity BIGINT`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS messages INT`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turns INT`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS forked_from_session_id TEXT`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS forked_from_title TEXT`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS fork_boundary_seq INT`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_fork_provenance_pair') THEN
         ALTER TABLE sessions ADD CONSTRAINT sessions_fork_provenance_pair
         CHECK ((forked_from_session_id IS NULL) = (fork_boundary_seq IS NULL)) NOT VALID;
       END IF;
     END $$`,
    `CREATE TABLE IF NOT EXISTS session_entries(
        session_id TEXT NOT NULL, seq INT NOT NULL, parent_seq INT,
        type TEXT NOT NULL, payload TEXT, scope_label TEXT NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY(session_id, seq)
      )`,
    `CREATE TABLE IF NOT EXISTS participants(
        session_id TEXT NOT NULL, principal_id TEXT NOT NULL,
        valid_from BIGINT NOT NULL, valid_to BIGINT,
        valid_from_seq INT, valid_to_seq INT,
        title TEXT, archived BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY(session_id, principal_id)
      )`,
    `CREATE TABLE IF NOT EXISTS session_leases(
        session_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at BIGINT NOT NULL
      )`,
    `ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS holder TEXT`,
    `ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS acquired_at BIGINT`,
    `CREATE TABLE IF NOT EXISTS session_tape(
        session_id TEXT NOT NULL, seq INT NOT NULL,
        kind TEXT NOT NULL, harness TEXT, payload TEXT NOT NULL, scope_label TEXT NOT NULL,
        bare_text TEXT, ts TEXT, change_time TEXT, hidden BOOLEAN, overheard BOOLEAN, author TEXT,
        entry_seq INT, covers_entry_seq INT, created_at BIGINT NOT NULL,
        PRIMARY KEY(session_id, seq)
      )`,
    `ALTER TABLE participants ADD COLUMN IF NOT EXISTS title TEXT`,
    `ALTER TABLE participants ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE participants ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE participants ADD COLUMN IF NOT EXISTS color TEXT`,
    `ALTER TABLE participants ADD COLUMN IF NOT EXISTS valid_from_seq INT`,
    `ALTER TABLE participants ADD COLUMN IF NOT EXISTS valid_to_seq INT`,
    `UPDATE participants p SET valid_from = 0, valid_from_seq = 0
        FROM sessions s
       WHERE s.id = p.session_id
         AND s.scope_id LIKE 'group:web-project-%'
         AND p.valid_to IS NULL
         AND (p.valid_from_seq IS DISTINCT FROM 0 OR p.valid_from <> 0)`,
    `UPDATE participants p SET title = NULL
        FROM sessions s
       WHERE s.id = p.session_id
         AND s.scope_id LIKE 'group:web-project-%'
         AND p.valid_to IS NULL
         AND p.title = ''`,
    `CREATE TABLE IF NOT EXISTS session_llm_requests(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_seq INT,
        step INT NOT NULL, model TEXT NOT NULL, scope_label TEXT NOT NULL,
        request TEXT NOT NULL, truncated BOOLEAN NOT NULL DEFAULT FALSE, created_at BIGINT NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS session_llm_requests_by_session
        ON session_llm_requests(session_id, created_at, step)`,
    `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS ttft_ms INT`,
    `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS duration_ms INT`,
    `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS step_gap_ms INT`,
    `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS tool_wall_json TEXT`,
    `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS usage_json TEXT`,
    `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS transport_json TEXT`,
    `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS gap_phases_json TEXT`,
    `ALTER TABLE session_llm_requests ALTER COLUMN request DROP NOT NULL`,
    `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS prompt_hash TEXT`,
    `CREATE TABLE IF NOT EXISTS llm_prompt_envelopes(
        hash TEXT PRIMARY KEY, body TEXT NOT NULL, created_at BIGINT NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS sessions_by_scope ON sessions(scope_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS sessions_by_activity ON sessions((COALESCE(last_activity, created_at)) DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS sessions_by_scope_activity
        ON sessions(scope_id, (COALESCE(last_activity, created_at)) DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS session_entries_user_ts ON session_entries(created_at) WHERE type = 'user'`,
    `CREATE INDEX IF NOT EXISTS session_entries_session_created ON session_entries(session_id, created_at DESC)`,
    `CREATE OR REPLACE FUNCTION entry_search_text(payload text) RETURNS text
        LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $entry_search_text$
        DECLARE j json;
        BEGIN
          j := replace(payload, '\\u0000', '')::json;
          RETURN CASE WHEN json_typeof(j -> 'text') = 'string' THEN j ->> 'text'
                      WHEN json_typeof(j) = 'string' THEN j #>> '{}'
                      ELSE NULL END;
        EXCEPTION WHEN others THEN RETURN NULL;
        END $entry_search_text$`,
    `ALTER TABLE session_entries ADD COLUMN IF NOT EXISTS search_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(entry_search_text(payload), ''))) STORED`,
    SESSION_ENTRIES_SEARCH_INDEX_SQL,
    `DROP INDEX IF EXISTS session_entries_search_fts`,
    `DELETE FROM session_entries WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
    `DELETE FROM participants WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
    `DELETE FROM session_leases WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
    `DELETE FROM session_llm_requests WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
    `DELETE FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$'`,
    `UPDATE sessions s
        SET messages = (SELECT COUNT(*) FROM session_entries t WHERE t.session_id = s.id),
            turns = (SELECT COUNT(*) FROM session_entries t WHERE t.session_id = s.id AND ${userTurn("t")}),
            last_activity = GREATEST(COALESCE(s.last_activity, 0), s.created_at, COALESCE((SELECT MAX(t.created_at) FROM session_entries t WHERE t.session_id = s.id), 0))
      WHERE s.messages IS NULL
         OR ${lastActivityExpr("s")} > (EXTRACT(EPOCH FROM now()) * 1000)::bigint - 172800000`,
  ]);

  const lockSession = (client: PoolClient, sessionId: string) =>
    client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [sessionId]);

  const withLease = async <T>(lease: Lease, invalidMsg: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    withPgTransaction(await pool(), async (client) => {
      await lockSession(client, lease.sessionId);
      const held = await client.query("SELECT token FROM session_leases WHERE session_id = $1 FOR UPDATE", [
        lease.sessionId,
      ]);
      if (held.rows[0]?.token !== lease.token) throw new Error(invalidMsg);
      await client.query("UPDATE session_leases SET expires_at = $2 WHERE session_id = $1", [
        lease.sessionId,
        now() + leaseTtlMs,
      ]);
      return fn(client);
    });

  const insertTapeRow = async (client: PoolClient, sessionId: string, rec: NewTapeRecord): Promise<TapeRecord> => {
    const max = await client.query("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM session_tape WHERE session_id = $1", [
      sessionId,
    ]);
    const seq = Number(max.rows[0]!.n);
    const stored = jsonbSafeStringify(rec.payload ?? null);
    const createdAt = now();
    await client.query(
      `INSERT INTO session_tape(session_id, seq, kind, harness, payload, scope_label, bare_text, ts, change_time, hidden, overheard, author, entry_seq, covers_entry_seq, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        sessionId,
        seq,
        rec.kind,
        rec.harness ?? null,
        stored,
        rec.scopeLabel,
        rec.meta?.bareText ?? null,
        rec.meta?.ts ?? null,
        rec.meta?.changeTime ?? null,
        rec.meta?.hidden ?? null,
        rec.meta?.overheard ?? null,
        rec.meta?.author ?? null,
        rec.entrySeq ?? null,
        rec.coversEntrySeq ?? null,
        createdAt,
      ],
    );
    return { ...rec, payload: JSON.parse(stored), sessionId, seq, createdAt };
  };

  return {
    async getOrCreateByThread(threadRef, type, scopeId, channelName, surface): Promise<Session> {
      const heal = async (row: Record<string, unknown>): Promise<Session> => {
        const s = rowToSession(row);
        if (channelName && s.channelName !== channelName) {
          await q("UPDATE sessions SET channel_name = $2 WHERE id = $1", [s.id, channelName]);
          s.channelName = channelName;
        }
        if (surface && !s.surface) {
          await q("UPDATE sessions SET surface = $2 WHERE id = $1", [s.id, surface]);
          s.surface = surface;
        }
        return s;
      };
      const existing = await q("SELECT * FROM sessions WHERE thread_ref = $1", [threadRef]);
      if (existing[0]) return heal(existing[0]);
      const session: Session = {
        id: randomUUID(),
        type,
        scopeId,
        threadRef,
        createdAt: now(),
        ...(channelName ? { channelName } : {}),
        ...(surface ? { surface } : {}),
      };
      await q(
        "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, channel_name, surface, last_activity, messages, turns) VALUES ($1,$2,$3,$4,$5,$6,$7,$5,0,0) ON CONFLICT (thread_ref) DO NOTHING",
        [
          session.id,
          session.type,
          session.scopeId,
          session.threadRef,
          session.createdAt,
          channelName ?? null,
          surface ?? null,
        ],
      );
      const rows = await q("SELECT * FROM sessions WHERE thread_ref = $1", [threadRef]);
      return heal(rows[0]!);
    },

    async getByThread(threadRef): Promise<Session | null> {
      const rows = await q("SELECT * FROM sessions WHERE thread_ref = $1", [threadRef]);
      return rows[0] ? rowToSession(rows[0]) : null;
    },

    async get(id): Promise<Session | null> {
      const rows = await q("SELECT * FROM sessions WHERE id = $1", [id]);
      return rows[0] ? rowToSession(rows[0]) : null;
    },

    async updateTitle(sessionId, title): Promise<void> {
      await q("UPDATE sessions SET title = $2 WHERE id = $1", [sessionId, title]);
    },

    async updateForkProvenance(sessionId, provenance): Promise<void> {
      await q(
        "UPDATE sessions SET forked_from_session_id = $2, forked_from_title = $3, fork_boundary_seq = $4 WHERE id = $1",
        [sessionId, provenance.forkedFrom.sessionId, provenance.forkedFrom.title ?? null, provenance.forkBoundarySeq],
      );
    },

    async acquireLease(sessionId, holder): Promise<LeaseAttempt> {
      const token = randomUUID();
      const t = now();
      return withPgTransaction(await pool(), async (client) => {
        await lockSession(client, sessionId);
        const granted = await client.query(
          `INSERT INTO session_leases(session_id, token, expires_at, holder, acquired_at)
             SELECT $1, $2, $3, $5, $4 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = $1)
           ON CONFLICT (session_id) DO UPDATE
             SET token = $2, expires_at = $3, holder = $5, acquired_at = $4
             WHERE session_leases.expires_at <= $4
           RETURNING token`,
          [sessionId, token, t + leaseTtlMs, t, holder ?? null],
        );
        if (granted.rows[0]) return { lease: { sessionId, token } };
        const held = await client.query(
          "SELECT expires_at, holder, acquired_at FROM session_leases WHERE session_id = $1",
          [sessionId],
        );
        const row = held.rows[0];
        if (!row) return { lease: null };
        return {
          lease: null,
          ...(row.holder != null ? { heldBy: row.holder as LeaseHolder } : {}),
          ...(row.acquired_at != null ? { heldSince: Number(row.acquired_at) } : {}),
          heldUntil: Number(row.expires_at),
        };
      });
    },

    async releaseLease(lease): Promise<void> {
      await q("DELETE FROM session_leases WHERE session_id = $1 AND token = $2", [lease.sessionId, lease.token]);
    },

    async forceReleaseLease(sessionId): Promise<void> {
      await q("DELETE FROM session_leases WHERE session_id = $1", [sessionId]);
    },

    async append(lease, entry: NewEntry): Promise<SessionEntry> {
      return withLease(lease, "append without a valid session lease", async (client) => {
        const max = await client.query(
          "SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM session_entries WHERE session_id = $1",
          [lease.sessionId],
        );
        const seq = Number(max.rows[0]!.n);
        const stored = jsonbSafeStringify(entry.payload ?? null);
        const full: SessionEntry = {
          sessionId: lease.sessionId,
          seq,
          parentSeq: seq === 0 ? null : seq - 1,
          type: entry.type,
          payload: JSON.parse(stored),
          scopeLabel: entry.scopeLabel as ScopeId,
          createdAt: now(),
        };
        await client.query(
          "INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [full.sessionId, full.seq, full.parentSeq, full.type, stored, full.scopeLabel, full.createdAt],
        );
        await client.query(
          `UPDATE sessions
              SET last_activity = GREATEST(COALESCE(last_activity, 0), $2),
                  messages = $3,
                  turns = CASE WHEN turns IS NULL OR messages IS DISTINCT FROM $5
                               THEN (SELECT COUNT(*) FROM session_entries t WHERE t.session_id = $1 AND ${userTurn("t")})
                               ELSE turns + $4 END
            WHERE id = $1`,
          [
            full.sessionId,
            full.createdAt,
            seq + 1,
            full.type === "user" && !stored.includes('"overheard":true') ? 1 : 0,
            seq,
          ],
        );
        return full;
      });
    },

    async clearSecurityTaint(sessionId) {
      const updated = await q(
        "UPDATE session_entries SET payload = (payload::jsonb - 'securityTainted')::text " +
          "WHERE session_id = $1 AND payload LIKE '%\"securityTainted\"%' RETURNING 1",
        [sessionId],
      );
      if (updated.length > 0) return true;
      return (await q("SELECT 1 FROM sessions WHERE id = $1", [sessionId])).length === 1;
    },

    async appendTape(lease, rec: NewTapeRecord): Promise<TapeRecord> {
      return withLease(lease, "tape append without a valid session lease", (client) =>
        insertTapeRow(client, lease.sessionId, rec),
      );
    },

    async getTape(sessionId, opts: GetTapeOptions = {}): Promise<TapeRecord[]> {
      const since = opts.sinceSeq ?? -1;
      if (opts.limit !== undefined) {
        const rows = await q(
          "SELECT * FROM session_tape WHERE session_id = $1 AND seq > $2 ORDER BY seq DESC LIMIT $3",
          [sessionId, since, opts.limit],
        );
        return rows.map(rowToTape).reverse();
      }
      const rows = await q("SELECT * FROM session_tape WHERE session_id = $1 AND seq > $2 ORDER BY seq ASC", [
        sessionId,
        since,
      ]);
      return rows.map(rowToTape);
    },

    async tapeCoverage(sessionId): Promise<number> {
      const rows = await q(
        `SELECT GREATEST(
           COALESCE(MAX(entry_seq) FILTER (
             WHERE kind = 'annotation'
               AND json_typeof(safe_json(payload)->'turnEnd') = 'boolean'
               AND safe_json(payload)->>'turnEnd' = 'true'
           ), -1),
           COALESCE(MAX(covers_entry_seq) FILTER (
             WHERE kind = 'context_event' AND safe_json(payload)->>'event' = 'legacy_import'
           ), -1)
         ) AS n FROM session_tape WHERE session_id = $1`,
        [sessionId],
      );
      return Number(rows[0]?.n ?? -1);
    },

    async getEntries(sessionId, opts?: GetEntriesOptions): Promise<SessionEntry[]> {
      const since = opts?.sinceSeq ?? 0;
      if (opts?.limit !== undefined) {
        const rows = await q(
          "SELECT * FROM session_entries WHERE session_id = $1 AND seq >= $2 ORDER BY seq DESC LIMIT $3",
          [sessionId, since, opts.limit],
        );
        return rows.map(rowToEntry).reverse();
      }
      const rows = await q("SELECT * FROM session_entries WHERE session_id = $1 AND seq >= $2 ORDER BY seq ASC", [
        sessionId,
        since,
      ]);
      return rows.map(rowToEntry);
    },

    async recordLlmRequest(sessionId, rec: NewLlmRequest, signal?: AbortSignal): Promise<LlmRequestRecord> {
      const envelope = promptEnvelopeBody(rec.promptEnvelope);
      if (envelope) {
        await q(
          "INSERT INTO llm_prompt_envelopes(hash, body, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [envelope.hash, envelope.body, now()],
          { signal },
        );
      }
      const full: LlmRequestRecord = {
        id: randomUUID(),
        sessionId,
        turnSeq: rec.turnSeq,
        step: rec.step,
        model: rec.model,
        scopeLabel: rec.scopeLabel as ScopeId,
        createdAt: now(),
        request: null,
        promptHash: envelope?.hash ?? null,
        ...(rec.promptEnvelope !== undefined ? { promptEnvelope: rec.promptEnvelope } : {}),
        truncated: rec.truncated ?? false,
        ttftMs: rec.ttftMs ?? null,
        durationMs: rec.durationMs ?? null,
        stepGapMs: rec.stepGapMs ?? null,
        toolWallMs: rec.toolWallMs ?? null,
        gapPhases: rec.gapPhases ?? null,
        usage: rec.usage ?? null,
        transport: rec.transport ?? null,
      };
      await q(
        "INSERT INTO session_llm_requests(id, session_id, turn_seq, step, model, scope_label, prompt_hash, truncated, created_at, ttft_ms, duration_ms, step_gap_ms, tool_wall_json, usage_json, transport_json, gap_phases_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
        [
          full.id,
          full.sessionId,
          full.turnSeq,
          full.step,
          full.model,
          full.scopeLabel,
          full.promptHash,
          full.truncated,
          full.createdAt,
          full.ttftMs,
          full.durationMs,
          full.stepGapMs,
          full.toolWallMs ? JSON.stringify(full.toolWallMs) : null,
          full.usage ? JSON.stringify(full.usage) : null,
          full.transport ? JSON.stringify(full.transport) : null,
          full.gapPhases ? JSON.stringify(full.gapPhases) : null,
        ],
        { signal },
      );
      return full;
    },

    async listLlmRequests(sessionId, opts): Promise<LlmRequestRecord[]> {
      const cols = opts?.omitRequest
        ? "r.id, r.session_id, r.turn_seq, r.step, r.model, r.scope_label, r.created_at, r.truncated, r.prompt_hash, r.ttft_ms, r.duration_ms, r.step_gap_ms, r.tool_wall_json, r.usage_json, r.transport_json, r.gap_phases_json"
        : "r.*, e.body AS prompt_body";
      const from = opts?.omitRequest
        ? "session_llm_requests r"
        : "session_llm_requests r LEFT JOIN llm_prompt_envelopes e ON e.hash = r.prompt_hash";
      const conds = ["r.session_id = $1"];
      const args: unknown[] = [sessionId];
      const turnSeqs = opts?.turnSeqs;
      if (turnSeqs) {
        args.push(turnSeqs);
        conds.push(
          opts?.orphans
            ? `(r.turn_seq = ANY($${args.length}) OR r.turn_seq IS NULL)`
            : `r.turn_seq = ANY($${args.length})`,
        );
      } else if (opts?.orphans) {
        conds.push("r.turn_seq IS NULL");
      }
      const rows = await q(
        `SELECT ${cols} FROM ${from} WHERE ${conds.join(" AND ")} ORDER BY r.created_at ASC, r.step ASC`,
        args,
      );
      return rows.map(rowToLlmRequest);
    },

    async addParticipant(sessionId, principalId, title, opts): Promise<void> {
      const includeHistory = opts?.includeHistory === true;
      await q(
        `WITH boundary AS (
           SELECT CASE WHEN $5 THEN 0 ELSE COALESCE(MAX(seq) + 1, 0) END AS seq
             FROM session_entries WHERE session_id = $1
         )
         INSERT INTO participants(session_id, principal_id, valid_from, valid_to, valid_from_seq, valid_to_seq, title)
         SELECT $1,$2,$3,NULL,boundary.seq,NULL,$4 FROM boundary
         ON CONFLICT (session_id, principal_id) DO UPDATE
           SET valid_from = CASE
                 WHEN $5 THEN 0
                 WHEN participants.valid_to IS NULL THEN participants.valid_from
                 ELSE EXCLUDED.valid_from END,
               valid_to = NULL,
               valid_from_seq = CASE
                 WHEN $5 THEN 0
                 WHEN participants.valid_to IS NULL THEN participants.valid_from_seq
                 ELSE EXCLUDED.valid_from_seq END,
               valid_to_seq = NULL,
               title = COALESCE(EXCLUDED.title, participants.title)
           WHERE participants.valid_to IS NOT NULL
              OR EXCLUDED.title IS NOT NULL
              OR ($5 AND (participants.valid_from_seq IS DISTINCT FROM 0 OR participants.valid_from <> 0))`,
        [sessionId, principalId, includeHistory ? 0 : now(), title ?? null, includeHistory],
      );
    },

    async removeParticipant(sessionId, principalId): Promise<void> {
      await q(
        "UPDATE participants SET valid_to = $3, valid_to_seq = (SELECT COALESCE(MAX(seq) + 1, 0) FROM session_entries WHERE session_id = $1) WHERE session_id = $1 AND principal_id = $2 AND valid_to IS NULL",
        [sessionId, principalId, now()],
      );
    },

    async deleteSession(sessionId): Promise<void> {
      await withPgTransaction(await pool(), async (client) => {
        await lockSession(client, sessionId);
        await client.query("DELETE FROM session_llm_requests WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM session_leases WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM participants WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM session_entries WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM session_tape WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
      });
    },

    async deleteSessionIfEmpty(sessionId): Promise<boolean> {
      return withPgTransaction(await pool(), async (client) => {
        await lockSession(client, sessionId);
        const gone = await client.query(
          `DELETE FROM sessions
            WHERE id = $1
              AND NOT EXISTS (SELECT 1 FROM session_entries WHERE session_id = $1)
              AND NOT EXISTS (SELECT 1 FROM session_leases WHERE session_id = $1 AND expires_at > $2)`,
          [sessionId, now()],
        );
        if (gone.rowCount === 0) return false;
        await client.query("DELETE FROM session_llm_requests WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM session_leases WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM participants WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM session_tape WHERE session_id = $1", [sessionId]);
        return true;
      });
    },

    async listByParticipant(principalId): Promise<Session[]> {
      const rows = await q(
        `SELECT s.*, p.title AS p_title, p.archived AS p_archived, p.pinned AS p_pinned, p.color AS p_color,
                COALESCE(MAX(e.created_at), s.created_at) AS user_last_activity,
                EXISTS (SELECT 1 FROM session_entries x WHERE x.session_id = s.id
                          AND ${withinParticipantWindow("x", "p")}) AS has_entries
           FROM sessions s
           JOIN participants p ON p.session_id = s.id
           LEFT JOIN session_entries e ON e.session_id = s.id AND e.type = 'user'
          WHERE p.principal_id = $1
          GROUP BY s.id, p.title, p.archived, p.pinned, p.color, p.valid_from, p.valid_to, p.valid_from_seq, p.valid_to_seq`,
        [principalId],
      );
      return rows.map(rowToParticipantSession);
    },

    async updateParticipantView(sessionId, principalId, patch): Promise<void> {
      if (patch.title !== undefined) {
        await q("UPDATE participants SET title = $3 WHERE session_id = $1 AND principal_id = $2", [
          sessionId,
          principalId,
          patch.title,
        ]);
      }
      if (patch.archived !== undefined) {
        await q("UPDATE participants SET archived = $3 WHERE session_id = $1 AND principal_id = $2", [
          sessionId,
          principalId,
          patch.archived,
        ]);
      }
      if (patch.pinned !== undefined) {
        await q("UPDATE participants SET pinned = $3 WHERE session_id = $1 AND principal_id = $2", [
          sessionId,
          principalId,
          patch.pinned,
        ]);
      }
      if (patch.color !== undefined) {
        await q("UPDATE participants SET color = $3 WHERE session_id = $1 AND principal_id = $2", [
          sessionId,
          principalId,
          patch.color,
        ]);
      }
    },

    async visibleEntries(sessionId, principalId): Promise<SessionEntry[]> {
      const rows = await q(
        `SELECT e.* FROM session_entries e
           JOIN participants p ON p.session_id = e.session_id AND p.principal_id = $2
          WHERE e.session_id = $1
            AND ${withinParticipantWindow("e", "p")}
          ORDER BY e.seq ASC`,
        [sessionId, principalId],
      );
      return rows.map(rowToEntry);
    },

    async searchEntries(principalId, query, limit = 40): Promise<EntrySearchHit[]> {
      const ts = tsPrefixQuery(query);
      if (!ts) return [];
      const rows = await q(
        `SELECT e.session_id, e.seq, e.type, e.created_at,
                entry_search_text(e.payload) AS text,
                (SELECT CASE WHEN e.type = 'user' AND json_typeof(j -> 'name') = 'string' THEN j ->> 'name' END
                   FROM (SELECT safe_json(replace(e.payload, '\\u0000', '')) AS j) _) AS author
           FROM session_entries e
           JOIN participants p ON p.session_id = e.session_id AND p.principal_id = $1
          WHERE e.type IN ('user', 'assistant', 'text')
            AND ${withinParticipantWindow("e", "p")}
            AND e.search_tsv @@ to_tsquery('simple', $2)
          ORDER BY e.created_at DESC, e.session_id, e.seq DESC
          LIMIT $3`,
        [principalId, ts, Math.max(1, Math.min(limit, 200))],
      );
      return rows.flatMap((r) => {
        const text = (r.text as string | null) ?? "";
        if (!text.trim()) return [];
        return [
          {
            sessionId: r.session_id as string,
            seq: Number(r.seq),
            type: r.type as EntrySearchHit["type"],
            ...(r.author ? { author: r.author as string } : {}),
            text,
            createdAt: Number(r.created_at),
          },
        ];
      });
    },

    async listAll(): Promise<Session[]> {
      const rows = await q("SELECT * FROM sessions");
      return rows.map(rowToSession);
    },

    async sessionsByThreadRefs(threadRefs): Promise<SessionRef[]> {
      if (threadRefs.length === 0) return [];
      const rows = await q("SELECT id, thread_ref, scope_id, type, title FROM sessions WHERE thread_ref = ANY($1)", [
        [...new Set(threadRefs)],
      ]);
      return rows.map((r) => ({
        id: r.id as string,
        threadRef: r.thread_ref as string,
        scopeId: r.scope_id as ScopeId,
        type: r.type as SessionType,
        title: (r.title as string | null) ?? null,
      }));
    },

    async distinctScopes(): Promise<DistinctScope[]> {
      const rows = await q("SELECT scope_id, MAX(channel_name) AS channel_name FROM sessions GROUP BY scope_id");
      return rows.map((r) => ({
        scopeId: r.scope_id as ScopeId,
        ...(r.channel_name != null ? { channelName: r.channel_name as string } : {}),
      }));
    },

    async scopeSessionSummaries(
      scope,
      orgWide,
      page?: SessionPage,
      includePreviews = true,
      sessionIds?: string[],
    ): Promise<SessionSummary[]> {
      const params: unknown[] = [orgWide, scope];
      let categoryClause = "";
      if (page?.category === "background") categoryClause = ` AND ${backgroundThreadRef("s.thread_ref")}`;
      else if (page?.category) categoryClause = ` AND NOT ${backgroundThreadRef("s.thread_ref")}`;
      const originClause = page?.origin ? ` AND ${originFilterClause("s.thread_ref", page.origin)}` : "";
      let idsClause = "";
      if (sessionIds) {
        params.push(sessionIds);
        idsClause = ` AND s.id = ANY($${params.length})`;
      }
      let cronClause = "";
      if (page?.cronId) {
        params.push(page.cronId);
        cronClause = ` AND ${cronIdExpr("s.thread_ref")} = $${params.length}`;
      }
      let keysetClause = "";
      if (page?.before) {
        params.push(page.before.lastActivity, page.before.id);
        keysetClause = ` AND (${lastActivityExpr("s")}, s.id) < ($${params.length - 1}::bigint, $${params.length}::text)`;
      }
      let pageClause = "";
      if (page) {
        params.push(page.limit);
        pageClause = ` LIMIT $${params.length}`;
        if (!page.before) {
          params.push(page.offset);
          pageClause += ` OFFSET $${params.length}`;
        }
      }
      const previewCols = includePreviews
        ? `(SELECT ${previewExpr("fe.payload")} FROM session_entries fe
                  WHERE fe.session_id = s.id AND ${userTurn("fe")}
                  ORDER BY fe.seq ASC LIMIT 1) AS first_user,
                (SELECT ${previewExpr("le.payload")} FROM session_entries le
                  WHERE le.session_id = s.id AND ${userTurn("le")}
                  ORDER BY le.seq DESC LIMIT 1) AS last_user`
        : `NULL AS first_user, NULL AS last_user`;
      const rows = await q(
        `SELECT s.id, s.type, s.scope_id, s.thread_ref, s.created_at,
                COALESCE(s.messages, 0) AS messages,
                COALESCE(s.turns, 0) AS turns,
                ${lastActivityExpr("s")} AS last_activity,
                ${previewCols}
           FROM sessions s
          WHERE ($1::boolean OR s.scope_id = $2)${categoryClause}${originClause}${idsClause}${cronClause}${keysetClause}
          ORDER BY last_activity DESC, s.id DESC${pageClause}`,
        params,
      );
      const parse = (v: unknown, maxLen?: number): string => userMessagePreview(v ?? null, maxLen);
      return rows.map((r) => ({
        id: r.id as string,
        type: r.type as Session["type"],
        origin: sessionOrigin(r.thread_ref as string | null),
        scopeId: r.scope_id as Session["scopeId"],
        threadRef: r.thread_ref as Session["threadRef"],
        turns: Number(r.turns),
        messages: Number(r.messages),
        lastActivity: Number(r.last_activity),
        createdAt: Number(r.created_at),
        firstMessage: parse(r.first_user),
        lastMessage: parse(r.last_user, 100),
      }));
    },

    async lastUserMessages(sessionIds): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      if (sessionIds.length === 0) return out;
      const rows = await q(
        `SELECT DISTINCT ON (le.session_id) le.session_id, ${previewExpr("le.payload")} AS last_user
           FROM session_entries le
          WHERE le.session_id = ANY($1) AND ${userTurn("le")}
          ORDER BY le.session_id, le.seq DESC`,
        [sessionIds],
      );
      for (const r of rows) out.set(r.session_id as string, userMessagePreview(r.last_user ?? null, 100));
      return out;
    },

    async scopeCronGroups(scope, orgWide): Promise<CronGroupSummary[]> {
      const rows = await q(
        `SELECT ${cronIdExpr("s.thread_ref")} AS cron_id,
                MIN(s.scope_id) AS scope_id,
                COUNT(*) AS sessions,
                COALESCE(SUM(s.messages), 0) AS messages,
                COALESCE(SUM(s.turns), 0) AS turns,
                MAX(${lastActivityExpr("s")}) AS last_activity,
                MIN(s.created_at) AS created_at
           FROM sessions s
          WHERE ($1::boolean OR s.scope_id = $2) AND ${cronIdExpr("s.thread_ref")} IS NOT NULL
          GROUP BY cron_id
          ORDER BY last_activity DESC, cron_id DESC`,
        [orgWide, scope],
      );
      return rows.map((r) => ({
        cronId: r.cron_id as string,
        scopeId: r.scope_id as ScopeId,
        sessions: Number(r.sessions),
        turns: Number(r.turns),
        messages: Number(r.messages),
        lastActivity: Number(r.last_activity),
        createdAt: Number(r.created_at),
      }));
    },

    async scopeSessionStats(scope, orgWide, category, originFilter, cronId): Promise<ScopeSessionStats> {
      const params: unknown[] = [orgWide, scope];
      const matchedClauses: string[] = [];
      if (category) {
        matchedClauses.push(
          category === "background"
            ? backgroundThreadRef("s.thread_ref")
            : `NOT ${backgroundThreadRef("s.thread_ref")}`,
        );
      }
      if (originFilter) matchedClauses.push(originFilterClause("s.thread_ref", originFilter));
      if (cronId) {
        params.push(cronId);
        matchedClauses.push(`${cronIdExpr("s.thread_ref")} = $${params.length}`);
      }
      const rows = await q(
        `SELECT origin, CASE WHEN origin = 'conversation' THEN type ELSE origin END AS bucket,
                matched, COUNT(*) AS sessions, COALESCE(SUM(turns), 0) AS turns,
                COUNT(DISTINCT cron_id) AS crons
           FROM (SELECT s.type, ${originExpr("s.thread_ref")} AS origin,
                        ${cronIdExpr("s.thread_ref")} AS cron_id,
                        (${matchedClauses.join(" AND ") || "TRUE"}) AS matched,
                        COALESCE(s.turns, 0) AS turns
                   FROM sessions s
                  WHERE ($1::boolean OR s.scope_id = $2)) t
          GROUP BY origin, bucket, matched`,
        params,
      );
      const byType: Record<string, number> = {};
      const byTypeAll: Record<string, number> = {};
      const totalByCategory = { conversation: 0, background: 0, all: 0 };
      let total = 0;
      let turns = 0;
      let crons = 0;
      for (const r of rows) {
        const n = Number(r.sessions);
        const bucket = r.bucket as string;
        totalByCategory[r.origin === "conversation" ? "conversation" : "background"] += n;
        totalByCategory.all += n;
        byTypeAll[bucket] = (byTypeAll[bucket] ?? 0) + n;
        if (r.origin === "cron") crons += Number(r.crons);
        if (!r.matched) continue;
        total += n;
        turns += Number(r.turns);
        byType[bucket] = (byType[bucket] ?? 0) + n;
      }
      return { total, turns, byType, byTypeAll, totalByCategory, crons };
    },

    async attributedTurns(): Promise<AttributedTurn[]> {
      const rows = await q(
        `SELECT p.principal_id, e.session_id, (e.created_at / 86400000)::bigint AS day,
                COUNT(*) AS turns, MIN(e.created_at) AS first_at, MAX(e.created_at) AS last_at
           FROM participants p
           JOIN session_entries e ON e.session_id = p.session_id
          WHERE ${userTurn("e")}
            AND ${withinParticipantWindow("e", "p")}
          GROUP BY p.principal_id, e.session_id, day`,
      );
      return rows.map((r) => ({
        principalId: r.principal_id as string,
        sessionId: r.session_id as string,
        day: Number(r.day),
        turns: Number(r.turns),
        firstAt: Number(r.first_at),
        lastAt: Number(r.last_at),
      }));
    },

    async listParticipants(): Promise<ParticipantWindow[]> {
      const rows = await q("SELECT session_id, principal_id, valid_from, valid_to FROM participants");
      return rows.map((r) => ({
        sessionId: r.session_id as string,
        principalId: r.principal_id as string,
        validFrom: Number(r.valid_from),
        validTo: r.valid_to == null ? null : Number(r.valid_to),
      }));
    },

    async participantsOf(sessionId): Promise<string[]> {
      const rows = await q("SELECT principal_id FROM participants WHERE session_id = $1", [sessionId]);
      return rows.map((r) => r.principal_id as string);
    },
  };
}
