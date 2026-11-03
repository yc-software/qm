import { test } from "node:test";
import assert from "node:assert/strict";
import { withTenant } from "../src/tenants/context.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";
import { inTestTenant, testTenants } from "./support/test-tenants.ts";

test("the outbox sweep claims pending swarms across tenants and delivers each under its own tenant", async () => {
  const [, other] = testTenants();
  const a = await inTestTenant(() => swarmFixture());
  const b = await withTenant(other, () =>
    swarmFixture({ url: a.url, store: a.store, sessions: a.sessions, runs: a.runs }),
  );
  const [workerA] = await inTestTenant(() => a.service.spawn(a.caller, { requestId: "a", text: "Work" }));
  const [workerB] = await withTenant(other, () => b.service.spawn(b.caller, { requestId: "b", text: "Work" }));
  await a.service.sweep();
  const swarmA = await inTestTenant(() => a.store.get(a.root.id));
  const swarmB = await withTenant(other, () => a.store.get(b.root.id));
  assert.equal(swarmA!.messages[0]!.notifications[workerA!.id]!.state, "queued");
  assert.equal(swarmB!.messages[0]!.notifications[workerB!.id]!.state, "queued");
  assert.equal(await inTestTenant(() => a.store.get(b.root.id)), null);
});
