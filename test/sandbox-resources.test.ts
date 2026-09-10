import { createBackgroundBroker } from "../src/connectors/background-exec-broker.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { createDeviceFlowCutoverStore } from "../src/credentials/device-flow-cutover.ts";
import { createTurnSandboxes, type TurnSandboxContext } from "../src/core/orchestrator/sandboxes.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSandboxResources,
  type SandboxResource,
  type SandboxDefault,
  type SandboxResourceRollout,
} from "../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter, type SandboxRoute } from "../src/sandbox/sandbox-routing.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

function fixture(configure?: (backend: Sandbox) => void, legacyScopes = ["personal:alice"]) {
  const records = createMemoryMap<SandboxResource>();
  const defaults = createMemoryMap<SandboxDefault>();
  const routes = createMemoryMap<SandboxRoute>();
  const rollout = createMemoryMap<SandboxResourceRollout>();
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
  const options = {
    enabled: true,
    rollout,
    legacyScopes: async () => legacyScopes,
    records,
    defaults,
    routes,
    backends: { local: backend },
    defaultBackend: "local",
    lock: createMemoryAdvisoryLock(),
    canUseScope: async (actor: string, scope: string) => actor === "admin" || scope === `personal:${actor}`,
  } satisfies Parameters<typeof createSandboxResources>[0];
  const resources = createSandboxResources(options);
  const router = createSandboxRouter({ routes, backends: { local: backend }, defaultBackend: "local", resources });
  const layers = [{ scopeId: "personal:alice", mode: "rw" as const, mountPath: "/" }];
  return { records, defaults, routes, resources, router, provisioned, layers, backend, options, rollout };
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
  assert.equal(await resources.resolve("personal:new"), null);
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

for (const shared of [false, true])
  test(`explicit target receives the same credential cleanup and restore as default (${shared ? "isolated shared automation" : "personal"})`, async () => {
    const scripts: Array<{ id: string; script: string }> = [];
    const restoredTars: Array<{ id: string; bytes: Uint8Array }> = [];
    const scope = shared ? "channel:team" : "personal:alice";
    const owner = shared ? scope : "alice";
    let failCleanupFor: string | undefined;
    const { resources, router } = fixture(
      (backend) => {
        backend.run = async (handle, script) => {
          scripts.push({ id: handle.id, script });
          if (handle.id === failCleanupFor && script.includes("rm -rf --")) {
            failCleanupFor = undefined;
            return { stdout: "", stderr: "cleanup failed", code: 1, timedOut: false };
          }
          return { stdout: "", stderr: "", code: 0, timedOut: false };
        };
        backend.writeFileBytes = async (handle, path, bytes) => {
          if (path.endsWith(".tar")) restoredTars.push({ id: handle.id, bytes });
        };
      },
      [scope],
    );
    const record = await resources.create("admin", scope, "local");
    const owners: string[] = [];
    const resetMarks: unknown[][] = [];
    const cutover = createDeviceFlowCutoverStore(createMemoryMap(), { resets: createMemoryMap() });
    await cutover.set(scope, "aws", "ephemeral_only", "admin");
    await cutover.set(scope, "aws", "legacy", "admin");
    const turn = createTurnSandboxes({
      deps: {
        sandbox: router,
        sandboxResources: resources,
        keychain: {
          listByOwner: async (id: string) => {
            owners.push(id);
            return [
              { kind: "file", service: "aws", origin: "device-flow-auto-capture", targets: [".aws/config"] },
              { kind: "file", service: "gh", origin: "device-flow-auto-capture", targets: [".config/gh/hosts.yml"] },
            ];
          },
          materializeOwnFiles: async (id: string) => {
            owners.push(id);
            return [
              {
                service: "aws",
                origin: "device-flow-auto-capture",
                files: [{ path: ".aws/config", contentBase64: Buffer.from("allowed-token").toString("base64") }],
              },
              {
                service: "gh",
                origin: "device-flow-auto-capture",
                files: [
                  {
                    path: ".config/gh/hosts.yml",
                    contentBase64: Buffer.from("quarantined-token").toString("base64"),
                  },
                ],
              },
            ];
          },
        },
        deviceFlowCutover: {
          ...cutover,
          markResidentReset: async (...args: Parameters<typeof cutover.markResidentReset>) => {
            resetMarks.push(args);
            await cutover.markResidentReset(...args);
          },
        },
      },
      input: { origin: shared ? { kind: "automation", useOwnerKeychain: true } : { kind: "user" } },
      actor: { id: "alice", type: "internal" },
      session: { id: "s" },
      resolution: { layers: [{ scopeId: scope, mode: "rw", mountPath: "/" }] },
      scopeId: scope,
      memoryScopeId: scope,
      transferId: "t",
      turnSessionDir: "turn/s",
      turnFilesDir: "turn/s/t",
      connectorEnv: {},
      isolateOwnerKeychain: shared,
      ownerAuthAvailable: false,
      ownerEnvCredentialIds: [],
      credentialTools: [
        { service: "aws", roots: [".aws"] },
        { service: "gh", roots: [".config/gh"] },
      ],
      credentialServices: ["aws"],
      credentialCutoverServices: [],
      quarantinedServices: ["gh"],
      cutoverModeOf: () => "legacy",
      visibleSkills: [],
      visibleSkillsForTurn: async () => [],
      emitGapWork: () => {},
      perf: { credsMs: 0 },
    } as unknown as TurnSandboxContext);
    if (shared) {
      failCleanupFor = scope;
      await assert.rejects(turn.provision(), /quarantine failed/);
      turn.invalidateProvision();
    }
    const legacyId = (await resources.list("admin", scope)).defaultSandboxId;
    const defaultHandle = shared ? await turn.provisionResource(legacyId!) : await turn.provision();
    failCleanupFor = record.backingScopeId;
    await assert.rejects(turn.provisionResource(record.id), /quarantine failed/);
    const explicit = await turn.provisionResource(record.id);
    assert.ok(owners.length >= 6);
    assert.ok(owners.every((id) => id === owner));
    assert.equal(resetMarks.length, 2);
    for (const handle of [defaultHandle, explicit]) {
      assert.ok(
        scripts.some(
          ({ id, script }) =>
            id === handle.id &&
            script.includes("rm -rf --") &&
            script.includes(".config/gh") &&
            script.includes(".aws"),
        ),
      );
      const tar = restoredTars.find(({ id }) => id === handle.id);
      assert.ok(tar);
      assert.ok(Buffer.from(tar.bytes).includes(Buffer.from("allowed-token")));
      assert.ok(!Buffer.from(tar.bytes).includes(Buffer.from("quarantined-token")));
    }
  });

test("disabled readers honor explicit defaults and refuse management without activating", async () => {
  const { options, defaults, records, backend, routes, rollout, layers, provisioned } = fixture(undefined, []);
  const resources = createSandboxResources({ ...options, enabled: false });
  const router = createSandboxRouter({ backends: { local: backend }, defaultBackend: "local", routes, resources });
  assert.equal(await resources.resolve("personal:alice"), undefined);
  const old = await router.provision(layers);
  assert.equal(old.id, "personal:alice");
  assert.equal(await rollout.get("explicit-defaults"), null);
  const record = (await records.all())[0]!;
  await defaults.put("personal:alice", { sandboxId: record.id });
  assert.equal((await resources.resolve("personal:alice"))?.id, record.id);
  await defaults.put("personal:alice", { sandboxId: null });
  await assert.rejects(router.provision(layers), /no default sandbox/);
  for (const action of [
    () => resources.create("alice", "personal:alice", "local"),
    () => resources.setDefault("alice", "personal:alice", record.id),
    () => resources.restart("alice", record.id),
    () => resources.retire("alice", record.id),
  ])
    await assert.rejects(action(), /management is disabled/);
  assert.deepEqual(provisioned, ["personal:alice"]);
});

test("activation preserves routes, cold identities and explicit nulls without calling a provider", async () => {
  const { options, records, defaults, routes, rollout, provisioned } = fixture(undefined, []);
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
    legacyScopes: async () => ["personal:old-session", "personal:unset"],
    legacySandboxes: async () => [
      { scopeId: "personal:routed", backend: "modal", machineId: "sb-old" },
      { scopeId: "personal:routed", backend: "e2b", machineId: "e2b-cold" },
      { scopeId: "sandbox-managed", backend: "local", machineId: "managed-machine" },
    ],
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
  assert.ok(await rollout.get("explicit-defaults"));
  const inventory = await resources.list("admin", "personal:routed");
  assert.ok(inventory.sandboxes.some((r) => r.backend === "e2b" && r.machineId === "e2b-cold"));
  assert.ok(!inventory.sandboxes.some((r) => r.legacy && r.backingScopeId === "sandbox-managed"));
  assert.deepEqual(inventory.sandboxes.find((r) => r.id === routed!.id)?.availableActions, []);
  assert.deepEqual(provisioned, []);
  assert.equal((await routes.get("personal:routed"))?.backend, "modal");
  const rollbackReader = createSandboxResources({ ...options, enabled: false });
  assert.equal(await rollbackReader.resolve("personal:new-after-activation"), null);
  assert.equal((await rollbackReader.resolve("personal:routed"))?.id, routed?.id);
});

test("activation retries partial durable writes without losing defaults or creating machines", async () => {
  const { options, defaults, rollout, records, provisioned } = fixture(undefined, [
    "personal:first",
    "personal:second",
  ]);
  const put = defaults.putIfAbsent;
  let fail = true;
  defaults.putIfAbsent = async (id, value) => {
    if (id === "personal:second" && fail) throw new Error("database interrupted");
    return put(id, value);
  };
  const resources = createSandboxResources(options);
  await assert.rejects(resources.resolve("personal:first"), /database interrupted/);
  assert.equal(await rollout.get("explicit-defaults"), null);
  const first = await defaults.get("personal:first");
  await defaults.put("personal:first", { sandboxId: null });
  fail = false;
  await Promise.all([resources.resolve("personal:first"), resources.resolve("personal:second")]);
  assert.ok(first?.sandboxId);
  assert.equal(await resources.resolve("personal:first"), null);
  assert.equal((await records.all()).length, 2);
  assert.ok(await rollout.get("explicit-defaults"));
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

test("activation and a compatible reader publish a late legacy computer without losing its default", async () => {
  const { options, defaults, records } = fixture(undefined, []);
  const enumerating = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<string[]>();
  const active = createSandboxResources({
    ...options,
    legacyScopes: () => {
      enumerating.resolve();
      return resume.promise;
    },
  });
  const reader = createSandboxResources({ ...options, enabled: false });
  const activation = active.initialize();
  await enumerating.promise;
  const publication = reader.recordLegacy("personal:late", "local", { id: "late-machine", rootDir: "/workspace" });
  resume.resolve([]);
  await activation;
  const id = await publication;
  assert.deepEqual(await defaults.get("personal:late"), { sandboxId: id });
  assert.equal((await reader.resolve("personal:late"))?.id, id);
  assert.equal((await records.get(id))?.machineId, "late-machine");
  await defaults.put("personal:cleared", { sandboxId: null });
  await reader.recordLegacy("personal:cleared", "local", { id: "in-flight", rootDir: "/workspace" });
  assert.equal(await reader.resolve("personal:cleared"), null);
});

test("activation waits for a compatible legacy route mutation and rejects later mutations", async () => {
  const { options, routes } = fixture(undefined, []);
  const reader = createSandboxResources({ ...options, enabled: false });
  const active = createSandboxResources(options);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const mutation = reader.withLegacyMutation("personal:moving", async () => {
    entered.resolve();
    await resume.promise;
    await routes.put("personal:moving", { backend: "modal" });
  });
  await entered.promise;
  const activation = active.initialize();
  resume.resolve();
  await Promise.all([mutation, activation]);
  assert.equal((await active.resolve("personal:moving"))?.backend, "modal");
  let changed = false;
  await assert.rejects(
    reader.withLegacyMutation("personal:moving", async () => {
      changed = true;
    }),
    /retired/,
  );
  assert.equal(changed, false);
});

test("a legacy migration queued behind activation fails before its action runs", async () => {
  const { options } = fixture(undefined, []);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<string[]>();
  const active = createSandboxResources({
    ...options,
    legacyScopes: () => {
      entered.resolve();
      return resume.promise;
    },
  });
  const reader = createSandboxResources({ ...options, enabled: false });
  const activation = active.initialize();
  await entered.promise;
  let changed = false;
  const rejected = assert.rejects(
    reader.withLegacyMutation("personal:late", async () => {
      changed = true;
    }),
    /retired/,
  );
  resume.resolve([]);
  await Promise.all([activation, rejected]);
  assert.equal(changed, false);
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
  const { options, backend, routes, layers } = fixture((sandbox) => {
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
  const router = createSandboxRouter({ resources, routes, backends: { local: backend }, defaultBackend: "local" });
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
  const starting = broker.start(handle, "sleep 60");
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
  await assert.rejects(broker.start(handle, "sleep 60"), /registry unavailable/);
  assert.deepEqual(signals, ["unregistered:KILL"]);
  await resources.retire("alice", record.id);
  assert.equal((await resources.get(record.id)).cleanupPending, false);
});
