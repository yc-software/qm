import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { testConfig } from "./support/test-config.ts";

const events: string[] = [];
let invalidIndexes = false;
let databaseOptions: Record<string, unknown> = {};
mock.module("pg", {
  defaultExport: {
    Client: class {
      constructor(options: Record<string, unknown>) {
        databaseOptions = options;
      }
      async connect() {
        events.push("database-connect");
      }
      async query(sql: string) {
        const index = sql.includes("pg_index");
        events.push(index ? "index-check" : "parallel-check");
        return { rows: index && invalidIndexes ? [{ index_name: "invalid" }] : [] };
      }
      async end() {
        events.push("database-close");
      }
    },
  },
});
const { runSessionSmoke } = await import("../src/deployment/postdeploy-smoke.ts");

test("session command preserves archive then database checks with bounded requests and database operations", async (t) => {
  const timeouts: number[] = [];
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    timeouts.push(ms);
    return timeout(ms);
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    assert.ok(init?.signal);
    if (path === "/v1/turns") {
      events.push("model");
      return Response.json({ status: "ok", sessionId: "session", reply: "QM deployment canary passed." });
    }
    if (path === "/v1/admin/errors") {
      events.push("errors");
      return Response.json({ errors: [] });
    }
    if (init?.method === "POST") {
      events.push("archive");
      return Response.json({});
    }
    events.push("persisted");
    return Response.json({ session: { title: "Canary" }, entries: [{ type: "user" }, { type: "assistant" }] });
  });
  const config = testConfig({
    databaseUrl: "postgres://unused",
    adminGrants: "admin:org_admin",
    portalIdentitySecret: "portal-secret",
    signingSecret: "source-secret",
  });
  await runSessionSmoke(config, "http://127.0.0.1:8080");
  assert.deepEqual(events, [
    "model",
    "persisted",
    "errors",
    "archive",
    "database-connect",
    "parallel-check",
    "index-check",
    "database-close",
  ]);
  assert.deepEqual(timeouts, [300_000, 60_000, 30_000, 30_000, 30_000]);
  for (const option of ["connectionTimeoutMillis", "query_timeout", "statement_timeout"])
    assert.equal(databaseOptions[option], 30_000);
  invalidIndexes = true;
  events.length = 0;
  try {
    await assert.rejects(runSessionSmoke(config, "http://127.0.0.1:8080"), /invalid PostgreSQL indexes/);
    assert.equal(events.at(-1), "database-close");
    assert.ok(events.indexOf("archive") < events.indexOf("database-connect"));
  } finally {
    invalidIndexes = false;
  }
});
