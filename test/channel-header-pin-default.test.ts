import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { scopeId, type ScopeId } from "../src/types.ts";

const org = scopeId("org", "acme");
const channel = "channel:C123" as ScopeId;
const other = "channel:C456" as ScopeId;

async function freshStore() {
  const store = createMemoryConfigStore("acme", {});
  await store.hydrate!();
  return store;
}

test("channel header pin defaults off with no org setting", async () => {
  const store = await freshStore();
  assert.equal(store.getChannelHeaderPin(channel), false);
  assert.equal(await store.getChannelHeaderPinDurable(channel), false);
  assert.equal(await store.getChannelHeaderPinDefaultDurable(), false);
});

test("an org default of on applies to channels without an explicit choice", async () => {
  const store = await freshStore();
  await store.setChannelHeaderPin(org, true);
  assert.equal(store.getChannelHeaderPin(channel), true);
  assert.equal(await store.getChannelHeaderPinDurable(channel), true);
  assert.equal(await store.getChannelHeaderPinDefaultDurable(), true);
  assert.equal(await store.getChannelHeaderPinOverrideDurable(channel), null);
});

test("an explicit channel off beats an org default of on", async () => {
  const store = await freshStore();
  await store.setChannelHeaderPin(org, true);
  await store.setChannelHeaderPin(channel, false);
  assert.equal(store.getChannelHeaderPin(channel), false);
  assert.equal(await store.getChannelHeaderPinDurable(channel), false);
  assert.equal(await store.getChannelHeaderPinOverrideDurable(channel), false);
  // other channels still follow the default
  assert.equal(await store.getChannelHeaderPinDurable(other), true);
});

test("clearing a channel override reverts it to the org default", async () => {
  const store = await freshStore();
  await store.setChannelHeaderPin(org, true);
  await store.setChannelHeaderPin(channel, false);
  await store.setChannelHeaderPin(channel, null);
  assert.equal(await store.getChannelHeaderPinDurable(channel), true);
  assert.equal(await store.getChannelHeaderPinOverrideDurable(channel), null);
});

test("changing the org default notifies listeners with the org scope", async () => {
  const store = await freshStore();
  const seen: ScopeId[] = [];
  store.onChannelHeaderPinChanged((id) => seen.push(id));
  await store.setChannelHeaderPin(org, true);
  await store.setChannelHeaderPin(channel, true);
  assert.deepEqual(seen, [org, channel]);
});

test("explicit overrides survive a scope refresh", async () => {
  const store = await freshStore();
  await store.setChannelHeaderPin(org, true);
  await store.setChannelHeaderPin(channel, false);
  await store.refreshScope(channel);
  assert.equal(store.getChannelHeaderPin(channel), false);
  await store.setChannelHeaderPin(channel, null);
  await store.refreshScope(channel);
  assert.equal(store.getChannelHeaderPin(channel), true);
});
