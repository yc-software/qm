import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeService } from "../src/agent/runtime-control.ts";
import type { Run } from "../src/runs/run-store.ts";
import type { Agent } from "../src/agent/agent.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { createOrchestrator, type OrchestratorDeps, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import type { Principal, TurnRequest } from "../src/types.ts";
import type { ProcessSandbox } from "../src/sandbox/sandbox.ts";
import { createPostgresProcessRegistry, type ProcessRegistry } from "../src/processes/process-registry.ts";
import { createProcessReaper } from "../src/processes/process-reaper.ts";
import { createPostgresLeaderLease } from "../src/persistence/leader-lease.ts";
import { createMonitorStore, type MonitorStore } from "../src/monitors/monitor-store.ts";
import { createMonitorPoller } from "../src/monitors/monitor-poller.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createSwarmService, type SwarmCaller } from "../src/swarms/swarm-service.ts";
import { orchestratorTestDeps } from "./support/orchestrator-deps.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings, testMap, testPgPool } from "./support/test-database.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";
import { errMessage } from "../src/util/errors.ts";
import { sleep } from "../src/util/async.ts";
import { probedCommand } from "./support/probed-command.ts";

const releaseBot: Principal = { id: "release-bot", type: "internal", displayName: "Release bot" };
const alice: Principal = { id: "alice", type: "internal" };
const refusedDirection = "a Slack bot's turn cannot direct a person's swarm";
const refusedComputer = "a Slack bot's turn can use only a computer it made that no person has used";
const refusedForum =
  "a swarm a Slack bot starts cannot take forumSandboxId; spawn without it and the swarm uses its own board computer";
const forumSpawn = { requestId: "forum", text: "work", forumSandboxId: "shared-notes" };

type Fixture = Awaited<ReturnType<typeof swarmFixture>>;

function channelSwarm(backend?: ProcessSandbox) {
  const url = testDatabaseUrl();
  return swarmFixture({
    ...(backend ? { backend } : {}),
    channel: "C1",
    sessions: createPostgresSessionStore(url),
    runs: createPostgresRunStore(url).runs,
  });
}
type ToolResult = { content: Array<{ text?: string }> };
type Tool = { execute: (id: string, params: unknown) => Promise<ToolResult> };
type Call = (name: string, params: Record<string, unknown>) => Promise<string>;

const textOf = (result: ToolResult): string => result.content.map((part) => part.text ?? "").join("");

function recordRuns(f: Fixture): Array<{ on: string; command: string }> {
  const ran: Array<{ on: string; command: string }> = [];
  f.backend.run = async (handle, command) => {
    ran.push({ on: handle.id, command: probedCommand(command) });
    return { stdout: f.disks.get(handle.id)?.get("plan.md") ?? "", stderr: "", code: 0, timedOut: false };
  };
  return ran;
}

function channelRequest(f: Fixture, actor: Principal, botActor: boolean, thread = f.root.threadRef): OrchestratorInput {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: thread, channelRef: "C1", audience: [actor] },
    origin: { kind: "human", messageTs: "1700000000.000100" },
    ...(botActor ? { botActor: true } : {}),
    text: "check on the swarm's computers",
  };
}

