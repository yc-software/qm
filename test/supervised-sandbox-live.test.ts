import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { spawnDockerExec } from "../src/sandbox/docker-exec.ts";
import { sleep } from "../src/util/async.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSandbox } from "../src/sandbox/local-sandbox.ts";
import { createSupervisedSandbox } from "../src/sandbox/supervised-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
test(
  "production supervisor adapter isolates credentials, retains workspace, and cancels children",
  { skip: process.env.QM_SUPERVISOR_DOCKER_TEST !== "1", timeout: 120_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "qm-supervisor-live-"));
    const workspace = createLocalWorkspaceStore(directory);
    const docker = spawnDockerExec("docker");
    const raw = createLocalSandbox(workspace, {
      image: process.env.QM_SUPERVISOR_LOCAL_IMAGE ?? "qm-sandbox-local:latest",
      dockerExec: (args, timeout) =>
        docker(
          args[0] === "network" && args[1] === "create" && process.env.QM_SUPERVISOR_TEST_SUBNET
            ? [...args.slice(0, 2), "--subnet", process.env.QM_SUPERVISOR_TEST_SUBNET, ...args.slice(2)]
            : args,
          timeout,
        ),
    });
    const box = createSupervisedSandbox(raw, { workspace, trust: createMemoryMap(), lock: createNoopAdvisoryLock() });
    let handle;
    try {
      handle = await box.provision([], { scratch: { key: `supervisor-integration-${process.pid}-${Date.now()}` } });
      const r = await box.run(handle, 'test "$SELECTED" = synthetic-value && cat "$HOME/.config/probe/token"', {
        credentials: {
          env: { SELECTED: "synthetic-value" },
          files: [{ path: ".config/probe/token", data: Buffer.from("synthetic-file") }],
        },
      });
      assert.equal(r.code, 0, JSON.stringify(r));
      assert.equal(r.stdout, "synthetic-file");
      assert.equal((await box.run(handle, 'test -z "$SELECTED" && test ! -e "$HOME/.config/probe/token"')).code, 0);
      await box.writeFile(handle, "output/result", "shared");
      assert.equal(await box.readFile(handle, "output/result"), "shared");
      assert.equal((await box.run(handle, "ln -s /dev/shm/qm-supervisor private-link")).code, 0);
      assert.equal(await box.readFile(handle, "private-link/nope"), null);
      const p = await box.startProcess!(handle, "printf background-ok; sleep 1");
      const out = await box.readProcess!(handle, p.processId, { waitMs: 2000 });
      assert.match(out.chunks, /background-ok/);
      const large = Buffer.alloc(1024 * 1024, 120);
      await box.writeFileBytes(handle, "large.bin", large);
      assert.deepEqual(Buffer.from((await box.readFileBytes(handle, "large.bin"))!), large);
      const controller = new AbortController();
      const running = box.run(
        handle,
        "echo started > cancel-ready; (sleep 2; echo survived > cancel-survivor) & sleep 60",
        { signal: controller.signal, credentials: { env: { CANCEL_SECRET: "synthetic-cancel" }, files: [] } },
      );
      const observed = running.then(
        () => ({ ok: true }),
        (error) => ({ error }),
      );
      for (let i = 0; i < 50; i++) {
        if (await box.readFile(handle, "cancel-ready")) break;
        await sleep(100);
      }
      assert.equal((await box.readFile(handle, "cancel-ready"))?.trim(), "started");
      controller.abort();
      const cancelled = await observed;
      assert.ok("error" in cancelled);
      await sleep(2200);
      assert.equal(await box.readFile(handle, "cancel-survivor"), null);
    } finally {
      if (handle) await box.teardown(handle, { destroy: true });
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
