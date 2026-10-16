import { DIRECTORY_MIGRATIONS } from "../directory/postgres-directory-store.ts";
import { randomUUID } from "node:crypto";
import { jsonbStringify } from "../persistence/durable-map.ts";
import {
  createPgPool,
  type PgPool,
  type PoolClient,
  type PgQueryOptions,
  type Rows,
  withPgTransaction,
} from "../persistence/pg-pool.ts";
import { jsonbSafeStringify, pgTextSafe } from "../util/text.ts";
import { reportFailure, reportFailureAs } from "../util/errors.ts";
import type { Session, SessionEntry, SessionType, ScopeId } from "../types.ts";
import type { GoalRecord } from "../harness/goal.ts";
import type {
  NewSessionPin,
  SessionPin,
  AttributedTurn,
  EntrySearchHit,
  CronGroupSummary,
  ScopeSessionRollup,
  DistinctScope,
  GetEntriesOptions,
  Lease,
  LeaseAttempt,
  LeaseHolder,
  LeasePeek,
  LlmRequestRecord,
  NewEntry,
  NewLlmRequest,
  ParticipantWindow,
  ScopeSessionStats,
  ScreenSample,
  SessionOrigin,
  SessionOriginFilter,
  SessionPage,
  SessionRef,
  SessionStore,
  SessionSummary,
  SpendRow,
  StoreOptions,
} from "./session-store.ts";
import { tsPrefixQuery } from "./entry-search.ts";
import { itemsMigration } from "./items-schema.ts";
import {
  DROP_SESSION_TAPE_SQL,
  LEGACY_TAPE_STEPS_SIZE_GUARD_SQL,
  LEGACY_TAPE_STEPS_SQL,
  PREPARE_TAPE_DROP_SQL,
} from "./legacy-tape-steps.ts";
import {
  cronIdOf,
  legacyOriginPattern,
  ORIGIN_ALTERNATION,
  promptEnvelopeBody,
  sessionOrigin,
  stableOriginPattern,
  threadRefCronIdExpr,
  userMessagePreview,
  isWebThread,
  isOverheardEntry,
  DuplicateCallError,
} from "./session-store.ts";
import {
  entryFromItem,
  itemFromEntry,
  ITEM_COLUMNS,
  type ItemRow,
  msOf,
  AGENT_REPLY_ITEM,
  SEARCHABLE_ITEM,
  USER_KINDS,
} from "./items.ts";
import { ITEMS_CUTOVER_SQL } from "./items-cutover.ts";
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

function rowToGoal(r: Record<string, unknown>): GoalRecord {
  return {
    objective: r.objective as string,
    status: r.status as GoalRecord["status"],
    tokensUsed: Number(r.tokens_used),
    createdAt: (r.created_at as Date).getTime(),
    updatedAt: (r.updated_at as Date).getTime(),
    ...(r.floor != null ? { floor: r.floor as GoalRecord["floor"] } : {}),
    ...(r.token_cap != null ? { capTokens: Number(r.token_cap) } : {}),
    ...(r.active_ms != null ? { activeMs: Number(r.active_ms) } : {}),
    ...(r.active_since != null ? { activeSince: (r.active_since as Date).getTime() } : {}),
    ...(r.completion_note != null ? { completionNote: r.completion_note as string } : {}),
    ...(r.cancel_note != null ? { cancelNote: r.cancel_note as string } : {}),
    ...(r.governor != null ? { governor: r.governor as GoalRecord["governor"] } : {}),
    ...(r.pause_reason != null ? { pauseReason: r.pause_reason as string } : {}),
  };
}

export function rowToSession(r: Record<string, unknown>): Session {
  return {
    id: r.id as string,
    type: r.type as SessionType,
    scopeId: r.scope_id as ScopeId,
    threadRef: r.thread_ref as string,
    ...(r.surface != null ? { surface: r.surface as string } : {}),
    ...(r.client_tools ? { clientTools: r.client_tools as Session["clientTools"] } : {}),
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
    ...(r.parent_session_id != null ? { parentSessionId: r.parent_session_id as string } : {}),
    ...(r.spawn_meta != null ? { spawnMeta: JSON.parse(r.spawn_meta as string) as Session["spawnMeta"] } : {}),
  };
}

function rowToParticipantSession(r: Record<string, unknown>): Session {
  const s = rowToSession(r);
  if (r.p_title != null) s.title = r.p_title as string;
  if (r.p_archived) s.archived = true;
  if (r.p_pinned) s.pinned = true;
  if (r.p_color != null) s.color = r.p_color as string;
  if (r.agent_last_reply != null && Number(r.agent_last_reply) > Number(r.p_read_at ?? 0) && isWebThread(s.threadRef))
    s.unread = true;
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
  return entryFromItem({
    sessionId: r.session_id as string,
    seq: Number(r.seq),
    ...(Object.fromEntries(
      ITEM_COLUMNS.map(([, key, type]) => [
        key,
        type === "bigint" && r[key] != null ? Number(r[key]) : (r[key] ?? null),
      ]),
    ) as unknown as ItemRow),
    scopeLabel: r.scope_label as ScopeId,
    createdAt: Number(r.created_at),
  });
}

const ITEM_FIELDS = `i.session_id, i.seq, ${ITEM_COLUMNS.map(([column, key]) => `${column === "blob_sha" ? "encode(i.blob_sha, 'hex')" : `i.${column}`} AS "${key}"`).join(",")}, ts.scope_id AS scope_label, ${msOf("i.created_at")} AS created_at`;
const ITEM_FROM = "items i JOIN sessions ts ON ts.id = i.session_id";
const TENANT = "qm_tenant_id()";
const tsOf = (ms: string): string => `to_timestamp((${ms})::double precision / 1000)`;

function rowToSpendRow(r: Record<string, unknown>): SpendRow {
  return {
    day: Number(r.day),
    model: (r.model as string | null) ?? null,
    scopeId: r.scope_id as ScopeId,
    origin: r.origin as SessionOrigin,
    calls: Number(r.calls),
    costUsd: Number(r.cost_usd),
    input: Number(r.input),
    output: Number(r.output),
    cacheRead: Number(r.cache_read),
    cacheWrite: Number(r.cache_write),
  };
}

