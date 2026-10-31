import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { withTenant } from "../../../src/tenants/context.ts";
import { addDeliveryClient, connectedUsers, deliveryClientsOf } from "../server/delivery-clients.ts";
import { activeRuns, forgetRun, rememberRun } from "../server/active-runs.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const USER = "same@example.com";

test("delivery clients are keyed by tenant and user", () => {
  const resA = {} as ServerResponse;
  const resB = {} as ServerResponse;
  const removeA = withTenant(A, () => addDeliveryClient(USER, resA));
  withTenant(B, () => addDeliveryClient(USER, resB));
  assert.deepEqual([...deliveryClientsOf(A, USER)], [resA]);
  assert.deepEqual([...deliveryClientsOf(B, USER)], [resB]);
  assert.deepEqual([...deliveryClientsOf(undefined, USER)], []);
  removeA();
  assert.deepEqual(connectedUsers(A), []);
  assert.deepEqual([...deliveryClientsOf(B, USER)], [resB]);
  assert.throws(() => addDeliveryClient(USER, resA), /No tenant is bound/);
});

test("active runs are tracked per tenant", () => {
  withTenant(A, () => rememberRun("r1", USER, "web:t1"));
  assert.deepEqual(
    withTenant(B, () => activeRuns(USER, "web:t1")),
    [],
  );
  withTenant(B, () => forgetRun("r1"));
  assert.deepEqual(
    withTenant(A, () => activeRuns(USER, "web:t1")),
    ["r1"],
  );
  assert.throws(() => activeRuns(USER, "web:t1"), /No tenant is bound/);
});
