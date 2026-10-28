import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobComputerSweep } from "../src/processes/job-computers.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import type { SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import type { ProcessSandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

function fixture() {
  const exited = new Set<string>();
  const retired: string[] = [];
  const finished: string[] = [];
  const errors: unknown[] = [];
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const computers: SandboxResource[] = ["job-a", "job-b", "job-new"].map((id) => ({
    id,
    backend: "local",
    ownerScopeId: "channel:room",
    backingScopeId: `sandbox-${id}`,
    name: "background job",
    createdBy: "alice",
    createdAt: id === "job-new" ? new Date().toISOString() : old,
    legacy: false,
    state: "ready",
    jobOnly: true,
  }));
  const processes = createMemoryProcessRegistry();
  const sandbox = {
    async provision(_layers: unknown, opts?: { sandboxId?: string }) {
      return { id: opts!.sandboxId!, rootDir: "/workspace", resourceId: opts!.sandboxId! };
    },
    async teardown() {},
    async listProcesses(handle: SandboxHandle) {
      return (await processes.listByScope("channel:room"))
        .filter((job) => job.sandboxId === handle.resourceId)
        .map((job) => ({
          processId: job.processId,
          status: exited.has(job.processId) ? { state: "exited", code: 0 } : { state: "running" },
        }));
    },
  } as unknown as ProcessSandbox;
  let now = Date.now();
  const provisions: string[] = [];
  const origProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = async (layers, opts) => {
    provisions.push(opts!.sandboxId!);
    return origProvision(layers, opts);
  };
  const failDestroy = new Set<string>();
  const destroyAttempts: string[] = [];
  const sweep = createJobComputerSweep({
    resources: {
      jobComputers: async () => computers.filter((computer) => !retired.includes(computer.id)),
      retireJobComputer: async (id, _seenState) => {
        destroyAttempts.push(id);
        if (failDestroy.has(id)) throw new Error("provider unavailable");
        retired.push(id);
      },
    },
    sandbox,
    processes,
    finish: async (_handle, processId) => void finished.push(processId),
    onError: (error) => void errors.push(error),
    now: () => now,
  });
  return {
    processes,
    exited,
    retired,
    finished,
    errors,
    provisions,
    computers,
    failDestroy,
    destroyAttempts,
    sweep,
    now: () => now,
    advance: (ms: number) => void (now += ms),
  };
}

test("the job sweep retires a job computer only after its jobs end and write back", async () => {
  const f = fixture();
  for (const [processId, sandboxId] of [
    ["p-a", "job-a"],
    ["p-b", "job-b"],
  ] as const)
    await f.processes.register({
      processId,
      scopeId: "channel:room",
      sandboxId,
      kind: "background",
      command: "bg: sync",
      ttlMs: 600_000,
    });
  f.exited.add("p-a");
  await f.sweep();
  assert.deepEqual(f.retired, ["job-a"]);
  assert.deepEqual(f.finished, ["p-a"]);
  assert.equal((await f.processes.get("p-a"))?.status, "exited");
  f.exited.add("p-b");
  await f.sweep();
  assert.deepEqual(f.retired, ["job-a"], "a box checked within the last five minutes is left alone");
  const checksBefore = f.provisions.filter((id) => id === "job-b").length;
  f.advance(5 * 60_000);
  await f.sweep();
  assert.ok(f.retired.includes("job-b"));
  assert.equal(f.provisions.filter((id) => id === "job-b").length, checksBefore + 1);
  assert.deepEqual(f.errors, []);
});

test("a job computer with no job yet gets a grace period from when the sweep first sees it ready", async () => {
  const f = fixture();
  await f.sweep();
  assert.ok(!f.retired.includes("job-new"));
  f.advance(90_000);
  await f.sweep();
  assert.ok(!f.retired.includes("job-new"));
  f.advance(60_000);
  await f.sweep();
  assert.ok(f.retired.includes("job-new"));
  assert.deepEqual(f.provisions, []);
});

test("a job computer stuck provisioning is retired after the limit, and a failed destroy is retried every five minutes", async () => {
  const f = fixture();
  f.computers[0]!.state = "provisioning";
  f.computers[1]!.state = "retired";
  f.computers[1]!.error = "provider unavailable";
  f.failDestroy.add("job-b");
  await f.sweep();
  assert.ok(!f.retired.includes("job-a"), "a box still provisioning is left alone");
  assert.equal(f.destroyAttempts.filter((id) => id === "job-b").length, 1);
  f.advance(60_000);
  await f.sweep();
  assert.equal(f.destroyAttempts.filter((id) => id === "job-b").length, 1, "no retry within five minutes");
  f.failDestroy.delete("job-b");
  f.advance(5 * 60_000);
  f.computers[0]!.createdAt = new Date(f.now() - 16 * 60_000).toISOString();
  await f.sweep();
  assert.ok(f.retired.includes("job-b"));
  assert.ok(f.retired.includes("job-a"), "a box provisioning for over fifteen minutes is retired");
});
