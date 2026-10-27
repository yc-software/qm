import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { MEMORY_FILE, type MemoryService } from "../../src/memory/memory-service.ts";
import type { SandboxAccessPlan } from "../../src/sandbox/sandbox-resources.ts";
import type { Sandbox, SandboxHandle } from "../../src/sandbox/sandbox.ts";
import { createToolContext, type ToolContextDeps } from "../../src/tools/tool-context.ts";
import { scopeId, type WorkspaceLayer, type ScopeId } from "../../src/types.ts";
import type { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

function setup(overrides: Partial<ToolContextDeps> = {}) {
  const pending = Promise.withResolvers<string | null>();
  const started = Promise.withResolvers<void>();
  let reads = 0;
  const tc = createToolContext({
    sandbox: {
      readFile: async () => {
        reads++;
        started.resolve();
        return pending.promise;
      },
    } as unknown as Sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }),
    layers: [
      { scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" },
      { scopeId: scopeId("org", "o"), mountPath: "global", mode: "ro" },
    ],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    ...overrides,
  });
  return { tc, pending, started, reads: () => reads };
}

test("cancelled file reads settle before IO and do not start fallback reads", async () => {
  const { tc, pending, started, reads } = setup();
  const controller = new AbortController();
  let settled = false;
  const result = tc
    .read("notes.md", controller.signal)
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  await started.promise;
  controller.abort();
  await sleep(30);
  const promptly = settled;
  pending.resolve(null);
  const outcome = await result;
  await sleep(10);
  assert.equal(promptly, true);
  assert.ok("error" in outcome && outcome.error.name === "AbortError");
  assert.equal(reads(), 1);
});

test("already cancelled reads never start IO", async () => {
  const { tc, pending, reads } = setup();
  pending.resolve("data");
  await assert.rejects(tc.read("notes.md", AbortSignal.abort()), { name: "AbortError" });
  assert.equal(reads(), 0);
});

