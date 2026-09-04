import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createBrowserSessionStore, type StoredBrowserSession } from "../src/connectors/browser-session-store.ts";

const KEY = deriveConnectorKey(Buffer.alloc(32, 7));
const STATE = JSON.stringify({ cookies: [{ name: "sid", value: "abc", domain: ".doordash.com" }] });

function build(key = KEY) {
  const map = createMemoryMap<StoredBrowserSession>();
  return { store: createBrowserSessionStore({ sessions: map, key }), map };
}

test("round-trips a principal's storage_state", async () => {
  const { store } = build();
  assert.equal(await store.get("U1"), null);
  await store.put("U1", STATE);
  assert.equal(await store.get("U1"), STATE);
});

test("the blob is encrypted at rest (plaintext never stored)", async () => {
  const { store, map } = build();
  await store.put("U1", STATE);
  const rec = await map.get("U1");
  assert.ok(rec);
  assert.doesNotMatch(rec!.stateEnc, /doordash|cookies|sid/);
});

test("is keyed per principal", async () => {
  const { store } = build();
  await store.put("U1", STATE);
  assert.equal(await store.get("U2"), null);
});

test("a blob that doesn't decrypt under the current key reads as absent (not a throw)", async () => {
  const { store, map } = build();
  await store.put("U1", STATE);
  const other = createBrowserSessionStore({ sessions: map, key: deriveConnectorKey(Buffer.alloc(32, 9)) });
  assert.equal(await other.get("U1"), null);
});
