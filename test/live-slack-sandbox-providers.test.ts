import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSandboxExecution,
  sandboxProviders,
  sandboxProviderScenarios,
  selectSandboxProviderScenarios,
} from "./live-slack/scenarios-sandbox-providers.ts";
import type { Ctx } from "./live-slack/harness.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";

const item = (fields: NewItem, seq: number): Item => storedItem(fields, { sessionId: "s", seq, createdAt: seq });

function evidence(sandboxId = "box", stdout = "nonce\n"): Item[] {
  return [
    item({ kind: "ToolCall", tool: "execute", callId: "call", body: { sandbox_id: sandboxId } }, 1),
    item(
      {
        kind: "ToolResult",
        tool: "execute",
        callId: "call",
        isError: false,
        text: `${stdout}\n[exit 0]`,
        body: { code: 0, timedOut: false },
      },
      2,
    ),
  ];
}

type Patch = Partial<Pick<Item, "tool" | "callId" | "isError" | "text">> & Record<string, unknown>;

function patched(result: Item, patch: Patch): Item {
  const { tool, callId, isError, text, ...body } = patch;
  return {
    ...result,
    ...(tool !== undefined ? { tool } : {}),
    ...(callId !== undefined ? { callId } : {}),
    ...(isError !== undefined ? { isError } : {}),
    ...("text" in patch ? { text: text ?? null } : {}),
    body: { ...result.body, ...body },
  };
}

test("provider execution requires correlated success on the exact sandbox", () => {
  assert.doesNotThrow(() => assertSandboxExecution(evidence(), "box", "nonce\n"));
  for (const patch of [
    { tool: "read" },
    { background: true },
    { callId: "unrelated" },
    { isError: true },
    { code: 1 },
    { timedOut: true },
    { text: "wrong\n\n[exit 0]" },
    { text: "nonce\n" },
    { text: undefined, stdout: "nonce\n" },
  ] as Patch[]) {
    const [call, result] = evidence();
    assert.throws(() => assertSandboxExecution([call!, patched(result!, patch)], "box", "nonce\n"));
  }
  assert.throws(() => assertSandboxExecution(evidence("other"), "box", "nonce\n"));
  assert.throws(() => assertSandboxExecution([item({ kind: "AgentMessage", text: "nonce" }, 1)], "box", "nonce\n"));
});

test("projected sandbox results require exact successful execution evidence", () => {
  const [call] = evidence();
  const result = item(
    { kind: "ToolResult", tool: "execute", callId: "call", isError: false, text: "nonce\n\n[exit 0]" },
    2,
  );
  const entries = [call!, result];
  assert.doesNotThrow(() => assertSandboxExecution(entries, "box", "nonce\n"));
  for (const patch of [
    { text: "nonce\n" },
    { text: "nonce\n\n[exit 1]" },
    { text: "nonce\n\n[exit 0 timed-out]" },
    { text: "wrong\n\n[exit 0]" },
    { text: "nonce\n\n[stderr]\nfailed\n[exit 0]" },
    { isError: true },
    { callId: "unrelated" },
    { code: 1 },
    { timedOut: true },
    { background: true },
  ] as Patch[]) {
    assert.throws(() => assertSandboxExecution([call!, patched(result, patch)], "box", "nonce\n"));
  }
  assert.throws(() => assertSandboxExecution(entries.toReversed(), "box", "nonce\n"));
});

test("a failed provider execution reports what the execute call returned", () => {
  const token = "eyJhbGciOiJIUzI1NiIsImtpZCI6ImsxIn0.eyJvcmdJZCI6InFhIn0.c2lnbmF0dXJlMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u";
  const [call, result] = evidence();
  const entries = [
    call!,
    patched(result!, {
      code: 1,
      text: `${"x".repeat(500)}\n[stderr]\nproxy https://x:${token}@proxy.example.com refused\nProxy-Authorization: Basic eDpzZWNyZXQ=\n[exit 1]`,
    }),
  ];
  assert.throws(
    () => assertSandboxExecution(entries, "box", "nonce\n"),
    (error: Error) =>
      error.message.includes('"code":1') &&
      error.message.includes("@proxy.example.com refused") &&
      error.message.includes("[exit 1]") &&
      !error.message.includes("x".repeat(151)) &&
      !error.message.includes("eyJvcmdJZCI6InFhIn0") &&
      !error.message.includes("c2lnbmF0dXJl") &&
      !error.message.includes("eDpzZWNyZXQ"),
  );
  assert.throws(() => assertSandboxExecution(evidence().slice(0, 1), "box", "nonce\n"), /no result recorded/);
});

test("every provider has its own parallel execution scenario", () => {
  assert.deepEqual(sandboxProviders.toSorted(), [
    "agent37",
    "aws",
    "do-managed-agents",
    "e2b",
    "local",
    "modal",
    "porter",
    "smolmachines",
    "sprites",
    "superserve",
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
      env: { qaUserId: "UQA" },
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
        waitForChannelMembership: async (channel: string, actor: string) => {
          assert.equal(channel, "test");
          assert.equal(actor, "UQA");
          assert.equal(actions.length, 0);
        },
        manageSandbox: async (_scope: string, body: Record<string, unknown>) => {
          actions.push(body);
          return { id: "box", backend: "sprites" };
        },
        findSessionByThread: async () => ({ id: "session", items: evidence("box", expected) }),
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
  assert.equal(selectSandboxProviderScenarios("all").length, 10);
  assert.deepEqual(selectSandboxProviderScenarios(undefined), []);
  for (const value of ["", "sprites,", "typo", "sprites,sprites", "all,sprites", "constructor", "__proto__"])
    assert.throws(() => selectSandboxProviderScenarios(value));
});

for (const backend of sandboxProviders) {
  test(`${backend} does not create or execute a sandbox before directory readiness`, async () => {
    const ctx = {
      env: { qaUserId: "UQA" },
      freshChannel: async () => ({ id: "test", mention: () => assert.fail("agent must not run") }),
      core: {
        withSignal() {
          return this;
        },
        listSandboxes: async () => ({ providers: [{ name: backend, actions: ["create", "retire"] }] }),
        waitForChannelMembership: async () => {
          throw new Error("directory readiness expired");
        },
        manageSandbox: () => assert.fail("sandbox must not be created"),
      },
    } as unknown as Ctx;
    await assert.rejects(
      sandboxProviderScenarios.find((s) => s.name === `sandbox-execute-${backend}`)!.run(ctx),
      /directory readiness expired/,
    );
  });
}
