import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService, MEMORY_FILE } from "../src/memory/memory-service.ts";
import { createMemoryStrategy, parseMemoryStrategyKind } from "../src/memory/strategy.ts";
import {
  AUTONOMOUS_EXTRACTION_ADDENDUM,
  createPerTurnStrategy,
  MEMORY_EXTRACTION_PROMPT,
  parseFacts,
} from "../src/memory/strategies/per-turn.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import type { HarnessModelUtilities } from "../src/harness/harness.ts";

const SCOPE = "user:U1";

function freshMemory() {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "mst-")));
  return { workspace, memory: createMemoryService(workspace) };
}

test("per-turn via oneShot sends the extraction prompt + the exact user/reply framing the old extractor sent", async () => {
  const calls: Array<{ system: string; prompt: string }> = [];
  const harness: HarnessModelUtilities = {
    oneShot(system, prompt) {
      calls.push({ system, prompt });
      return Promise.resolve("- Prefers terse replies\n* Working on the Q3 launch\nnot a bullet");
    },
  };
  const { workspace, memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness, memory });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.system, MEMORY_EXTRACTION_PROMPT);
  assert.equal(calls[0]!.prompt, "User said:\nhi\n\nAssistant replied:\nhello");
  const body = (await workspace.read(SCOPE, MEMORY_FILE)) ?? "";
  assert.match(body, /Prefers terse replies/);
  assert.match(body, /Working on the Q3 launch/);
  assert.doesNotMatch(body, /not a bullet/);
});

test("a system-actor turn extracts with the autonomous addendum; a human turn does not", async () => {
  const systems: string[] = [];
  const harness: HarnessModelUtilities = {
    oneShot(system) {
      systems.push(system);
      return Promise.resolve("NONE");
    },
  };
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness, memory });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "trigger", reply: "queued", actorId: "system:ambient:acme" });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "[cron wake]", reply: "done", actorId: "U1", autonomous: true });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello", actorId: "U1" });

  assert.equal(systems.length, 3);
  assert.equal(systems[0], `${MEMORY_EXTRACTION_PROMPT}\n\n${AUTONOMOUS_EXTRACTION_ADDENDUM}`);
  assert.equal(systems[1], `${MEMORY_EXTRACTION_PROMPT}\n\n${AUTONOMOUS_EXTRACTION_ADDENDUM}`);
  assert.equal(systems[2], MEMORY_EXTRACTION_PROMPT);
});

test("parseFacts: bullets in, NONE/empty/prose out", () => {
  assert.deepEqual(parseFacts("- a\n* b\n  - c \nplain"), ["a", "b", "c"]);
  assert.deepEqual(parseFacts("NONE"), []);
  assert.deepEqual(parseFacts("none"), []);
  assert.deepEqual(parseFacts(""), []);
  assert.deepEqual(parseFacts("-"), []);
});

test("per-turn swallows extraction failures and captures nothing", async () => {
  const harness: HarnessModelUtilities = {
    oneShot: () => Promise.reject(new Error("model down")),
  };
  const { workspace, memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness, memory });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello" });
  assert.equal(await workspace.read(SCOPE, MEMORY_FILE), null, "nothing captured");
});

test("per-turn does not capture when the model says NONE", async () => {
  const harness: HarnessModelUtilities = {
    oneShot: () => Promise.resolve("NONE"),
  };
  const { workspace, memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness, memory });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello" });
  assert.equal(await workspace.read(SCOPE, MEMORY_FILE), null);
});

test("MEMORY_STRATEGY parsing: per-turn is the default, agent-only disables post-turn extraction", () => {
  assert.equal(parseMemoryStrategyKind(undefined), "per-turn");
  assert.equal(parseMemoryStrategyKind("per-turn"), "per-turn");
  assert.equal(parseMemoryStrategyKind("bogus"), "per-turn");
  assert.equal(parseMemoryStrategyKind("agent-only"), "agent-only");

  const { workspace, memory } = freshMemory();
  const harness = createMockHarness().models;
  assert.equal(createMemoryStrategy("agent-only", { harness, memory, workspace }).strategy.onTurnEnd, undefined);
  assert.ok(createMemoryStrategy("per-turn", { harness, memory, workspace }).strategy.onTurnEnd);
});

test("debounced: autonomous and live turns from the same actor flush as separate bursts with different prompts", async () => {
  const systems: string[] = [];
  const harness: HarnessModelUtilities = {
    oneShot(system) {
      systems.push(system);
      return Promise.resolve("NONE");
    },
  };
  const { memory } = freshMemory();
  const strategy = createPerTurnStrategy({ harness, memory, captureQuietMs: 30, captureMaxTurns: 10 });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "[cron wake]", reply: "done", actorId: "U1", autonomous: true });
  await strategy.onTurnEnd!({ scopeId: SCOPE, input: "hi", reply: "hello", actorId: "U1" });
  await new Promise((r) => setTimeout(r, 120));

  assert.deepEqual(
    systems.sort(),
    [MEMORY_EXTRACTION_PROMPT, `${MEMORY_EXTRACTION_PROMPT}\n\n${AUTONOMOUS_EXTRACTION_ADDENDUM}`].sort(),
    "two flushes, one per burst, each under its own rules",
  );
});
