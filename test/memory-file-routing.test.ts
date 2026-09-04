import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext } from "../src/tools/primitives.ts";
import { MEMORY_FILE, type MemoryService } from "../src/memory/memory-service.ts";
import { scopeId, type ScopeId, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import type { WorkspaceStore } from "../src/workspace/workspace-store.ts";

const personal = scopeId("personal", "U1");

function harness(opts: { memoryStart?: string; recall?: boolean } = {}) {
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
    persistWritesToStore: { excludeDirs: [] },
  });
  return { ctx, wsWrites, sandboxFiles, getDurable: () => durable };
}

test("write() under memory/ is refused with a pointer at the `memory` tool — never a ghost write", async () => {
  const { ctx, wsWrites, sandboxFiles, getDurable } = harness({ memoryStart: "# Memory\n- real fact\n" });
  for (const path of [MEMORY_FILE, "memory/log/2026-06-29.md"]) {
    await assert.rejects(
      () => ctx.write(path, "## Onboarding\n- Onboarding: dismissed v2 on 2026-06-29.\n"),
      /`memory` tool/,
    );
  }
  assert.equal(getDurable(), "# Memory\n- real fact\n", "the durable notebook is untouched");
  assert.equal(wsWrites.length, 0);
  assert.equal(sandboxFiles.size, 0);
});

test("read(MEMORY_FILE) returns the MemoryService notebook, not the sandbox/workspace copy", async () => {
  const { ctx } = harness({ memoryStart: "# Memory\n- Onboarding: completed v2 on 2026-06-24.\n" });
  const r = await ctx.read(MEMORY_FILE);
  assert.match(r.content ?? "", /Onboarding: completed v2/);
  assert.equal(r.sourceScopeId, personal);
});

test("read(MEMORY_FILE) falls back to the workspace/sandbox copy only when the notebook is empty", async () => {
  const { ctx, sandboxFiles } = harness({ memoryStart: "" });
  sandboxFiles.set(MEMORY_FILE, "pre-migration notebook");
  const r = await ctx.read(MEMORY_FILE);
  assert.equal(r.content, "pre-migration notebook");
});

test("read(MEMORY_FILE) cannot bypass disabled recall or fall back to a sandbox copy", async () => {
  const { ctx, sandboxFiles } = harness({ memoryStart: "# Memory\n- private fact\n", recall: false });
  sandboxFiles.set(MEMORY_FILE, "stale copy");
  await assert.rejects(() => ctx.read(MEMORY_FILE), /memory recall is not enabled/);
});

test("non-memory writes still go to the workspace file store", async () => {
  const { ctx, wsWrites, getDurable } = harness();
  await ctx.write("notes/todo.txt", "buy milk");
  assert.equal(wsWrites.includes("notes/todo.txt"), true);
  assert.equal(getDurable(), "");
});
