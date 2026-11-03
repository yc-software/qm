import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { scopeId } from "../src/types.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { testTenants } from "./support/test-tenants.ts";

test("a session's tenant resolves from its row, for each tenant, and not for unknown sessions", async () => {
  const store = createPostgresSessionStore(testMigratedDatabaseUrl());
  const [a, b] = testTenants();
  const create = (tenant: string) =>
    withTenant(tenant, () => store.getOrCreateByThread(`lookup-${randomUUID()}`, "dm", scopeId("personal", "u")));
  const inA = await create(a);
  const inB = await create(b);
  assert.equal(await store.tenantOfSession(inA.id), a);
  assert.equal(await store.tenantOfSession(inB.id), b);
  assert.equal(await store.tenantOfSession(randomUUID()), undefined);
});
