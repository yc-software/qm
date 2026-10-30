import { DIRECTORY_MIGRATIONS } from "../directory/postgres-directory-store.ts";
import { randomUUID } from "node:crypto";
import { likeContains } from "../persistence/like.ts";
import { createPgPool, type PoolClient, withPgTransaction } from "../persistence/pg-pool.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";
import { reportFailure } from "../util/errors.ts";
import type { Session, SessionEntry, SessionType, ScopeId } from "../types.ts";
import type { GoalRecord } from "../agent/goal.ts";
import type {
  NewSessionPin,
  SessionPin,
  AttributedTurn,
  EntrySearchHit,
  ScopeActivity,
  DistinctScope,
  ParticipantPage,
  ParticipantPageQuery,
  ParticipantScope,
  SessionDescendant,
  GetEntriesOptions,
  Lease,
  LeaseAttempt,
  LeaseHolder,
  LeasePeek,
  LlmRequestRecord,
  NewEntry,
  NewLlmRequest,
  ParticipantWindow,
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
import { SESSION_SCHEMA, SPEND_INDEXABLE } from "./session-schema.ts";
import {
  cronIdOf,
  promptEnvelopeBody,
  sessionOrigin,
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
  searchTypeExpr,
  USER_ITEM_KINDS,
  USER_KINDS,
} from "./items.ts";
import { SECURITY_SCREEN_STEP, screenPayloadFromEnvelope } from "../security/security-posture.ts";

const LLM_CAPTURE_PURGE_BATCH = 100;
const ENVELOPE_TOUCH_MS = 24 * 60 * 60_000;

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
    ...(r.side_chat ? { sideChat: r.side_chat as Session["sideChat"] } : {}),
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
    promptHash: r.prompt_hash == null ? null : (r.prompt_hash as string),
    ...(r.prompt_body != null ? { promptEnvelope: JSON.parse(r.prompt_body as string) } : {}),
    truncated: Boolean(r.truncated),
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
const LIST_COLUMNS = `s.id, s.type, s.scope_id, s.thread_ref, s.surface, s.created_at, s.title, s.channel_name,
  s.forked_from_session_id, s.forked_from_title, s.fork_boundary_seq, s.parent_session_id, s.side_chat`;
const USER_ACTIVITY = "COALESCE(s.last_user_activity, s.created_at)";
const AUTOMATION_SURFACES = "('cron', 'webhook', 'loop')";

const tsOf = (ms: string): string => `to_timestamp((${ms})::double precision / 1000)`;

function rowToSpendRow(r: Record<string, unknown>): SpendRow {
  return {
    day: Number(r.day),
    model: (r.model as string | null) ?? null,
    scopeId: r.scope_id as ScopeId,
    origin: r.origin as SessionOrigin,
    cronId: (r.cron_id as string | null) ?? null,
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

const ADMIN_READ_TIMEOUT_MS = 10_000;
const FIRST_PREVIEW_LEN = 160;
const LAST_PREVIEW_LEN = 100;

const storedPreview = (payload: unknown, maxLen: number): string => pgTextSafe(userMessagePreview(payload, maxLen));

export function createPostgresSessionStore(connectionString: string, opts: StoreOptions = {}): SessionStore {
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
  function transcriptItemPredicate(alias: string, participant?: string): string {
    const receipt = (item: string): string => `COALESCE(${item}.body @> '{"slackReplyReceipt":true}'::jsonb, false)`;
    return `NOT (
      ${alias}.kind = 'UserMessage' AND ${receipt(alias)}
      AND EXISTS (
        SELECT 1 FROM items received
        WHERE received.tenant_id = ${alias}.tenant_id AND received.session_id = ${alias}.session_id
          AND received.kind = 'UserMessage' AND received.external_id = ${alias}.external_id
          AND NOT ${receipt("received")}
          ${participant ? `AND ${withinParticipantWindow("received", participant)}` : ""}
      )
    )`;
  }
  const [fromBounds, toBounds] = participantWindowBounds("x", "p");
  const participantPresenceSql = fromBounds
    .flatMap((from) =>
      toBounds.map(
        (to) => `SELECT 1 FROM items x WHERE x.tenant_id = ${TENANT} AND x.session_id = s.id AND ${from} AND ${to}`,
      ),
    )
    .join(" UNION ALL ");
  const SEES_ITEMS = `CASE WHEN p.valid_to IS NULL AND p.valid_to_seq IS NULL AND p.valid_from_seq IS NOT NULL
         THEN COALESCE(s.messages, 0) > p.valid_from_seq
         ELSE EXISTS (${participantPresenceSql}) END`;
  const HAS_CONTENT = `(NULLIF(btrim(COALESCE(p.title, s.title)), '') IS NOT NULL OR ${SEES_ITEMS})`;
  const participantSessionsSql = (extraWhere: string, columns = "s.*"): string =>
    `SELECT ${columns}, p.title AS p_title, p.archived AS p_archived, p.pinned AS p_pinned, p.color AS p_color,
            p.read_at AS p_read_at,
            (SELECT ${msOf("MAX(e.created_at)")} FROM items e
              WHERE e.tenant_id = ${TENANT} AND e.session_id = s.id AND ${AGENT_REPLY_ITEM("e")}) AS agent_last_reply,
            ${USER_ACTIVITY} AS user_last_activity,
            ${SEES_ITEMS} AS has_entries
       FROM sessions s
       JOIN participants p ON p.session_id = s.id
      WHERE p.principal_id = $1${extraWhere}`;
  const participantSessions = async (principalId: string, opts?: { limit: number }): Promise<Session[]> => {
    const limit = opts ? Math.max(0, Math.floor(opts.limit)) : undefined;
    const rows = await q(
      participantSessionsSql("", LIST_COLUMNS) +
        (limit === undefined ? "" : " ORDER BY COALESCE(s.last_activity, s.created_at) DESC, s.id LIMIT $2"),
      limit === undefined ? [principalId] : [principalId, limit],
    );
    return rows.map(rowToParticipantSession);
  };
  const participantScopes = async (principalId: string): Promise<ParticipantScope[]> => {
    const rows = await q(
      `SELECT s.scope_id, MAX(s.channel_name) AS channel_name,
              COUNT(*) FILTER (WHERE ${HAS_CONTENT}) AS session_count,
              MAX(${USER_ACTIVITY}) FILTER (WHERE ${HAS_CONTENT}) AS last_activity
         FROM sessions s
         JOIN participants p ON p.session_id = s.id
        WHERE p.principal_id = $1
        GROUP BY s.scope_id`,
      [principalId],
    );
    return rows.map((r) => ({
      scopeId: r.scope_id as ScopeId,
      ...(r.channel_name != null ? { channelName: r.channel_name as string } : {}),
      sessionCount: Number(r.session_count),
      lastActivityAt: r.last_activity == null ? null : Number(r.last_activity),
    }));
  };
  const participantPage = async (principalId: string, query: ParticipantPageQuery): Promise<ParticipantPage> => {
    const params: unknown[] = [principalId];
    const where: string[] = [
      "p.principal_id = $1",
      "s.parent_session_id IS NULL",
      "(s.side_chat IS NULL OR s.side_chat->>'expanded' = 'true')",
      `(s.surface IS NULL OR s.surface NOT IN ${AUTOMATION_SURFACES})`,
      HAS_CONTENT,
    ];
    const param = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    where.push(`COALESCE(p.archived, false) = ${param(query.archived === true)}`);
    if (query.pinned !== undefined) where.push(`COALESCE(p.pinned, false) = ${param(query.pinned)}`);
    if (query.surface !== undefined) where.push(`s.surface = ${param(query.surface)}`);
    if (query.scopeId !== undefined) where.push(`s.scope_id = ${param(query.scopeId)}`);
    if (query.sessionIds !== undefined) where.push(`s.id = ANY(${param([...query.sessionIds])}::text[])`);
    if (query.titleQuery?.trim()) {
      const pattern = param(likeContains(query.titleQuery.trim()));
      where.push(`(COALESCE(p.title, s.title) ILIKE ${pattern} OR s.channel_name ILIKE ${pattern})`);
    }
    if (query.before)
      where.push(`(${USER_ACTIVITY}, s.id) < (${param(query.before.activity)}::bigint, ${param(query.before.id)})`);
    const limit = Math.max(1, Math.min(Math.floor(query.limit), 200));
    const page = await q(
      `SELECT s.id, ${USER_ACTIVITY} AS activity
         FROM participants p JOIN sessions s ON s.id = p.session_id
        WHERE ${where.join(" AND ")}
        ORDER BY ${USER_ACTIVITY} DESC, s.id DESC
        LIMIT ${param(limit + 1)}`,
      params,
    );
    const more = page.length > limit;
    const ids = page.slice(0, limit).map((row) => row.id as string);
    if (!ids.length) return { sessions: [], next: null };
    const rows = await q(participantSessionsSql(" AND s.id = ANY($2::text[])", LIST_COLUMNS), [principalId, ids]);
    const byId = new Map(rows.map((row) => [row.id as string, rowToParticipantSession(row)]));
    const last = page[limit - 1];
    return {
      sessions: ids.flatMap((id) => byId.get(id) ?? []),
      next: more && last ? { activity: Number(last.activity), id: last.id as string } : null,
    };
  };
  const descendantsOf = async (rootIds: readonly string[]): Promise<SessionDescendant[]> => {
    if (!rootIds.length) return [];
    const rows = await q(
      `WITH RECURSIVE tree(id, root_id, thread_ref) AS (
         SELECT id, parent_session_id, thread_ref FROM sessions WHERE parent_session_id = ANY($1::text[])
         UNION
         SELECT s.id, t.root_id, s.thread_ref FROM sessions s JOIN tree t ON s.parent_session_id = t.id
       )
       SELECT id, root_id, thread_ref FROM tree`,
      [[...rootIds]],
    );
    return rows.map((r) => ({ id: r.id as string, rootId: r.root_id as string, threadRef: r.thread_ref as string }));
  };
  const participantSession = async (sessionId: string, principalId: string): Promise<Session | null> => {
    const rows = await q(participantSessionsSql(" AND s.id = $2"), [principalId, sessionId]);
    return rows[0] ? rowToParticipantSession(rows[0]) : null;
  };
  const isBackground = (alias: string): string => `${alias}.origin <> 'conversation'`;
  const hasOrigin = (alias: string, origin: SessionOrigin): string => `${alias}.origin = '${origin}'`;
  const originFilterClause = (alias: string, origin: SessionOriginFilter): string =>
    origin === "other_background" ? `${alias}.origin NOT IN ('conversation', 'cron')` : hasOrigin(alias, origin);
  const spendSql = `WITH RECURSIVE ancestry AS (
           SELECT s.id AS session_id, s.parent_session_id, s.origin AS origin, s.origin_id AS cron_id,
                  ARRAY[s.id] AS path
             FROM sessions s
            WHERE s.parent_session_id IS NOT NULL AND s.origin = 'conversation'
              AND EXISTS (SELECT 1 FROM session_llm_requests r
                           WHERE r.session_id = s.id AND r.created_at >= $1 AND r.created_at < $2
                             AND r.usage_json IS NOT NULL)
           UNION ALL
           SELECT a.session_id, p.parent_session_id, p.origin, p.origin_id, a.path || p.id
             FROM ancestry a JOIN sessions p ON p.id = a.parent_session_id
            WHERE a.origin = 'conversation' AND NOT p.id = ANY(a.path) AND cardinality(a.path) < 64
         ), origins AS (
           SELECT DISTINCT ON (session_id) session_id, origin, cron_id
             FROM ancestry ORDER BY session_id, cardinality(path) DESC
         ), rollup AS MATERIALIZED (
           SELECT (r.created_at / 86400000)::bigint AS day, s.scope_id,
                COALESCE(o.origin, s.origin) AS origin,
                COALESCE(o.cron_id, s.origin_id) AS cron_id, r.model,
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
          GROUP BY day, s.scope_id, COALESCE(o.origin, s.origin), COALESCE(o.cron_id, s.origin_id), r.model
         )
         SELECT * FROM rollup ORDER BY day, scope_id, origin, cron_id, model`;

  const { pool, q, query } = createPgPool(connectionString, [...DIRECTORY_MIGRATIONS, SESSION_SCHEMA]);

  const lockSession = (client: PoolClient, sessionId: string) =>
    client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [sessionId]);

  const withLease = async <T>(lease: Lease, invalidMsg: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    withPgTransaction(await pool(), async (client) => {
      const t = now();
      const held = await client.query(
        "UPDATE session_leases SET expires_at = $3 WHERE session_id = $1 AND token = $2 AND expires_at > $4",
        [lease.sessionId, lease.token, t + leaseTtlMs, t],
      );
      if (!held.rowCount) throw new Error(invalidMsg);
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
      const item = itemFromEntry(entry.type, JSON.parse(jsonbStringify(entry.payload ?? null)), {
        turnId: turnId ?? null,
        author: entry.author ?? null,
      });
      return {
        ...item,
        seq,
        scopeLabel: entry.scopeLabel as ScopeId,
      };
    });
    const full = items.map((item) => entryFromItem({ sessionId, createdAt, ...item }));
    const userTurns = full.filter((entry) => entry.type === "user" && !isOverheardEntry(entry));
    const firstUser = userTurns[0];
    const lastUser = userTurns[userTurns.length - 1];
    await client
      .query(
        `WITH inserted AS (
           INSERT INTO items(tenant_id, session_id, seq, ${ITEM_COLUMNS.map(([column]) => column).join(",")}, created_at)
           SELECT ${TENANT}, $1, i.seq, ${ITEM_COLUMNS.map(([column, key]) => (column === "blob_sha" ? `decode(i."${key}", 'hex')` : `i."${key}"`)).join(",")}, ${tsOf("$2::bigint")}
           FROM jsonb_to_recordset($9::jsonb) AS i(seq bigint, ${ITEM_COLUMNS.map(([, key, type]) => `"${key}" ${type}`).join(",")})
           ORDER BY i.seq)
         UPDATE sessions
            SET last_activity = CASE WHEN last_activity >= $2::bigint - ${LAST_ACTIVITY_DEBOUNCE_MS}
                                     THEN last_activity
                                     ELSE GREATEST(COALESCE(last_activity, 0), $2::bigint) END,
                messages = $3,
                turns = CASE WHEN turns IS NULL OR messages IS DISTINCT FROM $5
                             THEN (SELECT COUNT(*) FROM items t WHERE t.tenant_id = ${TENANT} AND t.session_id = $1 AND ${userTurn("t")}) + $4
                             ELSE turns + $4 END,
                first_user_preview = CASE WHEN first_user_preview IS NULL AND turns = 0 AND messages = $5
                                          THEN $6 ELSE first_user_preview END,
                last_user_preview = COALESCE($7, last_user_preview),
                last_user_activity = CASE WHEN $8::boolean THEN GREATEST(COALESCE(last_user_activity, 0), $2::bigint)
                                          ELSE last_user_activity END
          WHERE id = $1`,
        [
          sessionId,
          createdAt,
          startSeq + full.length,
          userTurns.length,
          startSeq,
          firstUser ? storedPreview(firstUser.payload, FIRST_PREVIEW_LEN) : null,
          lastUser ? storedPreview(lastUser.payload, LAST_PREVIEW_LEN) : null,
          items.some((item) => USER_ITEM_KINDS.includes(item.kind)),
          jsonbStringify(items),
        ],
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
    return full;
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

    async sideChatsOf(sessionId) {
      const rows = await q(
        `SELECT s.* FROM sessions s WHERE s.forked_from_session_id = $1 AND s.side_chat IS NOT NULL
         AND EXISTS (SELECT 1 FROM items i WHERE i.tenant_id = ${TENANT} AND i.session_id = s.id
           AND i.seq > s.fork_boundary_seq AND i.kind = 'UserMessage') ORDER BY s.created_at`,
        [sessionId],
      );
      return rows.map(rowToSession);
    },

    async expandSideChat(sessionId) {
      await q(
        "UPDATE sessions SET side_chat = jsonb_set(side_chat, '{expanded}', 'true') WHERE id = $1 AND side_chat IS NOT NULL",
        [sessionId],
      );
    },

    async updateForkProvenance(sessionId, provenance): Promise<void> {
      await q(
        "UPDATE sessions SET forked_from_session_id = $2, forked_from_title = $3, fork_boundary_seq = $4, side_chat = $5 WHERE id = $1",
        [
          sessionId,
          provenance.forkedFrom.sessionId,
          provenance.forkedFrom.title ?? null,
          provenance.forkBoundarySeq,
          provenance.sideChat ? JSON.stringify(provenance.sideChat) : null,
        ],
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
              `SELECT count(*)::int AS n FROM items i WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq < $2 AND ${transcriptItemPredicate("i")}`,
              [sessionId, beforeSeq],
            )
          : await q(
              `SELECT count(*)::int AS n FROM items i
                 JOIN participants p ON p.session_id = i.session_id AND p.principal_id = $3
                WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq < $2 AND ${transcriptItemPredicate("i", "p")} AND ${withinParticipantWindow("i", "p")}`,
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

    async hasDeliveryEntry(sessionId, deliveryKey, slackTs) {
      const rows = await q(
        `SELECT 1 FROM items WHERE tenant_id = ${TENANT} AND session_id = $1 AND kind = 'UserMessage'
         AND (body ->> 'deliveryKey' = $2 OR external_id = $3) LIMIT 1`,
        [sessionId, deliveryKey, slackTs ?? null],
      );
      return rows.length > 0;
    },

    async getEntries(sessionId, opts?: GetEntriesOptions): Promise<SessionEntry[]> {
      const params: unknown[] = [sessionId, opts?.sinceSeq ?? 0];
      let sql = `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM} WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq >= $2`;
      if (opts?.messagesOnly)
        sql += " AND i.kind IN ('UserMessage', 'SteeringMessage', 'AgentMessage') AND i.variant IS NULL";
      if (opts?.transcript) sql += ` AND ${transcriptItemPredicate("i")}`;
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
          `INSERT INTO llm_prompt_envelopes(hash, body, created_at) VALUES ($1,$2,$3)
           ON CONFLICT (hash) DO UPDATE SET created_at = EXCLUDED.created_at
            WHERE llm_prompt_envelopes.created_at < EXCLUDED.created_at - ${ENVELOPE_TOUCH_MS}`,
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
        promptHash: envelope?.hash ?? null,
        ...(rec.promptEnvelope !== undefined ? { promptEnvelope: rec.promptEnvelope } : {}),
        truncated: rec.truncated ?? false,
        usage: rec.usage ?? null,
        transport: rec.transport ?? null,
      };
      await q(
        "INSERT INTO session_llm_requests(id, session_id, turn_seq, step, model, scope_label, prompt_hash, truncated, created_at, usage_json, transport_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
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
          full.usage ? JSON.stringify(full.usage) : null,
          full.transport ? JSON.stringify(full.transport) : null,
        ],
        { signal },
      );
      return full;
    },

    async listLlmRequests(sessionId, opts): Promise<LlmRequestRecord[]> {
      const cols = opts?.omitRequest
        ? "r.id, r.session_id, r.turn_seq, r.step, r.model, r.scope_label, r.created_at, r.truncated, r.prompt_hash, r.usage_json, r.transport_json"
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

    async purgeLlmCaptures(cutoff, opts) {
      const deadline = opts?.deadline ?? Infinity;
      let envelopes = 0;
      while (Date.now() < deadline && !opts?.stop?.()) {
        const deleted = await query(
          `DELETE FROM llm_prompt_envelopes
            WHERE hash IN (SELECT hash FROM llm_prompt_envelopes WHERE created_at < $1
                            ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
              AND created_at < $1`,
          [cutoff, LLM_CAPTURE_PURGE_BATCH],
        );
        envelopes += deleted.rowCount;
        if (deleted.rowCount < LLM_CAPTURE_PURGE_BATCH) break;
      }
      return envelopes;
    },

    async addParticipant(sessionId, principalId, title, opts): Promise<void> {
      const includeHistory = opts?.includeHistory === true;
      await q(
        `WITH boundary AS (
           SELECT CASE WHEN $5 THEN 0
                       ELSE GREATEST(COALESCE(MAX(seq) + 1, 0),
                                     COALESCE((SELECT messages FROM sessions WHERE id = $1), 0)) END AS seq
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
        await client.query("DELETE FROM session_pins WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
      });
    },

    async deleteSessionIfEmpty(sessionId): Promise<boolean> {
      return withPgTransaction(await pool(), async (client) => {
        await lockSession(client, sessionId);
        await client.query("SELECT 1 FROM session_leases WHERE session_id = $1 FOR UPDATE", [sessionId]);
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
        await client.query("DELETE FROM session_pins WHERE session_id = $1", [sessionId]);
        return true;
      });
    },

    async listByParticipant(principalId, opts): Promise<Session[]> {
      return participantSessions(principalId, opts);
    },

    async participantScopes(principalId): Promise<ParticipantScope[]> {
      return participantScopes(principalId);
    },

    async listParticipantPage(principalId, query): Promise<ParticipantPage> {
      return participantPage(principalId, query);
    },

    async descendantsOf(rootIds): Promise<SessionDescendant[]> {
      return descendantsOf(rootIds);
    },

    async listDescendantsForParticipant(rootId, principalId, limit): Promise<Session[]> {
      const ids = (await descendantsOf([rootId])).map((d) => d.id).slice(0, Math.max(0, Math.floor(limit)));
      if (!ids.length) return [];
      const rows = await q(
        participantSessionsSql(" AND s.id = ANY($2::text[])", LIST_COLUMNS) + " ORDER BY s.created_at, s.id",
        [principalId, ids],
      );
      return rows.map(rowToParticipantSession);
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
      if (opts?.messagesOnly)
        sql += " AND i.kind IN ('UserMessage', 'SteeringMessage', 'AgentMessage') AND i.variant IS NULL";
      if (opts?.transcript) sql += ` AND ${transcriptItemPredicate("i", "p")}`;
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
        `SELECT i.session_id, i.seq, ${searchTypeExpr("i")} AS type,
                CASE WHEN i.kind IN ${USER_KINDS} AND jsonb_typeof(i.body -> 'name') = 'string'
                     THEN i.body ->> 'name' END AS author,
                i.text, ${msOf("i.created_at")} AS created_at,
                s.scope_id, COALESCE(p.title, s.title) AS title, s.channel_name, s.surface, p.archived
           FROM items i
           JOIN participants p ON p.session_id = i.session_id AND p.principal_id = $1
           JOIN sessions s ON s.id = i.session_id
          WHERE i.tenant_id = ${TENANT} AND i.search @@ to_tsquery('simple', $2)
            AND ${SEARCHABLE_ITEM("i")}
            AND ${withinParticipantWindow("i", "p")}
          ORDER BY i.created_at DESC, i.session_id, i.seq DESC
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
        cronClause = ` AND s.origin_id = $${params.length}`;
      }
      let keysetClause = "";
      if (page.before) {
        params.push(page.before.lastActivity, page.before.id);
        keysetClause = ` AND (${lastActivityExpr("s")}, s.id) < ($${params.length - 1}::bigint, $${params.length}::text)`;
      }
      params.push(page.limit);
      const rows = await q(
        `SELECT s.id, s.type, s.scope_id, s.thread_ref, s.origin, s.created_at, s.messages, s.turns,
                ${lastActivityExpr("s")} AS last_activity, s.first_user_preview, s.last_user_preview, s.title
           FROM sessions s
          WHERE ($1::boolean OR s.scope_id = $2)${categoryClause}${originClause}${cronClause}${keysetClause}
          ORDER BY ${lastActivityExpr("s")} DESC, s.id DESC
          LIMIT $${params.length}`,
        params,
        options,
      );
      return rows.map((r) => ({
        id: r.id as string,
        type: r.type as Session["type"],
        origin: r.origin as SessionOrigin,
        scopeId: r.scope_id as Session["scopeId"],
        threadRef: r.thread_ref as Session["threadRef"],
        turns: Number(r.turns ?? 0),
        messages: Number(r.messages ?? 0),
        lastActivity: Number(r.last_activity),
        createdAt: Number(r.created_at),
        firstMessage: ((r.first_user_preview ?? r.title ?? "") as string).trim(),
        lastMessage: (r.last_user_preview as string | null) ?? "",
      }));
    },

    async scopeConversationCount(scope): Promise<number> {
      const rows = await q("SELECT COUNT(*) AS n FROM sessions WHERE scope_id = $1 AND origin = 'conversation'", [
        scope,
      ]);
      return Number(rows[0]?.n ?? 0);
    },

    async scopeActivity(): Promise<ScopeActivity[]> {
      const rows = await q(
        `SELECT scope_id,
                COUNT(*) FILTER (WHERE origin = 'conversation') AS conversations,
                COUNT(*) FILTER (WHERE origin = 'cron') AS crons,
                COUNT(*) FILTER (WHERE origin NOT IN ('conversation', 'cron')) AS background,
                MAX(${lastActivityExpr("sessions")}) AS last_activity
           FROM sessions
          GROUP BY scope_id`,
        [],
        { timeoutMs: ADMIN_READ_TIMEOUT_MS },
      );
      return rows.map((r) => ({
        scopeId: r.scope_id as ScopeId,
        conversations: Number(r.conversations),
        crons: Number(r.crons),
        background: Number(r.background),
        lastActivity: Number(r.last_activity),
      }));
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
         LEFT JOIN session_spend_days c ON c.day = d.day
         ORDER BY d.day = max(d.day) OVER () DESC, c.updated_at NULLS FIRST, d.day DESC`,
      );
      for (const [index, { day }] of days.entries()) {
        try {
          await withPgTransaction(await pool(), async (client) => {
            const pending = await client.query("DELETE FROM session_spend_dirty WHERE day = $1 RETURNING day", [day]);
            if (!pending.rowCount) return;
            const updatedAt = now();
            const rows = await client.query(spendSql, [Number(day) * 86_400_000, (Number(day) + 1) * 86_400_000]);
            await client.query(
              `INSERT INTO session_spend_days(day, rows, updated_at) VALUES ($1, $2, $3)
               ON CONFLICT (day) DO UPDATE SET rows = EXCLUDED.rows, updated_at = EXCLUDED.updated_at`,
              [day, jsonbStringify(rows.rows), updatedAt],
            );
          });
        } catch (error) {
          reportFailure("spend: refresh daily totals", error);
          continue;
        }
        if (index > 0 && Date.now() - started >= 5_000) break;
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
