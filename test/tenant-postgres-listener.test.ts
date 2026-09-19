import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createTenantContext, currentTenant, runWithTenant } from "../src/tenancy/context.ts";
import { subscribePostgresChannel } from "../src/persistence/postgres-listener.ts";

const clients: FakeClient[] = [];
class FakeClient extends EventEmitter {
  async query() {
    return { rows: [] };
  }
  release() {}
}
class FakePool extends EventEmitter {
  async connect() {
    const client = new FakeClient();
    clients.push(client);
    return client;
  }
  async end() {}
}
mock.module("pg", { defaultExport: { Pool: FakePool } });

test("Postgres notifications enter the subscribing tenant even when emitted from another context", async () => {
  const context = createTenantContext({ id: "owner", env: {}, pooled: true });
  const foreign = createTenantContext({ id: "foreign", env: {}, pooled: true });
  const tenants: Array<string | undefined> = [];
  const ready = Promise.withResolvers<void>();
  const unsubscribe = runWithTenant(context, () =>
    subscribePostgresChannel(
      "postgres://test/listener-owner",
      "tenant_test",
      () => tenants.push(currentTenant()?.id),
      () => {
        tenants.push(currentTenant()?.id);
        ready.resolve();
      },
    ),
  );
  try {
    await ready.promise;
    runWithTenant(foreign, () => clients[0]!.emit("notification", { channel: "tenant_test", payload: "message" }));
    assert.deepEqual(tenants, ["owner", "owner"]);
    assert.equal(currentTenant(), undefined);
  } finally {
    await unsubscribe();
  }
});
