import assert from "node:assert/strict";
import test from "node:test";

function fakeStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  } as Storage & { data: Map<string, string> };
}

async function load(url: string, storage: Storage): Promise<typeof import("../src/composer-variant.ts")> {
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL(url) });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  return import(`../src/composer-variant.ts?${Math.random()}`);
}

test("the composer query parameter selects a variant and persists it", async () => {
  const storage = fakeStorage();
  const mod = await load("http://localhost/s/abc?composer=kilo", storage);
  assert.equal(mod.composerVariant(), "kilo");
  assert.equal(storage.data.get("web-ui:composer-variant"), "kilo");
});

test("an unknown variant falls back to the stored one, then to the default", async () => {
  const storage = fakeStorage();
  storage.data.set("web-ui:composer-variant", "beui");
  const stored = await load("http://localhost/?composer=nope", storage);
  assert.equal(stored.composerVariant(), "beui");
  const fresh = await load("http://localhost/", fakeStorage());
  assert.equal(fresh.composerVariant(), "bui");
});

test("setting the default clears the stored preference", async () => {
  const storage = fakeStorage();
  const mod = await load("http://localhost/?composer=scira", storage);
  mod.setComposerVariant("bui");
  assert.equal(mod.composerVariant(), "bui");
  assert.equal(storage.data.has("web-ui:composer-variant"), false);
});
