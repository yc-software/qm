import { foldPrincipalId, rosterIds } from "../directory/person.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { likeContains } from "../persistence/like.ts";
import type { ScopeId, Session } from "../types.ts";
import type {
  Participant,
  ParticipantPage,
  ParticipantPageQuery,
  ParticipantScope,
  ReplyNotificationClaim,
  SessionStore,
} from "./session-store.ts";
import { AGENT_REPLY_ITEM, msOf, TENANT } from "./items.ts";
import {
  BOT_VISIBLE,
  LIST_COLUMNS,
  NOT_AUTOMATION_SURFACE,
  OWN_CHAT,
  rowToParticipantSession,
  USER_ACTIVITY,
} from "./session-rows.ts";

const samePerson = (column: string, param: string): string => `${column} = ANY(${param}::text[])`;
const SEES_ITEMS = "COALESCE(s.messages, 0) > 0";
const LISTED_SIDE_CHAT = "(s.side_chat IS NULL OR s.side_chat->>'expanded' = 'true')";
const HAS_CONTENT = `(NULLIF(btrim(COALESCE(p.title, s.title)), '') IS NOT NULL OR ${SEES_ITEMS})`;
export const participantSessionsSql = (extraWhere: string, columns = "s.*"): string =>
  `SELECT ${columns}, p.title AS p_title, p.archived AS p_archived, p.pinned AS p_pinned, p.color AS p_color,
          p.read_at AS p_read_at,
          (SELECT ${msOf("MAX(e.created_at)")} FROM items e
            WHERE e.tenant_id = ${TENANT} AND e.session_id = s.id AND ${AGENT_REPLY_ITEM("e")}) AS agent_last_reply,
          ${USER_ACTIVITY} AS user_last_activity,
          ${SEES_ITEMS} AS has_entries
     FROM sessions s
     JOIN participants p ON p.session_id = s.id
    WHERE ${samePerson("p.principal_id", "$1")}${extraWhere}`;

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
  | "claimReplyNotifications"
> {
  const participantSessions: SessionStore["listByParticipant"] = async (principalId, opts) => {
    const limit = opts?.limit === undefined ? undefined : Math.max(0, Math.floor(opts.limit));
    const rows = await q(
      participantSessionsSql(
        ` AND NOT s.ephemeral AND ${NOT_AUTOMATION_SURFACE("s")}${BOT_VISIBLE(opts?.botActor)}`,
        LIST_COLUMNS,
      ) + (limit === undefined ? "" : " ORDER BY COALESCE(s.last_activity, s.created_at) DESC, s.id LIMIT $2"),
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
            FROM sessions s WHERE s.id = p.session_id AND NOT s.ephemeral AND ${NOT_AUTOMATION_SURFACE("s")} OFFSET 0
        ) s
        WHERE ${samePerson("p.principal_id", "$1")}
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
    const where: string[] = [samePerson("p.principal_id", "$1"), OWN_CHAT("s"), LISTED_SIDE_CHAT, HAS_CONTENT];
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
      await q(`DELETE FROM participants WHERE session_id = $1 AND ${samePerson("principal_id", "$2")}`, [
        sessionId,
        rosterIds(principalId),
      ]);
    },

    async updateParticipantView(sessionId, principalId, patch): Promise<void> {
      if (patch.title !== undefined) {
        await q(`UPDATE participants SET title = $3 WHERE session_id = $1 AND ${samePerson("principal_id", "$2")}`, [
          sessionId,
          rosterIds(principalId),
          patch.title,
        ]);
      }
      if (patch.archived !== undefined) {
        await q(`UPDATE participants SET archived = $3 WHERE session_id = $1 AND ${samePerson("principal_id", "$2")}`, [
          sessionId,
          rosterIds(principalId),
          patch.archived,
        ]);
      }
      if (patch.pinned !== undefined) {
        await q(`UPDATE participants SET pinned = $3 WHERE session_id = $1 AND ${samePerson("principal_id", "$2")}`, [
          sessionId,
          rosterIds(principalId),
          patch.pinned,
        ]);
      }
      if (patch.color !== undefined) {
        await q(`UPDATE participants SET color = $3 WHERE session_id = $1 AND ${samePerson("principal_id", "$2")}`, [
          sessionId,
          rosterIds(principalId),
          patch.color,
        ]);
      }
      if (patch.readAt !== undefined) {
        await q(`UPDATE participants SET read_at = $3 WHERE session_id = $1 AND ${samePerson("principal_id", "$2")}`, [
          sessionId,
          rosterIds(principalId),
          patch.readAt,
        ]);
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

    async claimReplyNotifications(sessionId, people): Promise<ReplyNotificationClaim[]> {
      const audience = people === "everyone" ? null : [...new Set(people.flatMap((id) => [id, foldPrincipalId(id)]))];
      const rows = await q(
        `WITH reply AS (
           SELECT e.text, ${msOf("e.created_at")} AS at FROM items e
            WHERE e.tenant_id = ${TENANT} AND e.session_id = $1 AND ${AGENT_REPLY_ITEM("e")}
            ORDER BY e.seq DESC LIMIT 1
         )
         UPDATE participants p SET notified_at = reply.at
           FROM sessions s, reply
          WHERE p.session_id = $1 AND s.id = p.session_id AND s.parent_session_id IS NULL AND s.surface = 'web' AND ${LISTED_SIDE_CHAT}
            AND NOT starts_with(s.thread_ref, 'web:' || p.principal_id || ':app-edit:')
            AND ($2::text[] IS NULL OR p.principal_id = ANY($2::text[]) OR lower(p.principal_id) = ANY($2::text[]))
            AND reply.at > COALESCE(p.read_at, 0) AND reply.at > COALESCE(p.notified_at, 0)
         RETURNING p.principal_id, COALESCE(p.title, s.title) AS title, COALESCE(reply.text, '') AS text`,
        [sessionId, audience],
      );
      return rows.map((r) => ({
        principalId: r.principal_id as string,
        title: (r.title as string | null) ?? null,
        text: r.text as string,
      }));
    },
  };
}
