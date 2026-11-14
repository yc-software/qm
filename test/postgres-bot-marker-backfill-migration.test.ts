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
  const creators = { crons: "createdBy", loops: "createdBy", monitors: "createdBy", keychain_asks: "requesterId" };
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

test("a deploy marks crons still running what a bot-marked turn wrote and lists the rest for review", async () => {
  const url = testDatabaseUrl();
  const built = buildApp(testConfig({ databaseUrl: url }));
  await migrateRegisteredPgSchemas(url);
  const control = createControlService(built.app, built.scheduler);
  const [ambient, scope] = ["system:ambient:default-org", "channel:C1"];
  const wake = { surface: "slack", origin: { kind: "automation" }, text: "wake", async: true } as const;
  const edit = async (id: string, label: string, bot?: "admitted" | "refused", args: object = { task: label }) => {
    const { owner } = (await built.app.getCron(id))!;
    const threadRef = `slack:C1:ambient:${label}`;
    const conversation = { kind: "channel" as const, threadRef };
    const { runId } = await built.app.turn({ ...wake, actor: { externalId: owner }, conversation, botActor: !!bot });
    const items: never[] = [];
    const steps = createStepRecorder({ emit: async (item: never) => void items.push(item) } as never, (w) => void w());
    const claims = { actorId: owner, scopeId: scope, exp: Date.now() + 60_000, botActor: bot === "refused" };
    const current = { cronPatch: (c: string, req: never) => control.patchCron(c, req, claims, async () => undefined) };
    const tools = createAgentTools({ current, emit: steps.emit, scopeLabel: scope } as never, { controlTools: true });
    const cron = recordingTools(tools, () => steps).find((t) => t.name === "cron")!;
    const call = { type: "toolCall", id: threadRef, name: "cron", arguments: { action: "patch", id, ...args } };
    steps.assistant({ role: "assistant", content: [call], stopReason: "toolUse" } as never);
    await cron.execute(call.id, call.arguments, undefined, undefined, undefined as never);
    const session = await built.sessions.getOrCreateByThread(threadRef, "channel", scope, "c", "slack");
    await built.sessions.appendMany({ sessionId: session.id, turnId: runId }, items);
    return { runId, threadRef };
  };
  const schedule = { cron: "0 9 * * *", timezone: "UTC" };
  const make = (action: string, botActor = false, owner = ambient) =>
    built.app.createCron({ ownerScopeId: scope, owner, createdBy: owner, botActor, schedule, action });
  const crons = await Promise.all([make("a", false, "U1"), make("b"), make("c"), make("d", true), make("e")]);
  const [marked, scripted, rewritten, already, refused] = crons;
  const from = await edit(marked.id, "bot-a", "admitted");
  await edit(marked.id, "bot-a-schedule", "admitted", { schedule: { ...schedule, cron: "0 10 * * *" } });
  const review = await edit(rewritten.id, "bot-b", "admitted", { task: "bot-b\0" });
  await edit(rewritten.id, "person-b");
  const fromScript = await edit(scripted.id, "sh", "admitted", { script: { command: "true", credentials: ["gh"] } });
  await edit(already.id, "bot-d", "admitted");
  await edit(refused.id, "bot-e", "refused");
  const before = await Promise.all(crons.map((c) => built.app.getCron(c.id)));
  const [pg, id] = [createPgPool(url), "triggers/0001-mark-bot-edited-crons"];
  await pg.q("DELETE FROM qm_schema_migrations WHERE id = $1", [id]);
  await migrateRegisteredPgSchemas(url);
  const after = await Promise.all(crons.map((c) => built.app.getCron(c.id)));
  assert.deepEqual(after, [{ ...before[0], botActor: true }, { ...before[1], botActor: true }, ...before.slice(2)]);
  const audit = await pg.q(`SELECT action, resource, scope_label, detail::jsonb FROM audit_log
    WHERE principal_id = 'system:migration' ORDER BY action, detail::jsonb ->> 'threadRef'`);
  await pg.close();
  assert.deepEqual(audit.map(Object.values), [
    ["cron_bot_marker_review", rewritten.id, scope, review],
    ["cron_update", marked.id, scope, { botActor: true, ...from }],
    ["cron_update", scripted.id, scope, { botActor: true, ...fromScript }],
  ]);
});

