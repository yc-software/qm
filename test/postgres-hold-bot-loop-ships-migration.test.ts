import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool, migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("a deploy revokes ship grants bot work made and holds the auto gates they and bot loops ship through", async () => {
  const url = testDatabaseUrl();
  const { app, sessions, loops } = buildApp(testConfig({ databaseUrl: url }));
  await migrateRegisteredPgSchemas(url);
  const [scope, actor] = ["channel:C1", { externalId: "U1" }];
  const wake = { surface: "slack", origin: { kind: "human" }, text: "go", async: true, actor } as const;
  let calls = 0;
  const call = async (bot: boolean, command: string, write: () => Promise<unknown>) => {
    const threadRef = `slack:C1:${String(++calls).padStart(2, "0")}`;
    const { runId } = await app.turn({ ...wake, botActor: bot, conversation: { kind: "channel", threadRef } });
    const session = await sessions.getOrCreateByThread(threadRef, "channel", scope, "c", "slack");
    const append = (item: object) => sessions.appendMany({ sessionId: session.id, turnId: runId }, [item as never]);
    await append({ kind: "ToolCall", tool: "execute", callId: threadRef, body: { command } });
    const written = await write();
    await append({ kind: "ToolResult", tool: "execute", callId: threadRef, text: JSON.stringify(written), body: {} });
    return { runId, threadRef };
  };
  const base = { owner: "U1", createdBy: "U1", ownerScopeId: scope, playbook: "p", successCondition: "done" };
  const gates = { shipActions: ["send_email", "post_slack"].map((action) => ({ action, gate: "auto" as const })) };
  const make = async (name: string, more = {}) => (await loops.store.create({ ...base, name, ...more })).loop;
  const grant = (id: string, shipAction: string, loopId: string) => () =>
    loops.grants.put({ id, loopId, shipAction, actorId: "U1", policyVersion: 1, createdAt: Date.now() });
  const grants = (loopId: string) => `curl -X POST "$AGENT_API_URL/v1/loops/${loopId}/grants"`;
  const [a, b] = [await make("a", gates), await make("b", { botActor: true, ...gates })];
  const e = await make("e", { shipActions: [{ action: "send_email", gate: "hold" }] });
  const fromGrant = await call(true, grants(a.id), grant("ga", "send_email", a.id));
  await call(false, grants(a.id), grant("pa", "post_slack", a.id));
  await call(true, "sleep 30 && ls", () => grant("sa", "post_slack", a.id)().then(() => "listing"));
  const fromGrantE = await call(true, grants(e.id), grant("ge", "send_email", e.id));
  await call(true, grants(a.id), grant("gr", "post_slack", a.id));
  await loops.grants.revoke("gr", "U1");
  const state = async () => ({
    loops: await Promise.all([a, b, e].map((loop) => loops.store.get(loop.id))),
    grants: await Promise.all(["ga", "pa", "sa", "ge", "gr"].map((id) => loops.grants.get(id))),
  });
  const [before, pg] = [await state(), createPgPool(url)];
  await pg.q("DELETE FROM qm_schema_migrations WHERE id = 'users/v2/0010-hold-bot-loop-ships'");
  await migrateRegisteredPgSchemas(url);
  const after = await state();
  const audit = await pg.q(`SELECT action, resource, scope_label, detail::jsonb FROM audit_log
    WHERE principal_id = 'system:migration' ORDER BY detail::jsonb ->> 'threadRef', action`);
  await pg.close();
  const revocation = { revokedAt: after.grants[0]?.revokedAt, revokedBy: "system:migration" };
  const [la, lb, le] = before.loops;
  assert.deepEqual(after, {
    loops: [
      { ...la, shipActions: [{ action: "send_email", gate: "hold" }, gates.shipActions[1]] },
      { ...lb, shipActions: gates.shipActions.map((p) => ({ ...p, gate: "hold" })) },
      le,
    ],
    grants: before.grants.map((g) => (["ga", "ge"].includes(g!.id) ? { ...g, ...revocation } : g)),
  });
  assert.ok(revocation.revokedAt! >= before.grants[0]!.createdAt);
  assert.deepEqual(audit.map(Object.values), [
    ["loop_update", a.id, scope, { ...fromGrant, heldShipActions: ["send_email"] }],
    ["ship_grant_revoke", "ga", scope, { ...fromGrant, loopId: a.id }],
    ["ship_grant_revoke", "ge", scope, { ...fromGrantE, loopId: e.id }],
    ["loop_update", b.id, scope, { heldShipActions: ["post_slack", "send_email"] }],
  ]);
});
