import { test } from "node:test";
import assert from "node:assert/strict";
import { createSandboxRouter, NoDefaultSandboxError, type SandboxBackendName } from "../src/sandbox/sandbox-routing.ts";
import type { SandboxResource, SandboxResources } from "../src/sandbox/sandbox-resources.ts";
import {
  CapabilityUnsupportedError,
  SandboxProvisionCleanupError,
  supportsScopeProfile,
} from "../src/sandbox/sandbox.ts";
import type {
  Sandbox,
  SandboxHandle,
  ExecResult,
  AgentComputerProfile,
  ProvisionOptions,
} from "../src/sandbox/sandbox.ts";
import type { ScopeId, WorkspaceLayer } from "../src/types.ts";

type Fake = Sandbox & { calls: string[]; provisioned: Array<{ layers: WorkspaceLayer[]; opts?: ProvisionOptions }> };

function fakeBackend(name: string): Fake {
  const calls: string[] = [];
  const provisioned: Fake["provisioned"] = [];
  const profile: AgentComputerProfile = { backend: name, writablePersistence: "resident_disk", processSessions: true };
  const s: Partial<Sandbox> & { calls: string[]; provisioned: Fake["provisioned"] } = {
    calls,
    provisioned,
    profile,
    async provision(layers: WorkspaceLayer[], opts?: ProvisionOptions): Promise<SandboxHandle> {
      provisioned.push({ layers, ...(opts ? { opts } : {}) });
      calls.push(`provision:${layers[0]?.scopeId ?? "-"}`);
      return { id: `${name}-box`, rootDir: `/${name}/workspace` };
    },
    async run(_h, command): Promise<ExecResult> {
      calls.push(`run:${command}`);
      return { stdout: name, stderr: "", code: 0, timedOut: false };
    },
    async teardown() {
      calls.push("teardown");
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async writeFileBytes() {},
    async readFileBytes() {
      return null;
    },
    async listDir() {
      return [];
    },
    async removeDir() {},
    async startProcess() {
      return { processId: "p" };
    },
    async readProcess() {
      return { chunks: "", cursor: 0, status: { state: "exited" as const, code: 0 } };
    },
    async writeStdin() {},
    async signalProcess() {},
    async listProcesses() {
      return [];
    },
  };
  return s as Fake;
}

const resource = (id: string, backend: SandboxBackendName, ownerScopeId = "personal:a"): SandboxResource => ({
  id,
  backend,
  ownerScopeId: ownerScopeId as ScopeId,
  backingScopeId: `sandbox:${id}`,
  name: id,
  createdBy: "u",
  createdAt: "2026-10-01T00:00:00Z",
  legacy: false,
  state: "ready",
});

function stubResources(defaults: Record<string, SandboxResource | null>, extra: SandboxResource[] = []) {
  const byId = new Map<string, SandboxResource>();
  for (const r of [...Object.values(defaults), ...extra]) if (r) byId.set(r.id, r);
  const locks: Array<{ id: string; exclusive: boolean }> = [];
  let held = 0;
  const stub = {
    locks,
    isLocked: () => held > 0,
    resolve: async (scopeId: string) => defaults[scopeId] ?? null,
    get: async (id: string) => {
      const r = byId.get(id);
      if (!r) throw new Error(`sandbox ${id} not found`);
      return r;
    },
    use: async <T>(id: string, action: () => Promise<T>, exclusive = false) => {
      locks.push({ id, exclusive });
      held++;
      try {
        return await action();
      } finally {
        held--;
      }
    },
  };
  return stub as typeof stub & SandboxResources;
}

const layersFor = (scopeId: string): WorkspaceLayer[] => [
  { scopeId: scopeId as WorkspaceLayer["scopeId"], mountPath: "/", mode: "rw" },
];

function build(defaults: Record<string, SandboxResource | null>, extra: SandboxResource[] = []) {
  const aws = fakeBackend("aws");
  const sprites = fakeBackend("sprites");
  const resources = stubResources(defaults, extra);
  const errors: Array<{ code: string; message: string; scopeLabel?: string }> = [];
  const router = createSandboxRouter({
    backends: { aws, sprites },
    defaultBackend: "aws",
    resources,
    onError: (e) => errors.push(e),
  });
  return { router, aws, sprites, resources, errors };
}

test("provision uses the scope's default resource: backend, backing scope, lock, and handle tags", async () => {
  const r = resource("r1", "sprites");
  const { router, aws, sprites, resources } = build({ "personal:a": r });
  const h = await router.provision(layersFor("personal:a"));
  assert.equal(h.backend, "sprites");
  assert.equal(h.resourceId, "r1");
  assert.equal(h.scopeId, "personal:a");
  assert.equal(sprites.provisioned[0]!.layers[0]!.scopeId, "sandbox:r1", "rw layer remapped to the backing scope");
  assert.deepEqual(resources.locks, [{ id: "r1", exclusive: false }]);
  assert.deepEqual(aws.calls, []);
});

test("an explicit sandboxId wins over the scope default", async () => {
  const def = resource("def", "aws");
  const pick = resource("pick", "sprites");
  const { router, aws } = build({ "personal:a": def }, [pick]);
  const h = await router.provision(layersFor("personal:a"), { sandboxId: "pick" });
  assert.equal(h.backend, "sprites");
  assert.equal(h.resourceId, "pick");
  assert.deepEqual(aws.calls, []);
});

test("no default resource refuses provision with NoDefaultSandboxError and touches no backend", async () => {
  const { router, aws, sprites } = build({});
  await assert.rejects(router.provision(layersFor("personal:none")), NoDefaultSandboxError);
  assert.deepEqual([...aws.calls, ...sprites.calls], []);
});

test("an inventory read failure propagates instead of falling back to the default backend", async () => {
  const { router, aws, resources } = build({});
  resources.resolve = async () => {
    throw new Error("db down");
  };
  await assert.rejects(router.provision(layersFor("personal:x")), /db down/);
  assert.deepEqual(aws.calls, []);
});

test("provision resolves by routeScopeId when the layers don't name the acting scope", async () => {
  const { router, sprites } = build({ "personal:m": resource("m", "sprites") });
  const h = await router.provision(layersFor("org:global"), { routeScopeId: "personal:m" });
  assert.equal(h.backend, "sprites");
  assert.equal(h.resourceId, "m");
  assert.equal(sprites.provisioned.length, 1);
});

test("a resource on an unconstructed backend refuses to substitute", async () => {
  const { router, aws } = build({ "personal:x": resource("x", "local") });
  await assert.rejects(router.provision(layersFor("personal:x")), /unavailable: local/);
  assert.deepEqual(aws.calls, []);
});

test("scratch picks the default resource's backend but stays isolated from the persistent box", async () => {
  const { router, sprites, resources } = build({ "personal:a": resource("r1", "sprites") });
  const layers = layersFor("personal:a");
  const scratch = { scratch: { key: "turn" }, routeScopeId: "personal:a" } as ProvisionOptions;
  const h = await router.provision(layers, scratch);
  assert.equal(h.backend, "sprites");
  assert.equal(h.scopeId, "personal:a");
  assert.equal(h.resourceId, undefined, "scratch must not claim the persistent resource");
  assert.deepEqual(resources.locks, [], "scratch must not take the resource lock");
  assert.deepEqual(sprites.provisioned[0]!.layers, layers, "scratch keeps its original layers");
  assert.equal(sprites.provisioned[0]!.opts, scratch);
});

test("scratch honours an explicit sandboxId for backend choice only", async () => {
  const { router, aws, sprites, resources } = build({ "personal:a": resource("def", "aws") }, [
    resource("pick", "sprites"),
  ]);
  const h = await router.provision(layersFor("personal:a"), { scratch: { key: "t" }, sandboxId: "pick" });
  assert.equal(h.backend, "sprites");
  assert.equal(h.resourceId, undefined);
  assert.deepEqual(resources.locks, []);
  assert.equal(sprites.provisioned[0]!.layers[0]!.scopeId, "personal:a");
  assert.deepEqual(aws.calls, []);
});

test("scratch with no selected computer uses the installation provider without creating a default", async () => {
  const { router, aws, sprites, resources } = build({});
  const handle = await router.provision([], { scratch: { key: "t" }, routeScopeId: "personal:none" });
  assert.equal(handle.backend, "aws");
  assert.equal(handle.resourceId, undefined);
  assert.equal(aws.provisioned.length, 1);
  assert.deepEqual(sprites.calls, []);
  assert.deepEqual(resources.locks, []);
  assert.equal(await resources.resolve("personal:none"), null);
});

test("failed scratch initialization keeps its selected backend for cleanup", async () => {
  const { router, sprites } = build({ "personal:p": resource("p", "sprites") });
  sprites.provision = async () => {
    throw new SandboxProvisionCleanupError(
      { id: "partial", rootDir: "/workspace", scratch: true },
      new Error("cleanup"),
      new Error("provision"),
    );
  };
  let pending: SandboxHandle | undefined;
  await assert.rejects(router.provision([], { scratch: { key: "turn" }, routeScopeId: "personal:p" }), (e: Error) => {
    assert.ok(e instanceof SandboxProvisionCleanupError);
    pending = e.handle;
    assert.equal(pending.backend, "sprites");
    return true;
  });
  await router.teardown(pending!, { destroy: true });
  assert.deepEqual(sprites.calls, ["teardown"]);
});

test("a handle's later calls follow its backend under the resource lock", async () => {
  const { router, aws, sprites, resources } = build({ "personal:m": resource("m", "sprites") });
  const h = await router.provision(layersFor("personal:m"));
  resources.locks.length = 0;
  assert.equal((await router.run(h, "whoami")).stdout, "sprites");
  await router.teardown(h);
  assert.ok(sprites.calls.includes("run:whoami") && sprites.calls.includes("teardown"));
  assert.ok(!aws.calls.some((c) => c.startsWith("run")));
  assert.deepEqual(
    resources.locks.map((l) => l.id),
    ["m", "m"],
  );
});

test("profileFor reports the resolved resource's provider, explicit id first", async () => {
  const { router } = build({ "personal:m": resource("m", "sprites") }, [resource("x", "aws")]);
  assert.ok(supportsScopeProfile(router));
  if (!supportsScopeProfile(router)) return;
  assert.equal((await router.profileFor("personal:m")).backend, "sprites");
  assert.equal((await router.profileFor("personal:m", "x")).backend, "aws");
});

test("profileFor with no default resource advertises the default backend for bootstrap", async () => {
  const { router } = build({});
  if (!supportsScopeProfile(router)) return assert.fail("router must expose profileFor");
  assert.equal((await router.profileFor("personal:none")).backend, "aws");
});

test("fleet sweeps are absent when no backend implements them", async () => {
  const { router } = build({});
  assert.equal(router.reapDeepIdle, undefined);
  assert.equal(router.computerStatus, undefined);
  assert.equal(router.restartComputer, undefined);
});

test("reapDeepIdle is exposed when a backend implements it, and sums across backends", async () => {
  const aws = fakeBackend("aws");
  (aws as unknown as { reapDeepIdle: unknown }).reapDeepIdle = async () => ({ reaped: 3 });
  const router = createSandboxRouter({
    backends: { aws, sprites: fakeBackend("sprites") },
    defaultBackend: "aws",
    resources: stubResources({}),
  });
  assert.deepEqual(await router.reapDeepIdle!(1000), { reaped: 3 });
});

function capabilitySplit(onError?: (e: { code: string; message: string; scopeLabel?: string }) => void) {
  const aws = fakeBackend("aws");
  (aws as unknown as { exportFiles: unknown }).exportFiles = async () => [];
  const sprites = fakeBackend("sprites");
  delete (sprites as Partial<Sandbox>).exportFiles;
  const router = createSandboxRouter({
    backends: { aws, sprites },
    defaultBackend: "aws",
    resources: stubResources({
      "personal:f": resource("f", "aws"),
      "personal:s": resource("s", "sprites", "personal:s"),
    }),
    ...(onError ? { onError } : {}),
  });
  return router;
}

test("a capability held by SOME backends stays exposed and dispatches per handle", async () => {
  const router = capabilitySplit();
  assert.equal(typeof router.exportFiles, "function");
  assert.deepEqual(await router.exportFiles!(await router.provision(layersFor("personal:f"))), []);
  const onSprites = await router.provision(layersFor("personal:s"));
  await assert.rejects(
    async () => router.exportFiles!(onSprites),
    (e: unknown) =>
      e instanceof CapabilityUnsupportedError && /does not support exportFiles/.test((e as Error).message),
  );
});

test("a capability refusal reaches the operator error stream, scope-labelled and de-duped", async () => {
  const errors: Array<{ code: string; message: string; scopeLabel?: string }> = [];
  const router = capabilitySplit((e) => errors.push(e));
  const handle = await router.provision(layersFor("personal:s"));
  for (let i = 0; i < 3; i++) await assert.rejects(async () => router.exportFiles!(handle));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "capability_unsupported");
  assert.equal(errors[0]!.scopeLabel, "personal:s");
  assert.match(errors[0]!.message, /sprites.*exportFiles/);
});

