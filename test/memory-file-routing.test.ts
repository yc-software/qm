import { testTenant } from "./support/test-tenant.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext } from "../src/tools/primitives.ts";
import { MEMORY_FILE, type MemoryService } from "../src/memory/memory-service.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const personal = scopeId("personal", "U1");

function agent(opts: { memoryStart?: string; recall?: boolean } = {}) {
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

  const sandboxFiles = new Map<string, string>();
  const sandbox = {
    async writeFile(_h: SandboxHandle, path: string, data: string) {
      sandboxFiles.set(path, data);
    },
    async readFile(_h: SandboxHandle, path: string) {
      return sandboxFiles.get(path) ?? null;
    },
  } as unknown as Sandbox;

  const ctx = createToolContext({
    tenant: testTenant,
    sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }) as SandboxHandle,
    writableScopeId: personal,
    readOnlyScopeIds: [],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    memory,
    memoryScopeId: personal,
    memoryAccess: { write: personal, read: opts.recall === false ? [] : [personal] },
  });
  return { ctx, sandboxFiles, getDurable: () => durable };
}

test("write() under memory/ is refused with a pointer at the `memory` tool — never a ghost write", async () => {
  const { ctx, sandboxFiles, getDurable } = agent({ memoryStart: "# Memory\n- real fact\n" });
  for (const path of [MEMORY_FILE, "memory/log/2026-06-29.md"]) {
    await assert.rejects(
      () => ctx.write(path, "## Onboarding\n- Onboarding: dismissed v2 on 2026-06-29.\n"),
      /`memory` tool/,
    );
  }
  assert.equal(getDurable(), "# Memory\n- real fact\n", "the durable notebook is untouched");
  assert.equal(sandboxFiles.size, 0);
});

test("read(MEMORY_FILE) returns the MemoryService notebook, not the sandbox/workspace copy", async () => {
  const { ctx } = agent({ memoryStart: "# Memory\n- Onboarding: completed v2 on 2026-06-24.\n" });
  const r = await ctx.read(MEMORY_FILE);
  assert.match(r.content ?? "", /Onboarding: completed v2/);
  assert.equal(r.sourceScopeId, personal);
});

test("read(MEMORY_FILE) never falls back to an unfiltered workspace copy", async () => {
  const { ctx, sandboxFiles } = agent({ memoryStart: "" });
  sandboxFiles.set(MEMORY_FILE, "pre-migration notebook");
  const r = await ctx.read(MEMORY_FILE);
  assert.equal(r.content, "");
});

test("read(MEMORY_FILE) cannot bypass disabled recall or fall back to a sandbox copy", async () => {
  const { ctx, sandboxFiles } = agent({ memoryStart: "# Memory\n- private fact\n", recall: false });
  sandboxFiles.set(MEMORY_FILE, "stale copy");
  await assert.rejects(() => ctx.read(MEMORY_FILE), /memory recall is not enabled/);
});

test("non-memory writes still go to the computer", async () => {
  const { ctx, sandboxFiles, getDurable } = agent();
  await ctx.write("notes/todo.txt", "buy milk");
  assert.equal(sandboxFiles.get("notes/todo.txt"), "buy milk");
  assert.equal(getDurable(), "");
});

test("a write whose path holds a long run of slashes returns promptly", async () => {
  const { ctx, sandboxFiles } = agent();
  const path = `notes${"/".repeat(100_000)}todo.txt`;
  const started = performance.now();
  await ctx.write(path, "buy milk");
  const elapsedMs = performance.now() - started;
  assert.equal(sandboxFiles.get(path), "buy milk");
  assert.ok(elapsedMs < 1_000, `write took ${Math.round(elapsedMs)} ms`);
});
