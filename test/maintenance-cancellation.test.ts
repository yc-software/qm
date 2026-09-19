import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withOperationSignal, withTimeout, sleep } from "../src/util/async.ts";
import { createSweeper } from "../src/util/sweeper.ts";
import { createGitFetcher } from "../src/skills/pack-fetcher.ts";
import { spawnDockerExec } from "../src/sandbox/docker-exec.ts";
import { createMicrovmApi, vmFetch } from "../src/sandbox/aws-microvm-api.ts";
import { createSdkModalClient } from "../src/sandbox/modal-client.ts";
import { createAgent37Sandbox } from "../src/sandbox/agent37-sandbox.ts";
import { createSmolmachinesSandbox } from "../src/sandbox/smolmachines-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createReaperKillHook } from "../src/processes/process-reaper.ts";
import type { ProcessSandbox } from "../src/sandbox/sandbox.ts";
import type { ProcessRecord } from "../src/processes/process-registry.ts";

for (const kind of ["git", "docker"] as const) {
  test(
    `maintenance cancellation kills and joins an active ${kind} process group`,
    { skip: process.platform === "win32" },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "qm-maintenance-cancel-"));
      const executable = join(dir, "hang");
      const pidFile = join(dir, "pid");
      const helperPidFile = join(dir, "helper-pid");
      const helperScript = `import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(helperPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      await writeFile(
        executable,
        `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nimport { spawn } from 'node:child_process';\nprocess.on('SIGTERM', () => {});\nspawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(helperScript)}], { stdio: 'inherit' });\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
      );
      await chmod(executable, 0o755);
      const controller = new AbortController();
      const work = withOperationSignal(controller.signal, () =>
        kind === "docker"
          ? spawnDockerExec(executable)(["inspect"])
          : createGitFetcher({ gitBin: executable, allowLocalRepos: true }).resolveRef({
              id: "one",
              kind: "git",
              url: dir,
              ref: "main",
              syncMode: "tracked",
              trustTier: "internal",
              targetScopeId: "org:test",
              subset: "all",
              createdBy: "U1",
              createdAt: 0,
            }),
      );
      const rejected = assert.rejects(work);
      try {
        const pids = await withTimeout(
          async () => {
            for (;;) {
              const values = await Promise.all(
                [pidFile, helperPidFile].map((path) => readFile(path, "utf8").catch(() => "")),
              );
              if (values.every(Boolean)) return values.map(Number);
              await sleep(5);
            }
          },
          2000,
          "child startup",
        );
        controller.abort();
        await withTimeout(() => rejected, 1000, "child cancellation");
        await withTimeout(
          async () => {
            for (const pid of pids) {
              for (;;) {
                try {
                  process.kill(pid, 0);
                } catch (error) {
                  assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
                  break;
                }
                await sleep(5);
              }
            }
          },
          1_000,
          "process group exit",
        );
      } finally {
        controller.abort();
        await rejected;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}

for (const kind of ["control", "daemon"] as const) {
  test(`stopping maintenance aborts the active AWS ${kind} HTTP request`, async () => {
    const entered = Promise.withResolvers<void>();
    let settled = false;
    const fetchImpl = (async (_url, init) => {
      entered.resolve();
      await new Promise<never>((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => {
            settled = true;
            reject(init!.signal!.reason);
          },
          { once: true },
        );
      });
      return new Response("{}");
    }) as typeof fetch;
    const api = createMicrovmApi({
      region: "test",
      credentials: async () => ({ accessKeyId: "test", secretAccessKey: "test" }),
      fetchImpl,
    });
    const sweeper = createSweeper(
      () => (kind === "control" ? api.getMicrovm("one") : vmFetch("test", "token", "/health", { fetchImpl })),
      60_000,
      { immediate: true },
    );
    sweeper.start();
    await entered.promise;
    await withTimeout(() => sweeper.stop(), 1000, "HTTP cancellation");
    assert.equal(settled, true);
  });
}

for (const kind of ["agent37", "smolmachines"] as const) {
  test(`maintenance cancellation aborts ${kind} provisioning before another request can start`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "qm-maintenance-provider-"));
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    let requests = 0;
    const fetchImpl = (async (_url, init) => {
      requests++;
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    }) as typeof fetch;
    const workspace = createLocalWorkspaceStore(dir);
    const sandbox =
      kind === "agent37"
        ? createAgent37Sandbox(workspace, { apiKey: "test", fetchImpl })
        : createSmolmachinesSandbox(workspace, { token: "test", fetchImpl });
    const pending = withOperationSignal(controller.signal, () =>
      sandbox.provision([{ scopeId: "personal:test", mountPath: "/", mode: "rw" }]),
    );
    const rejected = assert.rejects(pending);
    try {
      await withTimeout(() => entered.promise, 1000, "provider request startup");
      controller.abort();
      await withTimeout(() => rejected, 1000, "provider cancellation");
      assert.equal(requests, 1);
    } finally {
      controller.abort();
      await rejected;
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("cancelled maintenance cannot signal a process after its provision barrier resolves", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const provision = Promise.withResolvers<{ id: string; rootDir: string }>();
  let signals = 0;
  let teardowns = 0;
  const sandbox = {
    provision: async () => {
      entered.resolve();
      return provision.promise;
    },
    signalProcess: async () => void signals++,
    teardown: async () => void teardowns++,
  } as unknown as ProcessSandbox;
  const record = { scopeId: "personal:test", processId: "one" } as ProcessRecord;
  const pending = withOperationSignal(controller.signal, () => createReaperKillHook(sandbox)(record));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered.promise;
  controller.abort();
  provision.resolve({ id: "sandbox-one", rootDir: "/workspace" });
  await rejected;
  assert.equal(signals, 0);
  assert.equal(teardowns, 1);
});

test("maintenance cancellation closes only its Modal command channel and waits for the RPC to settle", async (t) => {
  const entered = Promise.withResolvers<void>();
  const handles: Array<{ detached: boolean }> = [];
  t.mock.module("modal", {
    namedExports: {
      ModalClient: class {
        apps = { fromName: async () => ({}) };
        images = { fromRegistry: () => ({}) };
        sandboxes = {
          fromId: async (sandboxId: string) => {
            const pending = Promise.withResolvers<{ imageId: string }>();
            const handle = {
              sandboxId,
              detached: false,
              poll: async () => null,
              snapshotDirectory: () => {
                entered.resolve();
                return pending.promise;
              },
              detach() {
                this.detached = true;
                pending.reject(new Error("RPC channel closed"));
              },
            };
            handles.push(handle);
            return handle;
          },
        };
      },
    },
  });
  const client = createSdkModalClient({ tokenId: "test", tokenSecret: "test", appName: "test", image: "test" });
  const original = await client.fromId("sb-one");
  const controller = new AbortController();
  const result = withOperationSignal(controller.signal, () => original.snapshotHome!());
  const rejected = assert.rejects(result, { name: "AbortError" });
  await entered.promise;
  controller.abort();
  await withTimeout(() => rejected, 1000, "Modal cancellation");
  assert.equal(handles.length, 2);
  assert.equal(handles[0]!.detached, false);
  assert.equal(handles[1]!.detached, true);
});
