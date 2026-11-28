import { test, before } from "node:test";
import { testTenant } from "./support/test-tenant.ts";
import assert from "node:assert/strict";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres audit-log tests";

async function reset(): Promise<void> {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DELETE FROM audit_log");
  await p.end();
}

function ev(at: number, action: string, scope = scopeId("personal", "U1")): AuditEvent {
  return { at, principalId: "U1", action, resource: `r-${action}`, scopeLabel: scope };
}

before(() => reset());

test("pg audit log: tail returns newest `limit`, scoped, and reads-its-writes", { skip }, async () => {
  await reset();
  const log = createPostgresAuditLog(URL!);
  const s1 = scopeId("personal", "U1");
  const s2 = scopeId("channel", "C1");
  for (let i = 1; i <= 5; i++) log.record(testTenant, ev(i, `a${i}`, i % 2 === 0 ? s2 : s1));

  const tail = await log.tail(testTenant, { limit: 2 });
  assert.deepEqual(
    tail.map((e) => e.action),
    ["a5", "a4"],
    "newest-first, limited",
  );

  const scoped = await log.tail(testTenant, { limit: 10, scopeLabel: s1 });
  assert.deepEqual(
    scoped.map((e) => e.action),
    ["a5", "a3", "a1"],
    "scope filter",
  );

  const byActions = await log.tail(testTenant, { limit: 10, action: ["a1", "a4"] });
  assert.deepEqual(
    byActions.map((e) => e.action),
    ["a4", "a1"],
    "action list filter",
  );

  const all = await log.events(testTenant);
  assert.deepEqual(
    all.map((e) => e.action),
    ["a1", "a2", "a3", "a4", "a5"],
    "events() oldest-first",
  );

  log.record(testTenant, ev(6, "a6", s1));
  assert.equal((await log.tail(testTenant, { limit: 1 }))[0]!.action, "a6", "read-your-write");
});

test("pg audit log: recordOnce is durable and idempotent across instances", { skip }, async () => {
  await reset();
  const first = createPostgresAuditLog(URL!);
  const second = createPostgresAuditLog(URL!);
  await first.recordOnce!(testTenant, "deployment-layer:org:default-org:1", ev(1, "layer-updated"));
  await second.recordOnce!(testTenant, "deployment-layer:org:default-org:1", ev(2, "duplicate"));
  const events = await first.events(testTenant);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.action, "layer-updated");
});

test("pg audit log: resource filter treats % and _ as literal characters", { skip }, async () => {
  await reset();
  const log = createPostgresAuditLog(URL!);
  const s1 = scopeId("personal", "U1");
  log.record(testTenant, { ...ev(1, "file.read", s1), resource: "my_report.pdf" });
  log.record(testTenant, { ...ev(2, "file.read", s1), resource: "myXreport.pdf" });
  log.record(testTenant, { ...ev(3, "file.read", s1), resource: "100% done" });
  log.record(testTenant, { ...ev(4, "file.read", s1), resource: "100 done" });

  const underscore = await log.tail(testTenant, { limit: 10, resourceContains: "my_report" });
  assert.deepEqual(
    underscore.map((e) => e.resource),
    ["my_report.pdf"],
  );
  const percent = await log.tail(testTenant, { limit: 10, resourceContains: "100%" });
  assert.deepEqual(
    percent.map((e) => e.resource),
    ["100% done"],
  );
});
