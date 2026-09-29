import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityChannelSql,
  activityRunSql,
  activityTimestampSql,
  channelPayloads,
  runPayloads,
  syntheticWords,
} from "./seed-activity.ts";
import { PAYLOAD_BUCKETS, type SeedPlan, validateTarget } from "./seed.ts";

const measurements = (prefix: string, value: number) => ({
  [`${prefix}_mean`]: value,
  [`${prefix}_quantiles`]: [value, value, value, value],
  [`${prefix}_max`]: value,
});
const plan: Pick<SeedPlan, "aggregates" | "anchorTime"> = {
  anchorTime: 1_700_000_000_000,
  aggregates: {
    runs_native_payload_widths: [{ source: "web", request_stored_mean: 600, request_bytes_mean: 800 }],
    runs_native_field_widths: [
      {
        source: "web",
        field: "request.text",
        sampled_rows: 8,
        present_rows: 8,
        ...measurements("text_bytes", 512),
        array_items_mean: null,
      },
      {
        source: "web",
        field: "result.reply",
        sampled_rows: 8,
        present_rows: 2,
        ...measurements("text_bytes", 768),
        array_items_mean: null,
      },
      {
        source: "web",
        field: "request.priorTurns",
        sampled_rows: 8,
        present_rows: 4,
        text_bytes_mean: null,
        ...measurements("serialized_bytes", 256),
        ...measurements("array_items", 2),
      },
    ],
    runs_native_result_shape: [
      {
        source: "web",
        result_status: "ok",
        sampled_rows: 2,
        idempotency_rows: 1,
        idempotency_bytes_mean: 40,
        idempotency_bytes: [40, 40, 40, 40],
      },
      { source: "web", result_status: "silent", sampled_rows: 6, idempotency_rows: 0 },
    ],
    channel_native_payload_widths: [
      {
        sampled_rows: 8,
        thread_rows: 4,
        bot_rows: 2,
        self_rows: 1,
        deleted_rows: 1,
        edited_rows: 2,
        mentions_rows: 1,
        handled_rows: 4,
        ...measurements("text_bytes", 120),
        ...measurements("lexemes", 12),
      },
    ],
  },
};

test("activity calibration populates conditional native fields without sampling reply tails from all statuses", () => {
  const runs = runPayloads(plan);
  assert.equal(runs.length, PAYLOAD_BUCKETS);
  assert.equal(runs.filter((r) => r.result.status === "ok").length, PAYLOAD_BUCKETS / 4);
  assert.equal(runs.filter((r) => r.idempotencyBytes).length, PAYLOAD_BUCKETS / 8);
  assert.ok(runs.every((r) => r.request.text!.length === 512));
  assert.ok(runs.filter((r) => r.result.status === "ok").every((r) => r.result.reply!.length === 768));
  assert.ok(runs.filter((r) => r.result.status === "silent").every((r) => !r.result.reply));
  assert.equal(runs.filter((r) => r.request.priorTurns).length, PAYLOAD_BUCKETS / 2);
  assert.ok(runs.filter((r) => r.request.priorTurns).every((r) => JSON.stringify(r.request.priorTurns).length === 256));
  const varied = structuredClone(plan);
  varied.aggregates.runs_native_field_widths![1] = {
    ...varied.aggregates.runs_native_field_widths![1]!,
    ...measurements("text_bytes", 768),
    text_bytes_quantiles: [500, 1400, 1600, 2000],
    text_bytes_max: 2500,
  };
  const replies = runPayloads(varied).flatMap((r) => (r.result.reply ? [r.result.reply.length] : []));
  assert.ok(Math.max(...replies) >= 2000);
  assert.ok(Math.abs(replies.reduce((a, b) => a + b, 0) / replies.length - 768) < 20);
  assert.throws(
    () =>
      runPayloads({ ...plan, aggregates: { runs_native_payload_widths: plan.aggregates.runs_native_payload_widths! } }),
    /requires native/,
  );
  const channel = channelPayloads(plan);
  assert.ok(channel.every((r) => r.text.length === 120 && new Set(r.text.trim().split(/\s+/)).size >= 12));
  assert.equal(channel.filter((r) => r.threaded).length, PAYLOAD_BUCKETS / 2);
  assert.equal(channel.filter((r) => r.deleted).length, PAYLOAD_BUCKETS / 8);
  const vocabulary = new Set<string>();
  for (let seed = 0; seed < 32; seed++) {
    const words = syntheticWords(String(seed), 80, 8, 6, 32);
    assert.equal(words.length, 80);
    const unique = new Set(words.trim().split(/\s+/));
    assert.equal(unique.size, 8);
    for (const word of unique) vocabulary.add(word);
  }
  assert.equal(vocabulary.size, 32);
  assert.throws(() => activityTimestampSql(plan.anchorTime, 108, "g;DROP"), /Invalid/);
});

