import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { boundTenant, currentTenant, isTenantId, withoutTenant, withTenant } from "../src/tenants/context.ts";

const a = randomUUID();
const b = randomUUID();

test("withoutTenant leaves work unbound and currentTenant refuses it", () => {
  withoutTenant(() => {
    assert.equal(boundTenant(), undefined);
    assert.throws(() => currentTenant(), /No tenant is bound/);
  });
});

test("withTenant binds across awaits and nests", async () => {
  await withoutTenant(() =>
    withTenant(a, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(currentTenant(), a);
      await withTenant(b, async () => {
        await Promise.resolve();
        assert.equal(currentTenant(), b);
      });
      assert.equal(currentTenant(), a);
      withoutTenant(() => assert.equal(boundTenant(), undefined));
      assert.equal(boundTenant(), a);
    }),
  );
});

test("concurrent work keeps its own tenant", async () => {
  const seen = await Promise.all(
    [a, b, a, b].map((id, index) =>
      withTenant(id, async () => {
        await new Promise((resolve) => setTimeout(resolve, 4 - index));
        return currentTenant();
      }),
    ),
  );
  assert.deepEqual(seen, [a, b, a, b]);
});

test("tenant ids must be lowercase uuids", () => {
  assert.equal(isTenantId(a), true);
  for (const id of [a.toUpperCase(), "", "tenant", `${a} `, a.replaceAll("-", "")]) {
    assert.equal(isTenantId(id), false);
    assert.throws(() => withTenant(id, () => undefined), /lowercase uuid/);
  }
});