test("a throwing error sink cannot replace the typed refusal callers catch", async () => {
  const router = capabilitySplit(() => {
    throw new Error("error store is down");
  });
  const handle = await router.provision(layersFor("personal:s"));
  await assert.rejects(
    async () => router.exportFiles!(handle),
    (e: unknown) => e instanceof CapabilityUnsupportedError,
  );
});

function computerBackends() {
  const aws = fakeBackend("aws");
  const sprites = fakeBackend("sprites");
  (sprites as unknown as { computerStatus: unknown }).computerStatus = async (scopeId: string) => {
    sprites.calls.push(`computerStatus:${scopeId}`);
    return { machine: "started", guestResponsive: true };
  };
  (sprites as unknown as { restartComputer: unknown }).restartComputer = async (scopeId: string) => {
    sprites.calls.push(`restartComputer:${scopeId}`);
  };
  return { aws, sprites };
}

test("computer status/restart target the resource's backing scope under its lock", async () => {
  const { aws, sprites } = computerBackends();
  const resources = stubResources({ "personal:s": resource("s", "sprites") });
  const router = createSandboxRouter({ backends: { aws, sprites }, defaultBackend: "aws", resources });
  assert.deepEqual(await router.computerStatus!("personal:s"), { machine: "started", guestResponsive: true });
  await router.restartComputer!("personal:s");
  assert.deepEqual(
    sprites.calls.filter((c) => c.startsWith("computer") || c.startsWith("restart")),
    ["computerStatus:sandbox:s", "restartComputer:sandbox:s"],
  );
  assert.deepEqual(resources.locks, [
    { id: "s", exclusive: false },
    { id: "s", exclusive: true },
  ]);
});

