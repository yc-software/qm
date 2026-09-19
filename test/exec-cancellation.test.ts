import assert from "node:assert/strict";
import test from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { spawnDockerExec } from "../src/sandbox/docker-exec.ts";
import { killableScript, killScript, runKillable } from "../src/sandbox/exec-kill.ts";
import { createDurableTasks } from "../src/durable/tasks.ts";
import { isolatedPostgres } from "./support/isolated-postgres.ts";
import {
  assertOperationActive,
  getOperationSignal,
  withAbort,
  withCleanupSignal,
  withOperationSignal,
  withTimeout,
} from "../src/util/async.ts";

for (const explicit of [false, true]) {
  test(`remote exec cancellation joins fresh cleanup with ${explicit ? "explicit and ambient" : "ambient-only"} signals`, async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const killing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pinned = new AsyncLocalStorage<string>();
    let cleanupSignal: AbortSignal | undefined;
    let settled = false;
    const running = pinned.run("original-provider-instance", () =>
      withOperationSignal(controller.signal, () =>
        runKillable(
          async (script) => {
            assertOperationActive();
            if (script.startsWith("i=0")) {
              assert.equal(pinned.getStore(), "original-provider-instance");
              cleanupSignal = getOperationSignal();
              assert.notEqual(cleanupSignal, controller.signal);
              assert.equal(cleanupSignal?.aborted, false);
              killing.resolve();
              await release.promise;
              assertOperationActive();
              return { code: 0, stdout: "", stderr: "", timedOut: false };
            }
            entered.resolve();
            return withAbort(() => new Promise(() => {}), getOperationSignal());
          },
          "sleep 30",
          60,
          explicit ? controller.signal : undefined,
        ),
      ),
    );
    const rejected = assert
      .rejects(running, (error) => error === controller.signal.reason)
      .finally(() => {
        settled = true;
      });
    try {
      await entered.promise;
      withOperationSignal(controller.signal, () => controller.abort());
      await withTimeout(() => killing.promise, 1000, "fresh cleanup entered");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      release.resolve();
      await rejected;
      assert.equal(cleanupSignal?.aborted, true);
    } finally {
      controller.abort();
      release.resolve();
      await rejected;
    }
  });
}

test("cleanup deadlines are bounded and do not reopen the canceled caller", async () => {
  const controller = new AbortController();
  await withOperationSignal(controller.signal, async () => {
    controller.abort();
    let cleanup: AbortSignal | undefined;
    await assert.rejects(
      withCleanupSignal(10, async () => {
        cleanup = getOperationSignal();
        assert.equal(cleanup?.aborted, false);
        return withAbort(() => new Promise(() => {}), cleanup);
      }),
      { name: "TimeoutError" },
    );
    assert.equal(cleanup?.aborted, true);
    assert.equal(getOperationSignal(), controller.signal);
    assert.throws(assertOperationActive, (error) => error === controller.signal.reason);
  });
});

