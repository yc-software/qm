import { randomUUID } from "node:crypto";
import { createSandboxResources, type SandboxResource } from "../../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../../src/sandbox/sandbox-routing.ts";
import { supportsProcessSessions, type Sandbox } from "../../src/sandbox/sandbox.ts";
import { createSwarmStore, type SwarmStore } from "../../src/swarms/swarm-store.ts";
import { createSwarmService, type SwarmCaller } from "../../src/swarms/swarm-service.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import type { RunStore } from "../../src/runs/run-store.ts";
import type { AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import type { SpawnMeta } from "../../src/types.ts";
import type { CapabilityClaims } from "../../src/auth/capability-token.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testAdvisoryLock, testDatabaseUrl, testMap } from "./test-database.ts";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import type { ProcessRegistry } from "../../src/processes/process-registry.ts";
import type { RunSignalStore } from "../../src/runs/run-signal-store.ts";
import { createReaperKillHook } from "../../src/processes/process-reaper.ts";

export async function swarmFixture(
  options: {
    store?: SwarmStore;
    sessions?: SessionStore;
    runs?: RunStore;
    lock?: AdvisoryLock;
    backend?: Sandbox;
    runtime?: Pick<OrchestratorInput, "model" | "thinkingLevel" | "fastMode" | "botActor">;
    request?: Pick<OrchestratorInput, "memoryNotebookOnly">;
    spawnMeta?: Pick<SpawnMeta, "memoryNotebookOnly">;
    claims?: Pick<CapabilityClaims, "memory">;
    channel?: string;
    processes?: ProcessRegistry;
    signals?: Pick<RunSignalStore, "send">;
  } = {},
) {
  const sessions = options.sessions ?? createPostgresSessionStore(testDatabaseUrl());
  const runs = options.runs ?? createPostgresRunStore(testDatabaseUrl()).runs;
  const lock = options.lock ?? testAdvisoryLock();
  const store = options.store ?? createSwarmStore(testMap(["pending"]), { runs, sessions });
  const records = testMap<SandboxResource>();
  const disks = new Map<string, Map<string, string>>();
  const provisioned: string[] = [];
  const state = { allowed: true, failProvision: false };
  const backend: Sandbox = options.backend ?? {
    profile: { backend: "modal", writablePersistence: "resident_disk", processSessions: false },
    async provision(id) {
      provisioned.push(id);
      if (state.failProvision) throw new Error("provider unavailable");
      if (!disks.has(id)) disks.set(id, new Map());
      return { id, rootDir: "/workspace" };
    },
    async run() {
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
    async readFile(handle, path) {
      return disks.get(handle.id)?.get(path) ?? null;
    },
    async writeFile(handle, path, data) {
      disks.get(handle.id)!.set(path, data);
    },
    async readFileBytes() {
      return null;
    },
    async writeFileBytes() {},
    async listDir() {
      return [];
    },
    async removeDir() {},
    async teardown() {},
    async destroyScope(id) {
      disks.delete(id);
    },
  };
  const sandboxes = createSandboxResources({
    records,
    defaults: testMap(),
    backends: { modal: backend },
    defaultBackend: "modal",
    lock,
    canUseScope: async (actorId, scopeId) =>
      scopeId === `personal:${actorId}` || (options.channel !== undefined && scopeId === `channel:${options.channel}`),
  });
  const sandbox = createSandboxRouter({
    backends: { modal: backend },
    defaultBackend: "modal",
    resources: sandboxes,
  });
  const actor = { id: "alice", type: "internal" as const };
  const root = await sessions.getOrCreateByThread(
    `web:alice:${randomUUID()}`,
    options.channel ? "channel" : "dm",
    options.channel ? `channel:${options.channel}` : "personal:alice",
    undefined,
    "web",
  );
  await sessions.addParticipant(root.id, actor.id);
  const conversation: OrchestratorInput["conversation"] = options.channel
    ? { kind: "channel", threadRef: root.threadRef, channelRef: options.channel, audience: [actor] }
    : { kind: "dm", threadRef: root.threadRef, audience: [actor] };
  if (options.spawnMeta)
    await sessions.setSpawnMeta(root.id, { surface: "web", actor, conversation, ...options.spawnMeta });
  const template: OrchestratorInput = {
    actor,
    conversation,
    origin: { kind: "human" },
    text: "Start workers",
    surface: "slack",
    deliveryTarget: "private-dm",
    ...options.runtime,
    ...options.request,
  };
  const { run } = await runs.enqueue({ sessionId: root.threadRef, request: template });
  const claim = (await runs.claimById(run.id, "swarm-fixture", 60_000))!;
  const caller: SwarmCaller = {
    kind: "agent",
    claims: {
      actorId: actor.id,
      scopeId: root.scopeId,
      runId: run.id,
      sessionId: root.id,
      runAttempt: claim.attempts,
      runLeaseToken: claim.leaseToken!,
      threadRef: root.threadRef,
      liveActor: true,
      exp: Date.now() + 60_000,
      ...options.claims,
    },
  };
  const serviceOptions = {
    store,
    sessions,
    runs,
    sandboxes,
    lock,
    authorize: async () => state.allowed,
    ...(options.signals ? { signals: options.signals } : {}),
    ...(options.processes && supportsProcessSessions(sandbox)
      ? { processes: options.processes, stopProcess: createReaperKillHook(sandbox) }
      : {}),
  };
  const service = createSwarmService(serviceOptions);
  const workerCaller = async (id: string): Promise<SwarmCaller> => {
    const swarm = (await store.get(root.id))!;
    const member = swarm.members.find((peer) => peer.id === id)!;
    const notification = swarm.messages
      .flatMap((message) => Object.entries(message.notifications))
      .find(([recipient]) => recipient === id)![1];
    let run = await runs.get(notification.runId!);
    if (run?.status === "pending") run = await runs.claimById(run.id, "swarm-fixture-worker", 60_000);
    return {
      kind: "agent",
      claims: {
        actorId: run!.request.actor.id,
        scopeId: root.scopeId,
        runId: notification.runId!,
        sessionId: member.sessionId!,
        runAttempt: run!.attempts,
        runLeaseToken: run!.leaseToken!,
        threadRef: member.threadRef,
        exp: Date.now() + 60_000,
        ...(run!.request.botActor ? { botActor: true } : {}),
      },
    };
  };
  const rootTurn = async (actorId: string, botActor: boolean) => {
    const { run } = await runs.enqueue({
      sessionId: root.threadRef,
      request: { ...template, actor: { id: actorId, type: "internal" }, ...(botActor ? { botActor } : {}) },
    });
    const claim = (await runs.claimById(run.id, "root-turn", 60_000))!;
    const turn: SwarmCaller = {
      kind: "agent",
      claims: {
        ...caller.claims,
        actorId,
        runId: run.id,
        runAttempt: claim.attempts,
        runLeaseToken: claim.leaseToken!,
        ...(botActor ? { botActor } : {}),
      },
    };
    return {
      caller: turn,
      claim,
      done: () => runs.complete(run.id, claim.leaseToken!, { status: "ok", reply: "done" }),
    };
  };
  return {
    service,
    serviceOptions,
    store,
    sessions,
    runs,
    sandboxes,
    sandbox,
    backend,
    records,
    disks,
    provisioned,
    state,
    root,
    caller,
    workerCaller,
    rootTurn,
    template,
  };
}