async function drive(
  f: Fixture,
  queued: Run,
  act: (call: Call, run: Run) => Promise<Record<string, unknown>>,
  jobs: Pick<OrchestratorDeps, "processes" | "monitors"> = {},
): Promise<Record<string, unknown>> {
  let calls = 0;
  let observed: Record<string, unknown> = {};
  const agent: Agent = {
    async runTurn(turn) {
      const tools = createAgentTools(
        { current: turn.tools, scopeLabel: turn.scopeLabel, emit: turn.emit, pendingApprovals: [] },
        { sandboxResources: true, sessionTools: false },
      );
      const call: Call = (name, params) =>
        (tools.find((entry) => entry.name === name) as unknown as Tool)
          .execute(`${queued.id}:${++calls}`, params)
          .then(textOf, (error: unknown) => `[threw] ${errMessage(error)}`);
      observed = await act(call, (await f.runs.get(queued.id))!);
      return { reply: "done", modelCalls: 1 };
    },
  };
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const config = testConfigStore("org");
  const orchestrator = createOrchestrator({
    ...orchestratorTestDeps(),
    config,
    runtime: createRuntimeService(
      { config, baseModelDefault: "claude-opus-5" },
      { authorizesCapabilityScope: async () => true },
    ),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService("org", config, acl),
    sessions: f.sessions,
    runs: f.runs,
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: f.sandbox,
    sandboxResources: f.sandboxes,
    swarms: f.service,
    ...jobs,
    auditLog,
    agent,
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deploy: createDeployService({
      ...singleProcessDeps(),
      deployStore: createDeployStore(testDeployBackings()),
      provider: createDockerDeployProvider(),
      deployDir: join(tmpdir(), "swarm-bot-computers-deploy"),
      auditLog,
      acl,
    }),
    acl,
  });
  const claim = (await f.runs.claimById(queued.id, "turn", 60_000))!;
  const result = await orchestrator.handleTurn({
    ...queued.request,
    runId: queued.id,
    runLeaseToken: claim.leaseToken!,
    attempt: claim.attempts,
  });
  assert.equal(result.status, "ok", JSON.stringify(result));
  return observed;
}

async function channelTurn(f: Fixture, actor: Principal, botActor: boolean): Promise<Record<string, unknown>> {
  const ran = recordRuns(f);
  const swarm = (await f.store.get(f.root.id))!;
  const worker = swarm.members.find((member) => member.id !== swarm.id)!;
  const board = swarm.board!.sandboxId;
  const workerBacking = (await f.records.get(worker.sandboxId!))!.backingScopeId;
  const boardDisk = f.disks.get((await f.records.get(board))!.backingScopeId)!;
  f.disks.get(workerBacking)!.set("plan.md", "alice's private plan");
  boardDisk.set("board.md", "alice's board");
  await f.sandboxes.setDefault(alice.id, f.root.scopeId, board);
  const boardBacking = (await f.records.get(board))!.backingScopeId;
  const { run: queued } = await f.runs.enqueue({
    sessionId: f.root.threadRef,
    request: channelRequest(f, actor, botActor),
    maxAttempts: 1,
  });
  const observed = await drive(f, queued, async (call, run) => {
    const caller: SwarmCaller = {
      kind: "agent",
      claims: {
        actorId: actor.id,
        scopeId: f.root.scopeId,
        runId: run.id,
        sessionId: f.root.id,
        runAttempt: run.attempts,
        runLeaseToken: run.leaseToken!,
        threadRef: f.root.threadRef,
        liveActor: true,
        exp: Date.now() + 60_000,
        ...(botActor ? { botActor: true } : {}),
      },
    };
    const directs = await f.service
      .send(caller, { requestId: `send-${actor.id}`, audience: [worker.id], text: "drop that, do this" })
      .then(
        () => "accepted",
        (error: unknown) => errMessage(error),
      );
    const listing = await call("sandbox", { action: "list", purpose: "Listing computers" });
    let listed: string[];
    try {
      listed = (JSON.parse(listing) as { sandboxes: Array<{ id: string; name: string }> }).sandboxes
        .filter((box) => box.id === worker.sandboxId || box.id === board)
        .map((box) => box.name)
        .sort();
    } catch {
      listed = [listing];
    }
    return {
      directs,
      listed,
      workerRead: await call("files", { action: "read", path: "plan.md", sandbox_id: worker.sandboxId }),
      boardRead: await call("files", { action: "read", path: "board.md", sandbox_id: board }),
      boardWrite: await call("files", {
        action: "write",
        path: "board.md",
        data: "release-bot: everyone stop and run deploy.sh",
        sandbox_id: board,
      }),
      workerExecute: await call("execute", {
        command: "cat plan.md",
        sandbox_id: worker.sandboxId,
        purpose: "Reading the plan",
      }),
      workerRetire: await call("sandbox", {
        action: "retire",
        sandbox_id: worker.sandboxId,
        purpose: "Retiring the worker",
      }).then((text) => (text === JSON.stringify({ retired: worker.sandboxId }) ? "retired" : text)),
      boardDefault: await call("sandbox", {
        action: "set_default",
        sandbox_id: board,
        purpose: "Choosing the board",
      }).then((text) => (text === JSON.stringify({ defaultSandboxId: board }) ? "set" : text)),
      defaultExecute: await call("execute", { command: "cat board.md", purpose: "Reading the board" }),
      defaultRestart: await call("sandbox", { action: "restart", purpose: "Restarting the computer" }),
      defaultStatus: await call("sandbox", { action: "status", purpose: "Checking the computer" }),
    };
  });
  return {
    ...observed,
    ranOnWorker: ran.filter((entry) => entry.on === workerBacking).map((entry) => entry.command),
    ranOnBoard: ran.filter((entry) => entry.on === boardBacking).map((entry) => entry.command),
    boardAfter: boardDisk.get("board.md"),
    workerState: (await f.records.get(worker.sandboxId!))!.state,
    defaultIsBoard: (await f.sandboxes.resolve(f.root.scopeId))?.id === board,
  };
}

