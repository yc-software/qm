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
  const store = createDeviceFlowCutoverStore(createMemoryMap(), { now: () => now });
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
  });

  await store.clear(channel, "aws");
  assert.equal(await store.resolve(channel, "aws"), "prefer_ephemeral");
});

test("stored policies discover services across restart", async () => {
  const backing = createMemoryMap<import("../src/credentials/device-flow-cutover.ts").DeviceFlowCutoverPolicy>();
  const org = scopeId("org", "default-org");
  const scope = scopeId("personal", "U1");
  const first = createDeviceFlowCutoverStore(backing);
  await first.set(org, "shared-tool", "prefer_ephemeral", "admin");
  await first.set(scope, "retired-tool", "ephemeral_only", "admin");
  await first.set(scopeId("personal", "U2"), "unrelated", "ephemeral_only", "admin");
  const restarted = createDeviceFlowCutoverStore(backing);
  assert.deepEqual(await restarted.listServices(scope), ["retired-tool", "shared-tool"]);
  await restarted.clear(scope, "retired-tool");
  assert.deepEqual(await restarted.listServices(scope), ["shared-tool"]);
});
