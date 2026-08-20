import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeMemoryPolicy, DEFAULT_MEMORY_POLICY } from "../src/memory/policy.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { scopeId } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("composeMemoryPolicy tightens per axis and never loosens", () => {
  const floor = { recall: "visible", capture: "writable" } as const;
  // A scope may tighten either axis independently.
  assert.deepEqual(composeMemoryPolicy(floor, { recall: "off", capture: "writable" }), {
    recall: "off",
    capture: "writable",
  });
  assert.deepEqual(composeMemoryPolicy(floor, { recall: "visible", capture: "off" }), {
    recall: "visible",
    capture: "off",
  });
  // An org floor of off cannot be loosened by a scope.
  assert.deepEqual(composeMemoryPolicy({ recall: "off", capture: "off" }, { recall: "visible", capture: "writable" }), {
    recall: "off",
    capture: "off",
  });
  // Recall ranks: off < writable < visible.
  assert.deepEqual(composeMemoryPolicy(floor, { recall: "writable", capture: "writable" }), {
    recall: "writable",
    capture: "writable",
  });
  assert.deepEqual(composeMemoryPolicy({ recall: "writable", capture: "writable" }, floor), {
    recall: "writable",
    capture: "writable",
  });
  // No scope value → the floor unchanged.
  assert.deepEqual(composeMemoryPolicy(floor), { ...floor });
});

test("the config store resolves memory policy per scope with the org floor as fallback", async () => {
  const store = createMemoryConfigStore("default-org", {
    defaultMemoryPolicy: { recall: "visible", capture: "writable" },
  });
  const org = scopeId("org", "default-org");
  const channel = scopeId("channel", "C1");

  // Nothing stored → the deployment default everywhere.
  assert.deepEqual(await store.getMemoryPolicyDurable(org), DEFAULT_MEMORY_POLICY);
  assert.deepEqual(await store.getMemoryPolicyDurable(channel), DEFAULT_MEMORY_POLICY);

  // Org floor: capture off deployment-wide via the org scope.
  await store.setMemoryPolicy(org, { recall: "visible", capture: "off" });
  assert.deepEqual(await store.getMemoryPolicyDurable(org), { recall: "visible", capture: "off" });

  // A channel cannot loosen the org floor…
  await store.setMemoryPolicy(channel, { recall: "visible", capture: "writable" });
  assert.deepEqual(await store.getMemoryPolicyDurable(channel), { recall: "visible", capture: "off" });

  // …but may tighten recall independently.
  await store.setMemoryPolicy(channel, { recall: "off", capture: "writable" });
  assert.deepEqual(await store.getMemoryPolicyDurable(channel), { recall: "off", capture: "off" });

  // Clearing the scope override returns it to the floor.
  store.clearMemoryPolicy(channel);
  assert.deepEqual(await store.getMemoryPolicyDurable(channel), { recall: "visible", capture: "off" });
});

test("memory capture can be disabled for one channel while others keep capturing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-mem-scope-"));
  const built = buildApp(testConfig({ dataDir }));
  const app = built.app;
  const configStore = built.config;

  // The issue's exact case: one channel must not be remembered from (#559).
  await configStore.setMemoryPolicy(scopeId("channel", "C1"), {
    recall: "visible",
    capture: "off",
  });

  const actor = { externalId: "U1" };
  const channel = (text: string, thread: string, channelRef: string) => ({
    surface: "test",
    actor,
    conversation: { kind: "channel", threadRef: `${channelRef}:${thread}`, channelRef, audience: [actor] },
    text,
  });

  await app.turn(channel("remember that I own the billing service", "t1", "C1"));
  const c1 = await app.turn(channel("!sysprompt", "t2", "C1"));
  assert.equal(c1.status, "ok");
  assert.doesNotMatch(c1.reply ?? "", /billing service/, "a capture-off channel must not recall facts from it");

  // A second channel keeps the default policy and DOES capture.
  await app.turn(channel("remember that the deploy env is called prod-west", "t1", "C2"));
  const c2 = await app.turn(channel("!sysprompt", "t2", "C2"));
  assert.equal(c2.status, "ok");
  assert.match(c2.reply ?? "", /prod-west/, "an untouched channel keeps the default capture behavior");
});