const LAST_ACTIVITY_DEBOUNCE_MS = 60_000;
const SEARCH_TIMEOUT_MS = 10_000;
const SPEND_INDEXABLE = `(spend_usage_json(usage_json) IS NOT NULL
  AND octet_length(session_id) + octet_length(model) + octet_length(usage_json) <= 2000)`;

const ADMIN_READ_TIMEOUT_MS = 10_000;
const FIRST_PREVIEW_LEN = 160;
const LAST_PREVIEW_LEN = 100;

const storedPreview = (payload: unknown, maxLen: number): string => pgTextSafe(userMessagePreview(payload, maxLen));

export function createPostgresSessionStore(
  connectionString: string,
  opts: StoreOptions & { stageItemsCutover?: boolean } = {},
): SessionStore {
  const now = opts.now ?? (() => Date.now());
  const leaseTtlMs = opts.leaseTtlMs ?? 5 * 60_000;

  const userTurn = (col: string): string =>
    `${col}.kind IN ${USER_KINDS} AND NOT (${col}.body @> '{"overheard":true}')`;
  const lastActivityExpr = (col: string): string => `COALESCE(${col}.last_activity, ${col}.created_at)`;
  const participantWindowBounds = (entry: string, participant: string, item = true) => {
    const at = (ms: string): string => (item ? tsOf(ms) : ms);
    return [
      [
        `(${participant}.valid_from_seq IS NOT NULL AND ${entry}.seq >= ${participant}.valid_from_seq)`,
        `(${participant}.valid_from_seq IS NULL AND ${entry}.created_at >= ${at(`${participant}.valid_from`)})`,
      ],
      [
        `(${participant}.valid_to_seq IS NOT NULL AND ${entry}.seq < ${participant}.valid_to_seq)`,
        `(${participant}.valid_to_seq IS NULL AND ${participant}.valid_to IS NOT NULL AND ${entry}.created_at < ${at(`${participant}.valid_to`)})`,
        `(${participant}.valid_to_seq IS NULL AND ${participant}.valid_to IS NULL)`,
      ],
    ] as const;
  };
  const withinParticipantWindow = (entry: string, participant: string, item = true): string =>
    participantWindowBounds(entry, participant, item)
      .map((bounds) => `(${bounds.join(" OR ")})`)
      .join(" AND ");
  const [fromBounds, toBounds] = participantWindowBounds("x", "p");
  const participantPresenceSql = fromBounds
    .flatMap((from) =>
      toBounds.map(
        (to) => `SELECT 1 FROM items x WHERE x.tenant_id = ${TENANT} AND x.session_id = s.id AND ${from} AND ${to}`,
      ),
    )
    .join(" UNION ALL ");
  const participantSessionsSql = (extraWhere: string): string =>
    `SELECT s.*, p.title AS p_title, p.archived AS p_archived, p.pinned AS p_pinned, p.color AS p_color,
            p.read_at AS p_read_at,
            (SELECT ${msOf("MAX(e.created_at)")} FROM items e
              WHERE e.tenant_id = ${TENANT} AND e.session_id = s.id AND ${AGENT_REPLY_ITEM("e")}) AS agent_last_reply,
            COALESCE((SELECT ${msOf("MAX(e.created_at)")} FROM items e
                       WHERE e.tenant_id = ${TENANT} AND e.session_id = s.id AND e.kind IN ${USER_KINDS}), s.created_at) AS user_last_activity,
            EXISTS (${participantPresenceSql}) AS has_entries
       FROM sessions s
       JOIN participants p ON p.session_id = s.id
      WHERE p.principal_id = $1${extraWhere}`;
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
  const spendSql = `WITH RECURSIVE ancestry AS (
           SELECT s.id AS session_id, s.parent_session_id, ${originExpr("s")} AS origin, ARRAY[s.id] AS path
             FROM sessions s
            WHERE s.parent_session_id IS NOT NULL AND ${originExpr("s")} = 'conversation'
              AND EXISTS (SELECT 1 FROM session_llm_requests r
                           WHERE r.session_id = s.id AND r.created_at >= $1 AND r.created_at < $2
                             AND r.usage_json IS NOT NULL)
           UNION ALL
           SELECT a.session_id, p.parent_session_id, ${originExpr("p")}, a.path || p.id
             FROM ancestry a JOIN sessions p ON p.id = a.parent_session_id
            WHERE a.origin = 'conversation' AND NOT p.id = ANY(a.path) AND cardinality(a.path) < 64
         ), origins AS (
           SELECT DISTINCT ON (session_id) session_id, origin
             FROM ancestry ORDER BY session_id, cardinality(path) DESC
         ), rollup AS MATERIALIZED (
           SELECT (r.created_at / 86400000)::bigint AS day, s.scope_id,
                COALESCE(o.origin, ${originExpr("s")}) AS origin, r.model,
                COUNT(*) AS calls,
                COALESCE(SUM(cost_usd), 0)::text AS cost_usd,
                COALESCE(SUM(input), 0) AS input,
                COALESCE(SUM(output), 0) AS output,
                COALESCE(SUM(cache_read), 0) AS cache_read,
                COALESCE(SUM(cache_write), 0) AS cache_write
           FROM (SELECT created_at, session_id, model,
                        (spend_usage_json(usage_json) ->> 'costUsd')::double precision AS cost_usd,
                        (spend_usage_json(usage_json) ->> 'input')::bigint AS input,
                        (spend_usage_json(usage_json) ->> 'output')::bigint AS output,
                        (spend_usage_json(usage_json) ->> 'cacheRead')::bigint AS cache_read,
                        (spend_usage_json(usage_json) ->> 'cacheWrite')::bigint AS cache_write
                   FROM session_llm_requests
                  WHERE created_at >= $1 AND created_at < $2 AND usage_json IS NOT NULL
                    AND ${SPEND_INDEXABLE}
                 UNION ALL
                 SELECT created_at, session_id, model,
                        (usage_json::jsonb ->> 'costUsd')::double precision AS cost_usd,
                        (usage_json::jsonb ->> 'input')::bigint AS input,
                        (usage_json::jsonb ->> 'output')::bigint AS output,
                        (usage_json::jsonb ->> 'cacheRead')::bigint AS cache_read,
                        (usage_json::jsonb ->> 'cacheWrite')::bigint AS cache_write
                   FROM session_llm_requests
                  WHERE created_at >= $1 AND created_at < $2 AND usage_json IS NOT NULL
                    AND NOT ${SPEND_INDEXABLE}
                    AND EXISTS (SELECT 1 FROM sessions WHERE id = session_llm_requests.session_id)
                 OFFSET 0) r
           JOIN sessions s ON s.id = r.session_id
           LEFT JOIN origins o ON o.session_id = s.id
          GROUP BY day, s.scope_id, COALESCE(o.origin, ${originExpr("s")}), r.model
         )
         SELECT * FROM rollup ORDER BY day, scope_id, origin, model`;

  const { pool, q } = createPgPool(
    connectionString,
    [
      ...DIRECTORY_MIGRATIONS,
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
      {
        id: "sessions/store/0016-tape-source-role",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `ALTER TABLE session_tape ADD COLUMN IF NOT EXISTS source_role TEXT`,
        ],
      },
      {
        id: "sessions/store/0017-transcript-entries",
        statements: [
          `CREATE INDEX IF NOT EXISTS session_tape_transcript_entries
           ON session_tape(session_id, entry_seq DESC, seq DESC)
           WHERE kind = 'annotation' AND safe_json(payload)->>'event' = 'transcript_entry'`,
          `CREATE OR REPLACE VIEW session_transcript_entries AS
           SELECT DISTINCT ON (session_id, entry_seq)
             session_id, entry_seq AS seq,
             (safe_json(payload)->'entry'->>'parentSeq')::int AS parent_seq,
             safe_json(payload)->'entry'->>'type' AS type,
             (safe_json(payload)->'entry'->'payload')::text AS payload,
             scope_label,
             (safe_json(payload)->'entry'->>'at')::bigint AS created_at
           FROM session_tape t
           WHERE kind = 'annotation' AND safe_json(payload)->>'event' = 'transcript_entry'
           ORDER BY t.session_id, t.entry_seq DESC, t.seq DESC`,
        ],
      },
      {
        id: "sessions/store/0017-subagent-parentage",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT`,
          `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS spawn_meta TEXT`,
          `CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id
             ON sessions(parent_session_id) WHERE parent_session_id IS NOT NULL`,
        ],
      },
      {
        id: "sessions/store/0016-status",
        statements: ["ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status JSONB"],
      },
      {
        id: "sessions/store/0018-llm-requests-created-at",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `CREATE INDEX IF NOT EXISTS session_llm_requests_created_at
        ON session_llm_requests(created_at)`,
        ],
      },
      {
        id: "sessions/store/0019-participant-activity-indexes",
        statements: [
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS participants_by_principal
             ON participants(principal_id, session_id)`,
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_entries_user_activity
             ON session_entries(session_id, created_at DESC) WHERE type = 'user'`,
        ],
      },
      {
        id: "sessions/store/0020-spend-usage-json",
        statements: [
          `CREATE OR REPLACE FUNCTION spend_usage_json(t text) RETURNS jsonb
             LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $spend_usage_json$
             SELECT CASE WHEN pg_input_is_valid(j ->> 'costUsd', 'double precision') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'input', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'output', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'cacheRead', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'cacheWrite', 'bigint') IS NOT FALSE THEN j END
               FROM (SELECT CASE WHEN pg_input_is_valid(t, 'jsonb') THEN t::jsonb END AS j OFFSET 0) parsed
             $spend_usage_json$`,
        ],
      },
      {
        id: "sessions/store/0020-spend-usage-json-size",
        statements: [
          `CREATE OR REPLACE FUNCTION spend_usage_json(t text) RETURNS jsonb
             LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $spend_usage_json$
             SELECT CASE WHEN pg_input_is_valid(j ->> 'costUsd', 'double precision') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'input', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'output', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'cacheRead', 'bigint') IS NOT FALSE
                          AND pg_input_is_valid(j ->> 'cacheWrite', 'bigint') IS NOT FALSE THEN j END
               FROM (SELECT CASE WHEN octet_length(t) > 2000 THEN NULL
                                 WHEN pg_input_is_valid(t, 'jsonb') THEN t::jsonb END AS j OFFSET 0) parsed
             $spend_usage_json$`,
        ],
      },
      {
        id: "sessions/store/0020-spend-usage-json-size-plpgsql",
        statements: [
          `CREATE OR REPLACE FUNCTION spend_usage_json(t text) RETURNS jsonb
             LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $spend_usage_json$
             DECLARE j jsonb;
             BEGIN
               IF t IS NULL OR octet_length(t) > 2000 OR NOT pg_input_is_valid(t, 'jsonb') THEN
                 RETURN NULL;
               END IF;
               j := t::jsonb;
               IF pg_input_is_valid(j ->> 'costUsd', 'double precision') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'input', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'output', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheRead', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheWrite', 'bigint') IS NOT FALSE THEN
                 RETURN j;
               END IF;
               RETURN NULL;
             END
             $spend_usage_json$`,
        ],
      },
      {
        id: "sessions/store/0021-spend-covering-index",
        statements: [
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_llm_requests_spend
             ON session_llm_requests(created_at,
               ((spend_usage_json(usage_json) ->> 'costUsd')::double precision),
               ((spend_usage_json(usage_json) ->> 'input')::bigint),
               ((spend_usage_json(usage_json) ->> 'output')::bigint),
               ((spend_usage_json(usage_json) ->> 'cacheRead')::bigint),
               ((spend_usage_json(usage_json) ->> 'cacheWrite')::bigint))
             INCLUDE (session_id, model, usage_json)
             WHERE usage_json IS NOT NULL AND ${SPEND_INDEXABLE}`,
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_llm_requests_spend_wide
             ON session_llm_requests(created_at)
             WHERE usage_json IS NOT NULL AND NOT ${SPEND_INDEXABLE}`,
        ],
      },
      {
        id: "sessions/store/0022-spend-days",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `CREATE TABLE session_spend_days(day BIGINT PRIMARY KEY, rows JSONB NOT NULL, updated_at BIGINT NOT NULL)`,
          `CREATE TABLE session_spend_dirty(
             day BIGINT, session_id TEXT, writer xid8 NOT NULL DEFAULT pg_current_xact_id(),
             UNIQUE(day, writer), CHECK (num_nonnulls(day, session_id) = 1)
           )`,
          `CREATE OR REPLACE FUNCTION invalidate_request_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_request_spend$
           BEGIN
             INSERT INTO session_spend_dirty(day)
             SELECT DISTINCT floor(at::numeric / 86400000)::bigint
               FROM (VALUES
                 (CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.created_at END),
                 (CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.created_at END)
               ) changed(at) WHERE at IS NOT NULL
             ON CONFLICT DO NOTHING;
             RETURN NULL;
           END $invalidate_request_spend$`,
          `CREATE TRIGGER session_llm_requests_spend_dirty
           AFTER INSERT OR UPDATE OF created_at, session_id, model, usage_json OR DELETE ON session_llm_requests
           FOR EACH ROW EXECUTE FUNCTION invalidate_request_spend()`,
          `CREATE OR REPLACE FUNCTION invalidate_session_spend() RETURNS trigger LANGUAGE plpgsql AS $invalidate_session_spend$
           BEGIN
             IF TG_OP = 'UPDATE' AND ROW(OLD.id, OLD.scope_id, OLD.origin, OLD.thread_ref, OLD.parent_session_id)
                  IS NOT DISTINCT FROM ROW(NEW.id, NEW.scope_id, NEW.origin, NEW.thread_ref, NEW.parent_session_id) THEN
               RETURN NULL;
             END IF;
             INSERT INTO session_spend_dirty(session_id)
             SELECT DISTINCT id FROM (VALUES (OLD.id), (NEW.id)) changed(id) WHERE id IS NOT NULL;
             RETURN NULL;
           END $invalidate_session_spend$`,
          `CREATE TRIGGER sessions_spend_dirty
           AFTER INSERT OR UPDATE OF id, scope_id, origin, thread_ref, parent_session_id OR DELETE ON sessions
           FOR EACH ROW EXECUTE FUNCTION invalidate_session_spend()`,
        ],
      },
      {
        id: "sessions/store/0023-spend-days-backfill",
        statements: [
          `INSERT INTO session_spend_dirty(day)
           SELECT DISTINCT floor(created_at::numeric / 86400000)::bigint
             FROM session_llm_requests WHERE usage_json IS NOT NULL
           ON CONFLICT DO NOTHING`,
        ],
      },
      {
        id: "sessions/store/0024-user-previews",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS first_user_preview TEXT`,
          `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_user_preview TEXT`,
        ],
      },
      {
        id: "sessions/store/0025-org-activity-index",
        statements: [
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_by_activity
             ON sessions((COALESCE(last_activity, created_at)) DESC, id DESC)`,
        ],
      },
      {
        id: "sessions/store/0026-participant-read-at",
        statements: [
          `ALTER TABLE participants ADD COLUMN IF NOT EXISTS read_at BIGINT`,
          `UPDATE participants SET read_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint WHERE read_at IS NULL`,
          `ALTER TABLE sessions DROP COLUMN IF EXISTS status`,
        ],
      },
      {
        id: "sessions/store/0027-agent-reply-index",
        statements: [
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS session_entries_agent_reply
             ON session_entries(session_id, created_at DESC) WHERE type IN ('assistant', 'delivery')`,
        ],
      },
      {
        id: "sessions/store/0028-drop-run-tasks",
        statements: [`DROP TABLE IF EXISTS task_events`, `DROP TABLE IF EXISTS tasks`],
      },
      {
        id: "sessions/store/0029-legacy-tape-steps",
        statements: LEGACY_TAPE_STEPS_SQL,
      },
      {
        id: "sessions/store/0030-legacy-tape-steps-size-guard",
        statements: LEGACY_TAPE_STEPS_SIZE_GUARD_SQL,
      },
      {
        id: "sessions/store/0031-drop-session-tape",
        prepare: PREPARE_TAPE_DROP_SQL,
        statements: DROP_SESSION_TAPE_SQL,
      },
      {
        id: "sessions/store/0032-session-goals",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `CREATE TABLE IF NOT EXISTS session_goals(
             session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
             objective TEXT NOT NULL,
             status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'complete', 'cancelled')),
             floor JSONB,
             token_cap BIGINT,
             tokens_used BIGINT NOT NULL DEFAULT 0,
             active_ms BIGINT,
             active_since TIMESTAMPTZ,
             completion_note TEXT,
             cancel_note TEXT,
             governor JSONB,
             pause_reason TEXT,
             created_at TIMESTAMPTZ NOT NULL,
             updated_at TIMESTAMPTZ NOT NULL
           )`,
        ],
      },
      {
        id: "sessions/store/0033-client-tools",
        statements: [`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS client_tools JSONB`],
      },
      ...(opts.stageItemsCutover
        ? []
        : [
            itemsMigration,
            {
              id: "sessions/store/0036-items-cutover",
              statements: ITEMS_CUTOVER_SQL,
            },
          ]),
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

  const insertEntries = async (
    client: PoolClient,
    sessionId: string,
    entries: readonly NewEntry[],
    turnId?: string,
  ): Promise<SessionEntry[]> => {
    if (!entries.length) return [];
    const max = await client.query(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(seq) FROM items WHERE tenant_id = ${TENANT} AND session_id = $1), -1) + 1,
         COALESCE((SELECT messages FROM sessions WHERE id = $1), 0)) AS n`,
      [sessionId],
    );
    const startSeq = Number(max.rows[0]!.n);
    const createdAt = now();
    const items = entries.map((entry, index) => {
      const seq = startSeq + index;
      const item = itemFromEntry(entry.type, JSON.parse(jsonbSafeStringify(entry.payload ?? null)), {
        turnId: turnId ?? null,
        author: entry.author ?? null,
      });
      return {
        ...item,
        seq,
        scopeLabel: entry.scopeLabel as ScopeId,
      };
    });
    for (const item of items) {
      if (item.kind !== "Retraction" || typeof item.body.ts !== "string") continue;
      const inBatch = items.findLast(
        (other) => other.seq < item.seq && other.kind === "UserMessage" && other.externalId === item.body.ts,
      );
      const {
        rows: [prior],
      } = await client.query(
        `SELECT max(seq) AS seq FROM items WHERE tenant_id=${TENANT} AND session_id=$1 AND external_id=$2 AND seq<$3`,
        [sessionId, item.body.ts, item.seq],
      );
      item.targetSeq = inBatch?.seq ?? (prior.seq == null ? null : Number(prior.seq));
    }
    const full = items.map((item) => entryFromItem({ sessionId, createdAt, ...item }));
    const userTurns = full.filter((entry) => entry.type === "user" && !isOverheardEntry(entry));
    const firstUser = userTurns[0];
    const lastUser = userTurns[userTurns.length - 1];
    await client
      .query(
        `INSERT INTO items(tenant_id, session_id, seq, ${ITEM_COLUMNS.map(([column]) => column).join(",")}, created_at)
       SELECT ${TENANT}, $1, i.seq, ${ITEM_COLUMNS.map(([column, key]) => (column === "blob_sha" ? `decode(i."${key}", 'hex')` : `i."${key}"`)).join(",")}, ${tsOf("$3::bigint")}
       FROM jsonb_to_recordset($2::jsonb) AS i(seq bigint, ${ITEM_COLUMNS.map(([, key, type]) => `"${key}" ${type}`).join(",")})
       ORDER BY i.seq`,
        [sessionId, jsonbStringify(items), createdAt],
      )
      .catch((err: unknown) => {
        const e = err as { code?: unknown; constraint?: unknown };
        if (e?.code !== "23505" || e.constraint !== "items_one_call_per_kind") throw err;
        throw new DuplicateCallError(
          sessionId,
          items.flatMap((item) => (item.callId ? [item.callId] : [])),
          { cause: err },
        );
      });
    await client.query(
      `UPDATE sessions
          SET last_activity = CASE WHEN last_activity >= $2::bigint - ${LAST_ACTIVITY_DEBOUNCE_MS}
                                   THEN last_activity
                                   ELSE GREATEST(COALESCE(last_activity, 0), $2::bigint) END,
              messages = $3,
              turns = CASE WHEN turns IS NULL OR messages IS DISTINCT FROM $5
                           THEN (SELECT COUNT(*) FROM items t WHERE t.tenant_id = ${TENANT} AND t.session_id = $1 AND ${userTurn("t")})
                           ELSE turns + $4 END,
              first_user_preview = CASE WHEN first_user_preview IS NULL AND turns = 0 AND messages = $5
                                        THEN $6 ELSE first_user_preview END,
              last_user_preview = COALESCE($7, last_user_preview)
        WHERE id = $1`,
      [
        sessionId,
        createdAt,
        startSeq + full.length,
        userTurns.length,
        startSeq,
        firstUser ? storedPreview(firstUser.payload, FIRST_PREVIEW_LEN) : null,
        lastUser ? storedPreview(lastUser.payload, LAST_PREVIEW_LEN) : null,
      ],
    );
    return full;
  };

  type UserPreviews = { first: string; last: string };
  const userPreviews = async (rows: Rows, options: PgQueryOptions): Promise<Map<string, UserPreviews>> => {
    const out = new Map<string, UserPreviews>();
    const missing: string[] = [];
    for (const r of rows) {
      const first = r.first_user_preview as string | null;
      const last = r.last_user_preview as string | null;
      out.set(r.id as string, { first: first ?? "", last: last ?? "" });
      if ((first === null || last === null) && (r.turns == null || Number(r.turns) > 0)) missing.push(r.id as string);
    }
    if (!missing.length) return out;
    const derived = await q(
      `SELECT s.id, s.first_user_preview, s.last_user_preview,
              (SELECT jsonb_build_object('text',fe.text) FROM items fe
                WHERE fe.tenant_id = ${TENANT} AND fe.session_id = s.id AND ${userTurn("fe")} ORDER BY fe.seq ASC LIMIT 1) AS first_user,
              (SELECT jsonb_build_object('text',le.text) FROM items le
                WHERE le.tenant_id = ${TENANT} AND le.session_id = s.id AND ${userTurn("le")} ORDER BY le.seq DESC LIMIT 1) AS last_user
         FROM sessions s WHERE s.id = ANY($1)`,
      [missing],
      options,
    ).catch((error: unknown) => {
      if (options.signal?.aborted) throw error;
      return reportFailureAs("sessions: derive legacy user previews", [] as Rows)(error);
    });
    for (const r of derived) {
      out.set(r.id as string, {
        first: (r.first_user_preview as string | null) ?? storedPreview(r.first_user ?? null, FIRST_PREVIEW_LEN),
        last: (r.last_user_preview as string | null) ?? storedPreview(r.last_user ?? null, LAST_PREVIEW_LEN),
      });
    }
    return out;
  };

  return {
    leaseTtlMs,
    async getOrCreateByThread(threadRef, type, scopeId, channelName, surface, clientTools): Promise<Session> {
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
        ...(clientTools?.length ? { clientTools: structuredClone(clientTools) } : {}),
        ...(channelName ? { channelName } : {}),
        ...(surface ? { surface } : {}),
      };
      await q(
        "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, channel_name, surface, last_activity, messages, turns, origin, origin_id, client_tools) VALUES ($1,$2,$3,$4,$5,$6,$7,$5,0,0,$8,$9,$10::jsonb) ON CONFLICT (thread_ref) DO NOTHING",
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
          clientTools?.length ? JSON.stringify(clientTools) : null,
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

    async setParentSession(sessionId, parentSessionId): Promise<void> {
      await q("UPDATE sessions SET parent_session_id = $2 WHERE id = $1", [sessionId, parentSessionId]);
    },

    async setSpawnMeta(sessionId, meta): Promise<void> {
      await q("UPDATE sessions SET spawn_meta = $2 WHERE id = $1", [sessionId, JSON.stringify(meta)]);
    },

    async childrenOf(parentSessionId): Promise<Session[]> {
      const rows = await q("SELECT * FROM sessions WHERE parent_session_id = $1 ORDER BY created_at", [
        parentSessionId,
      ]);
      return rows.map(rowToSession);
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
      return (await this.appendMany(lease, [entry]))[0]!;
    },

    async appendMany(lease, entries: readonly NewEntry[]): Promise<SessionEntry[]> {
      return withLease(lease, "append without a valid session lease", (client) =>
        insertEntries(client, lease.sessionId, entries, lease.turnId),
      );
    },

    async countEntriesBefore(sessionId, beforeSeq, principalId) {
      const rows =
        principalId === undefined
          ? await q(
              `SELECT count(*)::int AS n FROM items WHERE tenant_id = ${TENANT} AND session_id = $1 AND seq < $2`,
              [sessionId, beforeSeq],
            )
          : await q(
              `SELECT count(*)::int AS n FROM items i
                 JOIN participants p ON p.session_id = i.session_id AND p.principal_id = $3
                WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq < $2 AND ${withinParticipantWindow("i", "p")}`,
              [sessionId, beforeSeq, principalId],
            );
      return Number(rows[0]?.n ?? 0);
    },

    async latestEntrySeq(sessionId): Promise<number> {
      const rows = await q(
        `SELECT COALESCE(MAX(seq), -1) AS n FROM items WHERE tenant_id = ${TENANT} AND session_id = $1`,
        [sessionId],
      );
      return Number(rows[0]?.n ?? -1);
    },

    async goals(sessionIds) {
      const found = new Map<string, GoalRecord>();
      if (!sessionIds.length) return found;
      const rows = await q("SELECT * FROM session_goals WHERE session_id = ANY($1::text[])", [[...sessionIds]]);
      for (const row of rows) found.set(row.session_id as string, rowToGoal(row));
      return found;
    },

    async setGoal(lease, goal, notices = []) {
      await withLease(lease, "set goal without a valid session lease", async (client) => {
        await insertEntries(client, lease.sessionId, notices, lease.turnId);
        await client.query(
          `INSERT INTO session_goals(session_id, objective, status, floor, token_cap, tokens_used, active_ms,
                                     active_since, completion_note, cancel_note, governor, pause_reason,
                                     created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
           ON CONFLICT (session_id) DO UPDATE SET
             objective = EXCLUDED.objective, status = EXCLUDED.status, floor = EXCLUDED.floor,
             token_cap = EXCLUDED.token_cap, tokens_used = EXCLUDED.tokens_used, active_ms = EXCLUDED.active_ms,
             active_since = EXCLUDED.active_since, completion_note = EXCLUDED.completion_note,
             cancel_note = EXCLUDED.cancel_note, governor = EXCLUDED.governor, pause_reason = EXCLUDED.pause_reason,
             created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
          [
            lease.sessionId,
            goal.objective,
            goal.status,
            goal.floor ? JSON.stringify(goal.floor) : null,
            goal.capTokens ?? null,
            Math.floor(goal.tokensUsed),
            goal.activeMs === undefined ? null : Math.round(goal.activeMs),
            goal.activeSince === undefined ? null : new Date(goal.activeSince),
            goal.completionNote ?? null,
            goal.cancelNote ?? null,
            goal.governor ? JSON.stringify(goal.governor) : null,
            goal.pauseReason ?? null,
            new Date(goal.createdAt),
            new Date(goal.updatedAt),
          ],
        );
      });
    },

    async getEntries(sessionId, opts?: GetEntriesOptions): Promise<SessionEntry[]> {
      const params: unknown[] = [sessionId, opts?.sinceSeq ?? 0];
      let sql = `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM} WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq >= $2`;
      if (opts?.beforeSeq !== undefined) {
        params.push(opts.beforeSeq);
        sql += ` AND i.seq < $${params.length}`;
      }
      if (opts?.turnId !== undefined) {
        params.push(opts.turnId);
        sql += ` AND i.turn_id = $${params.length}::uuid`;
      }
      sql += " ORDER BY i.seq DESC";
      if (opts?.limit !== undefined) {
        params.push(opts.limit);
        sql += ` LIMIT $${params.length}`;
      }
      return (await q(sql, params)).map(rowToEntry).reverse();
    },

    async getContextWindow(sessionId) {
      const [meta, summary] = await Promise.all([
        q(`SELECT count(*)::int AS total FROM items i WHERE i.tenant_id = ${TENANT} AND i.session_id = $1`, [
          sessionId,
        ]),
        q(
          `SELECT through_seq AS through FROM items
            WHERE tenant_id = ${TENANT} AND session_id = $1 AND kind = 'ContextCompaction'
              AND through_seq IS NOT NULL AND text IS NOT NULL ORDER BY seq DESC LIMIT 1`,
          [sessionId],
        ),
      ]);
      const sinceSeq = summary[0]?.through == null ? 0 : Number(summary[0].through) + 1;
      const rows = await q(
        `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM} WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq >= $2 ORDER BY i.seq`,
        [sessionId, sinceSeq],
      );
      return { entries: rows.map(rowToEntry), totalEntries: Number(meta[0]?.total ?? 0) };
    },

    async getEntry(sessionId, seq): Promise<SessionEntry | undefined> {
      const rows = await q(
        `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM} WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq = $2`,
        [sessionId, seq],
      );
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
             FROM items WHERE tenant_id = ${TENANT} AND session_id = $1
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
        `UPDATE participants SET valid_to = $3, valid_to_seq = (SELECT COALESCE(MAX(seq) + 1, 0) FROM items WHERE tenant_id = ${TENANT} AND session_id = $1) WHERE session_id = $1 AND principal_id = $2 AND valid_to IS NULL`,
        [sessionId, principalId, now()],
      );
    },

    async deleteSession(sessionId): Promise<void> {
      await withPgTransaction(await pool(), async (client) => {
        await lockSession(client, sessionId);
        await client.query("DELETE FROM session_llm_requests WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM session_leases WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM participants WHERE session_id = $1", [sessionId]);
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
              AND NOT EXISTS (SELECT 1 FROM items WHERE tenant_id = ${TENANT} AND session_id = $1)
              AND NOT EXISTS (SELECT 1 FROM session_leases WHERE session_id = $1 AND expires_at > $2)`,
          [sessionId, now()],
        );
        if (gone.rowCount === 0) return false;
        await client.query("DELETE FROM session_llm_requests WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM session_leases WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM participants WHERE session_id = $1", [sessionId]);
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
      if (patch.readAt !== undefined) {
        await q("UPDATE participants SET read_at = $3 WHERE session_id = $1 AND principal_id = $2", [
          sessionId,
          principalId,
          patch.readAt,
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

    async visibleEntries(sessionId, principalId, opts?: GetEntriesOptions): Promise<SessionEntry[]> {
      const params: unknown[] = [sessionId, principalId, opts?.sinceSeq ?? 0];
      let sql = `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM}
           JOIN participants p ON p.session_id = i.session_id AND p.principal_id = $2
          WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq >= $3
            AND ${withinParticipantWindow("i", "p")}`;
      if (opts?.beforeSeq !== undefined) {
        params.push(opts.beforeSeq);
        sql += ` AND i.seq < $${params.length}`;
      }
      sql += " ORDER BY i.seq DESC";
      if (opts?.limit !== undefined) {
        params.push(opts.limit);
        sql += ` LIMIT $${params.length}`;
      }
      return (await q(sql, params)).map(rowToEntry).reverse();
    },

    async searchSessionTitles(principalId, query, limit = 20): Promise<Session[]> {
      const needle = query.trim();
      if (needle.length < 2) return [];
      const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = await q(
        participantSessionsSql(" AND COALESCE(p.title, s.title) ILIKE $2") +
          " ORDER BY COALESCE(s.last_activity, s.created_at) DESC, s.id LIMIT $3",
        [principalId, like, Math.max(1, Math.min(Math.floor(limit), 100))],
        { timeoutMs: SEARCH_TIMEOUT_MS },
      );
      return rows.map(rowToParticipantSession);
    },

    async searchEntries(principalId, query, limit = 40): Promise<EntrySearchHit[]> {
      const ts = tsPrefixQuery(query);
      if (!ts) return [];
      const rows = await q(
        `SELECT h.session_id, h.seq, h.type, h.author, h.text, h.created_at,
                s.scope_id, COALESCE(p.title, s.title) AS title, s.channel_name, s.surface, p.archived
           FROM session_entry_search h
           JOIN participants p ON p.session_id = h.session_id AND p.principal_id = $1
           JOIN sessions s ON s.id = h.session_id
          WHERE h.search_tsv @@ to_tsquery('simple', $2)
            AND ${withinParticipantWindow("h", "p", false)}
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
           SELECT e.text AS text FROM items e
            WHERE e.tenant_id = ${TENANT} AND e.session_id = $1 AND ${SEARCHABLE_ITEM("e")}
              AND NOT EXISTS (SELECT 1 FROM session_entry_search s WHERE s.session_id = e.session_id AND s.seq = e.seq)
         )
         SELECT COUNT(*) AS n FROM missing WHERE COALESCE(btrim(text), '') <> ''`,
        [sessionId],
      );
      return Number(rows[0]?.n ?? 0);
    },

    async lastSearchableEntrySeq(sessionId): Promise<number> {
      const rows = await q(
        `SELECT COALESCE(MAX(i.seq), -1) AS n FROM items i
          WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND ${SEARCHABLE_ITEM("i")}
            AND btrim(i.text) <> ''`,
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

    async scopeSessionSummaries(scope, orgWide, page: SessionPage): Promise<SessionSummary[]> {
      const options = { timeoutMs: ADMIN_READ_TIMEOUT_MS, ...(page.signal ? { signal: page.signal } : {}) };
      const params: unknown[] = [orgWide, scope];
      let categoryClause = "";
      if (page.category === "background") categoryClause = ` AND ${isBackground("s")}`;
      else if (page.category) categoryClause = ` AND NOT ${isBackground("s")}`;
      const originClause = page.origin ? ` AND ${originFilterClause("s", page.origin)}` : "";
      let cronClause = "";
      if (page.cronId) {
        params.push(page.cronId);
        cronClause = ` AND ${cronIdExpr("s")} = $${params.length}`;
      }
      let keysetClause = "";
      if (page.before) {
        params.push(page.before.lastActivity, page.before.id);
        keysetClause = ` AND (${lastActivityExpr("s")}, s.id) < ($${params.length - 1}::bigint, $${params.length}::text)`;
      }
      params.push(page.limit);
      const rows = await q(
        `SELECT s.id, s.type, s.scope_id, s.thread_ref, s.created_at, s.messages, s.turns,
                ${lastActivityExpr("s")} AS last_activity, s.first_user_preview, s.last_user_preview
           FROM sessions s
          WHERE ($1::boolean OR s.scope_id = $2)${categoryClause}${originClause}${cronClause}${keysetClause}
          ORDER BY ${lastActivityExpr("s")} DESC, s.id DESC
          LIMIT $${params.length}`,
        params,
        options,
      );
      const previews = await userPreviews(rows, options);
      return rows.map((r) => ({
        id: r.id as string,
        type: r.type as Session["type"],
        origin: sessionOrigin(r.thread_ref as string | null),
        scopeId: r.scope_id as Session["scopeId"],
        threadRef: r.thread_ref as Session["threadRef"],
        turns: Number(r.turns ?? 0),
        messages: Number(r.messages ?? 0),
        lastActivity: Number(r.last_activity),
        createdAt: Number(r.created_at),
        firstMessage: previews.get(r.id as string)!.first,
        lastMessage: previews.get(r.id as string)!.last,
      }));
    },

    async lastUserMessages(sessionIds): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      if (sessionIds.length === 0) return out;
      const rows = await q(
        `SELECT DISTINCT ON (le.session_id) le.session_id, left(le.text, ${LAST_PREVIEW_LEN}) AS last_user
           FROM items le
          WHERE le.tenant_id = ${TENANT} AND le.session_id = ANY($1) AND ${userTurn("le")}
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
        `SELECT r.scope_id, r.sessions, r.background_sessions, r.last_activity, r.last_conversation_activity,
                (
                  SELECT s.id FROM sessions s
                   WHERE s.scope_id = r.scope_id AND ${lastActivityExpr("s")} <= r.preview_activity
                     AND NOT (${isBackground("s")}) AND s.turns > 0
                   ORDER BY ${lastActivityExpr("s")} DESC, s.id DESC LIMIT 1
                ) AS preview_session_id
           FROM (SELECT scope_id,
                        COUNT(*) FILTER (WHERE NOT background) AS sessions,
                        COUNT(*) FILTER (WHERE background) AS background_sessions,
                        MAX(last_activity) AS last_activity,
                        COALESCE(MAX(last_activity) FILTER (WHERE NOT background), 0) AS last_conversation_activity,
                        MAX(last_activity) FILTER (WHERE NOT background AND turns > 0) AS preview_activity
                   FROM (SELECT s.scope_id, s.turns, ${lastActivityExpr("s")} AS last_activity,
                                ${isBackground("s")} AS background
                           FROM sessions s
                          WHERE ($1::boolean OR s.scope_id = $2)) t
                  GROUP BY scope_id) r`,
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
        { timeoutMs: ADMIN_READ_TIMEOUT_MS },
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
        `SELECT p.principal_id, e.session_id, (${msOf("e.created_at")} / 86400000)::bigint AS day,
                COUNT(*) AS turns, ${msOf("MIN(e.created_at)")} AS first_at, ${msOf("MAX(e.created_at)")} AS last_at
           FROM participants p
           JOIN items e ON e.tenant_id = ${TENANT} AND e.session_id = p.session_id
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

    async spendRollup(range): Promise<SpendRow[]> {
      return (await q(spendSql, [range.from, range.to])).map(rowToSpendRow);
    },

    async spendReport(range) {
      const dayMs = 86_400_000;
      if (range.from < 0 || range.from % dayMs || range.to % dayMs) {
        return { rows: (await q(spendSql, [range.from, range.to])).map(rowToSpendRow) };
      }
      let asOf = now();
      const days = await q(
        `WITH pending AS (SELECT DISTINCT day FROM session_spend_dirty WHERE day >= $1 AND day < $2)
         SELECT COALESCE(c.day, p.day) AS day, c.rows, c.updated_at,
                p.day IS NOT NULL OR EXISTS (SELECT 1 FROM session_spend_dirty WHERE session_id IS NOT NULL) AS pending
           FROM (SELECT * FROM session_spend_days WHERE day >= $1 AND day < $2) c
           FULL JOIN pending p ON p.day = c.day ORDER BY day`,
        [range.from / dayMs, range.to / dayMs],
      );
      if (days.some((day) => day.rows === null)) {
        return { rows: (await q(spendSql, [range.from, range.to])).map(rowToSpendRow) };
      }
      const rows: SpendRow[] = [];
      for (const day of days) {
        rows.push(...(day.rows as Record<string, unknown>[]).map(rowToSpendRow));
        if (day.pending) asOf = Math.min(asOf, Number(day.updated_at));
      }
      return { rows, asOf };
    },

    async refreshSpendRollup() {
      const started = Date.now();
      await withPgTransaction(await pool(), async (client) => {
        const changed = await client.query(
          "DELETE FROM session_spend_dirty WHERE session_id IS NOT NULL RETURNING session_id",
        );
        if (!changed.rowCount) return;
        await client.query(
          `WITH RECURSIVE affected(id) AS (
             SELECT unnest($1::text[])
             UNION
             SELECT s.id FROM sessions s JOIN affected a ON s.parent_session_id = a.id
           )
           INSERT INTO session_spend_dirty(day)
           SELECT DISTINCT floor(r.created_at::numeric / 86400000)::bigint
             FROM session_llm_requests r JOIN affected a ON a.id = r.session_id WHERE r.usage_json IS NOT NULL
           ON CONFLICT DO NOTHING`,
          [changed.rows.map((r) => r.session_id)],
        );
      });
      const days = await q(
        `SELECT d.day FROM (SELECT DISTINCT day FROM session_spend_dirty WHERE day IS NOT NULL) d
         LEFT JOIN session_spend_days c ON c.day = d.day ORDER BY c.updated_at NULLS FIRST, d.day DESC`,
      );
      for (const { day } of days) {
        try {
          await withPgTransaction(await pool(), async (client) => {
            const pending = await client.query("DELETE FROM session_spend_dirty WHERE day = $1 RETURNING day", [day]);
            if (!pending.rowCount) return;
            const updatedAt = now();
            const rows = await client.query(spendSql, [Number(day) * 86_400_000, (Number(day) + 1) * 86_400_000]);
            await client.query(
              `INSERT INTO session_spend_days(day, rows, updated_at) VALUES ($1, $2, $3)
               ON CONFLICT (day) DO UPDATE SET rows = EXCLUDED.rows, updated_at = EXCLUDED.updated_at`,
              [day, jsonbSafeStringify(rows.rows), updatedAt],
            );
          });
        } catch (error) {
          reportFailure("spend: refresh daily totals", error);
          continue;
        }
        if (Date.now() - started >= 5_000) break;
      }
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
