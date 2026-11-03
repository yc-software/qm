import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual, promisify } from "node:util";
import pg from "pg";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { rowToSession } from "../src/sessions/postgres-session-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import {
  SETTLED_CANDIDATES_MIGRATION,
  SETTLED_ORIGIN_MIGRATION,
  rewriteSurfaceOrigins,
} from "../src/surfaces/origin-migration.ts";
import { slackSurfaceOrigin } from "../src/surfaces/slack/adapter.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the surface origin migration tests";
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

async function rewrite(url: string): Promise<void> {
  const pg = createPgPool(url);
  try {
    await rewriteSurfaceOrigins(pg);
  } finally {
    await pg.close();
  }
}

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

async function createJsonTables(admin: pg.Pool): Promise<void> {
  for (const table of ["approvals", ...DESTINATION_TABLES.map(([table]) => table)])
    await admin.query(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
}

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

test(
  "boot leaves stored Slack origins untouched, and the ownership-time rewrite converts them once to the neutral shape",
  { skip },
  async () => {
    await withDatabase(async (url, admin) => {
      await migrate(url);
      await createJsonTables(admin);
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
      await run(
        "private-latest",
        "s2",
        "done",
        2,
        request({ slackSource: internalSource, privateSessionMessage: true }),
      );
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
      const bindSession = (id: string, binding: object, meta: object) =>
        admin.query(
          "INSERT INTO sessions (id, type, scope_id, thread_ref, created_at, spawn_meta, slack_binding) VALUES ($1, 'dm', 'org:o', $1, 1, $2, $3)",
          [id, JSON.stringify(meta), JSON.stringify(binding)],
        );
      await bindSession(
        "bound-external",
        { ...ids, externalPolicyNamespace: "external-slack:TPARTNER:x" },
        {
          externalSlack: { ...ids, ...access },
          origin: { kind: "human" },
        },
      );
      await bindSession("bound-internal", internalSource, { origin: { kind: "human" } });
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

      await admin.query("DELETE FROM qm_schema_migrations WHERE id = $1", [SETTLED_CANDIDATES_MIGRATION.id]);
      const beforeBoot = await snapshot(admin);
      await migrate(url);
      assert.deepEqual(await snapshot(admin), beforeBoot);
      const previousReleaseShape = (extra: Record<string, unknown>) => {
        const { origin: _typed, ...legacy } = request(extra);
        return legacy;
      };
      await admin.query("INSERT INTO approvals (id, json) VALUES ('a-overlap', $1)", [
        JSON.stringify({
          command: "security-screen",
          request: previousReleaseShape({
            triggered: true,
            securityScreenData: "d",
            triggerDestination: oldDestination,
          }),
        }),
      ]);
      await admin.query(
        "INSERT INTO run_signals (run_id, kind, payload, created_at) VALUES ('pending', 'steer', $1, 2)",
        [JSON.stringify({ kind: "steer", request: previousReleaseShape({ unprompted: true, entryTs: "9" }) })],
      );
      await admin.query("UPDATE surface_origin_settled_collected SET collected_at = $1", [now - 72 * 3_600_000]);
      await run("settled-after-boot", "s7", "done", 4, request({ slackSource: internalSource }), now - 48 * 3_600_000);
      await run(
        "finished-as-collected",
        "s8",
        "done",
        5,
        request({ slackSource: internalSource }),
        now - 72 * 3_600_000 - 1_000,
      );
      await rewrite(url);

      const { runs, close } = createPostgresRunStore(url);
      try {
        const read = async (id: string) =>
          (await runs.get(id))!.request as unknown as Record<string, unknown> & { origin: Record<string, unknown> };
        assert.deepEqual((await read("settled-after-boot")).surfaceOrigin, internalOrigin);
        assert.deepEqual(
          (await read("finished-as-collected")).surfaceOrigin,
          internalOrigin,
          "a run stamped just before collection but committed after it is still folded",
        );
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
      assert.equal(
        (await admin.query("SELECT request FROM runs WHERE id = 'unparseable'")).rows[0].request,
        unparseable,
      );
      const child = rowToSession((await admin.query("SELECT * FROM sessions WHERE id = 'child'")).rows[0]);
      assert.deepEqual(child.spawnMeta, {
        surfaceOrigin: internalOrigin,
        origin: { kind: "automation", destination: newDestination },
      });
      const bound = async (id: string) =>
        rowToSession((await admin.query("SELECT * FROM sessions WHERE id = $1", [id])).rows[0]);
      const boundExternal = await bound("bound-external");
      assert.deepEqual(
        boundExternal.surfaceBinding,
        slackSurfaceOrigin({ ...ids, policyNamespace: "external-slack:TPARTNER:x" }),
      );
      assert.deepEqual(boundExternal.spawnMeta, { surfaceOrigin: externalOrigin, origin: { kind: "human" } });
      const boundInternal = await bound("bound-internal");
      assert.deepEqual(boundInternal.surfaceBinding, internalOrigin);
      assert.deepEqual(boundInternal.spawnMeta, { origin: { kind: "human" } });
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
      assert.deepEqual(signals[2].payload.request.origin, { kind: "ambient", entryTs: "9" });
      const overlapApproval = (await admin.query("SELECT json FROM approvals WHERE id = 'a-overlap'")).rows[0].json;
      assert.deepEqual(overlapApproval.request.origin, {
        kind: "automation",
        screenData: "d",
        destination: newDestination,
      });
      const approval = (await admin.query("SELECT json FROM approvals WHERE id = 'a1'")).rows[0].json;
      assert.deepEqual(approval.request.surfaceOrigin, internalOrigin);
      assert.equal("slackSource" in approval.request, false);
      for (const [table, field] of DESTINATION_TABLES)
        assert.deepEqual(
          (await admin.query(`SELECT json FROM ${table} WHERE id = 'd1'`)).rows[0].json[field],
          { type: "slack", target: "C1", account: { id: "partner", workspace: "TPARTNER", policyNamespace: "ns" } },
          table,
        );

      assert.equal((await admin.query("SELECT to_regclass('surface_origin_settled_candidates') AS t")).rows[0].t, null);
      const migrated = await snapshot(admin);
      await admin.query("DELETE FROM qm_schema_migrations WHERE id = $1", [SETTLED_ORIGIN_MIGRATION.id]);
      await rewrite(url);
      assert.deepEqual(await snapshot(admin), migrated);
    });
  },
);

const RETIRED_KEYS = [
  "triggerTs",
  "entryTs",
  "triggered",
  "securityScreenData",
  "triggerDestination",
  "ownerKeychainUnion",
  "unprompted",
  "liveActor",
];
const turnRequest = (extra: Record<string, unknown>) => {
  const { origin: _typed, ...base } = request({});
  return { ...base, ...extra };
};

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
      triggerDestination: newDestination,
      ownerKeychainUnion: true,
    },
    { kind: "automation", screenData: "external payload", destination: newDestination, useOwnerKeychain: true },
  ],
  [
    "typed-destination",
    { origin: { kind: "automation", destination: newDestination } },
    { kind: "automation", destination: newDestination },
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

test(
  "boot only collects runs missing a typed origin, and the ownership-time rewrite folds every stored retired origin into `origin`",
  { skip },
  async () => {
    await withDatabase(async (url, admin) => {
      await migrate(url);
      await createJsonTables(admin);
      const run = (id: string, status: string, body: unknown, finishedAt: number | null = 1) =>
        admin.query(
          "INSERT INTO runs (id, session_id, status, request, created_at, finished_at) VALUES ($1, $2, $3, $4, $5, $6)",
          [id, `s-${id}`, status, typeof body === "string" ? body : JSON.stringify(body), 1, finishedAt],
        );
      for (const [name, stored] of CASES) {
        await run(`live-${name}`, "pending", turnRequest(stored), null);
        await run(`settled-${name}`, "done", turnRequest(stored));
      }
      await admin.query(
        `INSERT INTO runs (id, session_id, status, request, created_at, finished_at)
         SELECT 'bulk-' || g, 'bulk', 'done', $1, g, 1 FROM generate_series(1, 2500) g`,
        [JSON.stringify(turnRequest({ liveActor: true }))],
      );
      const unparseable = JSON.stringify(turnRequest({ liveActor: true, text: "a\u0000b\ud800" }));
      await run("unparseable", "done", unparseable);
      await admin.query(
        "INSERT INTO run_signals (run_id, kind, payload, created_at, consumed_at) VALUES ('live-human', 'steer', $1, 1, $2), ('live-human', 'steer', $1, 1, NULL)",
        [
          JSON.stringify({
            kind: "steer",
            request: turnRequest({ unprompted: true, entryTs: "7" }),
            sessionRequest: turnRequest({ origin: { kind: "automation" }, triggered: true, securityScreenData: "s" }),
          }),
          5,
        ],
      );
      await admin.query("INSERT INTO approvals (id, json) VALUES ('a1', $1), ('a2', $2)", [
        JSON.stringify({
          command: "security-screen",
          request: turnRequest({ triggered: true, securityScreenData: "d" }),
        }),
        JSON.stringify({ command: "rm", request: turnRequest({}) }),
      ]);

      await admin.query("DELETE FROM qm_schema_migrations WHERE id = $1", [SETTLED_CANDIDATES_MIGRATION.id]);
      const beforeBoot = await snapshot(admin);
      await migrate(url);
      assert.deepEqual(await snapshot(admin), beforeBoot, "boot writes no stored request");
      await run("settled-after-boot", "done", turnRequest({ unprompted: true, entryTs: "8" }), Date.now());
      await rewrite(url);

      const raw = async (id: string) =>
        JSON.parse((await admin.query("SELECT request FROM runs WHERE id = $1", [id])).rows[0].request) as Record<
          string,
          unknown
        >;
      for (const [name, before, origin] of CASES)
        for (const id of [`live-${name}`, `settled-${name}`]) {
          const stored = await raw(id);
          assert.deepEqual(stored.origin, origin, id);
          const folded = "origin" in before && !isDeepStrictEqual(before.origin, origin);
          for (const key of RETIRED_KEYS)
            assert.deepEqual(
              stored[key],
              folded ? undefined : before[key],
              `${id} ${folded ? "drops" : "keeps"} ${key}`,
            );
          assert.equal(stored.text, "hi", id);
        }
      assert.deepEqual((await raw("settled-after-boot")).origin, { kind: "ambient", entryTs: "8" });
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM runs WHERE id LIKE 'bulk-%' AND request NOT LIKE '%\"origin\"%'",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await admin.query("SELECT request FROM runs WHERE id = 'unparseable'")).rows[0].request,
        unparseable,
      );
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
      assert.equal(signals[0].payload.request.origin, undefined, "consumed signals are left alone");
      assert.deepEqual(signals[1].payload.request.origin, { kind: "ambient", entryTs: "7" });
      assert.equal(signals[1].payload.request.unprompted, true, "the previous release still reads the retired flag");
      assert.deepEqual(signals[1].payload.sessionRequest.origin, { kind: "automation", screenData: "s" });
      const approvals = Object.fromEntries(
        (await admin.query("SELECT id, json FROM approvals")).rows.map((r) => [r.id, r.json.request]),
      );
      assert.deepEqual(approvals.a1.origin, { kind: "automation", screenData: "d" });
      assert.equal(approvals.a1.triggered, true, "the previous release still reads the retired flag");
      assert.deepEqual(approvals.a2.origin, { kind: "direct" });

      const migrated = await snapshot(admin);
      await admin.query("DELETE FROM qm_schema_migrations WHERE id = ANY($1)", [
        [SETTLED_CANDIDATES_MIGRATION.id, SETTLED_ORIGIN_MIGRATION.id],
      ]);
      await migrate(url);
      await rewrite(url);
      assert.deepEqual(await snapshot(admin), migrated, "a second pass changes nothing");
    });
  },
);
