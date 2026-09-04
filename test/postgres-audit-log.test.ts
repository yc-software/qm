import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres audit-log tests";

async function reset(dropOldMap: boolean): Promise<void> {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS audit_log CASCADE");
  if (dropOldMap) await p.query("DROP TABLE IF EXISTS audit_events CASCADE");
  await p.end();
}

function ev(at: number, action: string, scope = scopeId("personal", "U1")): AuditEvent {
  return { at, principalId: "U1", action, resource: `r-${action}`, scopeLabel: scope };
}

before(() => reset(true));

test("pg audit log: tail returns newest `limit`, scoped, and reads-its-writes", { skip }, async () => {
  await reset(true);
  const log = createPostgresAuditLog(URL!);
  const s1 = scopeId("personal", "U1");
  const s2 = scopeId("channel", "C1");
  for (let i = 1; i <= 5; i++) log.record(ev(i, `a${i}`, i % 2 === 0 ? s2 : s1));

  const tail = await log.tail({ limit: 2 });
  assert.deepEqual(
    tail.map((e) => e.action),
    ["a5", "a4"],
    "newest-first, limited",
  );

  const scoped = await log.tail({ limit: 10, scopeLabel: s1 });
  assert.deepEqual(
    scoped.map((e) => e.action),
    ["a5", "a3", "a1"],
    "scope filter",
  );

  const all = await log.events();
  assert.deepEqual(
    all.map((e) => e.action),
    ["a1", "a2", "a3", "a4", "a5"],
    "events() oldest-first",
  );

  log.record(ev(6, "a6", s1));
  assert.equal((await log.tail({ limit: 1 }))[0]!.action, "a6", "read-your-write");
});

test("pg audit log: migrates rows once from the legacy audit_events JSONB map", { skip }, async () => {
  await reset(true);
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("CREATE TABLE audit_events (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
  const rows: AuditEvent[] = [ev(10, "old-a"), ev(30, "old-c"), ev(20, "old-b")];
  for (const r of rows)
    await p.query("INSERT INTO audit_events (id, json) VALUES ($1,$2)", [`${r.at}-${r.action}`, JSON.stringify(r)]);
  await p.end();

  const log = createPostgresAuditLog(URL!);
  const migrated = await log.events();
  assert.deepEqual(
    migrated.map((e) => e.action),
    ["old-a", "old-b", "old-c"],
    "legacy rows migrated, oldest-first",
  );

  const log2 = createPostgresAuditLog(URL!);
  assert.equal((await log2.events()).length, 3, "no duplicate copy on a second boot");
});

test("pg audit log: recordOnce is durable and idempotent across instances", { skip }, async () => {
  await reset(true);
  const first = createPostgresAuditLog(URL!);
  const second = createPostgresAuditLog(URL!);
  await first.recordOnce!("deployment-layer:org:default-org:1", ev(1, "layer-updated"));
  await second.recordOnce!("deployment-layer:org:default-org:1", ev(2, "duplicate"));
  const events = await first.events();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.action, "layer-updated");
});