test(
  "native activity SQL preserves UTC days, recent windows, thread links and generated English vectors",
  {
    skip: process.env.QM_PERF_TEST_DATABASE_URL
      ? false
      : "set QM_PERF_TEST_DATABASE_URL for read-only PostgreSQL check",
  },
  async () => {
    const url = process.env.QM_PERF_TEST_DATABASE_URL!;
    validateTarget(url, new URL(url).pathname.slice(1));
    const pg = (await import("pg")).default;
    const client = new pg.Client({
      connectionString: url,
      options: "-c default_transaction_read_only=on -c statement_timeout=10000",
    });
    await client.connect();
    try {
      for (const anchor of [plan.anchorTime, Math.floor(plan.anchorTime / 86_400_000) * 86_400_000]) {
        for (const days of [1, 25, 108]) {
          const expression = activityTimestampSql(anchor, days);
          const rows = (
            await client.query(
              `SELECT g,${anchor}-(g%${days})*86400000 AS old_at,${expression} AS at FROM generate_series(1::bigint,4096::bigint) g`,
            )
          ).rows;
          const times = rows.map((r) => Number(r.at));
          assert.ok(
            new Set(times).size >= (anchor % 86_400_000 === 0 ? 4096 - Math.floor(4096 / days) + 1 : 4096),
            JSON.stringify({ anchor, days, distinct: new Set(times).size }),
          );
          for (const row of rows) {
            const old = Number(row.old_at);
            const at = Number(row.at);
            assert.equal(Math.floor(at / 86_400_000), Math.floor(old / 86_400_000));
            assert.ok(at <= anchor);
            for (const width of [3_600_000, 86_400_000, 604_800_000])
              assert.equal(at >= anchor - width, old >= anchor - width);
          }
        }
      }
      const sqlPlan = {
        ...plan,
        cohorts: { max: { principalId: "perf-1@example.invalid" } },
        targets: { session_spend_days: 25 },
        sessions: [{}],
        scopes: ["channel:perf-1", "channel:perf-2"],
      } as unknown as SeedPlan;
      const runs = runPayloads(plan).map((row) => ({ ...row, key_bytes: row.idempotencyBytes }));
      const rows = (
        await client.query(
          `WITH perf_sessions AS (SELECT 1 AS n,'fixture-session' AS id,'channel:perf-1' AS scope,'web' AS surface,'conversation' AS origin,'ch:perf-1:1' AS thread),perf_run_payloads AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(source text,bucket int,request jsonb,result jsonb,key_bytes int)) ${activityRunSql(sqlPlan)}`,
          [1, PAYLOAD_BUCKETS, JSON.stringify(runs)],
        )
      ).rows;
      assert.equal(rows.length, PAYLOAD_BUCKETS);
      for (const row of rows) {
        const request = JSON.parse(row.request);
        assert.equal(request.actor.id, "perf-1@example.invalid");
        assert.equal(request.actor.externalId, undefined);
        assert.equal(request.conversation.threadRef, row.session_id);
        assert.equal(request.conversation.kind, "channel");
        assert.equal(JSON.parse(row.result).sessionId, "fixture-session");
        assert.equal(Number(row.started_at) - Number(row.created_at), 10);
        assert.equal(Number(row.finished_at) - Number(row.created_at), 1200);
        assert.ok(
          Number(row.created_at) <= Number(row.started_at) &&
            Number(row.started_at) <= Number(row.finished_at) &&
            Number(row.finished_at) <= plan.anchorTime + 1200,
        );
      }
      const keys = rows.flatMap((row) => (row.idempotency_key ? [row.idempotency_key] : []));
      assert.equal(new Set(keys).size, keys.length);
      const channels = (
        await client.query(
          `WITH perf_channel_payloads AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(bucket int,text text,threaded boolean,bot boolean,self boolean,deleted boolean,edited boolean,mentions boolean,handled boolean)),messages AS (${activityChannelSql(sqlPlan)}) SELECT *,length(to_tsvector('english',text)) AS lexemes FROM messages`,
          [1, PAYLOAD_BUCKETS, JSON.stringify(channelPayloads(plan))],
        )
      ).rows;
      const byTs = new Map(channels.map((row) => [row.ts, row]));
      for (const row of channels) {
        assert.ok(Number(row.lexemes) >= 12);
        if (row.sub) assert.equal(byTs.get(row.sub)?.container, row.container);
        if (row.deleted) assert.ok(Number(row.deleted_at) >= Number(row.created_at));
      }
    } finally {
      await client.end();
    }
  },
);
