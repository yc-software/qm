import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceFlowCutoverStore } from "../src/credentials/device-flow-cutover.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

test("device-flow cutover defaults every service and scope to legacy", async () => {
  const store = createDeviceFlowCutoverStore(createMemoryMap());

  assert.equal(await store.resolve(scopeId("channel", "C1"), "aws"), "legacy");
  assert.equal(await store.resolve(scopeId("personal", "U1"), "github"), "legacy");
});

test("exact-scope policy overrides the org service policy", async () => {
  const store = createDeviceFlowCutoverStore(createMemoryMap());
  const org = scopeId("org", "default-org");
  const channel = scopeId("channel", "C1");
  const other = scopeId("channel", "C2");

  await store.set(org, "AWS", "prefer_ephemeral", "admin@example.com");
  await store.set(channel, "aws", "ephemeral_only", "operator@example.com");

  assert.equal(await store.resolve(channel, "aws"), "ephemeral_only");
  assert.equal(await store.resolve(other, "aws"), "prefer_ephemeral");
  assert.equal(await store.resolve(channel, "github"), "legacy");
});

test("policies can be updated and cleared for immediate rollback", async () => {
  let now = 10;
  let reset = 0;
  const store = createDeviceFlowCutoverStore(createMemoryMap(), { now: () => now, resetId: () => `reset-${++reset}` });
  const org = scopeId("org", "default-org");
  const channel = scopeId("channel", "C1");

  await store.set(org, "aws", "prefer_ephemeral", "admin@example.com");
  await store.set(channel, "aws", "ephemeral_only", "operator@example.com");
  now = 20;
  await store.set(channel, "aws", "legacy", "rollback@example.com");

  assert.deepEqual(await store.get(channel, "aws"), {
    scopeId: channel,
    service: "aws",
    mode: "legacy",
    updatedAt: 20,
    updatedBy: "rollback@example.com",
    resetResident: true,
    resetGeneration: "reset-1",
  });
  assert.equal(await store.resolve(channel, "aws"), "legacy");
  const firstReset = await store.residentResetGeneration(channel, "aws");
  assert.ok(firstReset);
  await store.set(channel, "aws", "prefer_ephemeral", "operator@example.com");
  await store.set(channel, "aws", "legacy", "rollback@example.com");
  await store.markResidentReset(channel, "aws", firstReset);
  const newerReset = await store.residentResetGeneration(channel, "aws");
  assert.ok(newerReset, "acknowledging an older reset generation cannot consume a concurrent newer rollback");
  await store.markResidentReset(channel, "aws", newerReset);
  assert.equal(await store.residentResetGeneration(channel, "aws"), null);

  await store.clear(channel, "aws");
  assert.equal(await store.resolve(channel, "aws"), "prefer_ephemeral");

  await store.set(org, "aws", "legacy", "rollback@example.com");
  assert.equal(await store.resolve(channel, "aws"), "legacy");
  assert.ok(
    await store.residentResetGeneration(channel, "aws"),
    "an inherited org rollback has a per-scope one-shot reset",
  );

  await store.set(channel, "aws", "ephemeral_only", "operator@example.com");
  await store.clear(channel, "aws");
  assert.ok(
    await store.residentResetGeneration(channel, "aws"),
    "clearing a nonlegacy override to inherited legacy also requests reset",
  );

  await store.set(org, "aws", "prefer_ephemeral", "admin@example.com");
  await store.clear(org, "aws");
  assert.ok(
    await store.residentResetGeneration(channel, "aws"),
    "clearing an org cutover to default legacy requests a reset for every child computer",
  );
});