test("computer status/restart with no default resource refuse with NoDefaultSandboxError", async () => {
  const { aws, sprites } = computerBackends();
  const router = createSandboxRouter({
    backends: { aws, sprites },
    defaultBackend: "aws",
    resources: stubResources({}),
  });
  await assert.rejects(async () => router.computerStatus!("personal:none"), NoDefaultSandboxError);
  await assert.rejects(async () => router.restartComputer!("personal:none"), NoDefaultSandboxError);
  assert.deepEqual(sprites.calls, []);
});

test("computer status/restart on a backend without them is a typed refusal", async () => {
  const { aws, sprites } = computerBackends();
  const router = createSandboxRouter({
    backends: { aws, sprites },
    defaultBackend: "sprites",
    resources: stubResources({ "personal:a": resource("a", "aws") }),
  });
  await assert.rejects(async () => router.computerStatus!("personal:a"), CapabilityUnsupportedError);
  await assert.rejects(async () => router.restartComputer!("personal:a"), CapabilityUnsupportedError);
});

for (const combined of [true, false]) {
  test(`cleanup and listing share one resource lock (provider combined=${combined})`, async () => {
    const backend = fakeBackend("sprites");
    const resources = stubResources({});
    const calls: string[] = [];
    backend.removeDir = async (_h, path) => {
      assert.ok(resources.isLocked());
      calls.push(`remove:${path}`);
    };
    backend.listDir = async (_h, path) => {
      assert.ok(resources.isLocked());
      calls.push(`list:${path}`);
      return ["keep/file"];
    };
    if (combined)
      backend.removeDirAndList = async (_h, remove, list) => {
        assert.ok(resources.isLocked());
        calls.push(`combined:${remove}:${list}`);
        return ["keep/file"];
      };
    const router = createSandboxRouter({ backends: { sprites: backend }, defaultBackend: "sprites", resources });
    assert.deepEqual(
      await router.removeDirAndList!(
        { id: "box", rootDir: "/workspace", backend: "sprites", resourceId: "resource" },
        "old",
        "keep",
      ),
      ["keep/file"],
    );
    assert.equal(resources.locks.length, 1);
    assert.deepEqual(calls, combined ? ["combined:old:keep"] : ["remove:old", "list:keep"]);
  });
}
