import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import type {
  MemoryAuthority,
  MemoryCaptureContext,
  MemoryRecallContext,
  MemoryService,
} from "../src/memory/memory-service.ts";
import { recallText } from "./support/recall-text.ts";

function provider(name: string, calls: string[]): MemoryService {
  return {
    async recall(scope, context?: MemoryRecallContext) {
      calls.push(`${name}:recall:${scope}:${context?.query ?? ""}`);
      return [{ text: `${name} memory` }];
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
  };
}

test("routes recall and capture independently by scope and policy", async () => {
  const calls: string[] = [];
  const memory = createRoutedMemoryService({
    providers: { notebook: provider("notebook", calls), knowledge: provider("knowledge", calls) },
    routes: [
      { provider: "notebook", scopes: ["personal", "channel", "group"], capture: "automatic" },
      { provider: "knowledge", scopes: ["org"], capture: "explicit", manage: false },
    ],
  });
  assert.equal(recallText(await memory.recall("personal:u1", { query: "launch" })), "notebook memory");
  assert.equal(recallText(await memory.recall("org:acme", { query: "launch" })), "knowledge memory");
  assert.equal(
    await memory.capture(
      "personal:u1",
      ["prefers terse replies"],
      1,
      { actorId: "u1", context: "conversation" },
      { mode: "automatic" },
    ),
    1,
  );
  assert.equal(
    await memory.capture("org:acme", ["runbook"], 1, { actorId: "u1", context: "conversation" }, { mode: "automatic" }),
    0,
  );
  assert.equal(
    await memory.capture("org:acme", ["runbook"], 1, { actorId: "u1", context: "conversation" }, { mode: "explicit" }),
    1,
  );
  assert.deepEqual(calls, [
    "notebook:recall:personal:u1:launch",
    "knowledge:recall:org:acme:launch",
    "notebook:capture:personal:u1:automatic:prefers terse replies",
    "knowledge:capture:org:acme:explicit:runbook",
  ]);
});

test("multiple recall providers compose without duplicating query hits", async () => {
  const calls: string[] = [];
  const memory = createRoutedMemoryService({
    providers: { notebook: provider("notebook", calls), knowledge: provider("knowledge", calls) },
    routes: [
      { provider: "notebook", scopes: ["org"], capture: "off", label: "Notebook" },
      { provider: "knowledge", scopes: ["org"], capture: "off", label: "Org knowledge", manage: false },
    ],
  });
  assert.deepEqual(
    (await memory.recall("org:acme")).map((row) => [row.text, row.source?.label]),
    [
      ["notebook memory", "Notebook"],
      ["knowledge memory", "Org knowledge"],
    ],
  );
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
  assert.equal(recallText(await memory.recall("org:acme", { query: "launch" })), "notebook memory");
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
  const stored = await memory.capture(
    "org:acme",
    ["fact"],
    1,
    { actorId: "U1", context: "conversation" },
    { mode: "automatic" },
  );
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
  await assert.rejects(
    strictMemory.capture("org:acme", ["fact"], 1, { actorId: "U1", context: "conversation" }, { mode: "automatic" }),
    /offline/,
  );
});

test("cross-origin capture only reaches providers that preserve structured provenance", async () => {
  const calls: string[] = [];
  const notebook = provider("notebook", calls);
  notebook.facts = async () => [];
  const memory = createRoutedMemoryService({
    providers: { notebook, opaque: provider("opaque", calls) },
    routes: [
      { provider: "notebook", scopes: ["personal"], capture: "automatic" },
      { provider: "opaque", scopes: ["personal"], capture: "automatic", manage: false },
    ],
  });
  assert.equal(
    await memory.capture(
      "personal:alice",
      ["Synthetic fact"],
      1,
      { actorId: "alice", context: "conversation" },
      {
        mode: "automatic",
        conversationScopeId: "group:private",
        inheritedFacts: [],
        sensitivity: "sensitive",
      },
    ),
    1,
  );
  assert.deepEqual(calls, ["notebook:capture:personal:alice:automatic:Synthetic fact"]);
  calls.length = 0;
  await memory.capture(
    "personal:alice",
    ["Native fact"],
    1,
    { actorId: "alice", context: "conversation" },
    {
      mode: "explicit",
      conversationScopeId: "personal:alice",
    },
  );
  assert.equal(calls.length, 2);
});

test("only a conversation's capture reaches a provider that isn't a notebook", async () => {
  const calls: string[] = [];
  const notebook = provider("notebook", calls);
  notebook.facts = async () => [];
  const memory = createRoutedMemoryService({
    providers: { notebook, brain: provider("brain", calls) },
    routes: [
      { provider: "notebook", scopes: ["personal"], capture: "automatic" },
      { provider: "brain", scopes: ["personal"], capture: "explicit", manage: false },
    ],
  });
  const authorities: Array<MemoryAuthority | undefined> = [
    undefined,
    { actorId: "", context: "conversation" },
    { actorId: "alice", context: "self" },
    { actorId: "admin-bob", context: "admin" },
    { actorId: "system:personal:alice", context: "maintenance" },
  ];
  for (const by of authorities) {
    calls.length = 0;
    assert.equal(await memory.capture("personal:alice", ["Prefers tea"], 1, by, { mode: "explicit" }), 1);
    assert.deepEqual(calls, ["notebook:capture:personal:alice:explicit:Prefers tea"], JSON.stringify(by));
  }
  calls.length = 0;
  await memory.capture(
    "personal:alice",
    ["Prefers tea"],
    1,
    { actorId: "alice", context: "conversation" },
    {
      mode: "explicit",
    },
  );
  assert.deepEqual(calls, [
    "notebook:capture:personal:alice:explicit:Prefers tea",
    "brain:capture:personal:alice:explicit:Prefers tea",
  ]);
});

test("fact edits route to the managing provider and fail loudly when it can't edit", async () => {
  const calls: string[] = [];
  const notebook = provider("notebook", calls);
  notebook.edit = async (scope, edits) => void calls.push(`edit:${scope}:${edits.map((e) => e.id).join()}`);
  const memory = createRoutedMemoryService({
    providers: { notebook, opaque: provider("opaque", calls) },
    routes: [
      { provider: "notebook", scopes: ["personal"] },
      { provider: "opaque", scopes: ["org"] },
    ],
  });
  await memory.edit!("personal:u1", [{ id: "1", text: "x" }]);
  assert.deepEqual(calls, ["edit:personal:u1:1"]);
  await assert.rejects(memory.edit!("org:acme", [{ id: "1", text: "x" }]), /not directly editable/);
});
