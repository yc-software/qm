import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deliver,
  HOOK_SECRET,
  type Instance,
  signed,
  skip,
  startTenantInstance,
  stopTenantInstance,
} from "./support/tenant-instance.ts";

describe("a single-tenant deployment", { skip }, () => {
  let single: Instance;
  before(async () => {
    single = await startTenantInstance([]);
  });
  after(() => stopTenantInstance(single));

  it("keeps working with no hosts mapped", async () => {
    const created = await signed(
      single,
      "anything.example.test",
      "POST",
      "/v1/webhooks",
      JSON.stringify({
        ownerScopeId: "personal:U1",
        owner: "U1",
        createdBy: "U1",
        action: "triage",
        verification: { scheme: "github", secret: HOOK_SECRET },
        filters: [{ path: "action", in: ["closed"] }],
      }),
    );
    assert.equal(created.status, 200);
    const { webhook: hook } = JSON.parse(created.text);
    assert.equal((await deliver(single, "anything.example.test", hook.id)).status, 200);
    assert.equal((await deliver(single, "anything.example.test", "no-such-hook")).status, 404);
    const lookup = await signed(single, "core.internal", "GET", "/v1/operator/hosts/anything.example.test");
    const sole = (await single.owner.query("SELECT id::text FROM tenants")).rows[0].id;
    assert.deepEqual(JSON.parse(lookup.text), { tenant: sole, multi: false });
  });
});