test("cancel during a shared artifact read settles without touching a sandbox", async () => {
  const pending = Promise.withResolvers<Buffer>();
  const started = Promise.withResolvers<void>();
  const ownerScopeId = scopeId("personal", "U2");
  const { tc, reads } = setup({
    grantedHandles: [{ handlePath: "shared/file.bin", fileId: "file-id", ownerScopeId, permission: "read" }],
    files: {
      get: async () => ({ id: "file-id", name: "file.bin", ownerScopeId }),
      open: async () => ({
        artifact: { id: "file-id", name: "file.bin", ownerScopeId },
        sizeBytes: 3,
        stream: Readable.from(
          (async function* () {
            started.resolve();
            yield await pending.promise;
          })(),
        ),
      }),
    } as unknown as ToolContextDeps["files"],
    provision: async () => {
      throw new Error("must not provision");
    },
  });
  const controller = new AbortController();
  const result = tc.read("shared/file.bin", controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  pending.resolve(Buffer.from([255, 254, 0]));
  await sleep(0);
  assert.equal(reads(), 0);
});

const conversation = scopeId("channel", "C1");
const other = scopeId("channel", "C2");
const defaultBox: SandboxHandle = { id: "default", rootDir: "/workspace" };
const selectedBox: SandboxHandle = { id: "selected", rootDir: "/workspace" };

function plan(id: string, ownerScopeId: string, crossScope = false): SandboxAccessPlan {
  return {
    resource: { id, ownerScopeId, backingScopeId: `sandbox-${id}` },
    crossScope,
  } as unknown as SandboxAccessPlan;
}

function harness(opts: { access?: SandboxAccessPlan; extra?: Partial<ToolContextDeps> } = {}) {
  const disks = new Map<string, Map<string, string>>([
    ["default", new Map([["notes.md", "default copy"]])],
    [
      "selected",
      new Map([
        ["notes.md", "selected copy"],
        ["app/server.js", "listen()"],
      ]),
    ],
  ]);
  const stored: Array<{ scope: string; path: string }> = [];
  const deployed: Array<Record<string, unknown>> = [];
  let defaultProvisions = 0;
  const layers: WorkspaceLayer[] = [{ scopeId: conversation, mountPath: "", mode: "rw" }];
  const sandbox = {
    profile: { backend: "modal" },
    readFile: async (h: SandboxHandle, path: string) => disks.get(h.id)?.get(path) ?? null,
    readFileBytes: async (h: SandboxHandle, path: string) => {
      const v = disks.get(h.id)?.get(path);
      return v === undefined ? null : new TextEncoder().encode(v);
    },
    writeFile: async (h: SandboxHandle, path: string, data: string) => {
      disks.get(h.id)!.set(path, data);
    },
    listDir: async (h: SandboxHandle) => [...disks.get(h.id)!.keys()].filter((p) => p.startsWith("app/")),
  } as unknown as Sandbox;
  const ctx = createToolContext({
    sandbox,
    provision: async () => {
      defaultProvisions += 1;
      return defaultBox;
    },
    sandboxResources: { resolve: async () => ({ id: "default" }) } as never,
    accessSandboxResource: async (id) => {
      if (!opts.access || opts.access.resource.id !== id) throw new Error(`sandbox not found: ${id}`);
      return opts.access;
    },
    provisionResource: async (input, authorize) => {
      authorize?.(input as SandboxAccessPlan);
      return selectedBox;
    },
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {
      write: async (scope: string, path: string) => {
        stored.push({ scope, path });
      },
    } as never,
    files: {} as never,
    acl: {} as never,
    deploy: {
      getDeployment: async () => ({ entrypoint: "node server.js" }),
      deployOrUpdate: async (input: Record<string, unknown>) => {
        deployed.push(input);
        return { id: "d1", name: "site", currentVersion: 2, createdInScope: input.createdInScope };
      },
      deploymentGrantees: async () => [],
    } as never,
    createdBy: "U1",
    ...opts.extra,
  });
  return { ctx, disks, stored, deployed, provisions: () => defaultProvisions };
}

test("a selected sandbox read never falls back to the default computer", async () => {
  const h = harness({ access: plan("sb1", conversation) });
  assert.deepEqual(await h.ctx.read("notes.md", undefined, "sb1"), {
    content: "selected copy",
    sourceScopeId: conversation,
  });
  await assert.rejects(h.ctx.read("notes.md", undefined, "missing"), /sandbox not found: missing/);
  await assert.rejects(h.ctx.read("notes.md", undefined, ""), /must name a sandbox/);
  assert.equal(h.provisions(), 0);
});

test("a selected write persists to that computer's backing store, not the conversation default", async () => {
  const h = harness({ access: plan("sb1", conversation) });
  await h.ctx.write("notes.md", "edited", "sb1");
  assert.equal(h.disks.get("selected")!.get("notes.md"), "edited");
  assert.equal(h.disks.get("default")!.get("notes.md"), "default copy");
  assert.deepEqual(h.stored, [{ scope: conversation, path: "sandbox-files/sb1/notes.md" }]);
  assert.equal(h.provisions(), 0);
});

test("another conversation's computer can be read but not written", async () => {
  const h = harness({ access: plan("sb2", other, true) });
  assert.equal((await h.ctx.read("notes.md", undefined, "sb2")).sourceScopeId, other);
  await assert.rejects(h.ctx.write("notes.md", "x", "sb2"), /owned by this conversation/);
  assert.equal(h.disks.get("selected")!.get("notes.md"), "selected copy");
  assert.deepEqual(h.stored, []);
});

test("publish reads files from the selected sandbox while the app stays owned by its creator", async () => {
  const h = harness({ access: plan("sb2", other, true) });
  await h.ctx.publish({ dir: "app", entrypoint: "node server.js", name: "site", sandboxId: "sb2" });
  assert.equal(h.provisions(), 0);
  const [deploy] = h.deployed;
  assert.equal(deploy!.ownerScopeId, scopeId("personal", "U1"));
  assert.equal(deploy!.createdInScope, conversation);
  assert.deepEqual(
    (deploy!.files as Array<{ path: string }>).map((f) => f.path),
    ["server.js"],
  );
});

test("metadata-only publish needs no computer but still rejects an unknown sandbox", async () => {
  const h = harness();
  await h.ctx.publish({ name: "site", rollbackTo: 1 });
  assert.equal(h.provisions(), 0);
  await assert.rejects(h.ctx.publish({ name: "site", rollbackTo: 1, sandboxId: "missing" }), /sandbox not found/);
  assert.equal(h.deployed.length, 1);
});

test("naming the default sandbox explicitly persists exactly like omitting it", async () => {
  const access = plan("sb1", conversation);
  const h = harness({
    access,
    extra: {
      provision: async () => ({ ...selectedBox, resourceId: "sb1" }),
      sandboxResources: { get: async () => access.resource, resolve: async () => access.resource } as never,
    },
  });
  await h.ctx.write("notes.md", "implicit");
  await h.ctx.write("notes.md", "explicit", "sb1");
  assert.deepEqual(new Set(h.stored.map((e) => `${e.scope} ${e.path}`)), new Set([`${conversation} notes.md`]));
});

test("an absolute path inside a computer's workspace reads and writes like its workspace path", async () => {
  const h = harness({ access: plan("sb1", conversation) });
  assert.equal((await h.ctx.read("/workspace/notes.md", undefined, "sb1")).content, "selected copy");
  assert.equal((await h.ctx.read("/workspace/./notes.md")).content, "default copy");
  await h.ctx.write("/workspace/notes.md", "edited", "sb1");
  assert.equal(h.disks.get("selected")!.get("notes.md"), "edited");
  assert.deepEqual(h.stored, [{ scope: conversation, path: "sandbox-files/sb1/notes.md" }]);
});

test("an absolute path outside the workspace reads nothing and says so", async () => {
  const h = harness({ access: plan("sb1", conversation) });
  for (const path of ["/elsewhere/notes.md", "/workspace/../etc/notes.md"])
    assert.deepEqual(await h.ctx.read(path, undefined, "sb1"), {
      content: null,
      sourceScopeId: null,
      outsideWorkspace: true,
    });
  assert.deepEqual(await h.ctx.read("/workspace/absent.md", undefined, "sb1"), { content: null, sourceScopeId: null });
  await assert.rejects(h.ctx.write("/etc/notes.md", "x", "sb1"), /not in the computer's workspace/);
  assert.equal(h.disks.get("selected")!.has("etc/notes.md"), false);
});

const personal = scopeId("personal", "U1");

function memoryFileRoutingHarness(opts: { memoryStart?: string; recall?: boolean } = {}) {
  let durable = opts.memoryStart ?? "";
  const memory = {
    async read() {
      return durable;
    },
    async replace(_s: ScopeId, content: string) {
      durable = content;
    },
    async recall() {
      return "";
    },
    async capture() {
      return 0;
    },
    async query() {
      return [];
    },
  } as unknown as MemoryService;

  const wsWrites: string[] = [];
  const workspace = {
    async write(_s: ScopeId, path: string) {
      wsWrites.push(path);
    },
    async read() {
      return null;
    },
  } as unknown as WorkspaceStore;

  const sandboxFiles = new Map<string, string>();
  const sandbox = {
    async writeFile(_h: SandboxHandle, path: string, data: string) {
      sandboxFiles.set(path, data);
    },
    async readFile(_h: SandboxHandle, path: string) {
      return sandboxFiles.get(path) ?? null;
    },
  } as unknown as Sandbox;

  const layers: WorkspaceLayer[] = [{ scopeId: personal, mountPath: "", mode: "rw" }];
  const ctx = createToolContext({
    sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }) as SandboxHandle,
    layers,
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    memory,
    memoryScopeId: personal,
    memoryAccess: { write: personal, read: opts.recall === false ? [] : [personal] },
  });
  return { ctx, wsWrites, sandboxFiles, getDurable: () => durable };
}

