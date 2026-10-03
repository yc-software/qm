import type { PgPool } from "../../src/persistence/pg-pool.ts";
import { stableOriginPattern, legacyOriginPattern, ORIGIN_ALTERNATION } from "../../src/sessions/session-store.ts";
const threadRefCronIdExpr = (threadRef: string): string =>
  `COALESCE(substring(${threadRef} FROM '^agent:main:cron:([^:]+)$'), substring(${threadRef} FROM '^cron:([^:]+)(:.+)?$'))`;

const threadRefOriginExpr = (threadRef: string): string =>
  `COALESCE(substring(${threadRef} FROM '${stableOriginPattern(ORIGIN_ALTERNATION)}'), substring(${threadRef} FROM '${legacyOriginPattern(ORIGIN_ALTERNATION)}'), 'conversation')`;

export async function backfillSessionOriginBatch(q: PgPool["q"], limit: number): Promise<number> {
  const updated = await q(
    `UPDATE sessions
        SET origin = ${threadRefOriginExpr("thread_ref")}, origin_id = ${threadRefCronIdExpr("thread_ref")}
      WHERE id IN (SELECT id FROM sessions WHERE origin IS NULL LIMIT $1)
      RETURNING 1`,
    [limit],
  );
  return updated.length;
}

const SOURCE_CRON_ID_EXPR = threadRefCronIdExpr("provenance->>'sourceThreadRef'");

export async function backfillDeliverySourceCronIdBatch(q: PgPool["q"], limit: number): Promise<number> {
  const updated = await q(
    `UPDATE deliveries
        SET source_cron_id = ${SOURCE_CRON_ID_EXPR}
      WHERE id IN (SELECT id FROM deliveries
                    WHERE source_cron_id IS NULL AND ${SOURCE_CRON_ID_EXPR} IS NOT NULL
                    LIMIT $1)
      RETURNING 1`,
    [limit],
  );
  return updated.length;
}
