import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSandboxExecution,
  sandboxProviders,
  sandboxProviderScenarios,
  selectSandboxProviderScenarios,
} from "./live-slack/scenarios-sandbox-providers.ts";
import type { Ctx } from "./live-slack/harness.ts";

function evidence(sandboxId = "box", stdout = "nonce\n"): unknown[] {
  return [
    { type: "tool_call", payload: { tool: "sandbox", action: "exec", sandbox_id: sandboxId, callId: "call" } },
    {
      type: "tool_result",
      payload: { tool: "sandbox", action: "exec", callId: "call", isError: false, code: 0, timedOut: false, stdout },
    },
  ];
}

test("provider execution requires correlated success on the exact sandbox", () => {
  assert.doesNotThrow(() => assertSandboxExecution(evidence(), "box", "nonce\n"));
  for (const patch of [
    { tool: "read" },
    { action: "start_process" },
    { callId: "unrelated" },
    { isError: true },
    { code: 1 },
    { timedOut: true },
    { stdout: "wrong\n" },
    { stdout: undefined, result: "nonce\n" },
  ]) {
    const entries = evidence() as Array<{ type: string; payload: Record<string, unknown> }>;
    Object.assign(entries[1]!.payload, patch);
    assert.throws(() => assertSandboxExecution(entries, "box", "nonce\n"));
  }
  assert.throws(() => assertSandboxExecution(evidence("other"), "box", "nonce\n"));
  assert.throws(() => assertSandboxExecution([{ type: "assistant", payload: { text: "nonce" } }], "box", "nonce\n"));
});

test("projected sandbox results require exact successful execution evidence", () => {
  const entries = evidence() as Array<{ type: string; payload: Record<string, unknown> }>;
  entries[1]!.payload = { tool: "sandbox", callId: "call", isError: false, result: "nonce\n\n[exit 0]" };
  assert.doesNotThrow(() => assertSandboxExecution(entries, "box", "nonce\n"));
  for (const patch of [
    { result: "nonce\n" },
    { result: "nonce\n\n[exit 1]" },
    { result: "nonce\n\n[exit 0 timed-out]" },
    { result: "wrong\n\n[exit 0]" },
    { result: "nonce\n\n[stderr]\nfailed\n[exit 0]" },
    { isError: true },
    { callId: "unrelated" },
    { code: 1 },
    { timedOut: true },
    { action: "start_process" },
  ]) {
    const changed = [entries[0], { ...entries[1], payload: { ...entries[1]!.payload, ...patch } }];
    assert.throws(() => assertSandboxExecution(changed, "box", "nonce\n"));
  }
  assert.throws(() => assertSandboxExecution(entries.toReversed(), "box", "nonce\n"));
});

test("every provider has its own parallel execution scenario", () => {
  assert.deepEqual(sandboxProviders.toSorted(), [
    "agent37",
    "aws",
    "e2b",
    "local",
    "modal",
    "porter",
    "smolmachines",
    "sprites",
  ]);
  assert.equal(sandboxProviderScenarios.length, sandboxProviders.length);
  assert.ok(sandboxProviderScenarios.every((s) => s.lane === "parallel" && s.tags?.includes("provider-execution")));
});

for (const backend of sandboxProviders) {
  test(`${backend} fails qualification when unavailable`, async () => {
    const ctx = {
      freshChannel: async () => ({ id: "test" }),
      core: {
        withSignal() {
          return this;
        },
        listSandboxes: async () => ({ providers: [], sandboxes: [] }),
      },
    } as unknown as Ctx;
    await assert.rejects(
      sandboxProviderScenarios.find((s) => s.name === `sandbox-execute-${backend}`)!.run(ctx),
      /required sandbox provider .* is unavailable/,
    );
  });
}

for (const failExecution of [false, true]) {
  test(`provider execution cleans up its sandbox after ${failExecution ? "failure" : "success"}`, async () => {
    const actions: Record<string, unknown>[] = [];
    let expected = "";
    const ctx = {
      marker: () => "owned-test-box",
      freshChannel: async () => ({
        id: "test",
        mention: async (text: string) => {
          const parts = [...text.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]);
          assert.equal(parts.length, 2);
          expected = parts.join("") + "\n";
          return "root";
        },
        waitForBotReply: async () => {
          if (failExecution) throw new Error("agent could not execute");
          return {};
        },
      }),
      core: {
        withSignal() {
          return this;
        },
        listSandboxes: async () => ({
          providers: [{ name: "sprites", actions: ["create", "retire"] }],
          sandboxes: actions.some((a) => a.action === "create")
            ? [{ id: "box", backend: "sprites", name: "owned-test-box" }]
            : [],
        }),
        manageSandbox: async (_scope: string, body: Record<string, unknown>) => {
          actions.push(body);
          return { id: "box", backend: "sprites" };
        },
        findSessionByThread: async () => ({ id: "session", entries: evidence("box", expected) }),
      },
    } as unknown as Ctx;
    const run = sandboxProviderScenarios.find((s) => s.name === "sandbox-execute-sprites")!.run(ctx);
    if (failExecution) await assert.rejects(run, /agent could not execute/);
    else await run;
    assert.deepEqual(actions.slice(-2), [
      { action: "default", sandboxId: null },
      { action: "retire", sandboxId: "box" },
    ]);
  });
}

test("explicit provider selection retains strict coverage without treating deferred providers as failed skips", () => {
  const selected = selectSandboxProviderScenarios("sprites,aws,local,smolmachines,e2b,modal");
  assert.deepEqual(
    selected.map((s) => s.name),
    [
      "sandbox-execute-sprites",
      "sandbox-execute-aws",
      "sandbox-execute-local",
      "sandbox-execute-smolmachines",
      "sandbox-execute-e2b",
      "sandbox-execute-modal",
    ],
  );
  assert.equal(selectSandboxProviderScenarios("all").length, 8);
  assert.deepEqual(selectSandboxProviderScenarios(undefined), []);
  for (const value of ["", "sprites,", "typo", "sprites,sprites", "all,sprites", "constructor", "__proto__"])
    assert.throws(() => selectSandboxProviderScenarios(value));
});
