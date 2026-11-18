import type { PgPool } from "../persistence/pg-pool.ts";
import { likeContains } from "../persistence/like.ts";
import type { ScopeId, Session } from "../types.ts";
import type {
  Participant,
  ParticipantPage,
  ParticipantPageQuery,
  ParticipantScope,
  SessionStore,
} from "./session-store.ts";
import { AGENT_REPLY_ITEM, msOf, TENANT } from "./items.ts";
import { rosterIds } from "../directory/person.ts";
import { BOT_VISIBLE, LIST_COLUMNS, OWN_CHAT, rowToParticipantSession, USER_ACTIVITY } from "./session-rows.ts";

const SEES_ITEMS = "COALESCE(s.messages, 0) > 0";
const HAS_CONTENT = `(NULLIF(btrim(COALESCE(p.title, s.title)), '') IS NOT NULL OR ${SEES_ITEMS})`;
export const PERSON_ROW = (p: string, n = 1): string =>
  `${p}.principal_id = ANY($${n}::text[]) AND NOT EXISTS (SELECT 1 FROM participants o WHERE o.session_id = ${p}.session_id
     AND o.principal_id = ANY($${n}::text[])
     AND array_position($${n}::text[], o.principal_id) < array_position($${n}::text[], ${p}.principal_id))`;
const VIEW_COLUMNS = { title: "title", archived: "archived", pinned: "pinned", color: "color", readAt: "read_at" };
export const participantSessionsSql = (extraWhere: string, columns = "s.*"): string =>
  `SELECT ${columns}, p.title AS p_title, p.archived AS p_archived, p.pinned AS p_pinned, p.color AS p_color,
          p.read_at AS p_read_at,
          (SELECT ${msOf("MAX(e.created_at)")} FROM items e
            WHERE e.tenant_id = ${TENANT} AND e.session_id = s.id AND ${AGENT_REPLY_ITEM("e")}) AS agent_last_reply,
          ${USER_ACTIVITY} AS user_last_activity,
          ${SEES_ITEMS} AS has_entries
     FROM sessions s
     JOIN participants p ON p.session_id = s.id
    WHERE ${PERSON_ROW("p")}${extraWhere}`;

export function createSessionParticipants(
  q: PgPool["q"],
): Pick<
  SessionStore,
  | "addParticipant"
  | "removeParticipant"
  | "listByParticipant"
  | "participantScopes"
  | "listParticipantPage"
  | "getForParticipant"
  | "updateParticipantView"
  | "listParticipants"
  | "distinctParticipants"
  | "participantsOf"
