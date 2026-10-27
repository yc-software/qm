import { randomUUID } from "node:crypto";
import { likeContains } from "../persistence/like.ts";
import { withPgTransaction } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { NewSessionPin, SessionPin, ItemSearchHit, GetItemsOptions, SessionStore } from "./session-store.ts";
import type { Session } from "../types.ts";
import { tsPrefixQuery } from "./item-search.ts";
import { TENANT, withinParticipantWindow } from "./postgres-session-sql.ts";
import { rowToItem, rowToParticipantSession, ITEM_FIELDS, ITEM_FROM } from "./postgres-session-rows.ts";
import { lockSession, transcriptItemPredicate, type SessionStoreCtx } from "./postgres-session-items.ts";
import { participantSessionsSql } from "./postgres-session-participants.ts";
import { type Item, msOf, SEARCHABLE_ITEM, searchTypeExpr, USER_KINDS } from "./items.ts";

const SEARCH_TIMEOUT_MS = 10_000;

export function sessionPinAndSearchMethods(ctx: SessionStoreCtx) {
  const { q, pool, now } = ctx;
  return {
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

    async visibleItems(sessionId, principals, opts?: GetItemsOptions): Promise<Item[]> {
      const ids = [...new Set([principals].flat())];
      if (!ids.length) return [];
      const params: unknown[] = [sessionId, ids, opts?.sinceSeq ?? 0];
      // An item is visible only when every principal's participation window covers it.
      let sql = `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM}
          WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq >= $3
            AND (SELECT count(*) FROM participants p
                  WHERE p.session_id = i.session_id AND p.principal_id = ANY($2::text[])
                    AND ${withinParticipantWindow("i", "p")}
                    ${opts?.transcript ? `AND ${transcriptItemPredicate("i", "p")}` : ""}) = cardinality($2::text[])`;
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
      const like = likeContains(needle);
      const rows = await q(
        participantSessionsSql(" AND COALESCE(p.title, s.title) ILIKE $2") +
          " ORDER BY COALESCE(s.last_activity, s.created_at) DESC, s.id LIMIT $3",
        [principalId, like, Math.max(1, Math.floor(limit))],
        { timeoutMs: SEARCH_TIMEOUT_MS },
      );
      return rows.map(rowToParticipantSession);
    },

    async searchItems(principalId, query, limit = 40): Promise<ItemSearchHit[]> {
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
        [principalId, ts, Math.max(1, Math.floor(limit))],
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
            type: r.type as ItemSearchHit["type"],
            ...(r.author ? { author: r.author as string } : {}),
            text,
            createdAt: Number(r.created_at),
          },
        ];
      });
    },
  } satisfies Partial<SessionStore>;
}
