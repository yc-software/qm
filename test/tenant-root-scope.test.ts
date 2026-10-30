import test from "node:test";
import assert from "node:assert/strict";
import { tenantRootScope, withTenant } from "../src/tenants/context.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { composioNamespaceReader } from "../src/tenants/composio-namespace.ts";
import { createProductAnalytics } from "../src/util/product-analytics.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

test("each tenant has its own root scope and an unbound caller has none", () => {
  assert.equal(
    withTenant(A, () => tenantRootScope()),
    `org:${A}`,
  );
  assert.notEqual(
    withTenant(A, () => tenantRootScope()),
    withTenant(B, () => tenantRootScope()),
  );
  assert.throws(() => tenantRootScope(), /No tenant is bound/);
});

test("organization instructions and settings stay with the tenant that wrote them", async () => {
  const config = createMemoryConfigStore();
  await withTenant(A, () => config.setSoul(tenantRootScope(), "tenant A rules", "admin"));
  await withTenant(A, () => config.setOrgAmbient(false));
  withTenant(B, () => {
    assert.match(config.getSoul(tenantRootScope()) ?? "", /helpful internal assistant/);
    assert.equal(config.getOrgAmbient(), true);
  });
  withTenant(A, () => {
    assert.equal(config.getSoul(tenantRootScope()), "tenant A rules");
    assert.equal(config.getOrgAmbient(), false);
  });
  assert.throws(() => config.getOrgAmbient(), /No tenant is bound/);
});

test("resolution uses the bound tenant's root scope, mounts no org layer, and refuses an unbound turn", async () => {
  const config = createMemoryConfigStore();
  const resolution = createResolutionService(config, createAclStore());
  const actor = { id: "alice", type: "internal" as const };
  const conversation = { kind: "dm" as const, threadRef: "t", audience: [actor] };
  const resolved = await withTenant(A, () => resolution.resolve(conversation, actor));
  assert.equal(resolved.orgScopeId, `org:${A}`);
  assert.deepEqual(
    resolved.layers.map((layer) => layer.scopeId),
    ["personal:alice"],
  );
  await assert.rejects(() => resolution.resolve(conversation, actor), /No tenant is bound/);
});

test("without a database the Composio namespace is the bound tenant", async () => {
  const namespace = composioNamespaceReader(null);
  assert.equal(await withTenant(A, () => namespace()), A);
  assert.throws(() => namespace(), /No tenant is bound/);
});

test("product analytics send nothing without a bound tenant", async () => {
  let requests = 0;
  const analytics = createProductAnalytics({ apiKey: "token" }, async () => {
    requests += 1;
    return new Response("ok");
  });
  await analytics.appPublished("person", "app", 1);
  assert.equal(requests, 0);
  await withTenant(A, () => analytics.appPublished("person", "app", 1));
  assert.equal(requests, 1);
});
