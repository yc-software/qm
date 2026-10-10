import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/wiring.ts";
import { composeMemoryPolicy } from "../src/memory/policy.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryConfigStore, type PersistedMemoryPolicy } from "../src/resolution/config-store.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const actor = { externalId: "U1" };

function channel(id: string, thread: string, text: string): TurnRequest {
  return {
    surface: "test",
    actor,
    conversation: { kind: "channel", channelRef: id, threadRef: `${id}:${thread}`, audience: [actor] },
    text,
  };
}

async function waitForMemory(app: ReturnType<typeof buildApp>["app"], request: TurnRequest, pattern: RegExp) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await app.turn({
      ...request,
      conversation: { ...request.conversation, threadRef: `${request.conversation.threadRef}:${attempt}` },
    });
    if (pattern.test(result.reply ?? "")) return result.reply ?? "";
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return "";
}

async function waitForStoredMemory(memory: ReturnType<typeof buildApp>["memory"], target: string, pattern: RegExp) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await memory.read(target);
    if (pattern.test(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return "";
}

test("memory policy composition can only restrict deployment and organization floors", () => {
  assert.deepEqual(
    composeMemoryPolicy(
      { recall: "writable", capture: "off" },
      { recall: "visible", capture: "writable" },
      { recall: "visible", capture: "writable" },
    ),
    { recall: "writable", capture: "off" },
  );
  assert.deepEqual(
    composeMemoryPolicy(
      { recall: "visible", capture: "writable" },
      { recall: "writable", capture: "writable" },
      { recall: "off", capture: "off" },
    ),
    { recall: "off", capture: "off" },
  );
});

test("scoped memory policy survives a cold store restart, follows later org restrictions, and clears to defaults", async () => {
  const policies = createMemoryMap<PersistedMemoryPolicy>();
  const defaults = { recall: "visible", capture: "writable" } as const;
  const first = createMemoryConfigStore("default-org", { memoryPolicies: policies, defaultMemoryPolicy: defaults });
  await first.setMemoryPolicy("channel:private", { recall: "off", capture: "off" });

  const restarted = createMemoryConfigStore("default-org", { memoryPolicies: policies, defaultMemoryPolicy: defaults });
  assert.deepEqual(await restarted.getMemoryPolicyDurable("channel:private"), { recall: "off", capture: "off" });
  assert.deepEqual(await restarted.getMemoryPolicyDurable("channel:neighbor"), defaults);

  await restarted.setMemoryPolicy("org:default-org", { recall: "writable", capture: "off" });
  await restarted.setMemoryPolicy("channel:private", { recall: "visible", capture: "writable" });
  assert.deepEqual(await restarted.getMemoryPolicyDurable("channel:private"), {
    recall: "writable",
    capture: "off",
  });

  await restarted.clearMemoryPolicy("channel:private");
  assert.deepEqual(await restarted.getMemoryPolicyDurable("channel:private"), {
    recall: "writable",
    capture: "off",
  });
});

test("disabled channel neither captures nor recalls while a neighboring channel keeps deployment defaults", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "memory-policy-scope-")) }));
  const blocked = scopeId("channel", "private");
  const neighbor = scopeId("channel", "neighbor");
  await built.memory.replace(blocked, "# Memory\n\n- PREEXISTING_PRIVATE_FACT");
  await built.config.setMemoryPolicy(blocked, { recall: "off", capture: "off" });

  const hidden = await built.app.turn(channel("private", "recall", "!sysprompt"));
  assert.equal(hidden.status, "ok");
  assert.doesNotMatch(hidden.reply ?? "", /PREEXISTING_PRIVATE_FACT/);

  await built.app.turn(channel("private", "capture", "remember PRIVATE_NEW_FACT for later"));
  await built.app.turn(channel("neighbor", "capture", "remember NEIGHBOR_NEW_FACT for later"));
  const neighborPrompt = await waitForMemory(
    built.app,
    channel("neighbor", "recall", "!sysprompt"),
    /NEIGHBOR_NEW_FACT/,
  );
  assert.match(neighborPrompt, /NEIGHBOR_NEW_FACT/);

  assert.doesNotMatch(await built.memory.read(blocked), /PRIVATE_NEW_FACT/);
  assert.match(await built.memory.read(blocked), /PREEXISTING_PRIVATE_FACT/);
  assert.match(await built.memory.read(neighbor), /NEIGHBOR_NEW_FACT/);
});

test("recall-off turns still capture but cannot receive channel or organization memory", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "memory-policy-axes-")) }));
  const blocked = scopeId("channel", "private");
  const organization = scopeId("org", "default-org");
  await built.memory.replace(blocked, "# Memory\n\n- PREEXISTING_CHANNEL_FACT");
  await built.memory.replace(organization, "# Memory\n\n- PREEXISTING_ORG_FACT");
  await built.config.setMemoryPolicy(blocked, { recall: "off", capture: "writable" });

  await built.app.turn(channel("private", "capture", "remember CAPTURED_WITHOUT_RECALL for later"));
  const stored = await waitForStoredMemory(built.memory, blocked, /CAPTURED_WITHOUT_RECALL/);
  const prompt = await built.app.turn(channel("private", "recall", "!sysprompt"));

  assert.doesNotMatch(prompt.reply ?? "", /PREEXISTING_CHANNEL_FACT|PREEXISTING_ORG_FACT|CAPTURED_WITHOUT_RECALL/);
  assert.match(stored, /CAPTURED_WITHOUT_RECALL/);
});
