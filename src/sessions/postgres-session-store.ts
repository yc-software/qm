import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { DIRECTORY_MIGRATIONS } from "../directory/postgres-directory-store.ts";
import { randomUUID } from "node:crypto";
import { createPgPool, type PoolClient, withPgTransaction } from "../persistence/pg-pool.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";
import { claimAcrossTenants } from "../tenants/claim.ts";
import type { Session, SessionType, ScopeId } from "../types.ts";
import type { GoalRecord } from "../agent/goal.ts";
import type {
  NewSessionPin,
  SessionPin,
  EntrySearchHit,
  DistinctScope,
  SessionDescendant,
  GetItemsOptions,
  SessionWriter,
  LlmRequestRecord,
  NewLlmRequest,
  SessionOrigin,
  SessionRef,
  SessionStore,
  StoreOptions,
} from "./session-store.ts";
import { tsPrefixQuery } from "./entry-search.ts";
import { ancestry, SESSION_MIGRATIONS } from "./session-schema.ts";
import { createSessionSpend } from "./session-spend.ts";
import { createSessionAdminReads } from "./session-admin-reads.ts";
import { createSessionParticipants, participantSessionsSql } from "./session-participants.ts";
import { LIST_COLUMNS, OWN_CHAT, rowToParticipantSession, rowToSession } from "./session-rows.ts";
import {
  cronIdOf,
  promptEnvelopeBody,
  sessionOrigin,
  userMessagePreview,
  DuplicateCallError,
} from "./session-store.ts";
import {
  ITEM_COLUMNS,
  type Item,
  type NewItem,
  storedItem,
  msOf,
  SEARCHABLE_ITEM,
  searchTypeExpr,
  isUserItem,
  USER_KINDS,
  userTurn,
  TENANT,
} from "./items.ts";

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

function rowToItem(r: Record<string, unknown>): Item {
  return {
    sessionId: r.session_id as string,
    seq: Number(r.seq),
    createdAt: Number(r.created_at),
    ...Object.fromEntries(
      ITEM_COLUMNS.map(([, key, type]) => [
        key,
        type === "bigint" && r[key] != null ? Number(r[key]) : (r[key] ?? null),
      ]),
    ),
  } as Item;
}

const ITEM_FIELDS = `i.session_id, i.seq, ${ITEM_COLUMNS.map(([column, key]) => `${column === "blob_sha" ? "encode(i.blob_sha, 'hex')" : `i.${column}`} AS "${key}"`).join(",")}, ${msOf("i.created_at")} AS created_at`;
const ITEM_FROM = "items i";

const tsOf = (ms: string): string => `to_timestamp((${ms})::double precision / 1000)`;

const LAST_ACTIVITY_DEBOUNCE_MS = 60_000;
const SEARCH_TIMEOUT_MS = 10_000;

const FIRST_PREVIEW_LEN = 160;
const LAST_PREVIEW_LEN = 100;

const storedPreview = (item: Item, maxLen: number): string => pgTextSafe(userMessagePreview(item.text ?? "", maxLen));

