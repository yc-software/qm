import "./support/auto-fake-sprites.ts";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { buildApp } from "../src/wiring.ts";
import { migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import { testConfig } from "./support/test-config.ts";
import { loopItemRoutes } from "../src/api/routes/loop-items.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { ensureDefaultInboxLoops } from "../src/loops/inbox-loop.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

const databaseUrl = process.env.DATABASE_URL;

test(
  "upgrading retires only bundled email voice skills, including when seeding is disabled",
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const rows = [
      ["old-draft", "email-draft-in-voice", "system:skills-seed"],
      ["old-profile", "email-voice-profile", "system:skills-seed"],
      ["custom-draft", "email-draft-in-voice", "person@example.com"],
      ["layer-profile", "email-voice-profile", "system:deployment-layer"],
      ["voice", "voice", "person@example.com"],
      ["profile", "voice-profile", "person@example.com"],
      ["google", "google-workspace", "system:skills-seed"],
    ].map(([id, name, createdBy]) => ({
      id,
      scopeId: "org:example",
      manifest: { name, description: name, body: "Private writing instructions", requiredCapabilities: [] },
      createdBy,
      status: "published",
      version: 3,
      updatedAt: 1,
    }));
    await pool.query("CREATE TABLE skills (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    for (const row of rows) await pool.query("INSERT INTO skills VALUES ($1, $2)", [row.id, JSON.stringify(row)]);
    const { playbook } = JSON.parse(
      readFileSync(new URL("./fixtures/inbox-voice-upgrade.json", import.meta.url), "utf8"),
    ) as { playbook: string };
    const previous = {
      playbook,
      playbookVersion: 4,
      playbookHistory: [{ version: 4, at: 1, by: "person@example.com" }],
      updatedAt: 1,
    };
    const loops = [
      { id: "inbox", surface: "inbox:gmail", cronId: "sync", ...previous },
      { id: "custom", surface: "inbox:slack", ...previous, playbook: "My custom writing instructions" },
      { id: "other", surface: "custom", ...previous },
    ];
    await pool.query("CREATE TABLE loops (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    await pool.query("CREATE TABLE crons (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    for (const loop of loops) await pool.query("INSERT INTO loops VALUES ($1, $2)", [loop.id, JSON.stringify(loop)]);
    await pool.query("INSERT INTO crons VALUES ('sync', $1), ('unrelated', $1)", [
      JSON.stringify({ action: playbook, enabled: false, updatedAt: 1 }),
    ]);
    const built = buildApp(testConfig({ databaseUrl, seedSkills: false }));
    try {
      await migrateRegisteredPgSchemas(databaseUrl);
      const upgraded = new Map((await built.app.listSkills()).map((skill) => [skill.id, skill]));
      for (const row of rows) {
        const actual = upgraded.get(row.id!);
        assert.ok(actual);
        if (row.id === "old-draft" || row.id === "old-profile") {
          assert.equal(actual.status, "archived");
          assert.deepEqual(actual.manifest, row.manifest);
          assert.equal(actual.version, row.version);
        } else {
          assert.deepEqual(actual, row);
        }
      }
      const savedLoops = new Map(
        (await pool.query("SELECT id, json FROM loops ORDER BY id")).rows.map((row) => [row.id, row.json]),
      );
      const inbox = savedLoops.get("inbox");
      assert.equal(inbox.playbookVersion, 5);
      assert.deepEqual(inbox.playbookHistory[0], previous.playbookHistory[0]);
      assert.equal(inbox.playbookHistory[1].by, "system:voice-skill-retirement");
      assert.ok(inbox.playbook.includes("\nKeep my custom introduction.\n"));
      assert.ok(inbox.playbook.endsWith("\nKeep my custom closing preference."));
      assert.deepEqual(savedLoops.get("custom"), loops[1]);
      assert.deepEqual(savedLoops.get("other"), loops[2]);
      const savedCrons = new Map(
        (await pool.query("SELECT id, json FROM crons ORDER BY id")).rows.map((row) => [row.id, row.json]),
      );
      assert.equal(savedCrons.get("sync").enabled, false);
      assert.equal(savedCrons.get("sync").action, inbox.playbook);
      assert.deepEqual(savedCrons.get("unrelated"), { action: playbook, enabled: false, updatedAt: 1 });
      const store = createLoopStore();
      const [loop] = await ensureDefaultInboxLoops(store, "reviewer");
      await store.update(loop!.id, { cronId: "sync" });
      let resumedCron = { id: "sync", schedule: { everyMs: 900_000 }, ...savedCrons.get("sync") };
      let status = 0;
      await loopItemRoutes
        .find((route) => "path" in route && route.path === "/v1/loops/inbox/sync-cron")!
        .handle({
          capability: { actorId: "reviewer", scopeId: "personal:reviewer", liveActor: true },
          body: { enabled: true, loopId: loop!.id },
          deps: { loops: { store }, featureFlags: { enabled: async () => true } },
          app: {
            getCron: async () => resumedCron,
            updateCron: async (_id: string, patch: Record<string, unknown>) =>
              (resumedCron = { ...resumedCron, ...patch }),
            setCronEnabled: async (_id: string, enabled: boolean) => {
              resumedCron = { ...resumedCron, enabled };
            },
          },
          res: {
            getHeader: () => undefined,
            writeHead: (code: number) => {
              status = code;
            },
            end: () => {},
          },
        } as unknown as ApiCtx);
      assert.equal(status, 200);
      assert.equal(resumedCron.enabled, true);
      assert.equal(resumedCron.action, savedCrons.get("sync").action);
      await migrateRegisteredPgSchemas(databaseUrl);
      assert.deepEqual(await built.app.listSkills(), [...upgraded.values()]);
      assert.deepEqual(
        (await pool.query("SELECT id, json FROM loops ORDER BY id")).rows.map((row) => [row.id, row.json]),
        [...savedLoops],
      );
    } finally {
      await built.runtime.stop();
      await pool.end();
    }
  },
);
