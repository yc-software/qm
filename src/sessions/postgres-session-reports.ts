import type { PgPool } from "../persistence/pg-pool.ts";
import { tenantCols, withPgTransaction } from "../persistence/pg-pool.ts";
import { jsonbSafeStringify } from "../util/text.ts";
import { reportFailure } from "../util/errors.ts";
import type { ScopeId } from "../types.ts";
import type { AttributedTurn, SessionStore, SpendRow } from "./session-store.ts";
import type { SessionOrigin } from "./thread-ref.ts";
import { msOf } from "./items.ts";
import { SPEND_FIELDS, spendValue, TENANT, userTurn, withinParticipantWindow } from "./postgres-session-sql.ts";

const SPEND_BACKFILL_BATCH = 20_000;
const ATTRIBUTION_BATCH = 200;

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
            WHERE a.origin = 'conversation' AND NOT p.id = ANY(a.path)
         ), origins AS (
           SELECT DISTINCT ON (session_id) session_id, origin, cron_id
             FROM ancestry ORDER BY session_id, cardinality(path) DESC
         ), rollup AS MATERIALIZED (
           SELECT (r.created_at / 86400000)::bigint AS day, s.scope_id,
                COALESCE(o.origin, s.origin) AS origin,
                COALESCE(o.cron_id, s.origin_id) AS cron_id, r.model,
                COUNT(*) AS calls,
                COALESCE(SUM(spend_cost_usd), 0)::text AS cost_usd,
                COALESCE(SUM(spend_input), 0) AS input,
                COALESCE(SUM(spend_output), 0) AS output,
                COALESCE(SUM(spend_cache_read), 0) AS cache_read,
                COALESCE(SUM(spend_cache_write), 0) AS cache_write
           FROM (SELECT r.created_at, r.session_id, r.model,
                        ${SPEND_FIELDS.map(
                          ([column, key, type]) =>
                            `COALESCE(r.${column}, ${spendValue("unparsed.usage", key, type)}) AS ${column}`,
                        ).join(",\n                        ")}
                   FROM session_llm_requests r
                   LEFT JOIN LATERAL (SELECT llm_spend_usage(r.usage_json) AS usage
                                       WHERE r.spend_cost_usd IS NULL) unparsed ON TRUE
                  WHERE r.created_at >= $1 AND r.created_at < $2 AND r.usage_json IS NOT NULL
                 OFFSET 0) r
           JOIN sessions s ON s.id = r.session_id
           LEFT JOIN origins o ON o.session_id = s.id
          GROUP BY day, s.scope_id, COALESCE(o.origin, s.origin), COALESCE(o.cron_id, s.origin_id), r.model
         )
         SELECT * FROM rollup ORDER BY day, scope_id, origin, cron_id, model`;

/** Admin reports over all sessions: per-day LLM spend (cached per day) and per-person turn attribution (cached per session). */
export function createSessionReports(
  db: Pick<PgPool, "pool" | "q">,
  now: () => number,
): Pick<SessionStore, "attributedTurns" | "spendRollup" | "spendReport" | "refreshSpendRollup"> {
  const { pool, q } = db;
  return {
    async attributedTurns(): Promise<AttributedTurn[]> {
      // Sessions whose user items or participant windows changed are recomputed in small batches,
      // so a message append waits on at most one batch; everything else is read from the cache.
      for (;;) {
        const recomputed = await withPgTransaction(await pool(), async (client) => {
          const dirty = await client.query(
            `DELETE FROM attributed_turns_dirty WHERE session_id IN (
               SELECT session_id FROM attributed_turns_dirty LIMIT ${ATTRIBUTION_BATCH} FOR UPDATE SKIP LOCKED)
             RETURNING session_id`,
          );
          if (!dirty.rowCount) return false;
          const ids = dirty.rows.map((r) => r.session_id as string);
          await client.query("DELETE FROM attributed_turns WHERE session_id = ANY($1::text[])", [ids]);
          await client.query(
            `INSERT INTO attributed_turns(session_id, principal_id, day, turns, first_at, last_at)
             SELECT e.session_id, p.principal_id, (${msOf("e.created_at")} / 86400000)::bigint AS day,
                    COUNT(*), ${msOf("MIN(e.created_at)")}, ${msOf("MAX(e.created_at)")}
               FROM participants p
               JOIN items e ON e.tenant_id = ${TENANT} AND e.session_id = p.session_id
              WHERE p.session_id = ANY($1::text[])
                AND ${userTurn("e")}
                AND ${withinParticipantWindow("e", "p")}
              GROUP BY p.principal_id, e.session_id, day`,
            [ids],
          );
          return true;
        });
        if (!recomputed) break;
      }
      const rows = await q("SELECT principal_id, session_id, day, turns, first_at, last_at FROM attributed_turns");
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
      await q(
        `UPDATE session_llm_requests r
            SET ${SPEND_FIELDS.map(([column, key, type]) => `${column} = ${spendValue("unparsed.usage", key, type)}`).join(", ")}
           FROM (SELECT id, llm_spend_usage(usage_json) AS usage FROM session_llm_requests
                  WHERE usage_json IS NOT NULL AND spend_cost_usd IS NULL LIMIT $1) unparsed
          WHERE r.id = unparsed.id`,
        [SPEND_BACKFILL_BATCH],
      ).catch((error) => reportFailure("spend: backfill usage columns", error));
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
               ON CONFLICT (${tenantCols("day")}) DO UPDATE SET rows = EXCLUDED.rows, updated_at = EXCLUDED.updated_at`,
              [day, jsonbSafeStringify(rows.rows), updatedAt],
            );
          });
        } catch (error) {
          reportFailure("spend: refresh daily totals", error);
          continue;
        }
        if (index > 0 && Date.now() - started >= 5_000) break;
      }
    },
  };
}