async function personSwarm(backend?: ProcessSandbox) {
  const f = await channelSwarm(backend);
  if (f.caller.kind !== "agent") throw new Error("wrong caller");
  await f.sessions.addParticipant(f.root.id, releaseBot.id);
  await f.service.spawn(f.caller, { requestId: "initial", text: "alice's work" });
  await f.service.sweep();
  await f.runs.complete(f.caller.claims.runId!, f.caller.claims.runLeaseToken!, { status: "ok", reply: "started" });
  return f;
}

async function botSwarm(backend?: ProcessSandbox) {
  const f = await channelSwarm(backend);
  if (f.caller.kind !== "agent") throw new Error("wrong caller");
  await f.sessions.addParticipant(f.root.id, releaseBot.id);
  await f.runs.complete(f.caller.claims.runId!, f.caller.claims.runLeaseToken!, { status: "ok", reply: "idle" });
  const first = await f.rootTurn(releaseBot.id, true);
  await assert.rejects(f.service.spawn(first.caller, forumSpawn), { message: refusedForum });
  await f.service.spawn(first.caller, { requestId: "bot-initial", text: "bot work" });
  await first.done();
  await f.service.sweep();
  return f;
}

function assertKeptOut(observed: Record<string, unknown>): void {
  const { directs, listed, ranOnWorker, ranOnBoard, boardAfter, workerState, defaultIsBoard, ...attempts } = observed;
  assert.equal(directs, refusedDirection);
  assert.deepEqual(listed, []);
  for (const [attempt, result] of Object.entries(attempts))
    assert.ok(String(result).endsWith(refusedComputer), `${attempt}: ${String(result)}`);
  assert.deepEqual(ranOnWorker, []);
  assert.deepEqual(ranOnBoard, []);
  assert.equal(boardAfter, "alice's board");
  assert.equal(workerState, "ready");
  assert.equal(defaultIsBoard, true);
}

test("outside a swarm, a Slack bot's turn can use a computer it made only until a person's turn uses it", async () => {
  const f = await channelSwarm();
  if (f.caller.kind !== "agent") throw new Error("wrong caller");
  await f.runs.complete(f.caller.claims.runId!, f.caller.claims.runLeaseToken!, { status: "ok", reply: "idle" });
  recordRuns(f);
  const people = await f.sandboxes.create(alice.id, f.root.scopeId, "modal");
  const bots = await f.sandboxes.create(releaseBot.id, f.root.scopeId, "modal");
  const turn = async (actor: Principal, act: (call: Call) => Promise<string>): Promise<string> => {
    const request = channelRequest(f, actor, actor === releaseBot);
    const { run } = await f.runs.enqueue({ sessionId: f.root.threadRef, request, maxAttempts: 1 });
    const { out } = await drive(f, run, async (call) => ({ out: await act(call) }));
    await f.runs.complete(run.id, (await f.runs.get(run.id))!.leaseToken!, { status: "ok", reply: "done" });
    return String(out);
  };
  const execute = (sandbox_id: string) => (call: Call) =>
    call("execute", { command: "ls", sandbox_id, purpose: "Listing" });
  const retire = (call: Call) => call("sandbox", { action: "retire", sandbox_id: bots.id, purpose: "Retiring" });
  assert.ok((await turn(releaseBot, execute(people.id))).endsWith(refusedComputer));
  assert.ok(!(await turn(releaseBot, execute(bots.id))).endsWith(refusedComputer));
  await turn(alice, execute(bots.id));
  for (const act of [execute(bots.id), retire]) assert.ok((await turn(releaseBot, act)).endsWith(refusedComputer));
  assert.notEqual((await f.records.get(bots.id))!.state, "retired");
});

