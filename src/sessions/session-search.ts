import { likeContains } from "../persistence/like.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import type { ScopeId, Session } from "../types.ts";
import type { EntrySearchHit, SessionStore } from "./session-store.ts";
import { tsPrefixQuery } from "./entry-search.ts";
import { msOf, SEARCHABLE_ITEM, searchTypeExpr, TENANT, USER_KINDS } from "./items.ts";
import { participantSessionsSql } from "./session-participants.ts";
import { BOT_VISIBLE, OWN_CHAT, rowToParticipantSession } from "./session-rows.ts";

const SEARCH_TIMEOUT_MS = 10_000;

export function createSessionSearch(q: PgPool["q"]): Pick<SessionStore, "searchSessionTitles" | "searchEntries"> {
  return {
    async searchSessionTitles(principalId, query, limit = 20, botActor): Promise<Session[]> {
      const needle = query.trim();
      if (needle.length < 2) return [];
      const rows = await q(
        participantSessionsSql(
          ` AND ${OWN_CHAT("s")} AND COALESCE(p.title, s.title) ILIKE $2${BOT_VISIBLE(botActor)}`,
        ) + " ORDER BY COALESCE(s.last_activity, s.created_at) DESC, s.id LIMIT $3",
        [principalId, likeContains(needle), Math.max(1, Math.min(Math.floor(limit), 100))],
        { timeoutMs: SEARCH_TIMEOUT_MS },
      );
      return rows.map(rowToParticipantSession);
    },

    async searchEntries(principalId, query, limit = 40, botActor): Promise<EntrySearchHit[]> {
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
           JOIN sessions s ON s.id = i.session_id AND ${OWN_CHAT("s")}${BOT_VISIBLE(botActor)}
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
  };
}
