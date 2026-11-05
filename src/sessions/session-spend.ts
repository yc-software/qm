import { type PgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { jsonbStringify } from "../util/text.ts";
import { reportFailure } from "../util/errors.ts";
import type { ScopeId } from "../types.ts";
import type { SessionOrigin, SessionStore, SpendRow } from "./session-store.ts";
import { ancestry, SPEND_INDEXABLE } from "./session-schema.ts";

const spendSql = `WITH RECURSIVE ${ancestry(`s.parent_session_id IS NOT NULL AND s.origin = 'conversation'
            AND EXISTS (SELECT 1 FROM session_llm_requests r
                         WHERE r.session_id = s.id AND r.created_at >= $1 AND r.created_at < $2
                           AND r.usage_json IS NOT NULL)`)}, origins AS (
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

export function createSessionSpend(deps: {
  db: PgPool;
  now: () => number;
}): Pick<SessionStore, "spendRollup" | "spendReport" | "refreshSpendRollup"> {
  const { db, now } = deps;
  const { pool, q } = db;

  return {
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
             SELECT c.id FROM affected a
               CROSS JOIN LATERAL (SELECT id FROM sessions WHERE parent_session_id = a.id OFFSET 0) c
           )
           INSERT INTO session_spend_dirty(day)
           SELECT DISTINCT d.day FROM affected a
             CROSS JOIN LATERAL (
               SELECT floor(created_at::numeric / 86400000)::bigint AS day FROM session_llm_requests
                WHERE session_id = a.id AND usage_json IS NOT NULL OFFSET 0
             ) d
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
  };
}
