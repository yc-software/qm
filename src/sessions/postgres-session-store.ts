import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { DIRECTORY_MIGRATIONS } from "../directory/postgres-directory-store.ts";
import { randomUUID } from "node:crypto";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { claimAcrossTenants } from "../tenants/claim.ts";
import type { Session, SessionType, ScopeId } from "../types.ts";
import type {
  NewSessionPin,
  SessionPin,
  EntrySearchHit,
  DistinctScope,
  SessionDescendant,
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
import { createSessionItems, lockSession } from "./session-items.ts";
import { createSessionAdminReads } from "./session-admin-reads.ts";
import { createSessionParticipants, participantSessionsSql } from "./session-participants.ts";
import { LIST_COLUMNS, OWN_CHAT, rowToParticipantSession, rowToSession } from "./session-rows.ts";
import { cronIdOf, promptEnvelopeBody, sessionOrigin } from "./session-store.ts";
import { msOf, SEARCHABLE_ITEM, searchTypeExpr, USER_KINDS, TENANT } from "./items.ts";

const LLM_CAPTURE_PURGE_BATCH = 100;
const ENVELOPE_TOUCH_MS = 24 * 60 * 60_000;

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

const SEARCH_TIMEOUT_MS = 10_000;

export function createPostgresSessionStore(connectionString: string, opts: StoreOptions = {}): SessionStore {
  const now = opts.now ?? (() => Date.now());

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

    ...createSessionItems({ db, now }),
    ...createSessionParticipants(q),
    ...createSessionAdminReads(q),
    ...createSessionSpend({ db, now }),
  };
}