test(
  "real Docker cancellation kills the remote process group before its second write",
  { skip: process.env.QM_TEST_DOCKER !== "1", timeout: 30000 },
  async () => {
    const docker = spawnDockerExec("docker");
    const container = `qm-exec-cancel-${randomUUID()}`;
    const controller = new AbortController();
    const created = await docker(["run", "--rm", "-d", "--name", container, "node:24-bookworm-slim", "sleep", "60"]);
    assert.equal(created.code, 0, created.stderr);
    let rejected: Promise<void> | undefined;
    try {
      const running = withOperationSignal(controller.signal, () =>
        runKillable(
          async (script, timeoutSec) => ({
            ...(await docker(["exec", container, "sh", "-c", script], timeoutSec * 1000)),
            timedOut: false,
          }),
          "echo before >> /tmp/writes; sleep 8; echo after >> /tmp/writes",
          15,
        ),
      );
      rejected = assert.rejects(running, (error) => error === controller.signal.reason);
      const readyBy = Date.now() + 5000;
      await withTimeout(
        async () => {
          for (;;) {
            assert.ok(Date.now() < readyBy, "Docker command must start before the deadline");
            const written = await docker(["exec", container, "cat", "/tmp/writes"]);
            if (written.stdout === "before\n") break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        },
        5000,
        "Docker command first write",
      );
      const started = Date.now();
      withOperationSignal(controller.signal, () => controller.abort());
      await rejected;
      assert.ok(Date.now() - started < 5000, "cancellation must join remote cleanup promptly");
      await new Promise((resolve) => setTimeout(resolve, 8100));
      const written = await docker(["exec", container, "cat", "/tmp/writes"]);
      assert.equal(written.code, 0, written.stderr);
      assert.equal(written.stdout, "before\n");
      const markers = await docker(["exec", container, "sh", "-c", "find /tmp -name '.exec-*.pgid'"]);
      assert.equal(markers.code, 0, markers.stderr);
      assert.equal(markers.stdout, "");
      const delayed = randomUUID();
      const cancelled = await docker(["exec", container, "sh", "-c", killScript(delayed)]);
      assert.equal(cancelled.code, 0, cancelled.stderr);
      const late = await docker(["exec", container, "sh", "-c", killableScript("echo late >> /tmp/writes", delayed)]);
      assert.equal(late.code, 130, late.stderr);
      assert.equal((await docker(["exec", container, "cat", "/tmp/writes"])).stdout, "before\n");
      const exited = await docker(["exec", container, "sh", "-c", killableScript("exit 7", randomUUID())]);
      assert.equal(exited.code, 7, exited.stderr);
      const replaced = await docker([
        "exec",
        container,
        "sh",
        "-c",
        killableScript(
          `exec sh -c 'printf "%s|%s\\n" "$1" "$2"; printf "exec-warning" >&2; exit 7' _ 'one two' '$literal'`,
          randomUUID(),
        ),
      ]);
      assert.equal(replaced.code, 7, replaced.stderr);
      assert.equal(replaced.stdout, "one two|$literal\n");
      assert.equal(replaced.stderr, "exec-warning");
      assert.equal((await docker(["exec", container, "sh", "-c", "find /tmp -name '.exec-*.pgid'"])).stdout, "");
    } finally {
      controller.abort();
      await rejected;
      await docker(["rm", "-f", container]);
    }
  },
);

for (const postgres of [false, true]) {
  test(
    `${postgres ? "Postgres" : "memory"} handoff deadline does not wait for remote cleanup or charge its late failure`,
    { skip: postgres && !process.env.DATABASE_URL },
    async () => {
      const db = postgres ? await isolatedPostgres() : undefined;
      const tasks = createDurableTasks({ databaseUrl: db?.url, queue: "qm_exec_cleanup" });
      const entered = Promise.withResolvers<void>();
      const killing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<unknown>();
      const attempts: number[] = [];
      const errors: unknown[] = [];
      tasks.register("work", async (context) => {
        attempts.push(context.attempt);
        if (attempts.length > 1) return "replacement";
        return context.step("effect", async () => {
          try {
            return await runKillable(
              async (script) => {
                assertOperationActive();
                if (script.startsWith("i=0")) {
                  killing.resolve();
                  await release.promise;
                  return { code: 1, stdout: "", stderr: "unconfirmed remote cleanup", timedOut: false };
                }
                entered.resolve();
                return withAbort(() => new Promise(() => {}), getOperationSignal());
              },
              "sleep 30",
              60,
            );
          } catch (error) {
            finished.resolve(error);
            throw error;
          }
        });
      });
      const { taskId } = await tasks.spawn("work", {}, { idempotencyKey: "cleanup", maxAttempts: 1 });
      const retiring = tasks.start({ pollIntervalMs: 5, onError: (error) => errors.push(error) });
      try {
        await withTimeout(() => entered.promise, 2000, "remote command entered");
        retiring.requestHandoff(20);
        await withTimeout(() => killing.promise, 1000, "remote cleanup entered");
        await withTimeout(() => retiring.drained(), 1000, "handoff ignores pending remote cleanup");
        tasks.start({ pollIntervalMs: 5, onError: (error) => errors.push(error) });
        assert.equal(await withTimeout(() => tasks.result(taskId), 2000, "successor completes"), "replacement");
        assert.deepEqual(attempts, [1, 1]);
        release.resolve();
        assert.match(String(await withTimeout(() => finished.promise, 1000, "late cleanup failure")), /cleanup failed/);
        assert.equal(await tasks.result(taskId), "replacement");
        assert.deepEqual(errors, []);
      } finally {
        release.resolve();
        await tasks.close();
        await db?.cleanup();
      }
    },
  );
}
