import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { scopeId } from "../src/types.ts";

const rec = (at: number) => ({
  at,
  scopeLabel: scopeId("org", "default-org"),
  model: "m",
  inputTokens: 1,
  entryCount: 1,
});

test("model gateway audit is bounded: oldest records drop past the cap, newest are kept", () => {
  const gw = createModelGateway({ maxRecords: 3 });
  for (let i = 1; i <= 5; i++) gw.recordCall(rec(i));
  assert.deepEqual(
    gw.audit().map((r) => r.at),
    [3, 4, 5],
  );
});

test("model gateway audit returns a snapshot, not the live buffer", () => {
  const gw = createModelGateway({ maxRecords: 3 });
  gw.recordCall(rec(1));
  const snapshot = gw.audit();
  gw.recordCall(rec(2));
  assert.equal(snapshot.length, 1);
  assert.deepEqual(
    gw.audit().map((r) => r.at),
    [1, 2],
  );
});
