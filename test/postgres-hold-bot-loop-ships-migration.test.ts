import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool, migrateDatabase } from "../src/persistence/pg-pool.ts";
import { createPostgresUserStore } from "../src/identity/user-store.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("0001-mark-earlier-links marks and holds earlier work of linked app sign-ins without re-holding unrelated bot loops", async () => {
  const url = testDatabaseUrl();
  const { loops, directory } = buildApp(testConfig({ databaseUrl: url }));
  await migrateDatabase(url);
  const users = createPostgresUserStore(url);
  for (const id of ["U1", "U2"]) await users.record({ id, source: "turn", at: Date.now() });
  await users.markApps(["U2"]);
  await directory.replace([{ principalId: "U2", displayName: "U2", type: "internal", isBot: false }]);
  await users.link({ principalId: "kit", canonicalId: "U2", evidence: "qa", linkedBy: "", createdAt: 1 });
  const scope = "channel:C1";
  const gates = { shipActions: ["send_email", "post_slack"].map((action) => ({ action, gate: "auto" as const })) };
  const held = gates.shipActions.map((p) => ({ ...p, gate: "hold" }));
  const base = { owner: "U1", createdBy: "U1", ownerScopeId: scope, playbook: "p", successCondition: "done" };
  const make = async (name: string, more = {}) => (await loops.store.create({ ...base, name, ...more })).loop;
  const [k, p] = [
    await make("k", { owner: "kit", createdBy: "kit", ...gates }),
    await make("p", { botActor: true, ...gates }),
  ];
  await loops.grants.put({
    id: "gk",
    loopId: k.id,
    shipAction: "send_email",
    actorId: "kit",
    policyVersion: 1,
    createdAt: Date.now(),
  });
  const pg = createPgPool(url);
  await pg.q("DELETE FROM qm_schema_migrations WHERE id = 'migrations/0001-mark-earlier-links'");
  await migrateDatabase(url);
  const [lk, lp] = await Promise.all([k, p].map((loop) => loops.store.get(loop.id)));
  assert.deepEqual(
    [lk?.botActor, lk?.shipActions, lp?.shipActions, (await loops.grants.get("gk"))?.revokedBy],
    [true, held, gates.shipActions, "system:migration"],
  );
  await pg.close();
});
