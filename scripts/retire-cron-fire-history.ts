import { createPgPool, withPgTransaction } from "../src/persistence/pg-pool.ts";
import { databaseUrl } from "./lib/backfill-runner.ts";

const apply = process.argv.includes("--apply");
const db = createPgPool(databaseUrl());
const columns = "cron_id, fire_key, thread_ref, session_id, fired_at, scheduled_at, ended_at, status, note, reply";
const values = columns.split(", ").slice(2);
try {
  await withPgTransaction(await db.pool(), async (client) => {
    if (!apply) await client.query("SET TRANSACTION READ ONLY");
    const legacy = (await client.query("SELECT to_regclass('cron_fire_log') IS NOT NULL AS present")).rows[0]!.present;
    if (apply) {
      await client.query("LOCK TABLE crons, cron_fires IN SHARE ROW EXCLUSIVE MODE");
      if (legacy) await client.query("LOCK TABLE cron_fire_log IN SHARE ROW EXCLUSIVE MODE");
    }
    const sources = [
      "SELECT id AS cron_id, entry AS json FROM crons CROSS JOIN LATERAL jsonb_array_elements(COALESCE(json->'fireLog', '[]'::jsonb)) entry",
      ...(legacy
        ? [
            "SELECT cron_id, json || jsonb_build_object('fireKey', fire_key, 'firedAt', fired_at, 'endedAt', COALESCE((json->>'endedAt')::bigint, CASE WHEN json->>'status' IS DISTINCT FROM 'running' THEN fired_at END)) AS json FROM cron_fire_log",
          ]
        : []),
    ];
    let missing = 0;
    for (const source of sources) {
      const select = `WITH source AS (${source}) SELECT cron_id, json->>'fireKey' AS fire_key,
      COALESCE(json->>'threadRef', 'cron:' || cron_id) AS thread_ref,
      json->>'sessionId' AS session_id, (json->>'firedAt')::bigint AS fired_at,
      (json->>'scheduledAt')::bigint AS scheduled_at,
      (json->>'endedAt')::bigint AS ended_at,
      json->>'status' AS status, json->>'note' AS note, json->>'reply' AS reply FROM source`;
      if (apply) {
        await client.query(`INSERT INTO cron_fires (${columns}) ${select}
        ON CONFLICT (cron_id, fire_key) DO UPDATE SET ${values.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}
        WHERE EXCLUDED.fired_at >= cron_fires.fired_at
          AND (cron_fires.ended_at IS NULL OR EXCLUDED.ended_at IS NOT NULL)`);
      }
      const { rows } = await client.query(`SELECT count(*)::int AS missing FROM (${select}) old
      LEFT JOIN cron_fires current USING (cron_id, fire_key)
      WHERE current.cron_id IS NULL OR old.fired_at > current.fired_at
        OR (old.fired_at = current.fired_at AND old.ended_at IS NOT NULL AND current.ended_at IS NULL)`);
      missing += Number(rows[0]!.missing);
    }
    console.log(JSON.stringify({ missing }));
    if (missing) {
      if (apply) throw new Error(`History verification failed: ${missing} fires missing or stale`);
      process.exitCode = 1;
    } else if (apply) {
      await client.query("UPDATE crons SET json = json - 'fireLog' WHERE json ? 'fireLog'");
      if (legacy) await client.query("DROP TRIGGER IF EXISTS qm_sync_legacy_cron_fire ON cron_fire_log");
      await client.query("DROP FUNCTION IF EXISTS qm_sync_legacy_cron_fire()");
    }
  });
} finally {
  await db.close();
}
