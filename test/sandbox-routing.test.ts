import { test } from "node:test";
import assert from "node:assert/strict";
import { createSandboxRouter, type SandboxRoute } from "../src/sandbox/sandbox-routing.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { CapabilityUnsupportedError, supportsScopeProfile } from "../src/sandbox/sandbox.ts";
import type { Sandbox, SandboxHandle, ExecResult, AgentComputerProfile } from "../src/sandbox/sandbox.ts";
import type { WorkspaceLayer } from "../src/types.ts";

function fakeBackend(name: string): Sandbox & { calls: string[] } {
  const calls: string[] = [];
  const profile: AgentComputerProfile = { backend: name, writablePersistence: "resident_disk", processSessions: true };
  const s: Partial<Sandbox> & { calls: string[] } = {
    calls,
    profile,
    async provision(layers: WorkspaceLayer[]): Promise<SandboxHandle> {
      calls.push(`provision:${(layers[0] as WorkspaceLayer).scopeId}`);
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
  return s as Sandbox & { calls: string[] };
}

const layersFor = (scopeId: string): WorkspaceLayer[] => [
  { scopeId: scopeId as WorkspaceLayer["scopeId"], mountPath: "/", mode: "rw" },
];

function build(routeSeed?: Record<string, SandboxRoute>) {
  const routes = createMemoryMap<SandboxRoute>();
  const aws = fakeBackend("aws");
  const sprites = fakeBackend("sprites");
  const router = createSandboxRouter({ backends: { aws, sprites }, routes, defaultBackend: "aws" });
  const seed = async () => {
    for (const [k, v] of Object.entries(routeSeed ?? {})) await routes.put(k, v);
  };
  return { router, aws, sprites, routes, seed };
}

test("absent route → default backend; a route → the routed backend", async () => {
  const { router, aws, sprites, seed } = build({ "personal:migrated": { backend: "sprites" } });
  await seed();
  const h1 = await router.provision(layersFor("personal:unrouted"));
  assert.equal(h1.backend, "aws");
  assert.ok(aws.calls.includes("provision:personal:unrouted"));
  const h2 = await router.provision(layersFor("personal:migrated"));
  assert.equal(h2.backend, "sprites");
  assert.ok(sprites.calls.includes("provision:personal:migrated"));
});

test("a handle's later calls follow the backend that provisioned it", async () => {
  const { router, aws, sprites, seed } = build({ "personal:m": { backend: "sprites" } });
  await seed();
  const h = await router.provision(layersFor("personal:m"));
  const r = await router.run(h, "whoami");
  assert.equal(r.stdout, "sprites");
  await router.teardown(h);
  assert.ok(sprites.calls.includes("run:whoami") && sprites.calls.includes("teardown"));
  assert.ok(!aws.calls.some((c) => c.startsWith("run")), "aws must not have seen the routed handle");
});

test("profileFor returns the substrate the scope is actually on", async () => {
  const { router, seed } = build({ "personal:m": { backend: "sprites" } });
  await seed();
  assert.ok(supportsScopeProfile(router));
  if (!supportsScopeProfile(router)) return;
  assert.equal((await router.profileFor("personal:unrouted")).backend, "aws");
  assert.equal((await router.profileFor("personal:m")).backend, "sprites");
});

test("a route to an unconstructed backend falls back to default, surfaced not thrown", async () => {
  const routes = createMemoryMap<SandboxRoute>();
  await routes.put("personal:x", { backend: "local" });
  const aws = fakeBackend("aws");
  const errors: string[] = [];
  const router = createSandboxRouter({
    backends: { aws },
    routes,
    defaultBackend: "aws",
    onError: (e) => errors.push(e.code),
  });
  const h = await router.provision(layersFor("personal:x"));
  assert.equal(h.backend, "aws");
  assert.ok(errors.includes("backend_unavailable"));
});

test("fleet sweeps are absent when no backend implements them", async () => {
  const { router } = build();
  assert.equal(router.reapDeepIdle, undefined);
});

test("reapDeepIdle is exposed when a backend implements it, and sums across backends", async () => {
  const routes = createMemoryMap<SandboxRoute>();
  const aws = fakeBackend("aws");
  (aws as unknown as { reapDeepIdle: unknown }).reapDeepIdle = async () => ({ reaped: 3 });
  const sprites = fakeBackend("sprites");
  const router = createSandboxRouter({ backends: { aws, sprites }, routes, defaultBackend: "aws" });
  assert.equal(typeof router.reapDeepIdle, "function");
  assert.deepEqual(await router.reapDeepIdle!(1000), { reaped: 3 });
});

test("a capability held by SOME backends stays exposed and dispatches per handle", async () => {
  const routes = createMemoryMap<SandboxRoute>();
  const aws = fakeBackend("aws");
  (aws as unknown as { backupComputer: unknown }).backupComputer = async () => [];
  const sprites = fakeBackend("sprites");
  delete (sprites as Partial<Sandbox>).backupComputer;
  await routes.put("personal:s", { backend: "sprites" });
  const router = createSandboxRouter({ backends: { aws, sprites }, routes, defaultBackend: "aws" });
  assert.equal(typeof router.backupComputer, "function");
  const onAws = await router.provision(layersFor("personal:f"));
  assert.deepEqual(await router.backupComputer!(onAws), []);
  const onSprites = await router.provision(layersFor("personal:s"));
  await assert.rejects(
    async () => router.backupComputer!(onSprites),
    (e: unknown) => {
      assert.ok(e instanceof CapabilityUnsupportedError);
      assert.match((e as Error).message, /does not support backupComputer/);
      return true;
    },
  );
});

test("a capability refusal reaches the operator error stream, scope-labelled and de-duped", async () => {
  const routes = createMemoryMap<SandboxRoute>();
  const aws = fakeBackend("aws");
  (aws as unknown as { backupComputer: unknown }).backupComputer = async () => [];
  const sprites = fakeBackend("sprites");
  delete (sprites as Partial<Sandbox>).backupComputer;
  await routes.put("personal:s", { backend: "sprites" });
  const errors: Array<{ code: string; message: string; scopeLabel?: string }> = [];
  const router = createSandboxRouter({
    backends: { aws, sprites },
    routes,
    defaultBackend: "aws",
    onError: (e) => errors.push(e),
  });
  const handle = await router.provision(layersFor("personal:s"));
  await assert.rejects(async () => router.backupComputer!(handle));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "capability_unsupported");
  assert.equal(errors[0]!.scopeLabel, "personal:s");
  assert.match(errors[0]!.message, /sprites.*backupComputer/);
  await assert.rejects(async () => router.backupComputer!(handle));
  await assert.rejects(async () => router.backupComputer!(handle));
  assert.equal(errors.length, 1, "a repeated refusal must not re-report");
});

test("a handle-keyed refusal names the scope its box belongs to", async () => {
  const routes = createMemoryMap<SandboxRoute>();
  const aws = fakeBackend("aws");
  const thin = fakeBackend("sprites");
  delete (thin as Partial<Sandbox>).backupComputer;
  (aws as unknown as { backupComputer: unknown }).backupComputer = async () => [];
  await routes.put("personal:s", { backend: "sprites" });
  const errors: Array<{ scopeLabel?: string; message: string }> = [];
  const router = createSandboxRouter({
    backends: { aws, sprites: thin },
    routes,
    defaultBackend: "aws",
    onError: (e) => errors.push(e),
  });
  const handle = await router.provision(layersFor("personal:s"));
  await assert.rejects(async () => router.backupComputer!(handle));
  assert.equal(errors[0]!.scopeLabel, "personal:s", "publish's silent fallback must still name the scope");
});

test("a throwing error sink cannot replace the typed refusal callers catch", async () => {
  const routes = createMemoryMap<SandboxRoute>();
  const aws = fakeBackend("aws");
  (aws as unknown as { backupComputer: unknown }).backupComputer = async () => [];
  const sprites = fakeBackend("sprites");
  delete (sprites as Partial<Sandbox>).backupComputer;
  await routes.put("personal:s", { backend: "sprites" });
  const router = createSandboxRouter({
    backends: { aws, sprites },
    routes,
    defaultBackend: "aws",
    onError: () => {
      throw new Error("error store is down");
    },
  });
  const handle = await router.provision(layersFor("personal:s"));
  await assert.rejects(
    async () => router.backupComputer!(handle),
    (e: unknown) => {
      assert.ok(e instanceof CapabilityUnsupportedError);
      return true;
    },
  );
});

test("a routing-store read failure propagates instead of silently routing to the default", async () => {
  const routes = createMemoryMap<SandboxRoute>();
  const broken = {
    ...routes,
    get: async () => {
      throw new Error("db down");
    },
  };
  const aws = fakeBackend("aws");
  const router = createSandboxRouter({ backends: { aws }, routes: broken, defaultBackend: "aws" });
  await assert.rejects(router.provision(layersFor("personal:x")), /db down/);
});

test("provision routes by routeScopeId when the layers don't name the acting scope", async () => {
  const { router, sprites, seed } = build({ "personal:m": { backend: "sprites" } });
  await seed();
  const h = await router.provision(layersFor("org:global"), { routeScopeId: "personal:m" });
  assert.equal(h.backend, "sprites");
  assert.ok(sprites.calls.includes("provision:org:global"));
});
