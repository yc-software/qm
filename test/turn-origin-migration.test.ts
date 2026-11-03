import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { TURN_ORIGIN_MIGRATION } from "../src/surfaces/origin-migration.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the turn origin migration test";
const exec = promisify(execFile);

async function withDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const parent = new pg.Pool({ connectionString: databaseUrl });
  const name = `turn_origin_${randomUUID().replaceAll("-", "")}`;
  await parent.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: url.toString() });
  try {
    await run(url.toString(), admin);
  } finally {
    await admin.end();
    while ((await parent.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1", [name])).rowCount) await sleep(20);
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

const LEGACY_KEYS = [
  "triggerTs",
  "entryTs",
  "triggered",
  "securityScreenData",
  "triggerDestination",
  "ownerKeychainUnion",
  "unprompted",
  "liveActor",
];
const oldDestination = { type: "slack", target: "C1", slackAccountId: "partner", slackTeamId: "TPARTNER" };
const newDestination = { type: "slack", target: "C1", account: { id: "partner", workspace: "TPARTNER" } };
const request = (extra: Record<string, unknown>) => ({
  surface: "slack",
  actor: { externalId: "U1" },
  conversation: { kind: "channel", threadRef: "t", audience: [] },
  text: "hi",
  ...extra,
});

const CASES: [name: string, stored: Record<string, unknown>, origin: Record<string, unknown>][] = [
  ["human", { liveActor: true, triggerTs: "1", entryTs: "1" }, { kind: "human", messageTs: "1", entryTs: "1" }],
  ["human-empty-ts", { liveActor: true, triggerTs: "" }, { kind: "human" }],
  ["ambient", { unprompted: true, entryTs: "2" }, { kind: "ambient", entryTs: "2" }],
  [
    "ambient-live",
    { unprompted: true, liveActor: true, triggerTs: "human-ts", entryTs: "ambient-ts" },
    { kind: "ambient", entryTs: "ambient-ts", live: true },
  ],
  [
    "automation",
    {
      triggered: true,
      securityScreenData: "external payload",
      triggerDestination: oldDestination,
      ownerKeychainUnion: true,
    },
    { kind: "automation", screenData: "external payload", destination: newDestination, useOwnerKeychain: true },
  ],
  [
    "automation-wins",
    { triggered: true, unprompted: true, liveActor: true, triggerTs: "h", entryTs: "a" },
    { kind: "automation" },
  ],
  ["direct", {}, { kind: "direct" }],
  ["inert-legacy", { securityScreenData: "x", entryTs: "3" }, { kind: "direct" }],
  [
    "typed-human-legacy-automation",
    { origin: { kind: "human" }, triggered: true, securityScreenData: "external" },
    { kind: "automation", screenData: "external" },
  ],
  [
    "typed-automation-legacy-human",
    { origin: { kind: "automation", screenData: "external" }, liveActor: true },
    { kind: "automation", screenData: "external" },
  ],
  [
    "typed-ambient-legacy-human",
    { origin: { kind: "ambient", entryTs: "2" }, liveActor: true },
    { kind: "ambient", entryTs: "2" },
  ],
  [
    "typed-automation-legacy-screen",
    { origin: { kind: "automation" }, triggered: true, securityScreenData: "legacy" },
    { kind: "automation", screenData: "legacy" },
  ],
  [
    "both-screens",
    { origin: { kind: "automation", screenData: "typed" }, triggered: true, securityScreenData: "legacy" },
    { kind: "automation", screenData: "Typed automation data:\ntyped\n\nLegacy automation data:\nlegacy" },
  ],
  [
    "owner-keychain",
    { origin: { kind: "automation", useOwnerKeychain: true }, triggered: true },
    { kind: "automation", useOwnerKeychain: true },
  ],
  [
    "typed-human-legacy-ts",
    { origin: { kind: "human", entryTs: "e" }, liveActor: true, triggerTs: "9" },
    { kind: "human", messageTs: "9", entryTs: "e" },
  ],
  [
    "typed-ambient-legacy-live",
    { origin: { kind: "ambient" }, unprompted: true, liveActor: true },
    { kind: "ambient", live: true },
  ],
  ["typed-only", { origin: { kind: "human", messageTs: "5" } }, { kind: "human", messageTs: "5" }],
];

async function snapshot(admin: pg.Pool): Promise<unknown> {
  return Promise.all(
    ["SELECT id, request FROM runs ORDER BY id", "SELECT id, payload FROM run_signals ORDER BY id"]
      .concat("SELECT id, json FROM approvals ORDER BY id")
      .map(async (sql) => (await admin.query(sql)).rows),
  );
}

test("the migration folds every stored legacy origin into `origin`, as the translator read it", { skip }, async () => {
  await withDatabase(async (url, admin) => {
    await migrate(url);
    await admin.query("CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    const run = (id: string, status: string, body: unknown, finishedAt: number | null = 1) =>
      admin.query(
        "INSERT INTO runs (id, session_id, status, request, created_at, finished_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, `s-${id}`, status, typeof body === "string" ? body : JSON.stringify(body), 1, finishedAt],
      );
    for (const [name, stored] of CASES) {
      await run(`live-${name}`, "pending", request(stored), null);
      await run(`settled-${name}`, "done", request(stored));
    }
    const unparseable = JSON.stringify(request({ liveActor: true, text: "a\u0000b\ud800" }));
    await run("unparseable", "done", unparseable);
    await admin.query(
      "INSERT INTO run_signals (run_id, kind, payload, created_at, consumed_at) VALUES ('live-human', 'steer', $1, 1, $2), ('live-human', 'steer', $1, 1, NULL)",
      [
        JSON.stringify({
          kind: "steer",
          request: request({ unprompted: true, entryTs: "7" }),
          sessionRequest: request({ origin: { kind: "automation" }, triggered: true, securityScreenData: "s" }),
        }),
        5,
      ],
    );
    await admin.query("INSERT INTO approvals (id, json) VALUES ('a1', $1), ('a2', $2)", [
      JSON.stringify({ command: "security-screen", request: request({ triggered: true, securityScreenData: "d" }) }),
      JSON.stringify({ command: "rm", request: request({}) }),
    ]);

    await admin.query("DELETE FROM qm_schema_migrations WHERE id = $1", [TURN_ORIGIN_MIGRATION.id]);
    await migrate(url);

    const raw = async (id: string) =>
      JSON.parse((await admin.query("SELECT request FROM runs WHERE id = $1", [id])).rows[0].request) as Record<
        string,
        unknown
      >;
    for (const [name, , origin] of CASES)
      for (const id of [`live-${name}`, `settled-${name}`]) {
        const stored = await raw(id);
        assert.deepEqual(stored.origin, origin, id);
        for (const key of LEGACY_KEYS) assert.equal(key in stored, false, `${id} keeps ${key}`);
        assert.equal(stored.text, "hi", id);
      }
    assert.equal((await admin.query("SELECT request FROM runs WHERE id = 'unparseable'")).rows[0].request, unparseable);
    const { runs, close } = createPostgresRunStore(url);
    try {
      assert.deepEqual((await runs.get("settled-ambient-live"))!.request.origin, {
        kind: "ambient",
        entryTs: "ambient-ts",
        live: true,
      });
    } finally {
      await close();
    }

    const signals = (await admin.query("SELECT payload, consumed_at FROM run_signals ORDER BY id")).rows;
    assert.equal(signals[0].payload.request.unprompted, true, "consumed signals are left alone");
    assert.deepEqual(signals[1].payload.request.origin, { kind: "ambient", entryTs: "7" });
    assert.equal("unprompted" in signals[1].payload.request, false);
    assert.deepEqual(signals[1].payload.sessionRequest.origin, { kind: "automation", screenData: "s" });
    const approvals = Object.fromEntries(
      (await admin.query("SELECT id, json FROM approvals")).rows.map((r) => [r.id, r.json.request]),
    );
    assert.deepEqual(approvals.a1.origin, { kind: "automation", screenData: "d" });
    assert.equal("triggered" in approvals.a1, false);
    assert.deepEqual(approvals.a2.origin, { kind: "direct" });

    const migrated = await snapshot(admin);
    await admin.query("DELETE FROM qm_schema_migrations WHERE id = $1", [TURN_ORIGIN_MIGRATION.id]);
    await migrate(url);
    assert.deepEqual(await snapshot(admin), migrated, "a second pass changes nothing");
  });
});
