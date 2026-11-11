import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPgPool, migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import { createPostgresUserStore } from "../src/identity/user-store.ts";
import { BACKFILL_BOT_MARKER_MIGRATION } from "../src/triggers/trigger-store.ts";
import { createControlService } from "../src/api/control-service.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { createStepRecorder, recordingTools } from "../src/agent/step-recorder.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("the bot marker backfill marks what a Slack app user made and nothing a person made", async () => {
  const url = testDatabaseUrl();
  const users = createPostgresUserStore(url);
  for (const id of ["release-bot", "U1"]) await users.record({ id, source: "turn", at: Date.now() });
  await users.markApps(["release-bot"]);
  const maps = createPostgresMapFactory(url);
  const creators = {
    crons: "createdBy",
    loops: "createdBy",
    monitors: "createdBy",
    keychain_asks: "requesterId",
  };
  for (const [table, creator] of Object.entries(creators)) {
    const map = maps.map<Record<string, unknown>>(table);
    await map.put("by-bot", { id: "by-bot", [creator]: "release-bot" });
    await map.put("by-person", { id: "by-person", [creator]: "U1" });
  }
  const pg = createPgPool(url);
  try {
    await pg.migrate(BACKFILL_BOT_MARKER_MIGRATION);
    for (const table of Object.keys(creators)) {
      const rows = await maps.map<{ id: string; botActor?: boolean }>(table).all();
      assert.deepEqual(
        Object.fromEntries(rows.map((row) => [row.id, row.botActor ?? null])),
        { "by-bot": true, "by-person": null },
        table,
      );
    }
  } finally {
    await pg.close();
  }
});

test("a deploy marks crons still running a bot-prompted ambient wake's text and lists the rest for review", async () => {
  const url = testDatabaseUrl();
  const built = buildApp(testConfig({ databaseUrl: url }));
  await migrateRegisteredPgSchemas(url);
  const control = createControlService(built.app, built.scheduler);
  const [ambient, scope] = ["system:ambient:default-org", "channel:C1"];
  const wake = { surface: "slack", actor: { externalId: ambient }, origin: { kind: "automation" } } as const;
  const edit = async (id: string, task: string, bot?: "admitted" | "refused") => {
    const threadRef = `slack:C1:ambient:${task}`;
    const conversation = { kind: "channel" as const, threadRef };
    const { runId } = await built.app.turn({ ...wake, conversation, text: "wake", botActor: !!bot, async: true });
    const items: never[] = [];
    const steps = createStepRecorder({ emit: async (item: never) => void items.push(item) } as never, (w) => void w());
    const claims = { actorId: ambient, scopeId: scope, exp: Date.now() + 60_000, botActor: bot === "refused" };
    const current = { cronPatch: (cronId: string, req: never) => control.patchCron(cronId, req, claims) };
    const tools = createAgentTools({ current, emit: steps.emit, scopeLabel: scope } as never, { controlTools: true });
    const cron = recordingTools(tools, () => steps).find((t) => t.name === "cron")!;
    const call = { type: "toolCall" as const, id: threadRef, name: "cron", arguments: { action: "patch", id, task } };
    steps.assistant({ role: "assistant", content: [call], stopReason: "toolUse" } as never);
    await cron.execute(call.id, call.arguments, undefined, undefined, undefined as never);
    const session = await built.sessions.getOrCreateByThread(threadRef, "channel", scope, "c", "slack");
    await built.sessions.appendMany({ sessionId: session.id, turnId: runId }, items);
    return { runId, threadRef };
  };
  const schedule = { cron: "0 9 * * *", timezone: "UTC" };
  const make = (action: string, botActor = false) =>
    built.app.createCron({ ownerScopeId: scope, owner: ambient, createdBy: ambient, botActor, schedule, action });
  const crons = await Promise.all([make("a"), make("b"), make("c"), make("d", true), make("e")]);
  const [marked, rewritten, person, already, refused] = crons;
  const from = await edit(marked.id, "bot-a", "admitted");
  await edit(rewritten.id, "bot-b", "admitted");
  await edit(rewritten.id, "person-b");
  await edit(person.id, "person-c");
  await edit(already.id, "bot-d", "admitted");
  await edit(refused.id, "bot-e", "refused");
  const before = await Promise.all(crons.map((c) => built.app.getCron(c.id)));
  const [pg, id] = [createPgPool(url), "triggers/0001-mark-bot-edited-crons"];
  await pg.q("DELETE FROM qm_schema_migrations WHERE id = $1", [id]);
  await migrateRegisteredPgSchemas(url);
  const after = await Promise.all(crons.map((c) => built.app.getCron(c.id)));
  assert.deepEqual(after, [{ ...before[0], botActor: true }, ...before.slice(1)]);
  const audit = await pg.q(
    "SELECT action, resource, scope_label, detail::jsonb FROM audit_log WHERE principal_id = 'system:migration' ORDER BY id",
  );
  await pg.close();
  assert.deepEqual(audit.map(Object.values), [
    ["cron_update", marked.id, scope, { botActor: true, ...from }],
    ["cron_bot_marker_backfill", id, "org:default-org", { marked: 1, review: 1, reviewCronIds: [rewritten.id] }],
  ]);
});
