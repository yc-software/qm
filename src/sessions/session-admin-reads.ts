import type { PgPool } from "../persistence/pg-pool.ts";
import type { ScopeId, Session } from "../types.ts";
import type {
  ScopeActivity,
  SessionOrigin,
  SessionOriginFilter,
  SessionPage,
  SessionStore,
  SessionSummary,
} from "./session-store.ts";

const ADMIN_READ_TIMEOUT_MS = 10_000;
const lastActivityExpr = (col: string): string => `COALESCE(${col}.last_activity, ${col}.created_at)`;
const isBackground = (alias: string): string => `${alias}.origin <> 'conversation'`;
const hasOrigin = (alias: string, origin: SessionOrigin): string => `${alias}.origin = '${origin}'`;
const originFilterClause = (alias: string, origin: SessionOriginFilter): string =>
  origin === "other_background" ? `${alias}.origin NOT IN ('conversation', 'cron')` : hasOrigin(alias, origin);

export function createSessionAdminReads(
  q: PgPool["q"],
): Pick<SessionStore, "countSessions" | "scopeSessionSummaries" | "scopeConversationCount" | "scopeActivity"> {
  return {
    async countSessions(): Promise<number> {
      const rows = await q("SELECT COUNT(*) AS n FROM sessions");
      return Number(rows[0]?.n ?? 0);
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
  };
}
