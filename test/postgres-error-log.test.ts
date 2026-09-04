import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresErrorLog } from "../src/admin/postgres-error-log.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres error-log tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS error_events CASCADE");
  await p.end();
});

test("pg error log: persists events, filters by scope, newest-first, shape-only", { skip }, async () => {
  const log = createPostgresErrorLog(URL!);
  const s1 = scopeId("channel", "C1");
  const s2 = scopeId("channel", "C2");

  log.record({
    category: "command_policy",
    code: "denied",
    message: "rm -rf <redacted>",
    scopeLabel: s1,
    sessionId: "sess-1",
  });
  log.record({ category: "turn", code: "error", message: "boom (shape-only)", scopeLabel: s2 });

  const all = await log.list({ limit: 100 });
  assert.equal(all.length, 2, "both events persisted");
  assert.equal(all[0]!.scopeLabel, s2);
  assert.equal(all[0]!.category, "turn");
  assert.equal(all[0]!.code, "error");
  assert.equal(all[0]!.sessionId, undefined, "an absent session id stays absent (not empty string)");

  const onlyS1 = await log.list({ scopeId: s1, limit: 100 });
  assert.equal(onlyS1.length, 1, "scope filter narrows to one");
  assert.equal(onlyS1[0]!.category, "command_policy");
  assert.equal(onlyS1[0]!.message, "rm -rf <redacted>", "the redacted message round-trips");
  assert.equal(onlyS1[0]!.sessionId, "sess-1", "the triage session id round-trips");
  assert.ok(typeof onlyS1[0]!.ts === "number", "stamped with a timestamp");

  const capped = await log.list({ limit: 1 });
  assert.equal(capped.length, 1, "limit caps the result");

  assert.equal(await log.count(), 2, "count totals every event");
  assert.equal(await log.count({ scopeId: s1 }), 1, "count honors the scope filter");
  assert.equal(await log.count({ sessionId: "sess-1" }), 1, "count honors the session filter");
});

test("pg error log: survives a fresh log over the same table (durability)", { skip }, async () => {
  const reopened = createPostgresErrorLog(URL!);
  const rows = await reopened.list({ limit: 100 });
  assert.ok(rows.length >= 2, "events written by a prior log instance are still readable");
});

test("pg error log: flush makes writes visible to another process", { skip }, async () => {
  const writer = createPostgresErrorLog(URL!);
  const reader = createPostgresErrorLog(URL!);
  writer.record({
    category: "session_title",
    code: "generation_failed",
    message: "cross-process barrier",
    scopeLabel: scopeId("personal", "U1"),
    sessionId: "sess-cross-process",
  });

  await writer.flush();
  assert.equal((await reader.list({ sessionId: "sess-cross-process" })).length, 1);
});