> {
  const participantSessions: SessionStore["listByParticipant"] = async (principalId, opts) => {
    const limit = opts?.limit === undefined ? undefined : Math.max(0, Math.floor(opts.limit));
    const rows = await q(
      participantSessionsSql(BOT_VISIBLE(opts?.botActor), LIST_COLUMNS) +
        (limit === undefined ? "" : " ORDER BY COALESCE(s.last_activity, s.created_at) DESC, s.id LIMIT $2"),
      limit === undefined ? [rosterIds(principalId)] : [rosterIds(principalId), limit],
    );
    return rows.map(rowToParticipantSession);
  };
  const participantScopes = async (principalId: string): Promise<ParticipantScope[]> => {
    const rows = await q(
      `SELECT s.scope_id, MAX(s.channel_name) AS channel_name,
              COUNT(*) FILTER (WHERE s.has_content) AS session_count,
              MAX(s.activity) FILTER (WHERE s.has_content) AS last_activity
         FROM participants p
        CROSS JOIN LATERAL (
          SELECT s.scope_id, s.channel_name, ${USER_ACTIVITY} AS activity, ${HAS_CONTENT} AS has_content
            FROM sessions s WHERE s.id = p.session_id OFFSET 0
        ) s
        WHERE ${PERSON_ROW("p")}
        GROUP BY s.scope_id`,
      [rosterIds(principalId)],
    );
    return rows.map((r) => ({
      scopeId: r.scope_id as ScopeId,
      ...(r.channel_name != null ? { channelName: r.channel_name as string } : {}),
      sessionCount: Number(r.session_count),
      lastActivityAt: r.last_activity == null ? null : Number(r.last_activity),
    }));
  };
  const participantPage = async (principalId: string, query: ParticipantPageQuery): Promise<ParticipantPage> => {
    const params: unknown[] = [rosterIds(principalId)];
    const where: string[] = [
      PERSON_ROW("p"),
      OWN_CHAT("s"),
      "(s.side_chat IS NULL OR s.side_chat->>'expanded' = 'true')",
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
    if (query.sessionIds !== undefined) where.push(`p.session_id = ANY(${param([...query.sessionIds])}::text[])`);
    if (query.titleQuery?.trim()) {
      const pattern = param(likeContains(query.titleQuery.trim()));
      where.push(`(COALESCE(p.title, s.title) ILIKE ${pattern} OR s.channel_name ILIKE ${pattern})`);
    }
    if (query.before)
      where.push(`(${USER_ACTIVITY}, s.id) < (${param(query.before.activity)}::bigint, ${param(query.before.id)})`);
    const limit = Math.max(1, Math.min(Math.floor(query.limit), 200));
    const page = await q(
      `SELECT s.id, ${USER_ACTIVITY} AS activity
         FROM participants p ${
           query.scopeId === undefined
             ? "CROSS JOIN LATERAL (SELECT * FROM sessions WHERE id = p.session_id OFFSET 0) s"
             : "JOIN sessions s ON s.id = p.session_id"
         }
        WHERE ${where.join(" AND ")}
        ORDER BY ${USER_ACTIVITY} DESC, s.id DESC
        LIMIT ${param(limit + 1)}`,
      params,
    );
    const more = page.length > limit;
    const ids = page.slice(0, limit).map((row) => row.id as string);
    if (!ids.length) return { sessions: [], next: null };
    const rows = await q(participantSessionsSql(" AND s.id = ANY($2::text[])", LIST_COLUMNS), [
      rosterIds(principalId),
      ids,
    ]);
    const byId = new Map(rows.map((row) => [row.id as string, rowToParticipantSession(row)]));
    const last = page[limit - 1];
    return {
      sessions: ids.flatMap((id) => byId.get(id) ?? []),
      next: more && last ? { activity: Number(last.activity), id: last.id as string } : null,
    };
  };
  const participantSession = async (sessionId: string, principalId: string): Promise<Session | null> => {
    const rows = await q(participantSessionsSql(" AND s.id = $2"), [rosterIds(principalId), sessionId]);
    return rows[0] ? rowToParticipantSession(rows[0]) : null;
  };

  return {
    listByParticipant: participantSessions,
    participantScopes,
    listParticipantPage: participantPage,
    getForParticipant: participantSession,
    async addParticipant(sessionId, principalId, title): Promise<void> {
      await q(
        `INSERT INTO participants(session_id, principal_id, title) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, session_id, principal_id) DO UPDATE SET title = EXCLUDED.title WHERE EXCLUDED.title IS NOT NULL`,
        [sessionId, principalId, title ?? null],
      );
    },

    async removeParticipant(sessionId, principalId): Promise<void> {
      await q("DELETE FROM participants WHERE session_id = $1 AND principal_id = ANY($2::text[])", [
        sessionId,
        rosterIds(principalId),
      ]);
    },

    async updateParticipantView(sessionId, principalId, patch): Promise<void> {
      for (const [column, value] of Object.entries(VIEW_COLUMNS).flatMap(([key, col]) => {
        const v = patch[key as keyof typeof VIEW_COLUMNS];
        return v === undefined ? [] : [[col, v] as const];
      })) {
        await q(
          `UPDATE participants SET ${column} = $3 WHERE session_id = $1 AND principal_id = (
             SELECT p.principal_id FROM participants p WHERE p.session_id = $1 AND p.principal_id = ANY($2::text[])
              ORDER BY array_position($2::text[], p.principal_id) LIMIT 1)`,
          [sessionId, rosterIds(principalId), value],
        );
      }
    },

    async listParticipants(): Promise<Participant[]> {
      const rows = await q("SELECT session_id, principal_id FROM participants");
      return rows.map((r) => ({ sessionId: r.session_id as string, principalId: r.principal_id as string }));
    },

    async distinctParticipants(): Promise<string[]> {
      const rows = await q("SELECT DISTINCT principal_id FROM participants");
      return rows.map((r) => r.principal_id as string);
    },

    async participantsOf(sessionId): Promise<string[]> {
      const rows = await q("SELECT principal_id FROM participants WHERE session_id = $1", [sessionId]);
      return rows.map((r) => r.principal_id as string);
    },
  };
}
