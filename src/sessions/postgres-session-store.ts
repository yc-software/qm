import { randomUUID } from "node:crypto";
import { createPgPool, type PgPool, type PoolClient, withPgTransaction } from "../persistence/pg-pool.ts";
import { jsonbSafeStringify } from "../util/text.ts";
import type { Session, SessionEntry, SessionType, ScopeId } from "../types.ts";
import type {
  NewSessionPin,
  SessionPin,
  AttributedTurn,
  EntrySearchHit,
  CronGroupSummary,
  ScopeSessionRollup,
  DistinctScope,
  GetEntriesOptions,
  GetTapeOptions,
  Lease,
  LeaseAttempt,
  LeaseHolder,
  LeasePeek,
  LlmRequestRecord,
  NewEntry,
  NewLlmRequest,
  NewTapeRecord,
  ParticipantWindow,
  ScopeSessionStats,
  ScreenSample,
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
  cronIdOf,
  legacyOriginPattern,
  ORIGIN_ALTERNATION,
  promptEnvelopeBody,
  sessionOrigin,
  stableOriginPattern,
  threadRefCronIdExpr,
  userMessagePreview,
} from "./session-store.ts";
import { SECURITY_SCREEN_STEP, screenPayloadFromEnvelope } from "../security/security-posture.ts";

const threadRefOriginExpr = (threadRef: string): string =>
  `COALESCE(substring(${threadRef} FROM '${stableOriginPattern(ORIGIN_ALTERNATION)}'), substring(${threadRef} FROM '${legacyOriginPattern(ORIGIN_ALTERNATION)}'), 'conversation')`;

export async function backfillSessionOriginBatch(q: PgPool["q"], limit: number): Promise<number> {
  const updated = await q(
    `UPDATE sessions
        SET origin = ${threadRefOriginExpr("thread_ref")}, origin_id = ${threadRefCronIdExpr("thread_ref")}
      WHERE id IN (SELECT id FROM sessions WHERE origin IS NULL LIMIT $1)
      RETURNING 1`,
    [limit],
  );
  return updated.length;
}

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
    ...(r.attachments != null ? { attachments: JSON.parse(r.attachments as string) as unknown[] } : {}),
    ...(r.display != null ? { display: r.display as string } : {}),
    ...(r.security_tainted != null ? { securityTainted: Boolean(r.security_tainted) } : {}),
    ...(r.entry_created_at != null ? { entryCreatedAt: Number(r.entry_created_at) } : {}),
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

