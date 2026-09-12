import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

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

test("cancel during a shared read does not materialize late binary data", async () => {
  const pending = Promise.withResolvers<Uint8Array | null>();
  const started = Promise.withResolvers<void>();
  let writes = 0;
  const { tc } = setup({
    grantedHandles: [
      {
        handlePath: "shared/file.bin",
        ownerPath: "file.bin",
        ownerScopeId: scopeId("personal", "U2"),
        permission: "read",
      },
    ],
    workspace: {
      readBytes: async () => {
        started.resolve();
        return pending.promise;
      },
    } as unknown as ToolContextDeps["workspace"],
    sandbox: {
      writeFileBytes: async () => {
        writes++;
      },
    } as unknown as Sandbox,
  });
  const controller = new AbortController();
  const result = tc.read("shared/file.bin", controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  pending.resolve(new Uint8Array([255, 254, 0]));
  await sleep(0);
  assert.equal(writes, 0);
});

test("cancellation drains an in-flight materialization instead of abandoning writes", async () => {
  const writing = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const { tc } = setup({
    grantedHandles: [
      {
        handlePath: "shared/file.bin",
        ownerPath: "file.bin",
        ownerScopeId: scopeId("personal", "U2"),
        permission: "read",
      },
    ],
    workspace: { readBytes: async () => new Uint8Array([255, 254, 0]) } as unknown as ToolContextDeps["workspace"],
    sandbox: {
      writeFileBytes: async () => {
        writing.resolve();
        await finish.promise;
      },
    } as unknown as Sandbox,
  });
  const controller = new AbortController();
  let settled = false;
  const result = tc.read("shared/file.bin", controller.signal).finally(() => {
    settled = true;
  });
  await writing.promise;
  controller.abort();
  await sleep(10);
  assert.equal(settled, false);
  finish.resolve();
  await assert.rejects(result, { name: "AbortError" });
});
