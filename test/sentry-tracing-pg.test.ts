import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import * as Sentry from "@sentry/node";
import {
  flushErrorReporting,
  initializeErrorReporting,
  markFirstToken,
  traceQueued,
} from "../plugins/chassis/src/error-reporting.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres tracing test";

const captured: Record<string, any>[] = [];
const collector = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const lines = (req.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body).toString().split("\n");
  for (let i = 1; i + 1 < lines.length; i += 2) {
    if (JSON.parse(lines[i]!).type === "transaction") captured.push(JSON.parse(lines[i + 1]!));
  }
  res.end("{}");
});
collector.listen(0, "127.0.0.1");
await once(collector, "listening");
initializeErrorReporting(Sentry, "worker", {
  SENTRY_DSN: `http://public@127.0.0.1:${(collector.address() as AddressInfo).port}/1`,
  SENTRY_TRACES_SAMPLE_RATE: "1",
});
after(async () => {
  collector.closeAllConnections();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

test("Postgres queries become pool and query spans that name the SQL verb and nothing else", { skip }, async () => {
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
    for (let i = 0; i < 40 && !captured.some((event) => event.transaction === "probe"); i++) {
      await flushErrorReporting();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const probe = captured.find((event) => event.transaction === "probe");
    assert.ok(probe, "the transaction arrived");
    await flushErrorReporting();
    assert.doesNotMatch(JSON.stringify(captured), /private/);
    assert.equal(
      captured.filter((event) => event.contexts.trace.op === "db").length,
      0,
      "work that outlives its transaction is not sent as a transaction of its own",
    );
    assert.doesNotMatch(JSON.stringify(probe), /private|pg_sleep|pg_settings|postgres(ql)?:\/\//);
    const db = probe.spans.filter((span: { op: string }) => span.op === "db");
    const descriptions = db.map((span: { description: string }) => span.description);
    assert.ok(descriptions.includes("pg-pool.connect"), "pool checkout time is visible");
    assert.deepEqual(
      descriptions.filter((d: string) => !d.endsWith(".connect")),
      ["SELECT", "query", "query", "SELECT", "UPDATE"],
    );
    for (const span of db) {
      assert.equal(span.data["db.statement"], undefined);
      assert.equal(span.data["db.system"], "postgresql");
    }
  } finally {
    await pool.end();
  }
});

test(
  "a long run keeps its queries, waiting checkouts and first-token time within Sentry's event size",
  { skip },
  async () => {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: URL, max: 1 });
    try {
      await traceQueued(undefined, "long-run", {}, async () => {
        await Promise.all([pool.query("SELECT pg_sleep(0.02)"), pool.query("SELECT 'contended'")]);
        for (let i = 0; i < 700; i++) await pool.query("SELECT $1::int", [i]);
        markFirstToken();
        await pool.query("SELECT pg_sleep(0.02)");
      });
      for (let i = 0; i < 40 && !captured.some((event) => event.transaction === "long-run"); i++) {
        await flushErrorReporting();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const run = captured.find((event) => event.transaction === "long-run");
      assert.ok(run, "the transaction arrived");
      assert.ok(run.measurements.time_to_first_token.value > 0, "first-token time survives a late first token");
      const spans: Record<string, any>[] = run.spans;
      assert.ok(spans.length <= 500, `sent ${spans.length} spans`);
      assert.ok(run.contexts.trace.data["qm.truncated_spans"] > 0, "the cut is recorded");
      assert.ok(spans.some((span) => span.description === "SELECT"));
      const checkouts = spans.filter((span) => span.description === "pg-pool.connect");
      assert.ok(
        checkouts.some((span) => span.timestamp - span.start_timestamp >= 0.01),
        "a waiting checkout is kept",
      );
    } finally {
      await pool.end();
    }
  },
);

test("a truncated run keeps every sent span's parent even when parent and child start together", async () => {
  await traceQueued(undefined, "tied-run", {}, async () => {
    const start = Date.now() / 1000;
    for (let i = 0; i < 499; i++) {
      Sentry.startInactiveSpan({ name: "early", op: "task", startTime: start + i / 1000 }).end(
        start + i / 1000 + 0.0005,
      );
    }
    const tied = start + 1;
    Sentry.startSpan({ name: "parent", op: "task", startTime: tied }, () => {
      Sentry.startSpan({ name: "child", op: "task", startTime: tied }, () => {
        Sentry.startInactiveSpan({ name: "grandchild", op: "task", startTime: tied }).end(tied + 0.001);
      });
    });
  });
  for (let i = 0; i < 40 && !captured.some((event) => event.transaction === "tied-run"); i++) {
    await flushErrorReporting();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const run = captured.find((event) => event.transaction === "tied-run");
  assert.ok(run, "the transaction arrived");
  const spans: Record<string, any>[] = run.spans;
  assert.equal(spans.length, 500);
  const ids = new Set([run.contexts.trace.span_id, ...spans.map((sent) => sent.span_id)]);
  for (const sent of spans) assert.ok(ids.has(sent.parent_span_id), "every sent span's parent is sent");
  assert.equal(run.contexts.trace.data["qm.truncated_spans"], 2);
});

test("only quick, successful, childless pool checkouts are left out", async () => {
  const start = 1_700_000_000;
  const traceId = "0123456789abcdef0123456789abcdef";
  const span = (id: string, parent: string, description: string, seconds: number, status = "ok") => ({
    span_id: id.padStart(16, "0"),
    parent_span_id: parent.padStart(16, "0"),
    trace_id: traceId,
    op: "db",
    description,
    start_timestamp: start,
    timestamp: start + seconds,
    status,
    data: {},
  });
  Sentry.captureEvent({
    type: "transaction",
    transaction: "checkouts",
    start_timestamp: start,
    timestamp: start + 1,
    contexts: { trace: { trace_id: traceId, span_id: "1".padStart(16, "0"), op: "queue.process" } },
    spans: [
      span("a", "1", "pg-pool.connect", 0.0002),
      span("b", "1", "pg-pool.connect", 0.005),
      span("c", "1", "pg-pool.connect", 0.0002, "internal_error"),
      span("d", "1", "pg-pool.connect", 0.0002),
      span("e", "d", "pg.connect", 0.0001),
    ],
  });
  for (let i = 0; i < 40 && !captured.some((event) => event.transaction === "checkouts"); i++) {
    await flushErrorReporting();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const run = captured.find((event) => event.transaction === "checkouts");
  assert.ok(run, "the transaction arrived");
  assert.deepEqual(run.spans.map((sent: { span_id: string }) => sent.span_id.replace(/^0+/, "")).sort(), [
    "b",
    "c",
    "d",
    "e",
  ]);
  assert.equal(run.contexts.trace.data?.["qm.truncated_spans"], undefined);
});