test("a deploy gives a Slack bot linked to a person its own app user, so the bot marker backfill spares the person", async () => {
  const url = testDatabaseUrl();
  const built = buildApp(testConfig({ databaseUrl: url }));
  await migrateRegisteredPgSchemas(url);
  const users = createPostgresUserStore(url);
  const [pat, bot, sam, bot2, app, app2] = ["pat@acme.test", "B0BOT", "U0SAM", "B0BOT2", "B0APP", "B0APP2"];
  const [kim, lee, dir] = ["kim@acme.test", "U0LEE", "B0DIR"];
  const schedule = { cron: "0 9 * * *", timezone: "UTC" };
  const crons = await Promise.all(
    [pat, bot].map((who) =>
      built.app.createCron({ ownerScopeId: "channel:C1", owner: who, createdBy: who, schedule, action: who }),
    ),
  );
  for (const [alias, person] of Object.entries({ [bot]: pat, U0PAT: pat, [bot2]: sam, [app2]: app })) {
    await users.link({ principalId: alias, canonicalId: person, evidence: "admin", linkedBy: "U0ADM", createdAt: 1 });
    await users.markApps([person]);
  }
  for (const who of [kim, lee, dir]) await users.record({ id: who, source: "turn", at: 1 });
  await built.directory.replace([
    { principalId: pat, displayName: "Pat", type: "internal", slackId: "U0PAT" },
    { principalId: kim, displayName: "Kim", type: "internal", slackId: "U0KIM" },
    { principalId: dir, displayName: "Dir", type: "internal" },
  ]);
  await users.markApps([kim, lee, dir]);
  const said = (speaker: string, actor: string, botActor = false) => {
    const surfaceOrigin = { author: { surface: "slack", account: "default", id: speaker }, audience: "internal" };
    const request = { actor: { id: actor }, origin: { kind: "human" }, surfaceOrigin, botActor } as never;
    return built.runs.enqueue({ sessionId: `slack:C1:${speaker}`, request });
  };
  await Promise.all([
    said(bot, pat, true),
    said(sam, sam),
    said(bot2, sam, true),
    said(app, app, true),
    said(app2, app, true),
    said(lee, lee),
  ]);
  const pg = createPgPool(url);
  const rerun = async (id: string) => {
    await pg.q("DELETE FROM qm_schema_migrations WHERE id = $1", [id]);
    await migrateRegisteredPgSchemas(url);
  };
  const state = async () => ({
    links: await pg.q(`SELECT l.alias_id, u.primary_alias, u.kind, l.evidence, l.linked_by, l.created_at
      FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id ORDER BY 1`),
    audit: await pg.q(
      "SELECT action, resource, scope_label, detail::jsonb FROM audit_log WHERE principal_id = 'system:migration' ORDER BY action, detail COLLATE \"C\"",
    ),
  });
  const before = await state();
  await rerun("users/v2/0009-split-linked-bots");
  const after = await state();
  const person = { kind: "person" };
  const own = (alias: string) => ({ primary_alias: alias, evidence: "primary", linked_by: null });
  const moved = { [bot]: own(bot), [bot2]: own(bot2), [pat]: person, U0PAT: person, [kim]: person };
  assert.deepEqual(
    after.links,
    before.links.map((link) => ({ ...link, ...moved[String(link.alias_id)] })),
  );
  const signIns = [
    { alias: sam, evidence: "primary", signal: "none" },
    { alias: bot2, evidence: "admin", signal: "bot" },
  ];
  const review = { reason: "some sign-ins have no certain signal", signIns };
  const id = async (alias: string) => (await users.get(alias))!.id;
  const admin = await id("U0ADM");
  const split = async (alias: string) => ({ alias, userId: await id(alias), evidence: "admin", linkedBy: admin });
  assert.deepEqual(after.audit.map(Object.values), [
    ["user_sign_in_review", await id(sam), "users", review],
    ["user_sign_in_split", await id(kim), "users", { movedSignIns: [] }],
    ["user_sign_in_split", await id(pat), "users", { movedSignIns: [await split(bot)] }],
    ["user_sign_in_split", await id(sam), "users", { movedSignIns: [await split(bot2)] }],
  ]);
  await rerun("users/v2/0008-bot-marker-backfill");
  const marks = await Promise.all(crons.map(async (c) => (await built.app.getCron(c.id))?.botActor));
  await pg.close();
  assert.deepEqual(marks, [undefined, true]);
  await users.unlink(app2);
  assert.equal((await users.get(app))?.kind, "app");
});