test("write() under memory/ is refused with a pointer at the `memory` tool — never a ghost write", async () => {
  const { ctx, wsWrites, sandboxFiles, getDurable } = memoryFileRoutingHarness({
    memoryStart: "# Memory\n- real fact\n",
  });
  for (const path of [MEMORY_FILE, "memory/log/2026-06-29.md"]) {
    await assert.rejects(() => ctx.write(path, "## Preferences\n- Prefers short replies.\n"), /`memory` tool/);
  }
  assert.equal(getDurable(), "# Memory\n- real fact\n", "the durable notebook is untouched");
  assert.equal(wsWrites.length, 0);
  assert.equal(sandboxFiles.size, 0);
});

test("read(MEMORY_FILE) returns the MemoryService notebook, not the sandbox/workspace copy", async () => {
  const { ctx } = memoryFileRoutingHarness({ memoryStart: "# Memory\n- Prefers short replies.\n" });
  const r = await ctx.read(MEMORY_FILE);
  assert.match(r.content ?? "", /Prefers short replies/);
  assert.equal(r.sourceScopeId, personal);
});

test("read(MEMORY_FILE) never falls back to an unfiltered workspace copy", async () => {
  const { ctx, sandboxFiles } = memoryFileRoutingHarness({ memoryStart: "" });
  sandboxFiles.set(MEMORY_FILE, "pre-migration notebook");
  const r = await ctx.read(MEMORY_FILE);
  assert.equal(r.content, "");
});

test("read(MEMORY_FILE) cannot bypass disabled recall or fall back to a sandbox copy", async () => {
  const { ctx, sandboxFiles } = memoryFileRoutingHarness({ memoryStart: "# Memory\n- private fact\n", recall: false });
  sandboxFiles.set(MEMORY_FILE, "stale copy");
  await assert.rejects(() => ctx.read(MEMORY_FILE), /memory recall is not enabled/);
});

test("non-memory writes still go to the workspace file store", async () => {
  const { ctx, wsWrites, getDurable } = memoryFileRoutingHarness();
  await ctx.write("notes/todo.txt", "buy milk");
  assert.equal(wsWrites.includes("notes/todo.txt"), true);
  assert.equal(getDurable(), "");
});