test("a Slack bot's channel turn that may not direct a person's swarm cannot list or use the swarm's computers", async (t) => {
  const observed = await channelTurn(await personSwarm(), releaseBot, true);
  t.diagnostic(`observed: ${JSON.stringify(observed)}`);
  assertKeptOut(observed);
});

test("a Slack bot that started a swarm cannot list or use its computers once a person sent work into it", async (t) => {
  const f = await botSwarm();
  const person = await f.rootTurn(alice.id, false);
  const swarm = (await f.store.get(f.root.id))!;
  const worker = swarm.members.find((member) => member.id !== swarm.id)!;
  await f.service.send(person.caller, { requestId: "person-send", audience: [worker.id], text: "alice's work" });
  await person.done();
  const observed = await channelTurn(f, releaseBot, true);
  t.diagnostic(`observed: ${JSON.stringify(observed)}`);
  assertKeptOut(observed);
});

test("a Slack bot that started a swarm cannot list or use its computers once a person's turn worked on them, and the process reaper stops each of its jobs there exactly once", async (t) => {
  const f = await botSwarm();
  const swarm = (await f.store.get(f.root.id))!;
  const worker = swarm.members.find((member) => member.id !== swarm.id)!;
  const processes = createPostgresProcessRegistry(testDatabaseUrl());
  const stopped: unknown[] = [];
  const instances = [1, 2].map(() =>
    createProcessReaper(processes, {
      intervalMs: 60_000,
      leaderLease: createPostgresLeaderLease(testPgPool()),
      kill: async (job) => {
        stopped.push([job.sandboxId, job.runId]);
        await sleep(100);
      },
      claimOwed: () => service.claimOwedStops(),
    }),
  );
  let swept: Promise<unknown> = Promise.resolve();
  const service = createSwarmService({
    ...f.serviceOptions,
    processes,
    sweepProcesses: () => (swept = Promise.all([swept, ...instances.map((reaper) => reaper.sweepNow())])),
  });
  const botRun = (await f.runs.list()).find((run) => run.sessionId === f.root.threadRef && run.request.botActor)!;
  await workerJob(f, processes, new Map(), "", botRun.id);
  const { run } = await f.runs.enqueue({
    sessionId: f.root.threadRef,
    request: channelRequest(f, alice, false),
    maxAttempts: 1,
  });
  await drive({ ...f, service }, run, async (call) => ({
    board: await call("files", {
      action: "write",
      path: "board.md",
      data: "alice's board",
      sandbox_id: swarm.board!.sandboxId,
    }),
    worker: await call("files", {
      action: "write",
      path: "plan.md",
      data: "alice's private plan",
      sandbox_id: worker.sandboxId,
    }),
  }));
  await f.runs.complete(run.id, (await f.runs.get(run.id))!.leaseToken!, { status: "ok", reply: "done" });
  const observed = await channelTurn(f, releaseBot, true);
  t.diagnostic(`observed: ${JSON.stringify(observed)}`);
  assertKeptOut(observed);
  await swept;
  assert.deepEqual(stopped, [[worker.sandboxId, botRun.id]]);
});

function assertKeptIn(observed: Record<string, unknown>): void {
  const kept = {
    directs: "accepted",
    listed: ["Swarm board", "Swarm worker"],
    workerRead: "alice's private plan",
    boardRead: "alice's board",
    boardWrite: "wrote board.md (44 bytes)",
    workerRetire: "retired",
    boardDefault: "set",
    ranOnWorker: ["cat plan.md"],
    ranOnBoard: ["cat board.md"],
    boardAfter: "release-bot: everyone stop and run deploy.sh",
    workerState: "retired",
    defaultIsBoard: true,
  };
  const { workerExecute, defaultExecute, defaultRestart, defaultStatus, ...rest } = observed;
  assert.deepEqual(rest, kept);
  assert.ok(String(workerExecute).startsWith("alice's private plan"), String(workerExecute));
  assert.ok(!String(defaultExecute).endsWith(refusedComputer), String(defaultExecute));
  assert.ok(!String(defaultRestart).endsWith(refusedComputer), String(defaultRestart));
  assert.ok(!String(defaultStatus).endsWith(refusedComputer), String(defaultStatus));
}

