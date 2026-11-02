import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { rowToSession } from "../src/sessions/postgres-session-store.ts";
import { SURFACE_ORIGIN_MIGRATION } from "../src/surfaces/origin-migration.ts";
import { slackSurfaceOrigin } from "../src/surfaces/slack/adapter.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the surface origin migration test";
const exec = promisify(execFile);

async function withDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const parent = new pg.Pool({ connectionString: databaseUrl });
  const name = `surface_origin_${randomUUID().replaceAll("-", "")}`;
  await parent.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: url.toString() });
  try {
    await run(url.toString(), admin);
  } finally {
    await admin.end();
    await parent.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await parent.end();
  }
}

const migrate = (url: string) =>
  exec(process.execPath, ["src/migrate-main.ts"], {
    cwd: new URL("..", import.meta.url),
    timeout: 120_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: url,
      SANDBOX_BACKEND: "local",
      ORG_ID: "o",
      CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
    },
  });

const access = { companyDomains: ["company.example"], companyTeamIds: ["TCOMPANY"], serviceCredentials: ["search"] };
const ids = { accountId: "partner", teamId: "TPARTNER", userId: "U1" };
const internalSource = { ...ids, replyThreadTs: "1700.1" };
const internalOrigin = slackSurfaceOrigin(internalSource);
const externalOnlyOrigin = slackSurfaceOrigin({ ...ids, external: access });
const externalOrigin = slackSurfaceOrigin({ ...ids, policyNamespace: "external-slack:TPARTNER:x", external: access });
const oldDestination = { type: "slack", target: "C1", slackAccountId: "partner", slackTeamId: "TPARTNER" };
const newDestination = { type: "slack", target: "C1", account: { id: "partner", workspace: "TPARTNER" } };
const DESTINATION_TABLES = [
  ["crons", "destination"],
  ["loops", "destination"],
  ["webhooks", "destination"],
  ["monitors", "destination"],
  ["secret_drops", "destination"],
  ["keychain_asks", "requesterDestination"],
] as const;
const request = (extra: Record<string, unknown>) => ({
  surface: "slack",
  actor: { externalId: "U1" },
  conversation: { kind: "channel", threadRef: "t", audience: [] },
  origin: { kind: "human" },
  text: "hi",
  ...extra,
});

async function snapshot(admin: pg.Pool): Promise<unknown> {
  const queries = [
    "SELECT id, request FROM runs ORDER BY id",
    "SELECT id, spawn_meta FROM sessions ORDER BY id",
    "SELECT id, payload FROM run_signals ORDER BY id",
    "SELECT id, destination FROM deliveries ORDER BY id",
    "SELECT id, json FROM approvals ORDER BY id",
    ...DESTINATION_TABLES.map(([table]) => `SELECT id, json FROM ${table} ORDER BY id`),
  ];
  return Promise.all(queries.map(async (sql) => (await admin.query(sql)).rows));
}

