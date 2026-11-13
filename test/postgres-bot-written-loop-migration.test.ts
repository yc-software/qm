import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool, migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("a deploy marks loops bot work created or rewrote and revokes ship grants bot work made", async () => {
  const url = testDatabaseUrl();
  const { app, sessions, loops, crons } = buildApp(testConfig({ databaseUrl: url }));
  await migrateRegisteredPgSchemas(url);
  const [scope, api, actor] = ["channel:C1", 'curl -X POST "$AGENT_API_URL/v1/loops', { externalId: "U1" }];
  const wake = { surface: "slack", origin: { kind: "human" }, text: "go", async: true, actor } as const;
  let calls = 0;
  const call = async <T>(bot: boolean, command: string, write: () => Promise<T>) => {
    const threadRef = `slack:C1:${String(++calls).padStart(2, "0")}`;
    const { runId } = await app.turn({ ...wake, botActor: bot, conversation: { kind: "channel", threadRef } });
    const session = await sessions.getOrCreateByThread(threadRef, "channel", scope, "c", "slack");
    const append = (item: object) => sessions.appendMany({ sessionId: session.id, turnId: runId }, [item as never]);
    await append({ kind: "ToolCall", tool: "execute", callId: threadRef, body: { command } });
    const written = await write();
    await append({ kind: "ToolResult", tool: "execute", callId: threadRef, text: JSON.stringify(written), body: {} });
    return [{ runId, threadRef }, written] as const;
  };
  const base = { owner: "U1", createdBy: "U1", ownerScopeId: scope, playbook: "p", successCondition: "done" };
  const make = async (name: string, more = {}) => (await loops.store.create({ ...base, name, ...more })).loop;
  const edit = (id: string, playbook: string) => loops.store.update(id, { playbookEdit: { playbook, by: "U1" } });
  const patch = (id: string) => `curl -X PATCH "$AGENT_API_URL/v1/loops/${id}" -d '{"playbook":"..."}'`;
  const grant = (shipAction: string, loopId: string) => () =>
    loops.grants.put({ id: shipAction, loopId, shipAction, actorId: "U1", policyVersion: 1, createdAt: Date.now() });
  const cron = (action: string) => crons.create({ ...base, schedule: { cron: "0 9 * * *", timezone: "UTC" }, action });
  const [ka, kb, kf] = [await cron("a"), await cron("b"), await cron("f")];
  const a = await make("a", { cronId: ka.id });
  const [c, e, d] = [await make("c"), await make("e"), await make("d", { botActor: true })];
  const [fromPatch] = await call(true, patch(a.id), () => edit(a.id, "bot a"));
  const [fromCreate, b] = await call(true, api, () => make("b", { cronId: kb.id }));
  await call(true, patch(c.id), () => edit(c.id, "bot c"));
  await call(false, patch(c.id), () => edit(c.id, "person c"));
  await call(true, "sleep 30 && ls", () => edit(e.id, "person e").then(() => "listing"));
  await call(true, patch(d.id), () => edit(d.id, "bot d"));
  const [fromGrant] = await call(true, `${api}/${c.id}/grants"`, grant("send_email", c.id));
  await call(false, `${api}/${c.id}/grants"`, grant("post_slack", c.id));
  const [fromCreateF, f] = await call(true, api, () => make("f", { cronId: kf.id }));
  await call(false, patch(f.id), () => edit(f.id, "person f"));
  const state = async () => ({
    loops: await Promise.all([a, b, f, c, e, d].map((loop) => loops.store.get(loop.id))),
    crons: await Promise.all([ka, kb, kf].map((k) => crons.get(k.id))),
    grants: await Promise.all(["send_email", "post_slack"].map((id) => loops.grants.get(id))),
  });
  const [before, pg] = [await state(), createPgPool(url)];
  await pg.q("DELETE FROM qm_schema_migrations WHERE id = 'triggers/0002-mark-bot-written-loops'");
  await migrateRegisteredPgSchemas(url);
  const after = await state();
  const audit = await pg.q(`SELECT action, resource, scope_label, detail::jsonb FROM audit_log
    WHERE principal_id = 'system:migration' ORDER BY detail::jsonb ->> 'threadRef', action`);
  await pg.close();
  const [bot, automation] = [{ botActor: true }, { taskAuthor: "automation" }];
  const revocation = { revokedAt: after.grants[0]?.revokedAt, revokedBy: "system:migration" };
  const [la, lb, lf, ...rest] = before.loops;
  assert.deepEqual(after, {
    loops: [{ ...la, ...automation }, { ...lb, ...bot, ...automation }, { ...lf, ...bot }, ...rest],
    crons: [before.crons[0], { ...before.crons[1], ...bot }, { ...before.crons[2], ...bot }],
    grants: [{ ...before.grants[0], ...revocation }, before.grants[1]],
  });
  assert.ok(revocation.revokedAt! >= before.grants[0]!.createdAt);
  assert.deepEqual(audit.map(Object.values), [
    ["loop_update", a.id, scope, { ...fromPatch, ...automation }],
    ["cron_update", kb.id, scope, { ...fromCreate, ...bot }],
    ["loop_update", b.id, scope, { ...fromCreate, ...bot, ...automation }],
    ["ship_grant_revoke", "send_email", scope, { ...fromGrant, loopId: c.id }],
    ["cron_update", kf.id, scope, { ...fromCreateF, ...bot }],
    ["loop_update", f.id, scope, { ...fromCreateF, ...bot }],
  ]);
});
