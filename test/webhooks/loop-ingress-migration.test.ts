import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CRONS_MIGRATION } from "../../src/cron/cron-store.ts";
import { applyTenancy } from "../../src/persistence/tenancy.ts";
import { LOOP_INGRESS_TO_WEBHOOKS_MIGRATION } from "../../src/webhooks/loop-ingress-migration.ts";
import { WEBHOOKS_MIGRATION } from "../../src/webhooks/webhook-store.ts";

const URL = process.env.DATABASE_URL!;

type Pool = import("pg").Pool;

async function withDatabase(name: string, body: (pool: Pool) => Promise<void>): Promise<void> {
  const pg = (await import("pg")).default;
  const db = `qm_${name}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const target = new globalThis.URL(URL);
  target.pathname = `/${db}`;
  const pool = new pg.Pool({ connectionString: target.toString() });
  try {
    for (const table of ["loops", "loop_ingress", "loop_ingress_deliveries"])
      await pool.query(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    for (const sql of [...CRONS_MIGRATION.statements, ...WEBHOOKS_MIGRATION.statements]) await pool.query(sql);
    await body(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
}

const cron = (enabled: boolean, action: string) => ({
  ownerScopeId: "channel:C1",
  owner: "U1",
  createdBy: "U1",
  enabled,
  createdAt: 1,
  schedule: { cron: "0 9 * * *" },
  action,
  destination: { type: "slack", target: "C1", audienceScopeId: "channel:C1" },
});

const loops = {
  L1: { name: "Triage", cronId: "c1", ownerScopeId: "channel:C1", playbook: "old playbook" },
  L2: { name: "Mail", cronId: "c2", ownerScopeId: "personal:U1", playbook: "mail playbook" },
};

const ingress = {
  w1: {
    kind: "webhook",
    loopId: "L1",
    owner: "U1",
    enabled: true,
    secret: "hook-secret",
    createdAt: 1000,
    lastReceivedAt: 2000,
  },
  s1: {
    kind: "slack",
    loopId: "L1",
    owner: "U1",
    enabled: true,
    secret: "slack-secret",
    teamId: "T1",
    channels: ["C1", "C2"],
    lastError: "boom",
  },
  g1: {
    kind: "gmail",
    loopId: "L2",
    owner: "U1",
    enabled: true,
    gmail: { email: "u1@example.com", historyId: "9" },
    createdAt: 3000,
  },
  o1: { kind: "webhook", loopId: "gone", owner: "U9", enabled: true, secret: "orphan-secret", createdAt: 4000 },
  c1: { kind: "conversation", loopId: "L1", owner: "U1", enabled: true, createdAt: 5000 },
};

async function seed(pool: Pool, tenant?: string): Promise<void> {
  const col = tenant ? "tenant_id, " : "";
  const insert = async (table: string, id: string, json: object) =>
    pool.query(`INSERT INTO ${table} (${col}id, json) VALUES (${tenant ? "$3, " : ""}$1, $2)`, [
      id,
      JSON.stringify({ id, ...json }),
      ...(tenant ? [tenant] : []),
    ]);
  await insert("crons", "c1", cron(true, "triage the event"));
  await insert("crons", "c2", { ...cron(false, "file the mail"), ownerScopeId: "personal:U1" });
  for (const [id, json] of Object.entries(loops)) await insert("loops", id, json);
  for (const [id, json] of Object.entries(ingress)) await insert("loop_ingress", id, json);
  await insert("loop_ingress_deliveries", "d1", { queueKey: "w1" });
}

const WEBHOOK_COLUMNS = `id, owner_scope_id, owner, created_by, destination, enabled, created_at, last_fired_at, action,
  verification, filters, last_error`;

async function migrate(pool: Pool): Promise<void> {
  for (const sql of LOOP_INGRESS_TO_WEBHOOKS_MIGRATION.statements) await pool.query(sql);
}

test("each loop-ingress endpoint becomes a webhook with its secret and its cron's task", async () => {
  await withDatabase("loop_ingress", async (pool) => {
    await seed(pool);
    await migrate(pool);
    await migrate(pool);
    const rows = Object.fromEntries(
      (await pool.query(`SELECT ${WEBHOOK_COLUMNS} FROM webhooks ORDER BY id`)).rows.map((row) => [row.id, row]),
    );
    assert.deepEqual(Object.keys(rows), ["g1", "o1", "s1", "w1"]);
    const destination = { type: "slack", target: "C1", audienceScopeId: "channel:C1" };
    assert.deepEqual(rows.w1, {
      id: "w1",
      owner_scope_id: "channel:C1",
      owner: "U1",
      created_by: "U1",
      destination,
      enabled: true,
      created_at: "1000",
      last_fired_at: "2000",
      action: "triage the event",
      verification: { scheme: "hmac-sha256", secret: "hook-secret" },
      filters: null,
      last_error: null,
    });
    assert.deepEqual(rows.s1.verification, { scheme: "slack", secret: "slack-secret" });
    assert.deepEqual(rows.s1.filters, [
      { path: "event.channel", in: ["C1", "C2"] },
      { path: "team_id", in: ["T1"] },
    ]);
    assert.equal(rows.s1.last_error, "boom");
    assert.equal(rows.g1.verification.scheme, "google-pubsub");
    assert.match(rows.g1.verification.secret, /^[0-9a-f]{64}$/);
    assert.equal(rows.g1.enabled, false);
    assert.equal(rows.g1.action, "file the mail");
    assert.equal(rows.g1.owner_scope_id, "personal:U1");
    assert.equal(rows.o1.enabled, false);
    assert.equal(rows.o1.action, "");
    assert.equal(rows.o1.owner_scope_id, "personal:U9");
    assert.deepEqual(rows.o1.verification, { scheme: "hmac-sha256", secret: "orphan-secret" });
    const json = (await pool.query("SELECT json FROM webhooks WHERE id = 'w1'")).rows[0].json;
    assert.equal(json.action, "triage the event");
    for (const table of ["loop_ingress", "loop_ingress_deliveries"])
      assert.equal((await pool.query("SELECT to_regclass($1) AS r", [table])).rows[0].r, null);
  });
});

test("a tenantized database keeps each tenant's endpoints in that tenant", async () => {
  await withDatabase("loop_ingress_tenancy", async (pool) => {
    await applyTenancy(pool);
    const home = (await pool.query("SELECT id::text AS id FROM qm_tenant")).rows[0].id;
    const other = randomUUID();
    await seed(pool, home);
    await seed(pool, other);
    await migrate(pool);
    const rows = (
      await pool.query("SELECT tenant_id::text AS t, id, action FROM webhooks WHERE id = 'w1' ORDER BY tenant_id")
    ).rows;
    assert.deepEqual(
      rows.map((row) => [row.t, row.action]).sort(),
      [
        [home, "triage the event"],
        [other, "triage the event"],
      ].sort(),
    );
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM webhooks")).rows[0].n, 8);
  });
});

test("a database that never had loop ingress is left alone", async () => {
  await withDatabase("no_loop_ingress", async (pool) => {
    await pool.query("DROP TABLE loop_ingress, loop_ingress_deliveries");
    await migrate(pool);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM webhooks")).rows[0].n, 0);
  });
});
