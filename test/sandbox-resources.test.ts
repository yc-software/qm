import { createBackgroundBroker } from "../src/connectors/background-exec-broker.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { createTurnSandboxes, type TurnSandboxContext } from "../src/core/orchestrator/sandboxes.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSandboxResources, type SandboxResource, type SandboxDefault } from "../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../src/sandbox/sandbox-routing.ts";
import {
  upgradeLegacySandboxes,
  legacySandboxBackendForScope,
  legacySandboxId,
  type LegacyRoute,
  type SandboxResourceUpgradeMarker,
} from "../src/sandbox/sandbox-resource-upgrade.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

function fixture(configure?: (backend: Sandbox) => void, legacyScopes = ["personal:alice"]) {
  const records = createMemoryMap<SandboxResource>();
  const defaults = createMemoryMap<SandboxDefault>();
  const routes = createMemoryMap<LegacyRoute>();
  const marker = createMemoryMap<SandboxResourceUpgradeMarker>();
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
    async destroyScope(id) {
      disks.delete(id);
    },
    async computerStatus(scopeId) {
      return { machine: scopeId, guestResponsive: true };
    },
    async restartComputer(scopeId) {
      provisioned.push(`restart:${scopeId}`);
    },
  };
  configure?.(backend);
  const lock = createMemoryAdvisoryLock();
  const upgrade =
    (overrides: Partial<Parameters<typeof upgradeLegacySandboxes>[0]> = {}) =>
    () =>
      upgradeLegacySandboxes({
        availableBackends: ["local"],
        records,
        defaults,
        marker,
        lock,
        routes: () => routes.entries(),
        legacyScopes: async () => legacyScopes,
        legacyBackend: () => "local",
        ...overrides,
      });
  const options = {
    upgrade: upgrade(),
    records,
    defaults,
    backends: { local: backend },
    defaultBackend: "local",
    lock,
    canUseScope: async (actor: string, scope: string) =>
      actor === "admin" || scope === `personal:${actor}` || (actor === "alice" && scope === "channel:team"),
  } satisfies Parameters<typeof createSandboxResources>[0];
  const resources = createSandboxResources(options);
  const router = createSandboxRouter({ backends: { local: backend }, defaultBackend: "local", resources });
  const layers = [{ scopeId: "personal:alice", mode: "rw" as const, mountPath: "/" }];
  return { records, defaults, routes, resources, router, provisioned, layers, backend, options, marker, upgrade };
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

test("provisioning a running computer does not wait behind a long-running command on it", async () => {
  const { resources, router, layers } = fixture();
  const handle = await router.provision(layers);
  const command = Promise.withResolvers<void>();
  const running = resources.use(handle.resourceId!, () => command.promise);

  assert.equal((await router.provision(layers)).id, handle.id);
  command.resolve();
  await running;
});

test("explicit sandbox profiles follow selected storage rather than the parent's default provider", async () => {
  const { backend, options } = fixture();
  const modal: Sandbox = { ...backend, profile: { ...backend.profile, backend: "modal" } };
  const backends = { local: backend, modal };
  const resources = createSandboxResources({ ...options, backends });
  const router = createSandboxRouter({ backends, defaultBackend: "local", resources });
  const worker = await resources.create("alice", "personal:alice", "modal", "Worker");
  assert.equal((await router.profileFor!("personal:alice")).backend, "local");
  assert.equal((await router.profileFor!("personal:alice", worker.id)).backend, "modal");
  assert.equal((await router.profileFor!("personal:alice")).backend, "local");
});

test("unset defaults remain unset durably while explicit execution remains usable", async () => {
  const { resources, router, layers, defaults } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await resources.setDefault("alice", "personal:alice", null);
  assert.equal((await defaults.get("personal:alice"))?.sandboxId, null);
  await assert.rejects(
    router.provision(layers),
    /sandbox list, create, set_default, then retry before reporting blocked/,
  );
  const explicit = await router.provision(layers, { sandboxId: record.id });
  assert.equal(explicit.resourceId, record.id);
  const listed = await resources.list("alice", "personal:alice");
  assert.equal(listed.defaultSandboxId, null);
  assert.equal(listed.defaultMode, "none");
  assert.equal(await resources.resolve("personal:new"), null);
});

