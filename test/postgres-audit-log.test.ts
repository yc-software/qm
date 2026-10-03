import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createAuditLog, type AuditEvent, type AuditLog } from "../src/audit/audit-log.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres audit-log tests";

async function reset(dropOldMap: boolean): Promise<void> {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
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

test("pg audit log: scoped action pages preserve filters, payloads and tied ordering", { skip }, async () => {
  await reset(true);
  const log = createPostgresAuditLog(URL!);
  const memory = createAuditLog();
  const scope = scopeId("personal", "U1");
  const rows: AuditEvent[] = [
    { ...ev(1, "read", scope), resource: "keep-old", detail: "old payload" },
    { ...ev(2, "read", scopeId("personal", "U2")), resource: "keep-foreign" },
    { ...ev(3, "read", scope), resource: "keep-a", status: "ok", detail: '{"complete":true}' },
    { ...ev(3, "read", scope), resource: "keep-b", status: "", detail: "" },
    { ...ev(4, "other", scope), resource: "keep-other" },
    { ...ev(5, "read", scope), resource: "skip-new" },
    { ...ev(6, "", scope), resource: "keep-empty" },
  ];
  for (const [i, row] of rows.entries()) {
    await log.recordOnce!(`page:${i}`, row);
    memory.record(row);
  }
  const queries: Parameters<AuditLog["tail"]>[0][] = [
    { limit: 2, scopeLabel: scope, action: "read" },
    { limit: 1, scopeLabel: scope, action: "read", since: 3, resourceContains: "keep" },
    { limit: 20, scopeLabel: scope, action: "read", since: 4, resourceContains: "keep" },
    { limit: 0, scopeLabel: scope, action: "read" },
    { limit: 1, scopeLabel: scope, action: "" },
    { limit: 2000, scopeLabel: scope, action: "missing" },
    { limit: 2000, scopeLabel: scopeId("personal", "missing"), action: "read" },
    { limit: 20, scopeLabel: scope, action: "read", resourceContains: "" },
    { limit: 20, scopeLabel: scope, action: "read", resourceContains: "' OR 1=1 --" },
    { limit: 20, scopeLabel: scope },
    { limit: 20, action: "read" },
    { limit: 20 },
  ];
  for (const query of queries) assert.deepEqual(await log.tail(query), await memory.tail(query));

  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    const index = await client.query(
      `SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i WHERE i.indexrelid = to_regclass('audit_log_by_scope_action_at_id')`,
    );
    assert.deepEqual(index.rows, [
      {
        indisvalid: true,
        indisready: true,
        definition:
          "CREATE INDEX audit_log_by_scope_action_at_id ON public.audit_log USING btree (scope_label, action, at DESC, id DESC)",
      },
    ]);
    await client.query(
      `INSERT INTO audit_log(at, principal_id, action, resource, scope_label)
       SELECT 10, 'U1', 'tied', 'tied-' || n, $1 FROM generate_series(1, 2005) AS n ORDER BY n`,
      [scope],
    );
    const page = await log.tail({ limit: 2000, scopeLabel: scope, action: "tied" });
    assert.equal(page.length, 2000);
    assert.equal(page[0]?.resource, "tied-2005");
    assert.equal(page.at(-1)?.resource, "tied-6");
  } finally {
    await client.end();
  }
});