test("stored Slack origins and destination accounts are rewritten once to the neutral shape", { skip }, async () => {
  await withDatabase(async (url, admin) => {
    await migrate(url);
    for (const table of ["approvals", ...DESTINATION_TABLES.map(([table]) => table)])
      await admin.query(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    const now = Date.now();
    const run = (id: string, session: string, status: string, createdAt: number, body: unknown, finishedAt = 1) =>
      admin.query(
        "INSERT INTO runs (id, session_id, status, request, created_at, finished_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, session, status, typeof body === "string" ? body : JSON.stringify(body), createdAt, finishedAt],
      );
    await run(
      "pending",
      "s-pending",
      "pending",
      1,
      request({
        slackSource: internalSource,
        triggerDestination: oldDestination,
        origin: { kind: "automation", destination: oldDestination },
      }),
    );
    await run("old-internal", "s1", "done", 1, request({ slackSource: internalSource }));
    await run("recent-internal", "s1", "done", 2, request({ slackSource: internalSource }), now);
    await run("latest-internal", "s1", "done", 3, request({ slackSource: internalSource }));
    await run("old-external", "s1", "done", 0, request({ externalSlack: { ...ids, ...access } }));
    await run(
      "old-external-namespaced",
      "s1",
      "failed",
      0,
      request({
        slackSource: { ...ids, externalPolicyNamespace: "external-slack:TPARTNER:x" },
        externalSlack: { ...ids, ...access },
      }),
    );
    await run("public-before-private", "s2", "done", 1, request({ slackSource: internalSource }));
    await run("private-latest", "s2", "done", 2, request({ slackSource: internalSource, privateSessionMessage: true }));
    await run(
      "empty-strings",
      "s3",
      "done",
      1,
      request({ slackSource: { ...ids, externalPolicyNamespace: "", replyThreadTs: "" } }),
    );
    await run("null-source", "s4", "done", 1, request({ slackSource: null }));
    await run(
      "existing-origin",
      "s5",
      "done",
      1,
      request({ surfaceOrigin: externalOrigin, slackSource: internalSource }),
    );
    const unparseable = JSON.stringify(request({ slackSource: internalSource, text: "a\u0000b\ud800" }));
    await run("unparseable", "s6", "done", 1, unparseable);
    await admin.query(
      "INSERT INTO sessions (id, type, scope_id, thread_ref, created_at, spawn_meta) VALUES ('child', 'chat', 'org:o', 'child', 1, $1)",
      [JSON.stringify({ slackSource: internalSource, origin: { kind: "automation", destination: oldDestination } })],
    );
    const signal = (consumed: number | null) =>
      admin.query(
        "INSERT INTO run_signals (run_id, kind, payload, created_at, consumed_at) VALUES ('pending', 'steer', $1, 1, $2)",
        [
          JSON.stringify({
            kind: "steer",
            request: request({ slackSource: internalSource }),
            sessionRequest: request({ externalSlack: { ...ids, ...access } }),
          }),
          consumed,
        ],
      );
    await signal(null);
    await signal(5);
    const delivery = (id: string, deliveredAt: number | null) =>
      admin.query(
        "INSERT INTO deliveries (id, idempotency_key, destination, text, created_at, delivered_at) VALUES ($1, $1, $2, 'x', 1, $3)",
        [id, JSON.stringify(oldDestination), deliveredAt],
      );
    await delivery("undelivered", null);
    await delivery("delivered", 2);
    await admin.query("INSERT INTO approvals (id, json) VALUES ('a1', $1)", [
      JSON.stringify({ command: "rm -r x", request: request({ slackSource: internalSource }) }),
    ]);
    for (const [table, field] of DESTINATION_TABLES)
      await admin.query(`INSERT INTO ${table} (id, json) VALUES ('d1', $1)`, [
        JSON.stringify({ id: "d1", [field]: { ...oldDestination, slackPolicyNamespace: "ns" } }),
      ]);

    await admin.query("DELETE FROM qm_schema_migrations WHERE id = $1", [SURFACE_ORIGIN_MIGRATION.id]);
    await migrate(url);

    const { runs, close } = createPostgresRunStore(url);
    try {
      const read = async (id: string) =>
        (await runs.get(id))!.request as unknown as Record<string, unknown> & { origin: Record<string, unknown> };
      const pending = await read("pending");
      assert.deepEqual(pending.surfaceOrigin, internalOrigin);
      assert.equal("slackSource" in pending, false);
      assert.deepEqual(pending.triggerDestination, newDestination);
      assert.deepEqual(pending.origin.destination, newDestination);
      for (const id of ["recent-internal", "latest-internal", "public-before-private", "private-latest"])
        assert.deepEqual((await read(id)).surfaceOrigin, internalOrigin, id);
      assert.deepEqual((await read("old-external")).surfaceOrigin, externalOnlyOrigin);
      assert.equal("externalSlack" in (await read("old-external")), false);
      assert.deepEqual((await read("old-external-namespaced")).surfaceOrigin, externalOrigin);
      assert.deepEqual((await read("empty-strings")).surfaceOrigin, slackSurfaceOrigin(ids));
      const nullSource = await read("null-source");
      assert.equal("slackSource" in nullSource, false);
      assert.equal(nullSource.surfaceOrigin, undefined);
      const existing = await read("existing-origin");
      assert.deepEqual(existing.surfaceOrigin, externalOrigin);
      assert.equal("slackSource" in existing, false);
      const untouched = await read("old-internal");
      assert.deepEqual(untouched.slackSource, internalSource);
      assert.equal(untouched.surfaceOrigin, undefined);
    } finally {
      await close();
    }
    assert.equal((await admin.query("SELECT request FROM runs WHERE id = 'unparseable'")).rows[0].request, unparseable);
    const child = rowToSession((await admin.query("SELECT * FROM sessions WHERE id = 'child'")).rows[0]);
    assert.deepEqual(child.spawnMeta, {
      surfaceOrigin: internalOrigin,
      origin: { kind: "automation", destination: newDestination },
    });
    const signals = (await admin.query("SELECT payload FROM run_signals ORDER BY id")).rows;
    assert.deepEqual(signals[0].payload.request.surfaceOrigin, internalOrigin);
    assert.deepEqual(signals[0].payload.sessionRequest.surfaceOrigin, externalOnlyOrigin);
    assert.equal("slackSource" in signals[0].payload.request, false);
    assert.deepEqual(signals[1].payload.request.slackSource, internalSource);
    const deliveries = Object.fromEntries(
      (await admin.query("SELECT id, destination FROM deliveries")).rows.map((r) => [r.id, r.destination]),
    );
    assert.deepEqual(deliveries.undelivered, newDestination);
    assert.deepEqual(deliveries.delivered, oldDestination);
    const approval = (await admin.query("SELECT json FROM approvals WHERE id = 'a1'")).rows[0].json;
    assert.deepEqual(approval.request.surfaceOrigin, internalOrigin);
    assert.equal("slackSource" in approval.request, false);
    for (const [table, field] of DESTINATION_TABLES)
      assert.deepEqual(
        (await admin.query(`SELECT json FROM ${table} WHERE id = 'd1'`)).rows[0].json[field],
        { type: "slack", target: "C1", account: { id: "partner", workspace: "TPARTNER", policyNamespace: "ns" } },
        table,
      );

    const migrated = await snapshot(admin);
    await migrate(url);
    assert.deepEqual(await snapshot(admin), migrated);
    await admin.query("DELETE FROM qm_schema_migrations WHERE id = $1", [SURFACE_ORIGIN_MIGRATION.id]);
    await migrate(url);
    assert.deepEqual(await snapshot(admin), migrated);
  });
});
