import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { DIRECTORY_MIGRATIONS } from "../directory/postgres-directory-store.ts";
import { randomUUID } from "node:crypto";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { Session, SessionType, ScopeId } from "../types.ts";
import type {
  NewSessionPin,
  SessionPin,
  DistinctScope,
  SessionDescendant,
  SessionOrigin,
  SessionRef,
  SessionStore,
  StoreOptions,
} from "./session-store.ts";
import { ancestry, SESSION_MIGRATIONS } from "./session-schema.ts";
import { createSessionSpend } from "./session-spend.ts";
import { createLlmCaptures } from "./llm-captures.ts";
import { createSessionSearch } from "./session-search.ts";
import { createSessionItems, lockSession } from "./session-items.ts";
import { createSessionAdminReads } from "./session-admin-reads.ts";
import { createSessionParticipants, participantSessionsSql } from "./session-participants.ts";
import { LIST_COLUMNS, rowToParticipantSession, rowToSession } from "./session-rows.ts";
import { cronIdOf, sessionOrigin } from "./session-store.ts";
import { TENANT } from "./items.ts";
import { SLACK_TENANTS, SLACK_BRIDGE_TENANT, TENANT_LOOKUPS, tenantLookup } from "../tenants/lookup.ts";

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

  const db = createPgPool(connectionString, [
    ...DIRECTORY_MIGRATIONS,
    ...SESSION_MIGRATIONS,
    TENANT_LOOKUPS,
    SLACK_TENANTS,
    SLACK_BRIDGE_TENANT,
  ]);
  const { pool, q } = db;

  return {
    tenantLookup: tenantLookup(db),
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

    async setPersona(sessionId, personaId): Promise<void> {
      await q("UPDATE sessions SET persona_id = $2 WHERE id = $1", [sessionId, personaId]);
    },

    async threadsWithPersona(personaId, threadRefs): Promise<Set<string>> {
      if (!threadRefs.length) return new Set();
      const rows = await q("SELECT thread_ref FROM sessions WHERE thread_ref = ANY($1::text[]) AND persona_id = $2", [
        threadRefs,
        personaId,
      ]);
      return new Set(rows.map((r) => r.thread_ref as string));
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

    ...createSessionSearch(q),
    ...createLlmCaptures({ db, now }),
    ...createSessionItems({ db, now }),
    ...createSessionParticipants(q),
    ...createSessionAdminReads(q),
    ...createSessionSpend({ db, now }),
  };
}
