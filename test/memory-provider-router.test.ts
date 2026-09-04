import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import type { MemoryCaptureContext, MemoryRecallContext, MemoryService } from "../src/memory/memory-service.ts";

function provider(name: string, calls: string[]): MemoryService {
  return {
    async recall(scope, context?: MemoryRecallContext) {
      calls.push(`${name}:recall:${scope}:${context?.query ?? ""}`);
      return `${name} memory`;
    },
    async capture(scope, facts, _at, _author, context?: MemoryCaptureContext) {
      calls.push(`${name}:capture:${scope}:${context?.mode ?? "explicit"}:${facts.join(",")}`);
      return facts.length;
    },
    async query() {
      return [];
    },
    async read() {
      return `${name} notebook`;
    },
    async replace() {},
  };
}

test("routes recall and capture independently by scope and policy", async () => {
  const calls: string[] = [];
  const memory = createRoutedMemoryService({
    providers: { notebook: provider("notebook", calls), brain: provider("brain", calls) },
    routes: [
      { provider: "notebook", scopes: ["personal", "channel", "group"], capture: "automatic" },
      { provider: "brain", scopes: ["org"], capture: "explicit", manage: false },
    ],
  });
  assert.equal(await memory.recall("personal:u1", { query: "launch" }), "notebook memory");
  assert.equal(await memory.recall("org:acme", { query: "launch" }), "brain memory");
  assert.equal(await memory.capture("personal:u1", ["prefers terse replies"], 1, "u1", { mode: "automatic" }), 1);
  assert.equal(await memory.capture("org:acme", ["runbook"], 1, "u1", { mode: "automatic" }), 0);
  assert.equal(await memory.capture("org:acme", ["runbook"], 1, "u1", { mode: "explicit" }), 1);
  assert.deepEqual(calls, [
    "notebook:recall:personal:u1:launch",
    "brain:recall:org:acme:launch",
    "notebook:capture:personal:u1:automatic:prefers terse replies",
    "brain:capture:org:acme:explicit:runbook",
  ]);
});

test("multiple recall providers compose without duplicating query hits", async () => {
  const calls: string[] = [];
  const memory = createRoutedMemoryService({
    providers: { notebook: provider("notebook", calls), brain: provider("brain", calls) },
    routes: [
      { provider: "notebook", scopes: ["org"], capture: "off", label: "Notebook" },
      { provider: "brain", scopes: ["org"], capture: "off", label: "Org brain", manage: false },
    ],
  });
  assert.equal(await memory.recall("org:acme"), "### Notebook\nnotebook memory\n\n### Org brain\nbrain memory");
});

test("external recall failures degrade to the remaining provider", async () => {
  const errors: string[] = [];
  const calls: string[] = [];
  const broken = provider("broken", calls);
  broken.recall = async () => {
    throw new Error("offline");
  };
  const memory = createRoutedMemoryService({
    providers: { notebook: provider("notebook", calls), broken },
    routes: [
      { provider: "notebook", scopes: ["org"], capture: "off" },
      { provider: "broken", scopes: ["org"], capture: "off", manage: false, failOpen: true },
    ],
    onError: (error, providerId, operation) => errors.push(`${providerId}:${operation}:${String(error)}`),
  });
  assert.equal(await memory.recall("org:acme", { query: "launch" }), "notebook memory");
  assert.match(errors[0]!, /^broken:recall:Error: offline$/);
});

test("external capture failures degrade to the remaining provider", async () => {
  const errors: string[] = [];
  const calls: string[] = [];
  const broken = provider("broken", calls);
  broken.capture = async () => {
    throw new Error("consent denied");
  };
  const strict = provider("strict", calls);
  strict.capture = async () => {
    throw new Error("offline");
  };
  const memory = createRoutedMemoryService({
    providers: { notebook: provider("notebook", calls), broken, strict },
    routes: [
      { provider: "notebook", scopes: ["org"], capture: "automatic" },
      { provider: "broken", scopes: ["org"], capture: "automatic", manage: false, failOpen: true },
    ],
    onError: (error, providerId, operation) => errors.push(`${providerId}:${operation}:${String(error)}`),
  });
  const stored = await memory.capture("org:acme", ["fact"], 1, "U1", { mode: "automatic" });
  assert.ok(stored >= 0);
  assert.ok(
    calls.some((c) => c.startsWith("notebook:capture")),
    `notebook still wrote: ${calls.join(",")}`,
  );
  assert.match(errors[0]!, /^broken:capture:Error: consent denied$/);

  const strictMemory = createRoutedMemoryService({
    providers: { notebook: provider("notebook", calls), strict },
    routes: [
      { provider: "notebook", scopes: ["org"], capture: "automatic" },
      { provider: "strict", scopes: ["org"], capture: "automatic", manage: false, failOpen: false },
    ],
  });
  await assert.rejects(strictMemory.capture("org:acme", ["fact"], 1, "U1", { mode: "automatic" }), /offline/);
});
