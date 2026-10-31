import { randomUUID } from "node:crypto";
import { createSandboxResources } from "../../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../../src/sandbox/sandbox-routing.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import { createSwarmStore, type SwarmStore } from "../../src/swarms/swarm-store.ts";
import { createPostgresSwarmRows } from "../../src/swarms/swarm-table.ts";
import { createSwarmService, type SwarmCaller } from "../../src/swarms/swarm-service.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import type { RunStore } from "../../src/runs/run-store.ts";
import type { AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testAdvisoryLock, testDatabaseUrl, testMap, testSandboxResourceStores } from "./test-database.ts";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import { eachTenant } from "../../src/tenants/claim.ts";
import { TEST_TENANT } from "./tenant-seed.ts";

export async function swarmFixture(
  options: {
    store?: SwarmStore;
    sessions?: SessionStore;
    runs?: RunStore;
    lock?: AdvisoryLock;
    backend?: Sandbox;
    runtime?: Pick<OrchestratorInput, "model" | "thinkingLevel" | "fastMode">;
  } = {},
) {
  const url = testDatabaseUrl();
  const sessions = options.sessions ?? createPostgresSessionStore(url);
  const runs = options.runs ?? createPostgresRunStore(url).runs;
  const lock = options.lock ?? testAdvisoryLock();
  const store = options.store ?? createSwarmStore(createPostgresSwarmRows(url));
  const { records, defaults } = testSandboxResourceStores();
  const disks = new Map<string, Map<string, string>>();
  const provisioned: string[] = [];
  const state = { allowed: true, failProvision: false };
  const backend: Sandbox = options.backend ?? {
    profile: { backend: "modal", writablePersistence: "resident_disk", processSessions: false },
    async provision(layers) {
      const id = layers.find((layer) => layer.mode === "rw")!.scopeId;
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
    defaults,
    backends: { modal: backend },
    defaultBackend: async () => "modal",
    lock,
    canUseScope: async (actorId, scopeId) => scopeId === `personal:${actorId}`,
  });
  const sandbox = createSandboxRouter({
    backends: { modal: backend },
    defaultBackend: async () => "modal",
    resources: sandboxes,
  });
  const actor = { id: "alice", type: "internal" as const };
  const root = await sessions.getOrCreateByThread(
    `web:alice:${randomUUID()}`,
    "dm",
    "personal:alice",
    undefined,
    "web",
  );
  await sessions.addParticipant(root.id, actor.id);
  const template: OrchestratorInput = {
    actor,
    conversation: { kind: "dm", threadRef: root.threadRef, audience: [actor] },
    origin: { kind: "human" },
    text: "Start workers",
    surface: "slack",
    deliveryTarget: "private-dm",
    ...options.runtime,
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
    },
  };
  const serviceOptions = {
    store,
    sessions,
    runs,
    sandboxes,
    lock,
    authorize: async () => state.allowed,
    tenants: eachTenant(async () => [TEST_TENANT]),
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
        actorId: actor.id,
        scopeId: root.scopeId,
        runId: notification.runId!,
        sessionId: member.sessionId!,
        runAttempt: run!.attempts,
        runLeaseToken: run!.leaseToken!,
        threadRef: member.threadRef,
        exp: Date.now() + 60_000,
      },
    };
  };
  return {
    url,
    service,
    serviceOptions,
    store,
    sessions,
    runs,
    sandboxes,
    sandbox,
    backend,
    records,
    defaults,
    disks,
    provisioned,
    state,
    root,
    caller,
    workerCaller,
    template,
  };
}