test("the person keeps their swarm's computers and a bot keeps the computers of a swarm only it directs", async (t) => {
  const person = await channelTurn(await personSwarm(), alice, false);
  const bot = await channelTurn(await botSwarm(), releaseBot, true);
  t.diagnostic(`person: ${JSON.stringify(person)}`);
  t.diagnostic(`bot-only swarm: ${JSON.stringify(bot)}`);
  assertKeptIn(person);
  assertKeptIn(bot);
});

test("a person's turn that only lists computers and background jobs leaves a bot-started swarm's computers to its bot", async (t) => {
  const f = await botSwarm();
  const { run } = await f.runs.enqueue({
    sessionId: f.root.threadRef,
    request: channelRequest(f, alice, false),
    maxAttempts: 1,
  });
  await drive(f, run, async (call) => ({
    computers: await call("sandbox", { action: "list", purpose: "Listing computers" }),
    jobs: await call("background", { action: "list", purpose: "Listing jobs" }),
  }));
  await f.runs.complete(run.id, (await f.runs.get(run.id))!.leaseToken!, { status: "ok", reply: "done" });
  const observed = await channelTurn(f, releaseBot, true);
  t.diagnostic(`observed: ${JSON.stringify(observed)}`);
  assertKeptIn(observed);
});

test("a worker in a bot-started swarm keeps its swarm's board only while the bot may direct it", async () => {
  const f = await botSwarm();
  const swarm = (await f.store.get(f.root.id))!;
  const worker = swarm.members.find((member) => member.id !== swarm.id)!;
  const board = (await f.records.get(swarm.board!.sandboxId))!;
  const workerTurn = { actorId: releaseBot.id, threadRef: worker.threadRef, sessionId: worker.sessionId! };
  assert.equal(await f.service.botMayUseComputer(board, workerTurn), true);
  const person = await f.rootTurn(alice.id, false);
  await assert.rejects(f.service.spawn(person.caller, forumSpawn), { message: refusedForum });
  await f.service.send(person.caller, { requestId: "person-send", audience: [worker.id], text: "alice's work" });
  await person.done();
  assert.equal(await f.service.botMayUseComputer(board, workerTurn), false);
});

test("a worker turn queued in a bot-started swarm cannot use its own computer once a person sends work into the swarm as the turn opens it", async () => {
  const f = await botSwarm();
  const ran = recordRuns(f);
  const swarm = (await f.store.get(f.root.id))!;
  const worker = swarm.members.find((member) => member.id !== swarm.id)!;
  const queued = (await f.runs.list()).find((run) => run.sessionId === worker.threadRef && run.status === "pending")!;
  const provision = f.backend.provision;
  f.backend.provision = async (...args) => {
    f.backend.provision = provision;
    const person = await f.rootTurn(alice.id, false);
    await f.service.send(person.caller, { requestId: "person-send", audience: [worker.id], text: "alice's work" });
    await person.done();
    return provision(...args);
  };
  const { execute } = await drive(f, queued, async (call) => ({
    execute: await call("execute", { command: "cat plan.md", purpose: "Reading the plan" }),
  }));
  assert.ok(String(execute).endsWith(refusedComputer), String(execute));
  assert.deepEqual(ran, []);
});