export function createPostgresSessionStore(connectionString: string, opts: StoreOptions = {}): SessionStore {
  const now = opts.now ?? (() => Date.now());

  function transcriptItemPredicate(alias: string): string {
    const receipt = (item: string): string => `COALESCE(${item}.body @> '{"slackReplyReceipt":true}'::jsonb, false)`;
    return `NOT (
      ${alias}.kind = 'UserMessage' AND ${receipt(alias)}
      AND EXISTS (
        SELECT 1 FROM items received
        WHERE received.tenant_id = ${alias}.tenant_id AND received.session_id = ${alias}.session_id
          AND received.kind = 'UserMessage' AND received.external_id = ${alias}.external_id
          AND NOT ${receipt("received")}
      )
    )`;
  }

  const descendantsOf = async (rootIds: readonly string[]): Promise<SessionDescendant[]> => {
    if (!rootIds.length) return [];
    const rows = await q(
      `WITH RECURSIVE tree(id, root_id, thread_ref) AS (
         SELECT id, parent_session_id, thread_ref FROM sessions WHERE parent_session_id = ANY($1::text[])
         UNION
         SELECT c.id, t.root_id, c.thread_ref FROM tree t
           CROSS JOIN LATERAL (SELECT id, thread_ref FROM sessions WHERE parent_session_id = t.id OFFSET 0) c
       )
       SELECT id, root_id, thread_ref FROM tree`,
      [[...rootIds]],
    );
    return rows.map((r) => ({ id: r.id as string, rootId: r.root_id as string, threadRef: r.thread_ref as string }));
  };

  const db = createPgPool(connectionString, [...DIRECTORY_MIGRATIONS, ...SESSION_MIGRATIONS]);
  const { pool, q } = db;

  const lockSession = (client: PoolClient, sessionId: string) =>
    client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [sessionId]);

  const withSessionLock = async <T>(writer: SessionWriter, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    withPgTransaction(await pool(), async (client) => {
      await lockSession(client, writer.sessionId);
      if (writer.turnId && writer.runLeaseToken) {
        const held = await client.query(
          "SELECT 1 FROM runs WHERE id = $1 AND lease_token = $2 AND status = 'running' FOR SHARE",
          [writer.turnId, writer.runLeaseToken],
        );
        if (!held.rowCount) throw new Error(`run ${writer.turnId} no longer holds its claim; write refused`);
      }
      return fn(client);
    });

  const insertItems = async (
    client: PoolClient,
    sessionId: string,
    entries: readonly NewItem[],
    turnId?: string,
  ): Promise<Item[]> => {
    if (!entries.length) return [];
    const max = await client.query(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(seq) FROM items WHERE tenant_id = ${TENANT} AND session_id = $1), -1) + 1,
         COALESCE((SELECT messages FROM sessions WHERE id = $1), 0)) AS n`,
      [sessionId],
    );
    const startSeq = Number(max.rows[0]!.n);
    const createdAt = now();
    const items = entries.map((entry, index) =>
      storedItem(JSON.parse(jsonbStringify(entry)) as NewItem, { sessionId, seq: startSeq + index, createdAt, turnId }),
    );
    const userTurns = items.filter((item) => isUserItem(item) && item.body.overheard !== true);
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
          startSeq + items.length,
          userTurns.length,
          startSeq,
          firstUser ? storedPreview(firstUser, FIRST_PREVIEW_LEN) : null,
          lastUser ? storedPreview(lastUser, LAST_PREVIEW_LEN) : null,
          items.some(isUserItem),
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
    return items;
  };

  return {
    async getOrCreateByThread(threadRef, type, scopeId, channelName, surface, clientTools, facts): Promise<Session> {
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
        if (facts?.surfaceBinding && !s.surfaceBinding) {
          await q("UPDATE sessions SET slack_binding = $2::jsonb WHERE id = $1 AND slack_binding IS NULL", [
            s.id,
            JSON.stringify(facts.surfaceBinding),
          ]);
          s.surfaceBinding = facts.surfaceBinding;
        }
        if (facts?.context && canonicalJson(s.spawnMeta) !== canonicalJson(facts.context)) {
          await q("UPDATE sessions SET spawn_meta = $2 WHERE id = $1", [s.id, JSON.stringify(facts.context)]);
          s.spawnMeta = facts.context;
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
        "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, channel_name, surface, last_activity, messages, turns, origin, origin_id, client_tools) VALUES ($1,$2,$3,$4,$5,$6,$7,$5,0,0,$8,$9,$10::jsonb) ON CONFLICT (tenant_id, thread_ref) DO NOTHING",
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

    async setRuntime(sessionId, runtime): Promise<void> {
      await q("UPDATE sessions SET runtime = $2::jsonb WHERE id = $1 AND runtime IS DISTINCT FROM $2::jsonb", [
        sessionId,
        JSON.stringify(runtime),
      ]);
    },

    async endedInFailure(sessionIds): Promise<Set<string>> {
      if (!sessionIds.length) return new Set();
      const rows = await q(
        `SELECT ids.id FROM unnest($1::text[]) AS ids(id)
         CROSS JOIN LATERAL (
           SELECT kind FROM items WHERE tenant_id = ${TENANT} AND session_id = ids.id ORDER BY seq DESC LIMIT 1
         ) last
         WHERE last.kind = 'Error'`,
        [[...new Set(sessionIds)]],
      );
      return new Set(rows.map((row) => row.id as string));
    },

    async childrenOf(parentSessionId): Promise<Session[]> {
      const rows = await q("SELECT * FROM sessions WHERE parent_session_id = $1 ORDER BY created_at", [
        parentSessionId,
      ]);
      return rows.map(rowToSession);
    },

    async append(writer: SessionWriter, item: NewItem): Promise<Item> {
      return (await this.appendMany(writer, [item]))[0]!;
    },

    async appendMany(writer: SessionWriter, items: readonly NewItem[]): Promise<Item[]> {
      return withSessionLock(writer, (client) => insertItems(client, writer.sessionId, items, writer.turnId));
    },

    async countItemsBefore(sessionId, beforeSeq, principalId) {
      const rows =
        principalId === undefined
          ? await q(
              `SELECT count(*)::int AS n FROM items i WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq < $2 AND ${transcriptItemPredicate("i")}`,
              [sessionId, beforeSeq],
            )
          : await q(
              `SELECT count(*)::int AS n FROM items i
                 JOIN participants p ON p.session_id = i.session_id AND p.principal_id = $3
                WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq < $2 AND ${transcriptItemPredicate("i")}`,
              [sessionId, beforeSeq, principalId],
            );
      return Number(rows[0]?.n ?? 0);
    },

    async latestToolPurposes(turnIds) {
      if (!turnIds.length) return new Map();
      const rows = await q(
        `SELECT DISTINCT ON (i.turn_id) i.turn_id::text AS turn_id, btrim(i.body->>'purpose') AS purpose FROM items i
          WHERE i.tenant_id = ${TENANT} AND i.turn_id = ANY($1::uuid[]) AND i.kind = 'ToolCall'
            AND btrim(i.body->>'purpose') <> ''
          ORDER BY i.turn_id, i.seq DESC`,
        [turnIds.map((id) => id.toLowerCase())],
      );
      return new Map(rows.map((r) => [r.turn_id as string, r.purpose as string]));
    },

    async latestItemSeq(sessionId): Promise<number> {
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

    async setGoal(writer, goal, notices = []) {
      await withSessionLock(writer, async (client) => {
        await insertItems(client, writer.sessionId, notices, writer.turnId);
        await client.query(
          `INSERT INTO session_goals(session_id, objective, status, floor, token_cap, tokens_used, active_ms,
                                     active_since, completion_note, cancel_note, governor, pause_reason,
                                     created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
           ON CONFLICT (tenant_id, session_id) DO UPDATE SET
             objective = EXCLUDED.objective, status = EXCLUDED.status, floor = EXCLUDED.floor,
             token_cap = EXCLUDED.token_cap, tokens_used = EXCLUDED.tokens_used, active_ms = EXCLUDED.active_ms,
             active_since = EXCLUDED.active_since, completion_note = EXCLUDED.completion_note,
             cancel_note = EXCLUDED.cancel_note, governor = EXCLUDED.governor, pause_reason = EXCLUDED.pause_reason,
             created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
          [
            writer.sessionId,
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

    async getItems(sessionId, opts?: GetItemsOptions): Promise<Item[]> {
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
      return (await q(sql, params)).map(rowToItem).reverse();
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
      return { items: rows.map(rowToItem), totalItems: Number(meta[0]?.total ?? 0) };
    },

    async getItem(sessionId, seq): Promise<Item | undefined> {
      const rows = await q(
        `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM} WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq = $2`,
        [sessionId, seq],
      );
      return rows[0] ? rowToItem(rows[0]) : undefined;
    },

    async recordLlmRequest(sessionId, rec: NewLlmRequest): Promise<LlmRequestRecord> {
      const envelope = promptEnvelopeBody(rec.promptEnvelope);
      if (envelope) {
        await q(
          `INSERT INTO llm_prompt_envelopes(hash, body, created_at) VALUES ($1,$2,$3)
           ON CONFLICT (tenant_id, hash) DO UPDATE SET created_at = EXCLUDED.created_at
            WHERE llm_prompt_envelopes.created_at < EXCLUDED.created_at - ${ENVELOPE_TOUCH_MS}`,
          [envelope.hash, envelope.body, now()],
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

    async purgeLlmCaptures(cutoff, opts) {
      const deadline = opts?.deadline ?? Infinity;
      let envelopes = 0;
      while (Date.now() < deadline && !opts?.stop?.()) {
        const deleted = await claimAcrossTenants(
          db,
          `DELETE FROM llm_prompt_envelopes
            WHERE (tenant_id, hash) IN (SELECT tenant_id, hash FROM llm_prompt_envelopes WHERE created_at < $1
                            ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
              AND created_at < $1`,
          [cutoff, LLM_CAPTURE_PURGE_BATCH],
        );
        envelopes += deleted.rowCount;
        if (deleted.rowCount < LLM_CAPTURE_PURGE_BATCH) break;
      }
      return envelopes;
    },

    async deleteSession(sessionId): Promise<void> {
      await withPgTransaction(await pool(), async (client) => {
        await lockSession(client, sessionId);
        await client.query("DELETE FROM session_llm_requests WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM participants WHERE session_id = $1", [sessionId]);
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
              AND NOT EXISTS (SELECT 1 FROM items WHERE tenant_id = ${TENANT} AND session_id = $1)`,
          [sessionId],
        );
        if (gone.rowCount === 0) return false;
        await client.query("DELETE FROM session_llm_requests WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM participants WHERE session_id = $1", [sessionId]);
        await client.query("DELETE FROM session_pins WHERE session_id = $1", [sessionId]);
        return true;
      });
    },

    async descendantsOf(rootIds): Promise<SessionDescendant[]> {
      return descendantsOf(rootIds);
    },

    async inheritedOrigin(session): Promise<SessionOrigin> {
      const rows = await q(
        `WITH RECURSIVE ${ancestry("s.id = $1")} SELECT origin FROM ancestry ORDER BY cardinality(path) DESC LIMIT 1`,
        [session.id],
      );
      return (rows[0]?.origin as SessionOrigin | undefined) ?? "conversation";
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

    async sameScopeAncestors(threadRefs) {
      const rows = await q(
        `WITH RECURSIVE up(leaf_scope, id, scope_id, parent_id, depth, path) AS (
           SELECT l.scope_id, p.id, p.scope_id, p.parent_session_id, 1, ARRAY[l.id, p.id]
             FROM sessions l JOIN sessions p ON p.id = l.parent_session_id AND p.id <> l.id WHERE l.thread_ref = ANY($1::text[])
           UNION ALL
           SELECT u.leaf_scope, p.id, p.scope_id, p.parent_session_id, u.depth + 1, u.path || p.id FROM up u
             CROSS JOIN LATERAL (SELECT * FROM sessions WHERE id = u.parent_id OFFSET 0) p WHERE NOT p.id = ANY(u.path)
         ), hits AS (SELECT id, min(depth) AS depth FROM up WHERE scope_id = leaf_scope GROUP BY id)
         SELECT s.* FROM hits JOIN sessions s ON s.id = hits.id ORDER BY hits.depth, s.id`,
        [[...threadRefs]],
      );
      return rows.map(rowToSession);
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

    async visibleItems(sessionId, principalId, opts?: GetItemsOptions): Promise<Item[]> {
      const params: unknown[] = [sessionId, principalId, opts?.sinceSeq ?? 0];
      let sql = `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM}
           JOIN participants p ON p.session_id = i.session_id AND p.principal_id = $2
          WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq >= $3`;
      if (opts?.messagesOnly)
        sql += " AND i.kind IN ('UserMessage', 'SteeringMessage', 'AgentMessage') AND i.variant IS NULL";
      if (opts?.transcript) sql += ` AND ${transcriptItemPredicate("i")}`;
      if (opts?.beforeSeq !== undefined) {
        params.push(opts.beforeSeq);
        sql += ` AND i.seq < $${params.length}`;
      }
      sql += " ORDER BY i.seq DESC";
      if (opts?.limit !== undefined) {
        params.push(opts.limit);
        sql += ` LIMIT $${params.length}`;
      }
      return (await q(sql, params)).map(rowToItem).reverse();
    },

    async searchSessionTitles(principalId, query, limit = 20): Promise<Session[]> {
      const needle = query.trim();
      if (needle.length < 2) return [];
      const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = await q(
        participantSessionsSql(` AND ${OWN_CHAT("s")} AND COALESCE(p.title, s.title) ILIKE $2`) +
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
           JOIN sessions s ON s.id = i.session_id AND ${OWN_CHAT("s")}
          WHERE i.tenant_id = ${TENANT} AND i.search @@ to_tsquery('simple', $2)
            AND ${SEARCHABLE_ITEM("i")}
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

    ...createSessionParticipants(q),
    ...createSessionAdminReads(q),
    ...createSessionSpend({ db, now }),
  };
}
