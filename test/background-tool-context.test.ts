import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext, type ToolContextDeps, CommandDenied, NeedsApproval } from "../src/tools/primitives.ts";
import { scopeId, type WorkspaceLayer } from "../src/types.ts";
import type { CommandPolicy } from "../src/types.ts";
import type { ToolLedger } from "../src/runs/tool-ledger.ts";
import type { SandboxHandle, Sandbox } from "../src/sandbox/sandbox.ts";
import type { BackgroundExecBroker, BackgroundPollResult } from "../src/connectors/background-exec-broker.ts";

const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };

function recordingBroker() {
  const calls = { start: 0, poll: 0, write: 0, stop: 0, list: 0 };
  let pollState: "running" | "exited" = "running";
  const broker: BackgroundExecBroker = {
    async start(_h, _command) {
      calls.start += 1;
      return { processId: "p-1", output: "started", cursor: 6, status: { state: "running" }, reattached: false };
    },
    async poll(_h, processId) {
      calls.poll += 1;
      return {
        processId,
        chunks: pollState === "exited" ? "final" : "partial",
        cursor: 10,
        status: pollState === "exited" ? { state: "exited", code: 0 } : { state: "running" },
      } satisfies BackgroundPollResult;
    },
    async write(_h, processId, data) {
      calls.write += 1;
      return { processId, bytes: data.length, status: { state: "running" } };
    },
    async stop(_h, processId) {
      calls.stop += 1;
      return { processId, status: { state: "exited", code: 0 }, stopped: true };
    },
    async list() {
      calls.list += 1;
      return [];
    },
  };
  return { broker, calls, setPollState: (s: "running" | "exited") => void (pollState = s) };
}

function memoryLedger() {
  const store = new Map<string, string>();
  const ledger: ToolLedger = {
    async begin(runId, attempt, callIndex) {
      const key = `${runId}:${attempt}:${callIndex}`;
      return store.has(key) ? { cached: true, output: store.get(key)! } : { cached: false };
    },
    async record(runId, attempt, callIndex, output) {
      store.set(`${runId}:${attempt}:${callIndex}`, output);
    },
  };
  return { ledger, store };
}

function ctxFor(extra: Partial<ToolContextDeps>) {
  const scope = scopeId("personal", "U1");
  const layers: WorkspaceLayer[] = [{ scopeId: scope, mountPath: "", mode: "rw" }];
  const policy: CommandPolicy = extra.commandPolicy?.() ?? { mode: "denylist", rules: [] };
  return createToolContext({
    sandbox: {} as unknown as Sandbox,
    provision: async () => handle,
    layers,
    commandPolicy: () => policy,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    ...extra,
  });
}

test("backgroundStart routes a denied command to CommandDenied BEFORE the broker (no bypass of HiLO)", async () => {
  const { broker, calls } = recordingBroker();
  const ctx = ctxFor({
    backgroundBroker: broker,
    commandPolicy: () => ({
      mode: "denylist",
      rules: [{ pattern: "rm\\s+-rf", decision: "deny", reason: "destructive" }],
    }),
  });
  await assert.rejects(ctx.backgroundStart("rm -rf /"), (e) => e instanceof CommandDenied);
  assert.equal(calls.start, 0, "the broker must not be reached for a denied command");
});

test("backgroundStart routes a require_approval command to NeedsApproval BEFORE the broker", async () => {
  const { broker, calls } = recordingBroker();
  const ctx = ctxFor({
    backgroundBroker: broker,
    commandPolicy: () => ({
      mode: "denylist",
      rules: [{ pattern: "deploy prod", decision: "require_approval", reason: "prod" }],
    }),
  });
  await assert.rejects(ctx.backgroundStart("deploy prod"), (e) => e instanceof NeedsApproval);
  assert.equal(calls.start, 0);
});

test("an already-approved require_approval command DOES reach the broker", async () => {
  const { broker, calls } = recordingBroker();
  const ctx = ctxFor({
    backgroundBroker: broker,
    authorizeCommand: (c: string) => c === "deploy prod",
    commandPolicy: () => ({
      mode: "denylist",
      rules: [{ pattern: "deploy prod", decision: "require_approval", reason: "prod" }],
    }),
  });
  await ctx.backgroundStart("deploy prod");
  assert.equal(calls.start, 1);
});