test("a bot's turn loses the swarm computer it already opened and is told to stop, with its jobs there, once a person sends work into the swarm", async () => {
  let failed: unknown[] = [];
  const computers = jobComputers(async () => {
    lookupFailures = 1;
    failed = [await personSend().then(() => "sent", errMessage), await swept, stopped.length];
  });
  const f = await botSwarm(computers.backend);
  const ran = recordRuns(f);
  const swarm = (await f.store.get(f.root.id))!;
  const worker = swarm.members.find((member) => member.id !== swarm.id)!;
  await f.sandboxes.setDefault(alice.id, f.root.scopeId, swarm.board!.sandboxId);
  const registry = createPostgresProcessRegistry(testDatabaseUrl());
  let lookupFailures = 0;
  const processes: ProcessRegistry = {
    ...registry,
    async listLive(now) {
      if (lookupFailures-- > 0) throw new Error("process registry unavailable");
      return registry.listLive(now);
    },
  };
  const signals = createPostgresRunSignalStore(testDatabaseUrl());
  const stopped: unknown[] = [];
  const reaper = createProcessReaper(processes, {
    ...singleProcessDeps(),
    intervalMs: 60_000,
    kill: async (job) => void stopped.push([job.sandboxId, job.runId]),
    claimOwed: () => service.claimOwedStops(),
  });
  let swept: Promise<unknown> = Promise.resolve();
  let sweeps = 0;
  const service = createSwarmService({
    ...f.serviceOptions,
    signals,
    processes,
    sweepProcesses: () => {
      sweeps += 1;
      return (swept = reaper.sweepNow());
    },
  });
  await workerJob(f, processes, computers.output, "alice's build\n");
  const thread = `slack:C1:${f.root.id}`;
  const { run: queued } = await f.runs.enqueue({
    sessionId: thread,
    request: channelRequest(f, releaseBot, true, thread),
    maxAttempts: 1,
  });
  await processes.register({
    processId: `c2-${f.root.id}`,
    scopeId: "channel:C2",
    sandboxId: swarm.board!.sandboxId,
    kind: "background",
    command: "tail -f board.md",
    ttlMs: 600_000,
    runId: queued.id,
  });
  const personSend = () =>
    service.send(
      { kind: "human", actorId: alice.id, sessionId: f.root.id },
      { requestId: "person-send", audience: [worker.id], text: "alice's work" },
    );
  const observed = await drive(
    { ...f, service },
    queued,
    async (call) => {
      const before = await call("execute", { command: "cat board.md", purpose: "Reading the board" });
      const started = await call("execute", {
        command: "tail -f board.md",
        background: true,
        purpose: "Following the board",
      });
      const stops = (await signals.pending(queued.id)).map(({ signal }) => signal.kind);
      const after = await call("execute", { command: "cat board.md", purpose: "Reading the board again" });
      return { before, after, started, stops };
    },
    { processes },
  );
  assert.ok(!String(observed.before).endsWith(refusedComputer), String(observed.before));
  assert.ok(String(observed.after).endsWith(refusedComputer), String(observed.after));
  assert.deepEqual(
    ran.map((entry) => entry.command),
    ["cat board.md"],
  );
  assert.ok(String(observed.started).endsWith(refusedComputer), String(observed.started));
  assert.deepEqual(failed, ["sent", { reaped: 0 }, 0]);
  assert.deepEqual(observed.stops, ["abort"]);
  await reaper.sweepNow();
  assert.deepEqual(stopped, [[swarm.board!.sandboxId, queued.id]]);
  assert.equal((await processes.get(`c2-${f.root.id}`))?.status, "reaped");
  const launched = (await processes.listByScope(f.root.scopeId)).filter((job) => job.runId === queued.id);
  assert.deepEqual(
    launched.map((job) => job.status),
    ["reaped"],
  );
  await f.runs.complete(queued.id, (await f.runs.get(queued.id))!.leaseToken!, { status: "ok", reply: "done" });
  const root = await f.rootTurn(releaseBot.id, true);
  await personSend();
  assert.deepEqual(
    (await signals.pending(root.claim.id)).map(({ signal }) => signal.kind),
    ["abort"],
  );
  await root.done();
  const other = await f.rootTurn("other-bot", true);
  await personSend();
  assert.deepEqual(await signals.pending(other.claim.id), []);
  assert.equal(sweeps, 1);
});