test("legacy adoption is deterministic and reconnects the existing backing identity", async () => {
  const { resources, router, layers, records, backend } = fixture();
  const old = await backend.provision(layers);
  await backend.writeFile(old, "file", "keep");
  const lists = await Promise.all(Array.from({ length: 8 }, () => resources.list("alice", "personal:alice")));
  const id = lists[0]!.defaultSandboxId!;
  assert.equal(id, legacySandboxId("personal:alice", "local"));
  assert.ok(lists.every((list) => list.defaultSandboxId === id));
  assert.equal((await records.all()).length, 1);
  assert.equal((await records.get(id))?.backingScopeId, "personal:alice");
  const adopted = await router.provision(layers);
  assert.equal(adopted.resourceId, id);
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
  const { resources, provisioned } = fixture(undefined, []);
  assert.deepEqual(await resources.list("alice", "personal:alice"), {
    sandboxes: [],
    defaultSandboxId: null,
    defaultMode: "none",
    providers: [{ name: "local", actions: ["create", "status", "restart", "retire"] }],
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
  backend.destroyScope = async () => {
    destroyed = true;
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

test("every handle operation rejects retirement before reaching a backend that could revive the machine", async () => {
  let backendCalls = 0;
  const hit = async (): Promise<never> => {
    backendCalls++;
    throw new Error("backend reached");
  };
  const { resources, router, layers } = fixture((backend) => {
    backend.profile.processSessions = true;
    backend.startProcess = hit;
    backend.readProcess = hit;
    backend.writeStdin = hit;
    backend.signalProcess = hit;
    backend.listProcesses = async () => [];
    backend.exportFiles = hit;
    backend.stageIn = hit;
    backend.stageOut = hit;
    backend.importFiles = hit;
  });
  const record = await resources.create("alice", "personal:alice", "local");
  const handle = await router.provision(layers, { sandboxId: record.id });
  await resources.retire("alice", record.id);
  const operations: Array<() => Promise<unknown>> = [
    () => router.run(handle, "work"),
    () => router.readFile(handle, "file"),
    () => router.readFileBytes(handle, "file"),
    () => router.writeFile(handle, "file", "data"),
    () => router.writeFileBytes(handle, "file", new Uint8Array()),
    () => router.listDir(handle, "."),
    () => router.removeDir(handle, "dir"),
    () => router.teardown(handle),
    () => router.startProcess!(handle, "work"),
    () => router.readProcess!(handle, "process"),
    () => router.writeStdin!(handle, "process", "input"),
    () => router.signalProcess!(handle, "process", "TERM"),
    () => router.listProcesses!(handle),
    () => router.exportFiles!(handle),
    () => router.stageIn!(handle, "file", "blob"),
    () => router.stageOut!(handle, "file"),
    () => router.importFiles!(handle, []),
    () => resources.status("alice", record.id),
    () => resources.restart("alice", record.id),
  ];
  for (const operation of operations) await assert.rejects(operation(), /retired/);
  assert.equal(backendCalls, 0);
});

for (const fail of [false, true])
  test(`retirement waits for outstanding creation ${fail ? "failure" : "success"} and remains terminal`, async () => {
    const { resources, records, backend } = fixture();
    const provision = backend.provision;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    backend.provision = async (layers, options) => {
      if (first) {
        first = false;
        entered();
        await gate;
        if (fail) throw new Error("create failed");
      }
      return provision(layers, options);
    };
    const creating = resources.create("alice", "personal:alice", "local");
    const completed = creating.then(
      () => undefined,
      (error) => {
        assert.match(String(error), /create failed/);
      },
    );
    await started;
    const record = (await records.all())[0]!;
    let retired = false;
    const retiring = resources.retire("alice", record.id).then(() => {
      retired = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retired, false);
    assert.equal((await records.get(record.id))?.state, "provisioning");
    release();
    await Promise.all([completed, retiring]);
    assert.equal((await records.get(record.id))?.state, "retired");
    await assert.rejects(
      resources.use(record.id, async () => {}),
      /retired/,
    );
  });

test("activation preserves routes, cold identities and explicit nulls without calling a provider", async () => {
  const { options, records, defaults, routes, marker, provisioned, upgrade } = fixture(undefined, []);
  await routes.put("personal:routed", { backend: "modal" });
  await defaults.put("personal:unset", { sandboxId: null });
  const managed: SandboxResource = {
    id: "managed",
    backend: "local",
    ownerScopeId: "personal:selected",
    backingScopeId: "sandbox-managed",
    name: "managed",
    createdBy: "selected",
    createdAt: "2026-01-01",
    legacy: false,
    state: "ready",
  };
  await records.put(managed.id, managed);
  await defaults.put(managed.ownerScopeId, { sandboxId: managed.id });
  const resources = createSandboxResources({
    ...options,
    upgrade: upgrade({
      availableBackends: ["local", "modal"],
      legacyScopes: async () => ["personal:old-session", "personal:unset"],
      legacySandboxes: async () => [
        { scopeId: "personal:routed", backend: "modal", machineId: "sb-old" },
        { scopeId: "personal:routed", backend: "e2b", machineId: "e2b-cold" },
        { scopeId: "sandbox-managed", backend: "local", machineId: "managed-machine" },
      ],
    }),
  });
  const routed = await resources.resolve("personal:routed");
  assert.equal(routed?.backend, "modal");
  assert.equal(routed?.backingScopeId, "personal:routed");
  assert.equal(routed?.machineId, "sb-old");
  assert.equal(routed?.state, "unverified");
  assert.equal((await resources.resolve("personal:old-session"))?.machineId, undefined);
  assert.equal(await resources.resolve("personal:unset"), null);
  assert.equal((await resources.resolve(managed.ownerScopeId))?.id, "managed");
  assert.equal(await resources.resolve("personal:new-after-activation"), null);
  assert.ok(await marker.get("explicit-defaults"));
  const inventory = await resources.list("admin", "personal:routed");
  assert.ok(inventory.sandboxes.some((r) => r.backend === "e2b" && r.machineId === "e2b-cold"));
  assert.ok(!inventory.sandboxes.some((r) => r.legacy && r.backingScopeId === "sandbox-managed"));
  assert.deepEqual(inventory.sandboxes.find((r) => r.id === routed!.id)?.availableActions, []);
  assert.deepEqual(provisioned, []);
  assert.equal((await routes.get("personal:routed"))?.backend, "modal");
  await routes.put("personal:later", { backend: "local" });
  const restarted = createSandboxResources(options);
  assert.equal(await restarted.resolve("personal:later"), null);
  assert.equal((await restarted.resolve("personal:routed"))?.id, routed?.id);
});

test("activation retries partial durable writes without losing defaults or creating machines", async () => {
  const { options, defaults, marker, records, provisioned } = fixture(undefined, ["personal:first", "personal:second"]);
  const put = defaults.putIfAbsent;
  let fail = true;
  defaults.putIfAbsent = async (id, value) => {
    if (id === "personal:second" && fail) throw new Error("database interrupted");
    return put(id, value);
  };
  const resources = createSandboxResources(options);
  await assert.rejects(resources.resolve("personal:first"), /database interrupted/);
  assert.equal(await marker.get("explicit-defaults"), null);
  const first = await defaults.get("personal:first");
  await defaults.put("personal:first", { sandboxId: null });
  fail = false;
  await Promise.all([resources.resolve("personal:first"), resources.resolve("personal:second")]);
  assert.ok(first?.sandboxId);
  assert.equal(await resources.resolve("personal:first"), null);
  assert.equal((await records.all()).length, 2);
  assert.ok(await marker.get("explicit-defaults"));
  assert.deepEqual(provisioned, []);
});

test("boot activation freezes legacy scope adoption before a new session arrives", async () => {
  const known = ["personal:old"];
  const { options, defaults, provisioned } = fixture(undefined, known);
  const resources = createSandboxResources(options);
  await resources.initialize();
  known.push("personal:new-session");
  assert.equal(await resources.resolve("personal:new-session"), null);
  assert.equal(await defaults.get("personal:new-session"), null);
  assert.ok((await resources.resolve("personal:old"))?.id);
  assert.deepEqual(provisioned, []);
});

test("retirement deletes an inferred missing computer without provisioning, status or restore", async () => {
  const { resources, backend, provisioned } = fixture();
  await resources.initialize();
  const record = await resources.resolve("personal:alice");
  assert.equal(record?.state, "unverified");
  await resources.setDefault("alice", "personal:alice", null);
  const destroyed: string[] = [];
  backend.provision = async () => {
    throw new Error("must not restore");
  };
  backend.computerStatus = async () => {
    throw new Error("must not probe");
  };
  backend.destroyScope = async (scope) => {
    destroyed.push(scope);
  };
  await resources.retire("alice", record!.id);
  await resources.retire("alice", record!.id);
  assert.deepEqual(destroyed, ["personal:alice"]);
  assert.deepEqual(provisioned, []);
});

test("unsupported retirement is hidden and refuses before inventory mutation", async () => {
  const { resources, records } = fixture((backend) => {
    delete backend.destroyScope;
  });
  const record = await resources.create("alice", "personal:alice", "local");
  const before = await records.get(record.id);
  const list = await resources.list("alice", "personal:alice");
  assert.ok(!list.providers[0]!.actions.includes("retire"));
  assert.ok(!list.sandboxes.find((r) => r.id === record.id)!.availableActions!.includes("retire"));
  await assert.rejects(resources.retire("alice", record.id), /retirement unavailable/);
  assert.deepEqual(await records.get(record.id), before);
});

test("failed retirement stays unroutable and retries cleanup by backing scope after a core restart", async () => {
  const { resources, backend, records, options } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  backend.destroyScope = async () => {
    throw new Error("provider unavailable");
  };
  await assert.rejects(resources.retire("alice", record.id), /provider unavailable/);
  assert.equal((await records.get(record.id))?.cleanupPending, true);
  assert.equal((await records.get(record.id))?.state, "retired");
  await assert.rejects(resources.setDefault("alice", "personal:alice", record.id), /retired/);
  assert.deepEqual(
    (await resources.list("alice", "personal:alice")).sandboxes.find((r) => r.id === record.id)?.availableActions,
    ["retire"],
  );
  const destroyed: string[] = [];
  backend.destroyScope = async (scope) => {
    destroyed.push(scope);
  };
  backend.provision = async () => {
    throw new Error("must not restore");
  };
  const restarted = createSandboxResources(options);
  await restarted.retire("alice", record.id);
  assert.deepEqual(destroyed, [record.backingScopeId]);
  assert.equal((await records.get(record.id))?.cleanupPending, false);
  assert.equal((await records.get(record.id))?.error, undefined);
});

test("a pending retirement without an error remains retryable after a crash", async () => {
  const { resources, records, options, backend } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await records.put(record.id, { ...record, state: "retired", cleanupPending: true });
  let destroyed = false;
  backend.destroyScope = async () => {
    destroyed = true;
  };
  await createSandboxResources(options).retire("alice", record.id);
  assert.equal(destroyed, true);
  assert.equal((await records.get(record.id))?.cleanupPending, false);
});

test("retirement preserves core live-work and owning-scope guards before direct deletion", async () => {
  const { resources, records, options, backend } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  let destroyed = false;
  backend.destroyScope = async () => {
    destroyed = true;
  };
  const guarded = createSandboxResources({
    ...options,
    beforeRetire: async () => {
      throw new Error("live background work");
    },
  });
  await assert.rejects(guarded.retire("mallory", record.id), /permission/);
  await assert.rejects(guarded.retire("alice", record.id), /live background work/);
  assert.equal(destroyed, false);
  assert.equal((await records.get(record.id))?.state, "ready");
});

test("retirement waits for background startup to commit its live registry row", async () => {
  const { options, backend, layers } = fixture((sandbox) => {
    sandbox.profile.processSessions = true;
    sandbox.startProcess = async () => ({ processId: "job" });
    sandbox.readProcess = async () => ({ chunks: "", cursor: 0, status: { state: "running" } });
    sandbox.writeStdin = async () => {};
    sandbox.signalProcess = async () => {};
    sandbox.listProcesses = async () => [];
  });
  const registry = createMemoryProcessRegistry();
  const resources = createSandboxResources({
    ...options,
    beforeRetire: async (record) => {
      if ((await registry.liveByScope(record.ownerScopeId)).some((r) => r.sandboxId === record.id))
        throw new Error("live background work");
    },
  });
  const router = createSandboxRouter({ resources, backends: { local: backend }, defaultBackend: "local" });
  assert.ok(supportsProcessSessions(router));
  const record = await resources.create("alice", "personal:alice", "local");
  const handle = await router.provision(layers, { sandboxId: record.id });
  const entering = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const register = registry.register.bind(registry);
  registry.register = async (row) => {
    entering.resolve();
    await release.promise;
    return register(row);
  };
  const broker = createBackgroundBroker({ sandbox: router, registry, scopeId: "personal:alice", pollMs: 0 });
  const starting = broker.start(handle, "sleep 60", "Run background tests");
  await entering.promise;
  let destroyed = false;
  backend.destroyScope = async () => {
    destroyed = true;
  };
  const retiring = assert.rejects(resources.retire("alice", record.id), /live background work/);
  release.resolve();
  await Promise.all([starting, retiring]);
  assert.equal(destroyed, false);
  assert.equal((await registry.get("job"))?.sandboxId, record.id);
});

test("failed background registration kills its process and releases the resource lock", async () => {
  const { resources, router, backend, layers } = fixture((sandbox) => {
    sandbox.profile.processSessions = true;
    sandbox.startProcess = async () => ({ processId: "unregistered" });
    sandbox.readProcess = async () => ({ chunks: "", cursor: 0, status: { state: "running" } });
    sandbox.writeStdin = async () => {};
    sandbox.signalProcess = async () => {};
    sandbox.listProcesses = async () => [];
  });
  assert.ok(supportsProcessSessions(router));
  const record = await resources.create("alice", "personal:alice", "local");
  const handle = await router.provision(layers, { sandboxId: record.id });
  const registry = createMemoryProcessRegistry();
  registry.register = async () => {
    throw new Error("registry unavailable");
  };
  const signals: string[] = [];
  backend.signalProcess = async (_handle, id, signal) => {
    signals.push(`${id}:${signal}`);
  };
  const broker = createBackgroundBroker({ sandbox: router, registry, scopeId: "personal:alice", pollMs: 0 });
  await assert.rejects(broker.start(handle, "sleep 60", "Run background tests"), /registry unavailable/);
  assert.deepEqual(signals, ["unregistered:KILL"]);
  await resources.retire("alice", record.id);
  assert.equal((await resources.get(record.id)).cleanupPending, false);
});

test("resource activation honors scope defaults and preserves explicit legacy provider routes", async () => {
  const { options, routes, backend, upgrade } = fixture(undefined, [
    "personal:alice",
    "channel:room",
    "personal:existing",
  ]);
  await routes.put("personal:existing", { backend: "aws" });
  const scopeDefaults = { personal: "modal", channel: "sprites" } as const;
  const resources = createSandboxResources({
    ...options,
    upgrade: upgrade({
      availableBackends: ["aws", "modal", "sprites"],
      legacyBackend: (scope) => legacySandboxBackendForScope(scope, "sprites", scopeDefaults),
    }),
    backends: { modal: backend, sprites: backend, aws: backend },
    defaultBackend: "sprites",
  });
  assert.equal((await resources.resolve("personal:alice"))?.backend, "modal");
  assert.equal((await resources.resolve("channel:room"))?.backend, "sprites");
  assert.equal((await resources.resolve("personal:existing"))?.backend, "aws");
  assert.equal(await resources.resolve("personal:new"), null);
  assert.equal(resources.defaultBackend(), "sprites");
  assert.equal(legacySandboxBackendForScope("org", "sprites", scopeDefaults), "sprites");
});

for (const [kind, waiting] of [
  ["modal", "command"],
  ["modal", "checkpoint"],
  ["sprites", "command"],
  ["sprites", "checkpoint"],
] as const) {
  test(`${kind} ${waiting} allows other tools while restart waits`, { timeout: 10000 }, async () => {
    const { options, backend, layers } = fixture();
    const resources = createSandboxResources({ ...options, backends: { [kind]: backend }, defaultBackend: kind });
    const router = createSandboxRouter({ backends: { [kind]: backend }, defaultBackend: kind, resources });
    const record = await resources.create("alice", "personal:alice", kind);
    await resources.setDefault("alice", "personal:alice", record.id);
    const handle = await router.provision(layers);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const hold = async () => {
      entered.resolve();
      await release.promise;
    };
    backend.teardown = hold;
    backend.run = async (_handle, command) => {
      if (command === "long") await hold();
      return { stdout: command, stderr: "", code: 0, timedOut: false };
    };
    const long = waiting === "command" ? router.run(handle, "long") : router.teardown(handle);
    let restarted = false;
    backend.restartComputer = async () => {
      restarted = true;
    };
    let restarting: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      const result = await Promise.race([
        router.run(handle, "responsive"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("ordinary tool was serialized")), 1000);
        }),
      ]);
      assert.equal(result.stdout, "responsive");
      assert.equal((await resources.status("alice", record.id)).guestResponsive, true);
      restarting =
        waiting === "command" ? resources.restart("alice", record.id) : router.restartComputer!("personal:alice");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(restarted, false);
    } finally {
      clearTimeout(timer);
      release.resolve();
      await long;
      await restarting;
    }
    assert.equal(restarted, true);
    await resources.setDefault("alice", "personal:alice", null);
    await resources.retire("alice", record.id);
    await assert.rejects(router.run(handle, "retired"), /retired/);
  });
}

test("Modal provisioning and destructive cleanup wait for active operations", { timeout: 10000 }, async () => {
  const { options, backend, layers } = fixture();
  const resources = createSandboxResources({ ...options, backends: { modal: backend }, defaultBackend: "modal" });
  const router = createSandboxRouter({ backends: { modal: backend }, defaultBackend: "modal", resources });
  const record = await resources.create("alice", "personal:alice", "modal");
  const handle = await router.provision(layers, { sandboxId: record.id });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  backend.run = async () => {
    entered.resolve();
    await release.promise;
    return { stdout: "done", stderr: "", code: 0, timedOut: false };
  };
  const running = router.run(handle, "long");
  await entered.promise;
  let provisioned = false;
  let destroyed = false;
  backend.provision = async () => {
    provisioned = true;
    return handle;
  };
  backend.teardown = async () => {
    destroyed = true;
  };
  const provision = router.provision(layers, { sandboxId: record.id });
  const teardown = router.teardown(handle, { destroy: true });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(provisioned, false);
    assert.equal(destroyed, false);
  } finally {
    release.resolve();
    await Promise.all([running, provision, teardown]);
  }
  assert.equal(provisioned, true);
  assert.equal(destroyed, true);
});

test("concurrent commands on one Sprites computer run together", { timeout: 10000 }, async () => {
  const { options, backend, layers } = fixture();
  const resources = createSandboxResources({ ...options, backends: { sprites: backend }, defaultBackend: "sprites" });
  const router = createSandboxRouter({ backends: { sprites: backend }, defaultBackend: "sprites", resources });
  const record = await resources.create("alice", "personal:alice", "sprites");
  const handle = await router.provision(layers, { sandboxId: record.id });
  const release = Promise.withResolvers<void>();
  let running = 0;
  let peak = 0;
  backend.run = async (_handle, command) => {
    peak = Math.max(peak, ++running);
    if (peak === 3) release.resolve();
    await release.promise;
    running--;
    return { stdout: command, stderr: "", code: 0, timedOut: false };
  };
  const results = await Promise.all(["a", "b", "c"].map((command) => router.run(handle, command)));
  assert.deepEqual(
    results.map((result) => result.stdout),
    ["a", "b", "c"],
  );
  assert.equal(peak, 3);
});

test("parking teardown waits for active commands on the computer", { timeout: 10000 }, async () => {
  const { options, backend, layers } = fixture();
  const parking: Sandbox = { ...backend, profile: { ...backend.profile, parksOnTeardown: true } };
  const resources = createSandboxResources({ ...options, backends: { e2b: parking }, defaultBackend: "e2b" });
  const router = createSandboxRouter({ backends: { e2b: parking }, defaultBackend: "e2b", resources });
  const record = await resources.create("alice", "personal:alice", "e2b");
  const handle = await router.provision(layers, { sandboxId: record.id });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  parking.run = async () => {
    entered.resolve();
    await release.promise;
    return { stdout: "done", stderr: "", code: 0, timedOut: false };
  };
  let parked = false;
  parking.teardown = async () => {
    parked = true;
  };
  const running = router.run(handle, "long");
  await entered.promise;
  const teardown = router.teardown(handle);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(parked, false);
  } finally {
    release.resolve();
    await Promise.all([running, teardown]);
  }
  assert.equal(parked, true);
});

