import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import * as bridge from "../src/core-bridge.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

for (const change of [{ inherit: true }, { keep: true }, { harnessId: "pi", modelId: "new-model" }]) {
  test(`runtime saves notify all subscribers with the server's canonical scope: ${JSON.stringify(change)}`, async () => {
    const config = { scopeId: "personal:reader@example.com", upgradeAvailable: false } as bridge.RuntimeConfig;
    const first: bridge.RuntimeConfig[] = [];
    const second: bridge.RuntimeConfig[] = [];
    const unsubscribeFirst = bridge.onRuntimeConfigChanged((c) => first.push(c));
    const unsubscribeSecond = bridge.onRuntimeConfigChanged((c) => second.push(c));
    globalThis.fetch = async () => Response.json(config);
    try {
      assert.deepEqual(await bridge.updateRuntimeConfig(null, change), config);
      assert.deepEqual(first, [config]);
      assert.deepEqual(second, [config]);
      unsubscribeSecond();
      await bridge.updateRuntimeConfig(null, change);
      assert.equal(first.length, 2);
      assert.equal(second.length, 1, "disposed panes no longer receive updates");
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
  });
}

test("failed saves leave every pane's prompt alone", async () => {
  const updates: bridge.RuntimeConfig[] = [];
  const unsubscribe = bridge.onRuntimeConfigChanged((c) => updates.push(c));
  globalThis.fetch = async () => Response.json({ error: "save failed" }, { status: 500 });
  try {
    await assert.rejects(bridge.updateRuntimeConfig(null, { inherit: true }));
    assert.deepEqual(updates, []);
  } finally {
    unsubscribe();
  }
});

test("composer sync is scope-filtered, invalidates older reads, and unsubscribes on disposal", () => {
  const source = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
  const start = source.indexOf("const unsubscribeRuntime = onRuntimeConfigChanged");
  assert.ok(start >= 0, "every composer must subscribe to runtime saves");
  const handler = source.slice(start, source.indexOf("\n  });", start));
  assert.match(handler, /if \(config\.scopeId !== scopeKey\(\)\) return;/);
  assert.match(handler, /\+\+runtimeRequest;/);
  assert.match(handler, /seededRuntime = null;/);
  assert.match(handler, /applySelectedRuntime\(config, ctx\.chat\.state\.agent \?\? undefined\);/);
  assert.match(source.slice(source.indexOf("function dispose()")), /unsubscribeRuntime\(\);/);
});
