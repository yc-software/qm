import { Readable } from "node:stream";
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