test("a verified live turn can create only its own new scope computer without directory mutations", async () => {
  const { resources, router } = fixture(undefined, []);
  const scope = "channel:external-slack:T1:policy:C1";
  await resources.initialize();
  assert.equal(await resources.resolve(scope), null);
  await assert.rejects(resources.create("alice", scope, "local"), /permission/);
  let current = true;
  const turn = resources.forTurn({ actorId: "alice", scopeId: scope, isCurrent: async () => current });
  const computer = await turn.create("alice", scope, "local", "external work");
  await turn.setDefault("alice", scope, computer.id);
  const handle = await router.provision([{ scopeId: scope, mode: "rw", mountPath: "" }]);
  assert.equal(handle.scopeId, scope);
  await router.writeFile(handle, "result", "safe-output");
  assert.equal(await router.readFile(handle, "result"), "safe-output");
  await assert.rejects(turn.create("bob", scope, "local"), /permission/);
  await assert.rejects(turn.create("alice", "personal:bob", "local"), /permission/);
  current = false;
  await assert.rejects(turn.access("alice", computer.id), /permission/);
  await assert.rejects(turn.setDefault("alice", scope, computer.id), /permission/);
});

test("legacy import refuses an unavailable selected provider before writing any adoption state", async () => {
  const { options, upgrade, records, defaults, marker } = fixture();
  const resources = createSandboxResources({ ...options, upgrade: upgrade({ availableBackends: [] }) });
  await assert.rejects(resources.initialize(), /personal:alice: backend local is not configured/);
  assert.deepEqual(await records.all(), []);
  assert.deepEqual(await defaults.all(), []);
  assert.equal(await marker.get("explicit-defaults"), null);
  await createSandboxResources(options).initialize();
  assert.ok((await defaults.get("personal:alice"))?.sandboxId);
});

test("legacy import does not validate obsolete provider choices after explicit selection or clearing", async () => {
  const { options, upgrade, defaults, marker } = fixture(undefined, ["personal:cleared", "personal:selected"]);
  await defaults.put("personal:cleared", { sandboxId: null });
  await defaults.put("personal:selected", { sandboxId: "newer-computer" });
  await createSandboxResources({ ...options, upgrade: upgrade({ availableBackends: [] }) }).initialize();
  assert.deepEqual(await defaults.get("personal:cleared"), { sandboxId: null });
  assert.deepEqual(await defaults.get("personal:selected"), { sandboxId: "newer-computer" });
  assert.ok(await marker.get("explicit-defaults"));
});
