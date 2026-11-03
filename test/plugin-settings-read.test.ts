import assert from "node:assert/strict";
import test from "node:test";
import { corePluginSettings } from "../plugins/chassis/src/plugin-settings.ts";

test("an unreachable core is remembered briefly, so sign-ins do not each wait on it", async (t) => {
  let clock = 1_000;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) throw new Error("core is down");
    return new Response(JSON.stringify({ values: { OIDC_ISSUER: "https://issuer.example" } }));
  });
  const read = corePluginSettings("http://core.test", "secret".repeat(6), 30_000, () => clock);
  await assert.rejects(read(), /core is down/);
  clock += 1_000;
  await assert.rejects(read(), /core is down/);
  assert.equal(calls, 1);
  clock += 1_500;
  assert.deepEqual(await read(), { OIDC_ISSUER: "https://issuer.example" });
  assert.equal(calls, 2);
});

test("a read core refuses is retried on the next sign-in", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return calls === 1 ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ values: { A: "b" } }));
  });
  const read = corePluginSettings("http://core.test", "secret".repeat(6), 30_000, () => 1_000);
  await assert.rejects(read(), /HTTP 503/);
  assert.deepEqual(await read(), { A: "b" });
});
