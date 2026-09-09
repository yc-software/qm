import { createTurnSandboxes, type TurnSandboxContext } from "../src/core/orchestrator/sandboxes.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSandboxResources, type SandboxResource, type SandboxDefault } from "../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter, type SandboxRoute } from "../src/sandbox/sandbox-routing.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

function fixture() {
  const records = createMemoryMap<SandboxResource>();
  const defaults = createMemoryMap<SandboxDefault>();
  const routes = createMemoryMap<SandboxRoute>();
  const disks = new Map<string, Map<string, string>>();
  const provisioned: string[] = [];
  const backend: Sandbox = {
    profile: { backend: "local", writablePersistence: "resident_disk", processSessions: false },
    async provision(layers) {
      const id = layers.find((layer) => layer.mode === "rw")!.scopeId;
      provisioned.push(id);
      if (!disks.has(id)) disks.set(id, new Map());
      return { id, rootDir: "/workspace" };
    },
    async run(handle) {
      return { stdout: handle.id, stderr: "", code: 0, timedOut: false };
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
    async computerStatus(scopeId) {
      return { machine: scopeId, guestResponsive: true };
    },
    async restartComputer(scopeId) {
      provisioned.push(`restart:${scopeId}`);
    },
  };
  const resources = createSandboxResources({
    records,
    defaults,
    routes,
    backends: { local: backend },
    defaultBackend: "local",
    lock: createMemoryAdvisoryLock(),
    canUseScope: async (actor, scope) => actor === "admin" || scope === `personal:${actor}`,
  });
  const router = createSandboxRouter({ routes, backends: { local: backend }, defaultBackend: "local", resources });
  const layers = [{ scopeId: "personal:alice", mode: "rw" as const, mountPath: "/" }];
  return { records, defaults, routes, resources, router, provisioned, layers, backend };
}

test("blank sandbox identities coexist and default changes never copy files or redirect existing handles", async () => {
  const { resources, router, layers } = fixture();
  const old = await router.provision(layers);
  await router.writeFile(old, "secret", "old disk");
  const first = await resources.create("alice", "personal:alice", "local", "build");
  const second = await resources.create("alice", "personal:alice", "local", "analysis");
  const a = await router.provision(layers, { sandboxId: first.id });
  const b = await router.provision(layers, { sandboxId: second.id });
  assert.notEqual(a.id, b.id);
  assert.equal(await router.readFile(a, "secret"), null);
  await router.writeFile(a, "output", "A");
  await resources.setDefault("alice", "personal:alice", first.id);
  assert.equal((await router.provision(layers)).id, a.id);
  await resources.setDefault("alice", "personal:alice", second.id);
  assert.equal((await router.provision(layers)).id, b.id);
  assert.equal((await router.run(a, "pwd")).stdout, a.id);
  assert.equal(await router.readFile(a, "output"), "A");
  assert.equal(await router.readFile(b, "output"), null);
  assert.equal(await router.readFile(old, "secret"), "old disk");
  assert.equal(a.scopeId, "personal:alice");
  assert.equal(a.resourceId, first.id);
});

test("unset defaults remain unset durably while explicit execution remains usable", async () => {
  const { resources, router, layers, defaults } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await resources.setDefault("alice", "personal:alice", null);
  assert.equal((await defaults.get("personal:alice"))?.sandboxId, null);
  await assert.rejects(router.provision(layers), /no default sandbox/);
  const explicit = await router.provision(layers, { sandboxId: record.id });
  assert.equal(explicit.resourceId, record.id);
  const listed = await resources.list("alice", "personal:alice");
  assert.equal(listed.defaultSandboxId, null);
  assert.equal(listed.defaultMode, "none");
  assert.equal(await resources.resolve("personal:new"), undefined);
});

test("legacy adoption is deterministic and reconnects the existing backing identity", async () => {
  const { resources, router, layers, records } = fixture();
  const old = await router.provision(layers);
  await router.writeFile(old, "file", "keep");
  const lists = await Promise.all(Array.from({ length: 8 }, () => resources.list("alice", "personal:alice")));
  const id = lists[0]!.defaultSandboxId!;
  assert.ok(lists.every((list) => list.defaultSandboxId === id));
  assert.equal((await records.all()).length, 1);
  await resources.setDefault("alice", "personal:alice", id);
  const adopted = await router.provision(layers);
  assert.equal(adopted.id, old.id);
  assert.equal(await router.readFile(adopted, "file"), "keep");
});

test("scope ACL protects inventory and target access and prevents cross-scope default credential relocation", async () => {
  const { resources } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await assert.rejects(resources.access("bob", record.id), /permission/);
  await assert.rejects(resources.list("bob", "personal:alice"), /permission/);
  await assert.rejects(resources.create("bob", "personal:alice", "local"), /permission/);
  await assert.rejects(resources.setDefault("bob", "personal:alice", record.id), /permission/);
  await assert.rejects(resources.setDefault("admin", "personal:bob", record.id), /belong to this scope/);
  assert.equal((await resources.access("admin", record.id)).id, record.id);
});

test("status and restart resolve the selected backing machine rather than legacy scope", async () => {
  const { resources, router, provisioned } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await resources.setDefault("alice", "personal:alice", record.id);
  assert.equal((await router.computerStatus!("personal:alice")).machine, record.backingScopeId);
  await router.restartComputer!("personal:alice");
  assert.deepEqual(provisioned, [record.backingScopeId, `restart:${record.backingScopeId}`]);
});

test("listing an untouched scope never invents a legacy machine", async () => {
  const { resources, provisioned } = fixture();
  assert.deepEqual(await resources.list("alice", "personal:alice"), {
    sandboxes: [],
    defaultSandboxId: null,
    defaultMode: "legacy",
  });
  assert.deepEqual(provisioned, []);
  await assert.rejects(resources.create("alice", "personal:alice", "__proto__"), /unavailable/);
  await assert.rejects(resources.create("alice", "personal:alice", "toString"), /unavailable/);
});

test("turn default changes invalidate cached provisioning while explicit calls dedupe and cleanup each computer once", async () => {
  const { resources, router, layers, backend } = fixture();
  const released: string[] = [];
  backend.teardown = async (handle) => {
    released.push(handle.id);
  };
  const a = await resources.create("alice", "personal:alice", "local");
  const b = await resources.create("alice", "personal:alice", "local");
  await resources.setDefault("alice", "personal:alice", a.id);
  const turn = createTurnSandboxes({
    deps: { sandbox: router, sandboxResources: resources },
    input: { origin: { kind: "user" } },
    actor: { id: "alice", type: "internal" },
    session: { id: "s" },
    resolution: { layers },
    scopeId: "personal:alice",
    memoryScopeId: "personal:alice",
    transferId: "t",
    turnSessionDir: "turn/s",
    turnFilesDir: "turn/s/t",
    connectorEnv: { AGENT_API_TOKEN: "scope-token" },
    ownerAuthAvailable: false,
    ownerEnvCredentialIds: [],
    credentialCutoverServices: [],
    visibleSkills: [],
    visibleSkillsForTurn: async () => [],
    emitGapWork: () => {},
    perf: { credsMs: 0 },
  } as unknown as TurnSandboxContext);
  const old = await turn.provision();
  await resources.setDefault("alice", "personal:alice", b.id);
  turn.invalidateProvision();
  const next = await turn.provision();
  assert.notEqual(old.id, next.id);
  assert.equal((await router.run(old, "still old")).stdout, old.id);
  const [x, y] = await Promise.all([turn.provisionResource(a.id), turn.provisionResource(a.id)]);
  assert.equal(x, y);
  await turn.reclaimBox();
  assert.deepEqual(released.sort(), [a.backingScopeId, b.backingScopeId].sort());
});

test("retirement refuses the default, waits for an active command, and prevents future execution", async () => {
  const { resources, router, backend, layers } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await resources.setDefault("alice", "personal:alice", record.id);
  await assert.rejects(resources.retire("alice", record.id), /default/);
  const handle = await router.provision(layers);
  await resources.setDefault("alice", "personal:alice", null);
  let finish!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  backend.run = async () => {
    started();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { stdout: "done", stderr: "", code: 0, timedOut: false };
  };
  let destroyed = false;
  backend.teardown = async (_handle, options) => {
    destroyed = options?.destroy === true;
  };
  const command = router.run(handle, "work");
  await running;
  const retiring = resources.retire("alice", record.id);
  assert.equal(destroyed, false);
  finish();
  await command;
  await retiring;
  assert.equal(destroyed, true);
  await assert.rejects(router.run(handle, "no resurrection"), /retired/);
  await assert.rejects(resources.setDefault("alice", "personal:alice", record.id), /retired/);
});
