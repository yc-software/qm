import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool, migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import { createPostgresUserStore } from "../src/identity/user-store.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("a deploy revokes ship grants a bot made and holds the auto gates of loops bot work made", async () => {
  const url = testDatabaseUrl();
  const { loops } = buildApp(testConfig({ databaseUrl: url }));
  await migrateRegisteredPgSchemas(url);
  const users = createPostgresUserStore(url);
  for (const id of ["release-bot", "U1"]) await users.record({ id, source: "turn", at: Date.now() });
  await users.markApps(["release-bot"]);
  const scope = "channel:C1";
  const gates = { shipActions: ["send_email", "post_slack"].map((action) => ({ action, gate: "auto" as const })) };
  const base = { owner: "U1", createdBy: "U1", ownerScopeId: scope, playbook: "p", successCondition: "done" };
  const make = async (name: string, more = {}) => (await loops.store.create({ ...base, name, ...more })).loop;
  const [a, b] = [await make("a", gates), await make("b", { botActor: true, ...gates })];
  const c = await make("c", { owner: "release-bot", createdBy: "release-bot", ...gates });
  const e = await make("e", { botActor: true, shipActions: [{ action: "send_email", gate: "hold" }] });
  const grant = (id: string, loopId: string, shipAction: string, actorId: string) =>
    loops.grants.put({ id, loopId, shipAction, actorId, policyVersion: 1, createdAt: Date.now() });
  await grant("gb", b.id, "send_email", "release-bot");
  await grant("pa", a.id, "post_slack", "U1");
  await grant("ge", e.id, "send_email", " release-bot ");
  await grant("gr", b.id, "post_slack", "release-bot");
  await loops.grants.revoke("gr", "U1");
  const state = async () => ({
    loops: await Promise.all([a, b, c, e].map((loop) => loops.store.get(loop.id))),
    grants: await Promise.all(["gb", "pa", "ge", "gr"].map((id) => loops.grants.get(id))),
  });
  const [before, pg] = [await state(), createPgPool(url)];
  await pg.q("DELETE FROM qm_schema_migrations WHERE id = 'users/v2/0010-hold-bot-loop-ships'");
  await migrateRegisteredPgSchemas(url);
  const after = await state();
  const audit = await pg.q(`SELECT action, resource, scope_label, detail::jsonb FROM audit_log
    WHERE principal_id = 'system:migration' ORDER BY action, resource`);
  await pg.close();
  const revocation = { revokedAt: after.grants[0]?.revokedAt, revokedBy: "system:migration" };
  const [[la, lb, lc, le], held] = [before.loops, gates.shipActions.map((p) => ({ ...p, gate: "hold" }))];
  assert.deepEqual(after, {
    loops: [la, { ...lb, shipActions: held }, { ...lc, shipActions: held }, le],
    grants: before.grants.map((g) => (["gb", "ge"].includes(g!.id) ? { ...g, ...revocation } : g)),
  });
  assert.ok(revocation.revokedAt! >= before.grants[0]!.createdAt);
  assert.deepEqual(audit.map(Object.values), [
    ...[b.id, c.id].sort().map((id) => ["loop_update", id, scope, { heldShipActions: ["send_email", "post_slack"] }]),
    ["ship_grant_revoke", "gb", scope, { loopId: b.id }],
    ["ship_grant_revoke", "ge", scope, { loopId: e.id }],
  ]);
});
