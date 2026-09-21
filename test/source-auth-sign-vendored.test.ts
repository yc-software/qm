import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/auth/source-auth-sign.ts";
import * as chassis from "../plugins/chassis/src/source-auth-sign.ts";
import { createTenantContext, runWithTenant } from "../src/tenancy/context.ts";

test("core uses the shared chassis canonical payload and HMAC implementation", () => {
  assert.equal(core.canonicalPayload, chassis.canonicalPayload);
  assert.equal(core.signRequest, chassis.signRequest);
});

test("dedicated core and chassis signers produce the same legacy protocol", () => {
  const context = createTenantContext({ id: "dedicated", env: {} });
  for (const secret of [undefined, "signing-secret"]) {
    const args = [
      secret,
      "POST",
      "/v1/turns?x=1",
      '{"text":"hello"}',
      { "content-type": "application/json" },
      1000,
    ] as const;
    const expected = chassis.signedRequestHeaders(...args);
    assert.deepEqual(core.signedRequestHeaders(...args), expected);
    assert.deepEqual(
      runWithTenant(context, () => core.signedRequestHeaders(...args)),
      expected,
    );
  }
});

test("pooled core and chassis signers bind identical requests to the same tenant protocol", async () => {
  const signatures = await Promise.all(
    ["alpha", "beta"].map(async (id) => {
      const context = createTenantContext({ id, env: {}, pooled: true });
      return runWithTenant(context, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (const secret of [undefined, "shared-signing-secret"]) {
          const args = [secret, "POST", "/v1/turns?x=1", '{"text":"hello"}', { "x-qm-tenant": "stale" }, 1000] as const;
          const actual = core.signedRequestHeaders(...args);
          assert.deepEqual(actual, chassis.signedRequestHeaders(...args, id));
          assert.equal(actual["x-qm-tenant"], id);
        }
        return core.signedRequestHeaders("shared-signing-secret", "GET", "/v1/deliveries", "", {}, 1000)["x-signature"];
      });
    }),
  );
  assert.ok(signatures.every(Boolean));
  assert.notEqual(signatures[0], signatures[1]);
});
