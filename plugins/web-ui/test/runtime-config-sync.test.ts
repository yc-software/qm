import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  getRuntimeConfig,
  loadRuntimeConfig,
  saveRuntimeConfig,
  seedRuntimeConfig,
  subscribeRuntimeConfig,
} from "../src/runtime-config-store.ts";
import { runtimeConfig } from "./runtime-fixture.ts";
import { defaultModelValue } from "../src/model-options.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const [i, change] of [{ inherit: true }, { keep: true }, { harnessId: "pi", modelId: "new-model" }].entries()) {
  test(`successful runtime saves update one shared snapshot for every view: ${JSON.stringify(change)}`, async () => {
    const scope = `scope:save-${i}`;
    const config = runtimeConfig(scope, { upgradeAvailable: false });
    let first = 0;
    let second = 0;
    let other = 0;
    const stop = subscribeRuntimeConfig(scope, () => {
      first++;
      assert.equal(getRuntimeConfig(scope)?.upgradeAvailable, false);
    });
    const stop2 = subscribeRuntimeConfig(scope, () => {
      second++;
    });
    const stopOther = subscribeRuntimeConfig("scope:other", () => {
      other++;
    });
    globalThis.fetch = async () => Response.json(config);
    try {
      assert.deepEqual(await saveRuntimeConfig(scope, change), config);
      assert.deepEqual([first, second, other], [1, 1, 0]);
      assert.deepEqual(getRuntimeConfig(scope), config);
      stop2();
      await saveRuntimeConfig(scope, change);
      assert.deepEqual([first, second, other], [2, 1, 0]);
    } finally {
      stop();
      stop2();
      stopOther();
    }
  });
}

test("boot hydration and derived options are shared, not consumed by a pane", async () => {
  const config = runtimeConfig("scope:boot");
  seedRuntimeConfig(config.scopeId, config);
  globalThis.fetch = async () => {
    throw new Error("unexpected fetch");
  };
  assert.equal(await loadRuntimeConfig(config.scopeId), config);
  assert.equal(await loadRuntimeConfig(config.scopeId), config);
  assert.equal(defaultModelValue(config.scopeId), "pi:model");
  assert.equal(getRuntimeConfig("scope:unknown"), null);
});

test("concurrent loads share one request, and explicit refresh publishes to all views", async () => {
  const scope = "scope:load";
  const response = deferred<Response>();
  let requests = 0;
  let changes = 0;
  const stop = subscribeRuntimeConfig(scope, () => {
    changes++;
  });
  globalThis.fetch = async () => {
    requests++;
    return response.promise;
  };
  try {
    const first = loadRuntimeConfig(scope);
    const second = loadRuntimeConfig(scope);
    response.resolve(Response.json(runtimeConfig(scope)));
    assert.equal(await first, await second);
    assert.equal(requests, 1);
    assert.equal(changes, 1);
    globalThis.fetch = async () => Response.json(runtimeConfig(scope, { upgradeAvailable: false }));
    await loadRuntimeConfig(scope, true);
    assert.equal(changes, 2);
    assert.equal(getRuntimeConfig(scope)?.upgradeAvailable, false);
  } finally {
    stop();
  }
});

test("an old GET cannot restore a prompt after a successful save", async () => {
  const scope = "scope:stale";
  const response = deferred<Response>();
  globalThis.fetch = async (_input, init) =>
    init?.method === "PUT" ? Response.json(runtimeConfig(scope, { upgradeAvailable: false })) : response.promise;
  const pending = loadRuntimeConfig(scope);
  await saveRuntimeConfig(scope, { keep: true });
  response.resolve(Response.json(runtimeConfig(scope)));
  assert.equal((await pending)?.upgradeAvailable, false);
  assert.equal(getRuntimeConfig(scope)?.upgradeAvailable, false);
});

test("writes serialize per scope; reads during a save wait, and another scope is independent", async () => {
  const scope = "scope:ordering";
  const first = deferred<Response>();
  const calls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.method, "PUT", "no GET may run ahead of pending saves");
    const { scopeId, modelId } = JSON.parse(String(init.body));
    calls.push(modelId);
    if (modelId === "first") return first.promise;
    return Response.json(runtimeConfig(scopeId, { effective: { harnessId: "pi", modelId } }));
  };
  const save1 = saveRuntimeConfig(scope, { modelId: "first" });
  const save2 = saveRuntimeConfig(scope, { modelId: "second" });
  const read = loadRuntimeConfig(scope);
  await saveRuntimeConfig("scope:independent", { modelId: "other" });
  assert.deepEqual(calls, ["first", "other"]);
  first.resolve(Response.json(runtimeConfig(scope, { effective: { harnessId: "pi", modelId: "first" } })));
  await Promise.all([save1, save2]);
  assert.equal((await read)?.effective.modelId, "second");
  assert.equal(getRuntimeConfig(scope)?.effective.modelId, "second");
});

test("failed saves keep the last good snapshot and do not poison the write queue", async () => {
  const scope = "scope:failure";
  const config = runtimeConfig(scope);
  seedRuntimeConfig(scope, config);
  let calls = 0;
  let changes = 0;
  const stop = subscribeRuntimeConfig(scope, () => {
    changes++;
  });
  globalThis.fetch = async () =>
    ++calls === 1
      ? Response.json({ error: "save failed" }, { status: 500 })
      : Response.json(runtimeConfig(scope, { upgradeAvailable: false }));
  try {
    await assert.rejects(saveRuntimeConfig(scope, { inherit: true }), /save failed/);
    assert.equal(getRuntimeConfig(scope), config);
    assert.equal(changes, 0);
    await saveRuntimeConfig(scope, { keep: true });
    assert.equal(changes, 1);
  } finally {
    stop();
  }
});

test("bad scope responses never update or notify the requested scope", async () => {
  globalThis.fetch = async () => Response.json(runtimeConfig("scope:wrong"));
  await assert.rejects(loadRuntimeConfig("scope:expected"), /scope mismatch/);
  assert.equal(getRuntimeConfig("scope:expected"), null);
});

test("cached configuration is revalidated when returning to a view after the freshness window", async () => {
  const scope = "scope:revalidate";
  seedRuntimeConfig(scope, runtimeConfig(scope));
  const now = Date.now;
  Date.now = () => now() + 60_000;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(runtimeConfig(scope, { upgradeAvailable: false }));
  };
  try {
    assert.equal((await loadRuntimeConfig(scope))?.upgradeAvailable, false);
    assert.equal(calls, 1);
  } finally {
    Date.now = now;
  }
});
