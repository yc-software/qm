import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import * as Sentry from "@sentry/node";
import { flushErrorReporting, initializeErrorReporting } from "../plugins/chassis/src/error-reporting.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres tracing test";

const captured: Record<string, any>[] = [];
const collector = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const lines = Buffer.concat(chunks).toString().split("\n");
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
