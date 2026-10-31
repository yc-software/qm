import { test } from "node:test";
import assert from "node:assert/strict";
import { type AuditEvent } from "../src/audit/audit-log.ts";
import { scopeId } from "../src/types.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

function ev(at: number, action: string, scope = scopeId("personal", "U1")): AuditEvent {
  return { at, principalId: "U1", action, resource: `r-${action}`, scopeLabel: scope };
}

test("events() returns everything oldest-first", async () => {
  const log = createPostgresAuditLog(testDatabaseUrl());
  log.record(ev(100, "grant"));
  log.record(ev(200, "revoke"));
  log.record(ev(300, "deploy"));
  assert.deepEqual(
    (await log.events()).map((e) => e.action),
    ["grant", "revoke", "deploy"],
  );
});

test("tail returns the newest `limit` events, newest-first", async () => {
  const log = createPostgresAuditLog(testDatabaseUrl());
  for (let i = 1; i <= 5; i++) log.record(ev(i, `a${i}`));
  const got = await log.tail({ limit: 2 });
  assert.deepEqual(
    got.map((e) => e.action),
    ["a5", "a4"],
  );
});

test("tail scopeLabel filters to that scope", async () => {
  const log = createPostgresAuditLog(testDatabaseUrl());
  const s1 = scopeId("personal", "U1");
  const s2 = scopeId("channel", "C1");
  log.record(ev(1, "a", s1));
  log.record(ev(2, "b", s2));
  log.record(ev(3, "c", s1));
  const got = await log.tail({ limit: 10, scopeLabel: s1 });
  assert.deepEqual(
    got.map((e) => e.action),
    ["c", "a"],
  );
});

test("a just-recorded event is immediately visible to tail (read-your-write)", async () => {
  const log = createPostgresAuditLog(testDatabaseUrl());
  log.record(ev(1, "grant"));
  assert.deepEqual(
    (await log.tail({ limit: 10 })).map((e) => e.action),
    ["grant"],
  );
});