test("ledger replay: a start result is CACHED — a crash-replay returns the same handle, no second startProcess", async () => {
  const { ledger } = memoryLedger();
  const { broker, calls } = recordingBroker();
  const run = "run-1";

  const first = await ctxFor({ backgroundBroker: broker, ledger, runId: run }).backgroundStart("npm test");
  assert.equal(calls.start, 1);

  const replay = await ctxFor({ backgroundBroker: broker, ledger, runId: run }).backgroundStart("npm test");
  assert.equal(calls.start, 1, "no second startProcess on replay");
  assert.deepEqual(replay, first);
});

test("ledger replay: a STILL-RUNNING poll is NOT cached (replay reattaches + re-reads)", async () => {
  const { ledger } = memoryLedger();
  const { broker, calls, setPollState } = recordingBroker();
  const run = "run-2";
  setPollState("running");

  await ctxFor({ backgroundBroker: broker, ledger, runId: run }).backgroundPoll("p-1");
  assert.equal(calls.poll, 1);

  setPollState("exited");
  const replay = await ctxFor({ backgroundBroker: broker, ledger, runId: run }).backgroundPoll("p-1");
  assert.equal(calls.poll, 2, "a still-running poll is not cached → replay re-reads");
  assert.equal(replay.status.state, "exited");
});

test("ledger replay: a TERMINAL (exited) poll IS cached — replay returns final output, no re-read", async () => {
  const { ledger } = memoryLedger();
  const { broker, calls, setPollState } = recordingBroker();
  const run = "run-3";
  setPollState("exited");

  const first = await ctxFor({ backgroundBroker: broker, ledger, runId: run }).backgroundPoll("p-1");
  assert.equal(calls.poll, 1);
  assert.equal(first.status.state, "exited");

  const replay = await ctxFor({ backgroundBroker: broker, ledger, runId: run }).backgroundPoll("p-1");
  assert.equal(calls.poll, 1, "a terminal poll is cached → no re-read on replay");
  assert.deepEqual(replay, first);
});

test("ledger replay: a stop result IS cached (idempotent)", async () => {
  const { ledger } = memoryLedger();
  const { broker, calls } = recordingBroker();
  const run = "run-4";

  await ctxFor({ backgroundBroker: broker, ledger, runId: run }).backgroundStop("p-1");
  await ctxFor({ backgroundBroker: broker, ledger, runId: run }).backgroundStop("p-1");
  assert.equal(calls.stop, 1, "the cached stop replays without re-signalling");
});

test("callIndex advances on every once() — a non-cached poll between two cached calls keeps keys deterministic", async () => {
  const { ledger } = memoryLedger();
  const { broker, calls, setPollState } = recordingBroker();
  const run = "run-5";

  const ctx1 = ctxFor({ backgroundBroker: broker, ledger, runId: run });
  await ctx1.backgroundStart("npm test");
  setPollState("running");
  await ctx1.backgroundPoll("p-1");
  setPollState("exited");
  await ctx1.backgroundPoll("p-1");
  assert.equal(calls.start, 1);
  assert.equal(calls.poll, 2);

  setPollState("exited");
  const ctx2 = ctxFor({ backgroundBroker: broker, ledger, runId: run });
  await ctx2.backgroundStart("npm test");
  await ctx2.backgroundPoll("p-1");
  await ctx2.backgroundPoll("p-1");
  assert.equal(calls.start, 1, "start stayed cached across replay (deterministic key)");
  assert.equal(calls.poll, 3, "only the previously-uncached running poll re-ran");
});

test("off-Fly degradation: with NO broker the four mutating methods throw the 'use execute' guidance (never fake a success the agent misreads as done); list is empty", async () => {
  const ctx = ctxFor({});
  const guidance = /isn't available.*execute/s;

  await assert.rejects(ctx.backgroundStart("npm test"), guidance);
  await assert.rejects(ctx.backgroundPoll("p-1"), guidance);
  await assert.rejects(ctx.backgroundStop("p-1"), guidance);
  await assert.rejects(ctx.backgroundWrite("p-1", "ABCD-1234\n"), guidance);

  const list = await ctx.backgroundList();
  assert.deepEqual(list, []);
});