function jobComputers(beforeStart?: () => Promise<unknown>) {
  const output = new Map<string, string>();
  const reads: string[] = [];
  const backend: ProcessSandbox = {
    profile: { backend: "modal", writablePersistence: "resident_disk", processSessions: true },
    async provision(id) {
      return { id, rootDir: "/workspace" };
    },
    async run() {
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async readFileBytes() {
      return null;
    },
    async writeFileBytes() {},
    async listDir() {
      return [];
    },
    async removeDir() {},
    async teardown() {},
    async destroyScope() {},
    async startProcess() {
      await beforeStart?.();
      return { processId: "bg-1" };
    },
    async readProcess(_handle, processId, options) {
      reads.push(processId);
      const text = output.get(processId) ?? "";
      return { chunks: text.slice(options?.sinceCursor ?? 0), cursor: text.length, status: { state: "running" } };
    },
    async writeStdin() {},
    async signalProcess() {},
    async listProcesses() {
      return [];
    },
  };
  return { backend, output, reads };
}

async function workerJob(f: Fixture, processes: ProcessRegistry, output: Map<string, string>, text: string, run = "") {
  const swarm = (await f.store.get(f.root.id))!;
  const worker = swarm.members.find((member) => member.id !== swarm.id)!;
  const job = await processes.register({
    processId: `build-${f.root.id}`,
    scopeId: f.root.scopeId,
    sandboxId: worker.sandboxId!,
    kind: "background",
    command: "npm run build",
    purpose: "the build",
    ttlMs: 600_000,
    ...(run ? { runId: run } : {}),
  });
  output.set(job.processId, text);
  return { job, worker };
}

function jobPoller(f: Fixture, processes: ProcessRegistry, monitors: MonitorStore, wakes: TurnRequest[]) {
  return createMonitorPoller({
    ...singleProcessDeps(),
    monitors,
    processes,
    sandbox: f.sandbox,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(testMap()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    sandboxResources: f.sandboxes,
    swarms: f.service,
    run: async (request) => {
      wakes.push(request);
      return { status: "ok", reply: "noted" };
    },
  });
}

async function botWatchTurn(f: Fixture, processes: ProcessRegistry, monitors: MonitorStore, processId: string) {
  const { run: queued } = await f.runs.enqueue({
    sessionId: f.root.threadRef,
    request: channelRequest(f, releaseBot, true),
    maxAttempts: 1,
  });
  return drive(
    f,
    queued,
    async (call) => ({
      list: await call("background", { action: "list", purpose: "Listing jobs" }),
      watch: await call("background", { action: "watch", process_id: processId, purpose: "Watching the build" }),
    }),
    { processes, monitors },
  );
}

test("a Slack bot's channel turn cannot list, watch or stream the background jobs on a person's swarm computers", async (t) => {
  const computers = jobComputers();
  const f = await personSwarm(computers.backend);
  const processes = createPostgresProcessRegistry(testDatabaseUrl());
  const monitors = createMonitorStore(testMap());
  const { job } = await workerJob(f, processes, computers.output, "alice's build log\n");
  const observed = await botWatchTurn(f, processes, monitors, job.processId);
  const wakes: TurnRequest[] = [];
  await jobPoller(f, processes, monitors, wakes).tick();
  t.diagnostic(`observed: ${JSON.stringify(observed)}`);
  assert.ok(!String(observed.list).includes(job.processId), String(observed.list));
  assert.ok(String(observed.watch).endsWith(refusedComputer), String(observed.watch));
  assert.deepEqual(await monitors.list(), []);
  assert.deepEqual(computers.reads, []);
  assert.deepEqual(wakes, []);
});

test("a bot's watch of a job in a swarm only it directs stops reading the job once a person sends work into the swarm", async () => {
  const computers = jobComputers();
  const f = await botSwarm(computers.backend);
  const processes = createPostgresProcessRegistry(testDatabaseUrl());
  const monitors = createMonitorStore(testMap());
  const { job, worker } = await workerJob(f, processes, computers.output, "bot step\n");
  const observed = await botWatchTurn(f, processes, monitors, job.processId);
  assert.ok(String(observed.list).includes(job.processId), String(observed.list));
  const wakes: TurnRequest[] = [];
  const poller = jobPoller(f, processes, monitors, wakes);
  await poller.tick();
  assert.deepEqual(
    wakes.map((wake) => [wake.botActor, wake.text.includes("bot step")]),
    [[true, true]],
  );
  await f.service.send(
    { kind: "human", actorId: alice.id, sessionId: f.root.id },
    { requestId: "person-send", audience: [worker.id], text: "alice's work" },
  );
  computers.output.set(job.processId, "bot step\nalice's step\n");
  const reads = computers.reads.length;
  await poller.tick();
  assert.equal(wakes.length, 1);
  assert.equal(computers.reads.length, reads);
  const [monitor] = await monitors.list();
  assert.deepEqual([monitor?.enabled, monitor?.lastError], [false, refusedComputer]);
});
