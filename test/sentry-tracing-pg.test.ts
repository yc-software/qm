import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as Sentry from "@sentry/node";
import {
  initializeErrorReporting,
  startDispatchTrace,
  tracePhase,
  tracePoolCheckout,
  traceQueued,
} from "../plugins/chassis/src/error-reporting.ts";
import { configurePgPooling, createPgPool, withPgTransaction } from "../src/persistence/pg-pool.ts";
import { collectSpans } from "./support/sentry-spans.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres tracing test";

const sentry = await collectSpans();
initializeErrorReporting(Sentry, "worker", { SENTRY_DSN: sentry.dsn, SENTRY_TRACES_SAMPLE_RATE: "1" });
after(() => sentry.close());

test("Postgres queries become spans that name the SQL verb and nothing else", { skip }, async () => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL, max: 1 });
  let detached: Promise<unknown> | undefined;
  try {
    await Sentry.startSpan({ name: "probe", op: "queue.process" }, async () => {
      await pool.query("SELECT $1::text AS value, 'private-literal' AS literal", ["private-param"]);
      await pool.query("/* private-comment */ SELECT 1");
      await pool.query("private_not_sql").catch(() => undefined);
      detached = new Promise((resolve) => setTimeout(resolve, 300)).then(() =>
        pool.query("SELECT 'private-detached' AS late"),
      );
      await Promise.all([
        pool.query("SELECT pg_sleep(0.05)"),
        pool.query("UPDATE pg_settings SET setting = setting WHERE false"),
      ]);
    });
    await detached;
    const probe = await sentry.segment((sent) => sent.name === "probe");
    assert.doesNotMatch(JSON.stringify(sentry.spans), /private|pg_sleep|pg_settings|postgres(ql)?:\/\//);
    assert.deepEqual(
      sentry.spans.filter((sent) => sent.trace_id === probe.trace_id && sent.is_segment).map((sent) => sent.op),
      ["queue.process"],
      "work that outlives its segment is sent inside it, never as a segment of its own",
    );
    const db = probe.spans.filter((sent) => sent.op === "db");
    assert.deepEqual(
      db.map((sent) => sent.name),
      ["SELECT", "query", "query", "SELECT", "UPDATE", "SELECT"],
    );
    for (const sent of db) {
      assert.equal(sent.attributes["db.statement"], undefined);
      assert.equal(sent.attributes["db.query.text"], sent.name);
      assert.equal(sent.attributes["db.system"], "postgresql");
    }
  } finally {
    await pool.end();
  }
});

test("a run sends every pooled query as one span, and a checkout only when it waited", { skip }, async () => {
  configurePgPooling({ queryMax: 1 });
  const store = createPgPool(URL!);
  const bounded = { timeoutMs: 5_000 };
  try {
    await store.q("SELECT 1");
    await traceQueued(undefined, "pooled-run", {}, async () => {
      for (let i = 0; i < 1_100; i++) await store.q("SELECT $1::int", [i], bounded);
      await Promise.all([
        store.q("SELECT pg_sleep(0.05)", [], bounded),
        store.q("UPDATE pg_settings SET setting = setting WHERE false", [], bounded),
      ]);
      await withPgTransaction(await store.pool(), (client) => client.query("SELECT 2"));
      const dispatch = startDispatchTrace();
      dispatch.firstToken();
      dispatch.end();
      await tracePhase("step.persist", async () => undefined);
    });
    const run = await sentry.segment((sent) => sent.name === "pooled-run");
    const db = run.spans.filter((sent) => sent.op === "db");
    const checkouts = db.filter((sent) => sent.name === "pg-pool.connect");
    const statements = db.filter((sent) => sent.name !== "pg-pool.connect").map((sent) => sent.name);
    assert.deepEqual([...new Set(statements)].sort(), ["SELECT", "UPDATE"]);
    assert.equal(statements.length, 1_103);
    assert.ok(checkouts.length < 30, `${checkouts.length} checkouts recorded for 1,103 queries`);
    assert.ok(checkouts.some((sent) => sent.end_timestamp - sent.start_timestamp >= 0.02));
    assert.ok(run.spans.some((sent) => sent.op === "step.persist"));
    assert.ok(run.attributes.time_to_first_text > 0);
  } finally {
    await store.close();
    configurePgPooling({});
  }
});

test("a failed span keeps a Sentry status name and loses any other status text", async () => {
  await traceQueued(undefined, "failed-spans-run", {}, async () => {
    await assert.rejects(tracePoolCheckout(() => Promise.reject(new Error("private-no-connection"))));
    for (const message of ["unavailable", "private-driver-text"])
      Sentry.startInactiveSpan({ name: "GET https://example.com/private", op: "http.client" })
        .setStatus({ code: 2, message })
        .end();
  });
  const run = await sentry.segment((sent) => sent.name === "failed-spans-run");
  assert.deepEqual(
    run.spans.map((sent) => [sent.name, sent.status, sent.attributes["sentry.status.message"]]),
    [
      ["pg-pool.connect", "error", "internal_error"],
      ["GET https://example.com", "error", "unavailable"],
      ["GET https://example.com", "error", "internal_error"],
    ],
  );
});

test("first-token time lands on the run even when the stream calls back outside the run's context", async () => {
  const { EventEmitter } = await import("node:events");
  const stream = new EventEmitter();
  let first: (() => void) | undefined;
  stream.on("delta", () => first?.());
  const outside = new Promise<void>((resolve) => setTimeout(resolve, 30)).then(() => stream.emit("delta"));
  await traceQueued(undefined, "detached-stream-run", {}, async () => {
    const dispatch = startDispatchTrace();
    first = () => dispatch.firstToken();
    await outside;
    dispatch.end();
  });
  const run = await sentry.segment((sent) => sent.name === "detached-stream-run");
  assert.ok(run.attributes.time_to_first_text >= 20);
  assert.ok(run.spans.some((sent) => sent.op === "turn.dispatch"));
});