function rowToParticipantWindow(r: Record<string, unknown>): ParticipantWindow {
  return {
    sessionId: r.session_id as string,
    principalId: r.principal_id as string,
    validFrom: Number(r.valid_from),
    validTo: r.valid_to == null ? null : Number(r.valid_to),
    validFromSeq: r.valid_from_seq == null ? null : Number(r.valid_from_seq),
    validToSeq: r.valid_to_seq == null ? null : Number(r.valid_to_seq),
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

const LAST_ACTIVITY_DEBOUNCE_MS = 60_000;
const SEARCH_TIMEOUT_MS = 10_000;

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
  const participantSessionsSql = (extraWhere: string): string =>
    `SELECT s.*, p.title AS p_title, p.archived AS p_archived, p.pinned AS p_pinned, p.color AS p_color,
            COALESCE(MAX(e.created_at), s.created_at) AS user_last_activity,
            EXISTS (SELECT 1 FROM session_entries x WHERE x.session_id = s.id
                      AND ${withinParticipantWindow("x", "p")}) AS has_entries
       FROM sessions s
       JOIN participants p ON p.session_id = s.id
       LEFT JOIN session_entries e ON e.session_id = s.id AND e.type = 'user'
      WHERE p.principal_id = $1${extraWhere}
      GROUP BY s.id, p.title, p.archived, p.pinned, p.color, p.valid_from, p.valid_to, p.valid_from_seq, p.valid_to_seq`;
  const participantSessions = async (principalId: string, opts?: { limit: number }): Promise<Session[]> => {
    const limit = opts ? Math.max(0, Math.floor(opts.limit)) : undefined;
    const rows = await q(
      participantSessionsSql("") +
        (limit === undefined ? "" : " ORDER BY COALESCE(s.last_activity, s.created_at) DESC, s.id LIMIT $2"),
      limit === undefined ? [principalId] : [principalId, limit],
    );
    return rows.map(rowToParticipantSession);
  };
  const participantSession = async (sessionId: string, principalId: string): Promise<Session | null> => {
    const rows = await q(participantSessionsSql(" AND s.id = $2"), [principalId, sessionId]);
    return rows[0] ? rowToParticipantSession(rows[0]) : null;
  };
  const originExpr = (alias: string): string =>
    `COALESCE(${alias}.origin, ${threadRefOriginExpr(`${alias}.thread_ref`)})`;
  const cronIdExpr = (alias: string): string =>
    `COALESCE(${alias}.origin_id, ${threadRefCronIdExpr(`${alias}.thread_ref`)})`;
  const isBackground = (alias: string): string => `${originExpr(alias)} <> 'conversation'`;
  const hasOrigin = (alias: string, origin: SessionOrigin): string => `${originExpr(alias)} = '${origin}'`;
  const originFilterClause = (alias: string, origin: SessionOriginFilter): string =>
    origin === "other_background" ? `${originExpr(alias)} NOT IN ('conversation', 'cron')` : hasOrigin(alias, origin);
  const previewExpr = (col: string): string =>
    `(SELECT CASE WHEN json_typeof(j -> 'text') = 'string' THEN j ->> 'text'
                  WHEN json_typeof(j) = 'string' THEN j #>> '{}'
                  ELSE NULL END
        FROM (SELECT safe_json(replace(${col}, '\\u0000', '')) AS j) _)`;

  const recountRecentSessions = `UPDATE sessions s
        SET messages = c.messages, turns = c.turns, last_activity = c.last_activity
       FROM (SELECT r.id,
                    (SELECT COUNT(*) FROM session_entries t WHERE t.session_id = r.id)::int AS messages,
                    (SELECT COUNT(*) FROM session_entries t WHERE t.session_id = r.id AND ${userTurn("t")})::int AS turns,
                    GREATEST(COALESCE(r.last_activity, 0), r.created_at, COALESCE((SELECT MAX(t.created_at) FROM session_entries t WHERE t.session_id = r.id), 0)) AS last_activity
               FROM sessions r
              WHERE r.messages IS NULL
                 OR ${lastActivityExpr("r")} > (EXTRACT(EPOCH FROM now()) * 1000)::bigint - 172800000) c
      WHERE s.id = c.id
        AND (s.messages IS DISTINCT FROM c.messages
          OR s.turns IS DISTINCT FROM c.turns
          OR s.last_activity IS DISTINCT FROM c.last_activity)`;

  const { pool, q } = createPgPool(
    connectionString,
    [
      {
        id: "sessions/store/0001",
        expectedChecksum: "cf56c9f6488806677a229698193ef6dd7cb74300c343bdb1930c17702c5ccf2f",
        statements: [
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
          `CREATE INDEX IF NOT EXISTS sessions_by_scope ON sessions(scope_id, created_at DESC)`,
          `CREATE INDEX IF NOT EXISTS sessions_by_activity ON sessions((COALESCE(last_activity, created_at)) DESC, id DESC)`,
          `CREATE INDEX IF NOT EXISTS sessions_by_scope_activity
        ON sessions(scope_id, (COALESCE(last_activity, created_at)) DESC, id DESC)`,
          `CREATE INDEX IF NOT EXISTS session_entries_user_ts ON session_entries(created_at) WHERE type = 'user'`,
          `CREATE INDEX IF NOT EXISTS session_entries_session_created ON session_entries(session_id, created_at DESC)`,
          `DELETE FROM session_entries WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
          `DELETE FROM participants WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
          `DELETE FROM session_leases WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
          `DELETE FROM session_llm_requests WHERE session_id IN (SELECT id FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$')`,
          `DELETE FROM sessions WHERE type IN ('channel','group') AND thread_ref ~ '^[a-z0-9_]+/[^:/]+$'`,
        ],
      },
      {
        id: "sessions/store/0002",
        expectedChecksum: "ca9877865861adf81cfb433750327462aedcfa1e60d4e87a7845d1a77f64c2ec",
        statements: [
          `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS forked_from_session_id TEXT`,
          `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS forked_from_title TEXT`,
          `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS fork_boundary_seq INT`,
          `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_fork_provenance_pair') THEN
          ALTER TABLE sessions ADD CONSTRAINT sessions_fork_provenance_pair
          CHECK ((forked_from_session_id IS NULL) = (fork_boundary_seq IS NULL)) NOT VALID;
        END IF;
      END $$`,
          `ALTER TABLE session_llm_requests ALTER COLUMN request DROP NOT NULL`,
          `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS prompt_hash TEXT`,
          `CREATE TABLE IF NOT EXISTS llm_prompt_envelopes(
        hash TEXT PRIMARY KEY, body TEXT NOT NULL, created_at BIGINT NOT NULL
      )`,
        ],
      },
      {
        id: "sessions/store/0003",
        expectedChecksum: "fd77efdccf169dee81da809a54313be30a0aaf92cdea4f6c33e34555bb2396c8",
        statements: [
          `CREATE OR REPLACE FUNCTION entry_search_text(payload text) RETURNS text
        LANGUAGE plpgsql IMMUTABLE PARALLEL UNSAFE AS $entry_search_text$
        DECLARE j json;
        BEGIN
          j := replace(payload, '\\u0000', '')::json;
          RETURN CASE WHEN json_typeof(j -> 'text') = 'string' THEN j ->> 'text'
                      WHEN json_typeof(j) = 'string' THEN j #>> '{}'
                      ELSE NULL END;
        EXCEPTION WHEN others THEN RETURN NULL;
        END $entry_search_text$`,
          `CREATE INDEX IF NOT EXISTS session_entries_search_fts
        ON session_entries USING GIN (to_tsvector('simple', COALESCE(entry_search_text(payload), '')))
        WHERE type IN ('user', 'assistant', 'text')`,
        ],
      },
      {
        id: "sessions/store/0004",
        expectedChecksum: "856cc6940c934b59e37d511271630f77d72b235c92ab0e2e2085207d15750a75",
        statements: [
          `CREATE TABLE IF NOT EXISTS session_pins(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT, entry_seq INT,
        added_by TEXT NOT NULL, created_at BIGINT NOT NULL
      )`,
          `CREATE INDEX IF NOT EXISTS session_pins_by_session ON session_pins(session_id, created_at)`,
        ],
      },
      {
        id: "sessions/store/0005",
        expectedChecksum: "4b0824aa4311df8c66b57b16f331e9dcf3dfc8d11c112a000d83f46b1fba1bd0",
        statements: [
          `CREATE INDEX IF NOT EXISTS session_entries_user_attributed
        ON session_entries(session_id, created_at, seq)
        WHERE type = 'user' AND (payload IS NULL OR payload NOT LIKE '%"overheard":true%')`,
        ],
      },
      {
        id: "sessions/store/0006",
        expectedChecksum: "57037691db0c87e9eeb28927758ae35e426eb8a8b7f7b5b8440bb08817f39203",
        statements: [
          `ALTER FUNCTION entry_search_text(text) PARALLEL SAFE`,
          `ALTER TABLE session_entries ADD COLUMN IF NOT EXISTS search_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(entry_search_text(payload), ''))) STORED`,
          `CREATE INDEX IF NOT EXISTS session_entries_search_tsv
        ON session_entries USING GIN (search_tsv)
        WHERE type IN ('user', 'assistant', 'text')`,
          `DROP INDEX IF EXISTS session_entries_search_fts`,
        ],
      },
      {
        id: "sessions/store/0007",
        expectedChecksum: "8322f0c560da60399baf59f0364e8125e836384cd8b4d9795bd1c114d4d7d514",
        statements: [`ALTER TABLE session_tape ADD COLUMN IF NOT EXISTS attachments TEXT`],
      },
      {
        id: "sessions/store/0008",
        expectedChecksum: "4b32bec77fa021de97736856a70a45bf1e51e59e574987e0d044fe748ec4cf58",
        statements: [
          `ALTER TABLE session_tape ADD COLUMN IF NOT EXISTS display TEXT`,
          `ALTER TABLE session_tape ADD COLUMN IF NOT EXISTS security_tainted BOOLEAN`,
          `ALTER TABLE session_tape ADD COLUMN IF NOT EXISTS entry_created_at BIGINT`,
        ],
      },
      {
        id: "sessions/store/0009",
        expectedChecksum: "40558264e0589a236a8a5a688a42eb49acf8a774371b9e1c6a3e5e0a84065c7d",
        statements: [
          `CREATE TABLE IF NOT EXISTS session_entry_search(
        session_id TEXT NOT NULL, seq INT NOT NULL, type TEXT NOT NULL,
        author TEXT, text TEXT NOT NULL, created_at BIGINT NOT NULL,
        search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
        PRIMARY KEY(session_id, seq)
      )`,
          `CREATE INDEX IF NOT EXISTS session_entry_search_tsv
        ON session_entry_search USING GIN (search_tsv)`,
        ],
      },
      {
        id: "sessions/store/0010",
        expectedChecksum: "29832445f9d3bfaf0d97f11b2748a1ca533ff57c6f4bd96c594e83a6ab4f7c9a",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `DROP INDEX IF EXISTS sessions_by_activity`,
          `ALTER TABLE sessions SET (fillfactor = 70)`,
        ],
      },
      {
        id: "sessions/store/0011",
        expectedChecksum: "be590472124ab471453cfbbd7d3c1a0c57f792c97704707fba3682f4183f870d",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS origin TEXT`,
          `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS origin_id TEXT`,
        ],
      },
      {
        id: "sessions/store/0012",
        expectedChecksum: "6f52591c733daffdda7aca112ad5a21cfec5c0c36f97838d74b107a79b7100bf",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `CREATE INDEX IF NOT EXISTS session_llm_requests_screens
        ON session_llm_requests(created_at DESC) WHERE step = -1`,
        ],
      },
      {
        id: "sessions/store/0013",
        expectedChecksum: "86c8d0eff24f8f2deab4f33eccff6d0206b3a9a64943a812eec0965203dd5262",
        statements: [
          `CREATE EXTENSION IF NOT EXISTS btree_gin`,
          `CREATE INDEX IF NOT EXISTS session_entries_session_search_tsv
        ON session_entries USING GIN (session_id, search_tsv)
        WHERE type IN ('user', 'assistant', 'text')`,
          `CREATE INDEX IF NOT EXISTS session_entry_search_session_tsv
        ON session_entry_search USING GIN (session_id, search_tsv)`,
        ],
      },
      {
        id: "sessions/store/0014-search-write-through-v1",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `CREATE OR REPLACE FUNCTION sync_session_entry_search() RETURNS trigger
           LANGUAGE plpgsql AS $sync_session_entry_search$
           DECLARE body text;
           BEGIN
             IF TG_OP = 'DELETE' THEN
               DELETE FROM session_entry_search WHERE session_id = OLD.session_id AND seq = OLD.seq;
               RETURN OLD;
             END IF;
             IF TG_OP = 'UPDATE' AND (OLD.session_id, OLD.seq) IS DISTINCT FROM (NEW.session_id, NEW.seq) THEN
               DELETE FROM session_entry_search WHERE session_id = OLD.session_id AND seq = OLD.seq;
             END IF;
             IF NEW.type IN ('user', 'assistant', 'text') THEN
               body := entry_search_text(NEW.payload);
             END IF;
             IF body IS NULL OR btrim(body) = '' THEN
               DELETE FROM session_entry_search WHERE session_id = NEW.session_id AND seq = NEW.seq;
             ELSE
               INSERT INTO session_entry_search(session_id, seq, type, author, text, created_at)
               VALUES (NEW.session_id, NEW.seq, NEW.type,
                       CASE WHEN NEW.type = 'user' THEN
                         (SELECT CASE WHEN json_typeof(j -> 'name') = 'string' THEN j ->> 'name' END
                            FROM (SELECT safe_json(replace(NEW.payload, '\\u0000', '')) AS j) _) END,
                       body, NEW.created_at)
               ON CONFLICT (session_id, seq) DO UPDATE
                 SET type = EXCLUDED.type, author = EXCLUDED.author, text = EXCLUDED.text,
                     created_at = EXCLUDED.created_at;
             END IF;
             RETURN NEW;
           END $sync_session_entry_search$`,
          `CREATE TRIGGER session_entries_search_write_through
           AFTER INSERT OR UPDATE OF payload, type, created_at, session_id, seq OR DELETE ON session_entries
           FOR EACH ROW EXECUTE FUNCTION sync_session_entry_search()`,
        ],
      },
      {
        id: "sessions/store/0015-search-backfill-v1",
        statements: [
          `WITH missing AS MATERIALIZED (
             SELECT e.session_id, e.seq, e.type,
                    CASE WHEN e.type = 'user' THEN
                      (SELECT CASE WHEN json_typeof(j -> 'name') = 'string' THEN j ->> 'name' END
                         FROM (SELECT safe_json(replace(e.payload, '\\u0000', '')) AS j) _) END AS author,
                    entry_search_text(e.payload) AS text, e.created_at
               FROM session_entries e
              WHERE e.type IN ('user', 'assistant', 'text')
                AND NOT EXISTS (SELECT 1 FROM session_entry_search s WHERE s.session_id = e.session_id AND s.seq = e.seq)
              FOR SHARE OF e
           )
           INSERT INTO session_entry_search(session_id, seq, type, author, text, created_at)
           SELECT session_id, seq, type, author, text, created_at FROM missing
            WHERE COALESCE(btrim(text), '') <> ''
           ON CONFLICT (session_id, seq) DO NOTHING`,
        ],
      },
    ],
    [
      {
        id: "sessions/maintenance/safe-jsonb-parallel",
        statements: [
          `DO $safe_jsonb_parallel$
        BEGIN
          IF to_regprocedure('safe_jsonb(text)') IS NOT NULL THEN
            ALTER FUNCTION safe_jsonb(text) PARALLEL UNSAFE;
          END IF;
        END $safe_jsonb_parallel$`,
        ],
      },
      {
        id: "sessions/maintenance/entry-search-text-parallel",
        statements: [
          `DO $entry_search_text_parallel$
        BEGIN
          IF to_regprocedure('entry_search_text(text)') IS NOT NULL THEN
            ALTER FUNCTION entry_search_text(text) PARALLEL UNSAFE;
          END IF;
        END $entry_search_text_parallel$`,
        ],
      },
      { id: "sessions/maintenance/recount-recent", statements: [recountRecentSessions] },
    ],
  );

  const lockSession = (client: PoolClient, sessionId: string) =>
    client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [sessionId]);

  const withLease = async <T>(lease: Lease, invalidMsg: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    withPgTransaction(await pool(), async (client) => {
      await lockSession(client, lease.sessionId);
      const held = await client.query("SELECT token, expires_at FROM session_leases WHERE session_id = $1 FOR UPDATE", [
        lease.sessionId,
      ]);
      if (held.rows[0]?.token !== lease.token || Number(held.rows[0]!.expires_at) <= now()) throw new Error(invalidMsg);
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
      `INSERT INTO session_tape(session_id, seq, kind, harness, payload, scope_label, bare_text, ts, change_time, hidden, overheard, author, attachments, display, security_tainted, entry_created_at, entry_seq, covers_entry_seq, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
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
        rec.meta?.attachments !== undefined ? jsonbSafeStringify(rec.meta.attachments) : null,
        rec.meta?.display ?? null,
        rec.meta?.securityTainted ?? null,
        rec.meta?.entryCreatedAt ?? null,
        rec.entrySeq ?? null,
        rec.coversEntrySeq ?? null,
        createdAt,
      ],
    );
    return { ...rec, payload: JSON.parse(stored), sessionId, seq, createdAt };
  };

  return {
    leaseTtlMs,
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
        "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, channel_name, surface, last_activity, messages, turns, origin, origin_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$5,0,0,$8,$9) ON CONFLICT (thread_ref) DO NOTHING",
        [
          session.id,
          session.type,
          session.scopeId,
          session.threadRef,
          session.createdAt,
          channelName ?? null,
          surface ?? null,
          sessionOrigin(threadRef),
          cronIdOf(threadRef),
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
        for (;;) {
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
          if (row) {
            return {
              lease: null,
              ...(row.holder != null ? { heldBy: row.holder as LeaseHolder } : {}),
              ...(row.acquired_at != null ? { heldSince: Number(row.acquired_at) } : {}),
              heldUntil: Number(row.expires_at),
            };
          }
          const exists = await client.query("SELECT 1 FROM sessions WHERE id = $1", [sessionId]);
          if (!exists.rows[0]) return { lease: null };
        }
      });
    },

    async peekLease(sessionId): Promise<LeasePeek | null> {
      const rows = await q("SELECT holder, expires_at FROM session_leases WHERE session_id = $1", [sessionId]);
      const row = rows[0];
      if (!row) return null;
      return {
        ...(row.holder != null ? { holder: row.holder as LeaseHolder } : {}),
        heldUntil: Number(row.expires_at),
      };
    },

    async renewLease(lease): Promise<boolean> {
      const t = now();
      const rows = await q(
        "UPDATE session_leases SET expires_at = $3 WHERE session_id = $1 AND token = $2 AND expires_at > $4 RETURNING token",
        [lease.sessionId, lease.token, t + leaseTtlMs, t],
      );
      return rows.length > 0;
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
              SET last_activity = CASE WHEN last_activity >= $2::bigint - ${LAST_ACTIVITY_DEBOUNCE_MS}
                                       THEN last_activity
                                       ELSE GREATEST(COALESCE(last_activity, 0), $2::bigint) END,
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

    async latestEntrySeq(sessionId): Promise<number> {
      const rows = await q("SELECT COALESCE(MAX(seq), -1) AS n FROM session_entries WHERE session_id = $1", [
        sessionId,
      ]);
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

    async getContextWindow(sessionId) {
      const [meta, summary] = await Promise.all([
        q(
          `SELECT count(*)::int AS total,
                  bool_or((payload::jsonb -> 'securityTainted') = 'true'::jsonb) AS taint
             FROM session_entries WHERE session_id = $1`,
          [sessionId],
        ),
        q(
          `SELECT (payload::jsonb ->> 'throughSeq')::int AS through
             FROM session_entries
            WHERE session_id = $1 AND type = 'system'
              AND payload::jsonb ->> 'kind' = 'context_summary'
              AND jsonb_typeof(payload::jsonb -> 'throughSeq') = 'number'
              AND jsonb_typeof(payload::jsonb -> 'text') = 'string'
            ORDER BY seq DESC LIMIT 1`,
          [sessionId],
        ),
      ]);
      const through = summary[0]?.through;
      const sinceSeq = typeof through === "number" ? through + 1 : 0;
      const rows = await q("SELECT * FROM session_entries WHERE session_id = $1 AND seq >= $2 ORDER BY seq ASC", [
        sessionId,
        sinceSeq,
      ]);
      return {
        entries: rows.map(rowToEntry),
        totalEntries: Number(meta[0]?.total ?? 0),
        hasSecurityTaint: meta[0]?.taint === true,
      };
    },

    async getEntry(sessionId, seq): Promise<SessionEntry | undefined> {
      const rows = await q("SELECT * FROM session_entries WHERE session_id = $1 AND seq = $2", [sessionId, seq]);
      return rows[0] ? rowToEntry(rows[0]) : undefined;
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

    async listScreenSamples(limit): Promise<ScreenSample[]> {
      const wanted = Math.max(0, Math.trunc(limit));
      const pageSize = Math.max(wanted, 100);
      const samples: ScreenSample[] = [];
      let beforeAt: number | null = null;
      let beforeId: string | null = null;
      while (samples.length < wanted) {
        const rows = await q(
          `SELECT r.id, r.session_id, r.scope_label, r.created_at, r.model, e.body AS prompt_body
             FROM session_llm_requests r JOIN llm_prompt_envelopes e ON e.hash = r.prompt_hash
            WHERE r.step = $1
              AND ($3::bigint IS NULL OR (r.created_at, r.id) < ($3::bigint, $4::text))
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT $2`,
          [SECURITY_SCREEN_STEP, pageSize, beforeAt, beforeId],
        );
        for (const r of rows) {
          const payload = screenPayloadFromEnvelope(JSON.parse(r.prompt_body as string));
          if (!payload) continue;
          samples.push({
            id: r.id as string,
            sessionId: r.session_id as string,
            scopeLabel: r.scope_label as ScopeId,
            createdAt: Number(r.created_at),
            model: r.model as string,
            payload,
          });
          if (samples.length === wanted) return samples;
        }
        if (rows.length < pageSize) break;
        const last = rows.at(-1)!;
        beforeAt = Number(last.created_at);
        beforeId = last.id as string;
      }
      return samples;
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
        await client.query("DELETE FROM session_entry_search WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM session_pins WHERE session_id = $1", [sessionId]);
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
        await client.query("DELETE FROM session_entry_search WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM session_pins WHERE session_id = $1", [sessionId]);
        return true;
      });
    },

    async listByParticipant(principalId, opts): Promise<Session[]> {
      return participantSessions(principalId, opts);
    },

    async getForParticipant(sessionId, principalId): Promise<Session | null> {
      return participantSession(sessionId, principalId);
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

    async addPin(sessionId, pin: NewSessionPin, maxPins?: number): Promise<SessionPin | null> {
      const rec: SessionPin = { ...pin, id: randomUUID(), sessionId, createdAt: now() };
      return withPgTransaction(await pool(), async (client) => {
        await lockSession(client, sessionId);
        const inserted = await client.query(
          `INSERT INTO session_pins(id, session_id, text, entry_seq, added_by, created_at)
           SELECT $1, $2, $3, $4, $5, $6
            WHERE EXISTS (SELECT 1 FROM sessions WHERE id = $2)
              AND ($7::int IS NULL OR (SELECT COUNT(*) FROM session_pins WHERE session_id = $2) < $7)
           RETURNING id`,
          [rec.id, sessionId, rec.text ?? null, rec.entrySeq ?? null, rec.addedBy, rec.createdAt, maxPins ?? null],
        );
        return inserted.rowCount ? rec : null;
      });
    },

    async listPins(sessionId): Promise<SessionPin[]> {
      const rows = await q(
        "SELECT id, session_id, text, entry_seq, added_by, created_at FROM session_pins WHERE session_id = $1 ORDER BY created_at ASC, id ASC",
        [sessionId],
      );
      return rows.map((r) => ({
        id: r.id as string,
        sessionId: r.session_id as string,
        ...(r.text != null ? { text: r.text as string } : {}),
        ...(r.entry_seq != null ? { entrySeq: Number(r.entry_seq) } : {}),
        addedBy: r.added_by as string,
        createdAt: Number(r.created_at),
      }));
    },

    async removePin(sessionId, pinId): Promise<boolean> {
      const res = await q("DELETE FROM session_pins WHERE session_id = $1 AND id = $2 RETURNING id", [
        sessionId,
        pinId,
      ]);
      return res.length > 0;
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
        `WITH viewer AS MATERIALIZED (
           SELECT session_id, valid_from_seq, valid_from, valid_to_seq, valid_to, title, archived
             FROM participants WHERE principal_id = $1
         ), candidates AS MATERIALIZED (
           SELECT session_id, seq, type, author, text, created_at
             FROM session_entry_search
            WHERE session_id = ANY(ARRAY(SELECT session_id FROM viewer))
              AND search_tsv @@ to_tsquery('simple', $2)
         )
         SELECT h.*, s.scope_id, COALESCE(p.title, s.title) AS title, s.channel_name, s.surface, p.archived
           FROM candidates h
           JOIN viewer p ON p.session_id = h.session_id
           JOIN sessions s ON s.id = h.session_id
          WHERE ${withinParticipantWindow("h", "p")}
          ORDER BY h.created_at DESC, h.session_id, h.seq DESC
          LIMIT $3`,
        [principalId, ts, Math.max(1, Math.min(limit, 200))],
        { timeoutMs: SEARCH_TIMEOUT_MS },
      );
      return rows.flatMap((r) => {
        const text = (r.text as string | null) ?? "";
        if (!text.trim()) return [];
        return [
          {
            sessionId: r.session_id as string,
            scopeId: r.scope_id as ScopeId,
            ...(r.title != null ? { title: r.title as string } : {}),
            ...(r.channel_name ? { channelName: r.channel_name as string } : {}),
            ...(r.surface ? { surface: r.surface as string } : {}),
            ...(r.archived ? { archived: true } : {}),
            seq: Number(r.seq),
            type: r.type as EntrySearchHit["type"],
            ...(r.author ? { author: r.author as string } : {}),
            text,
            createdAt: Number(r.created_at),
          },
        ];
      });
    },

    async appendSearchEntries(lease, rows): Promise<void> {
      if (!rows.length) return;
      await withLease(lease, "search index append without a valid session lease", async (client) => {
        for (const row of rows) {
          await client.query(
            `INSERT INTO session_entry_search(session_id, seq, type, author, text, created_at)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (session_id, seq) DO NOTHING`,
            [
              lease.sessionId,
              row.seq,
              row.type,
              row.author?.replaceAll("\u0000", "") ?? null,
              row.text.replaceAll("\u0000", ""),
              row.createdAt,
            ],
          );
        }
      });
    },

    async searchIndexCoverage(sessionId): Promise<number> {
      const rows = await q("SELECT COALESCE(MAX(seq), -1) AS n FROM session_entry_search WHERE session_id = $1", [
        sessionId,
      ]);
      return Number(rows[0]?.n ?? -1);
    },

    async missingSearchEntries(sessionId): Promise<number> {
      const rows = await q(
        `WITH missing AS MATERIALIZED (
           SELECT entry_search_text(e.payload) AS text FROM session_entries e
            WHERE e.session_id = $1 AND e.type IN ('user', 'assistant', 'text')
              AND NOT EXISTS (SELECT 1 FROM session_entry_search s WHERE s.session_id = e.session_id AND s.seq = e.seq)
         )
         SELECT COUNT(*) AS n FROM missing WHERE COALESCE(btrim(text), '') <> ''`,
        [sessionId],
      );
      return Number(rows[0]?.n ?? 0);
    },

    async lastSearchableEntrySeq(sessionId): Promise<number> {
      const rows = await q(
        `SELECT COALESCE(MAX(seq), -1) AS n FROM session_entries
          WHERE session_id = $1 AND type IN ('user', 'assistant', 'text')
            AND COALESCE(btrim(entry_search_text(payload)), '') <> ''`,
        [sessionId],
      );
      return Number(rows[0]?.n ?? -1);
    },

    async scanAll(): Promise<Session[]> {
      const rows = await q("SELECT * FROM sessions");
      return rows.map(rowToSession);
    },

    async countSessions(): Promise<number> {
      const rows = await q("SELECT COUNT(*) AS n FROM sessions");
      return Number(rows[0]?.n ?? 0);
    },

    async listByScope(scope): Promise<Session[]> {
      const rows = await q("SELECT * FROM sessions WHERE scope_id = $1 ORDER BY created_at DESC, id DESC", [scope]);
      return rows.map(rowToSession);
    },

    async scopeHasSessions(scope): Promise<boolean> {
      const rows = await q("SELECT EXISTS(SELECT 1 FROM sessions WHERE scope_id = $1) AS present", [scope]);
      return Boolean(rows[0]?.present);
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

    async scopeSessionSummaries(scope, orgWide, page?: SessionPage, sessionIds?: string[]): Promise<SessionSummary[]> {
      const params: unknown[] = [orgWide, scope];
      let categoryClause = "";
      if (page?.category === "background") categoryClause = ` AND ${isBackground("s")}`;
      else if (page?.category) categoryClause = ` AND NOT ${isBackground("s")}`;
      const originClause = page?.origin ? ` AND ${originFilterClause("s", page.origin)}` : "";
      let idsClause = "";
      if (sessionIds) {
        params.push(sessionIds);
        idsClause = ` AND s.id = ANY($${params.length})`;
      }
      let cronClause = "";
      if (page?.cronId) {
        params.push(page.cronId);
        cronClause = ` AND ${cronIdExpr("s")} = $${params.length}`;
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
      const rows = await q(
        `SELECT s.id, s.type, s.scope_id, s.thread_ref, s.created_at,
                COALESCE(s.messages, 0) AS messages,
                COALESCE(s.turns, 0) AS turns,
                ${lastActivityExpr("s")} AS last_activity,
                (SELECT ${previewExpr("fe.payload")} FROM session_entries fe
                  WHERE fe.session_id = s.id AND ${userTurn("fe")}
                  ORDER BY fe.seq ASC LIMIT 1) AS first_user,
                (SELECT ${previewExpr("le.payload")} FROM session_entries le
                  WHERE le.session_id = s.id AND ${userTurn("le")}
                  ORDER BY le.seq DESC LIMIT 1) AS last_user
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
        `SELECT t.cron_id,
                MIN(t.scope_id) AS scope_id,
                COUNT(*) AS sessions,
                COALESCE(SUM(t.messages), 0) AS messages,
                COALESCE(SUM(t.turns), 0) AS turns,
                MAX(t.activity) AS last_activity,
                MIN(t.created_at) AS created_at
           FROM (SELECT ${cronIdExpr("s")} AS cron_id, s.scope_id, s.messages, s.turns, s.created_at,
                        ${lastActivityExpr("s")} AS activity
                   FROM sessions s
                  WHERE ($1::boolean OR s.scope_id = $2)) t
          WHERE t.cron_id IS NOT NULL
          GROUP BY t.cron_id
          ORDER BY last_activity DESC, t.cron_id DESC`,
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

    async scopeSessionRollups(scope, orgWide): Promise<ScopeSessionRollup[]> {
      const rows = await q(
        `SELECT scope_id,
                COUNT(*) FILTER (WHERE NOT background) AS sessions,
                COUNT(*) FILTER (WHERE background) AS background_sessions,
                MAX(last_activity) AS last_activity,
                COALESCE(MAX(last_activity) FILTER (WHERE NOT background), 0) AS last_conversation_activity,
                (array_agg(id ORDER BY last_activity DESC, id DESC) FILTER (WHERE NOT background AND turns > 0))[1]
                  AS preview_session_id
           FROM (SELECT s.scope_id, s.id, COALESCE(s.turns, 0) AS turns,
                        ${lastActivityExpr("s")} AS last_activity,
                        ${isBackground("s")} AS background
                   FROM sessions s
                  WHERE ($1::boolean OR s.scope_id = $2)) t
          GROUP BY scope_id`,
        [orgWide, scope],
      );
      return rows.map((r) => ({
        scopeId: r.scope_id as ScopeId,
        sessions: Number(r.sessions),
        backgroundSessions: Number(r.background_sessions),
        lastActivity: Number(r.last_activity),
        lastConversationActivity: Number(r.last_conversation_activity),
        previewSessionId: (r.preview_session_id as string | null) ?? null,
      }));
    },

    async scopeSessionStats(scope, orgWide, category, originFilter, cronId): Promise<ScopeSessionStats> {
      const params: unknown[] = [orgWide, scope];
      const matchedClauses: string[] = [];
      if (category) {
        matchedClauses.push(category === "background" ? isBackground("s") : `NOT ${isBackground("s")}`);
      }
      if (originFilter) matchedClauses.push(originFilterClause("s", originFilter));
      if (cronId) {
        params.push(cronId);
        matchedClauses.push(`${cronIdExpr("s")} = $${params.length}`);
      }
      const rows = await q(
        `SELECT origin, CASE WHEN origin = 'conversation' THEN type ELSE origin END AS bucket,
                matched, COUNT(*) AS sessions, COALESCE(SUM(turns), 0) AS turns,
                COUNT(DISTINCT cron_id) AS crons
           FROM (SELECT s.type, ${originExpr("s")} AS origin,
                        ${cronIdExpr("s")} AS cron_id,
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
      const rows = await q(
        "SELECT session_id, principal_id, valid_from, valid_to, valid_from_seq, valid_to_seq FROM participants",
      );
      return rows.map(rowToParticipantWindow);
    },

    async distinctParticipants(): Promise<string[]> {
      const rows = await q("SELECT DISTINCT principal_id FROM participants");
      return rows.map((r) => r.principal_id as string);
    },

    async participantWindowsOf(sessionId): Promise<ParticipantWindow[]> {
      const rows = await q(
        "SELECT session_id, principal_id, valid_from, valid_to, valid_from_seq, valid_to_seq FROM participants WHERE session_id = $1",
        [sessionId],
      );
      return rows.map(rowToParticipantWindow);
    },

    async participantsOf(sessionId): Promise<string[]> {
      const rows = await q("SELECT principal_id FROM participants WHERE session_id = $1", [sessionId]);
      return rows.map((r) => r.principal_id as string);
    },
  };
}
