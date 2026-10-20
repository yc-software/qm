import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createRunPreemption, createWorker } from "../src/runs/worker.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { handbackStop, PARKED, type Run, type RunStore } from "../src/runs/run-store.ts";
import type { Principal, TurnResult } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const actor: Principal = { id: "internal:U1", type: "internal" };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const request = (text: string, over: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
  actor,
  conversation: { kind: "dm", threadRef: "t", audience: [actor] },
  origin: { kind: "human" },
  text,
  ...over,
});
const cron = (text: string) => request(text, { origin: { kind: "automation" } });
const subagentOf = (parent: Run, text: string) =>
  request(text, { origin: { kind: "automation" }, delegatingRunId: parent.id });
const swarm = { swarmId: "s", messageId: "m", recipientId: "r" };

const backends: Array<{ name: string; skip: string | false; make: () => Promise<RunStore> }> = [
  { name: "memory", skip: false, make: async () => createMemoryRunStore().runs },
  {
    name: "postgres",
    skip: URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres run-priority tests",
    make: async () => {
      const pool = new (await import("pg")).default.Pool({ connectionString: URL });
      await pool.query("DROP TABLE IF EXISTS runs, tool_calls CASCADE");
      await pool.query("DELETE FROM qm_schema_migrations WHERE id LIKE 'runs/%'").catch(() => {});
      await pool.end();
      return createPostgresRunStore(URL!).runs;
    },
  },
];

async function claimAll(runs: RunStore): Promise<string[]> {
  const order: string[] = [];
  for (let run = await runs.claim("w", 60_000); run; run = await runs.claim("w", 60_000)) {
    order.push(run.request.text);
    await runs.complete(run.id, run.leaseToken!, { status: "ok", sessionId: run.sessionId, reply: "" });
  }
  return order;
}

for (const backend of backends) {
  test(
    `[${backend.name}] people's turns run first, then their subagents, then background work`,
    { skip: backend.skip },
    async () => {
      const runs = await backend.make();
      try {
        const nightly = (await runs.enqueue({ sessionId: "cron", request: cron("cron") })).run;
        const human = (await runs.enqueue({ sessionId: "dm", request: request("person") })).run;
        const child = (await runs.enqueue({ sessionId: "c", request: subagentOf(human, "subagent") })).run;
        await runs.enqueue({ sessionId: "g", request: subagentOf(child, "sub-subagent") });
        await runs.enqueue({ sessionId: "nc", request: subagentOf(nightly, "cron subagent") });
        await runs.enqueue({ sessionId: "sw", request: { ...subagentOf(human, "swarm worker"), swarm } });
        await runs.enqueue({ sessionId: "shared", request: cron("background first in its conversation") });
        await runs.enqueue({ sessionId: "shared", request: request("person second in its conversation") });
        assert.equal(await runs.personWaiting(Date.now() - 60_000), false, "only turns past the grace period count");
        assert.equal(await runs.personWaiting(Date.now()), true);
        assert.deepEqual(await claimAll(runs), [
          "person",
          "subagent",
          "sub-subagent",
          "cron",
          "cron subagent",
          "swarm worker",
          "background first in its conversation",
          "person second in its conversation",
        ]);
      } finally {
        await runs.close?.();
      }
    },
  );
}

for (const backend of backends) {
  test(
    `[${backend.name}] a parked run records why it stopped and is not charged a claim`,
    { skip: backend.skip },
    async () => {
      const runs = await backend.make();
      try {
        const queued = (await runs.enqueue({ sessionId: "cron", request: cron("cron") })).run;
        const lease = (await runs.claim("w", 60_000))!;
        assert.equal(await runs.releaseLease(lease.id, lease.leaseToken!, { kind: "parked" }), true);
        const parked = (await runs.get(queued.id))!;
        assert.deepEqual([parked.status, parked.preemptions, parked.lastStop], ["pending", 1, { kind: "parked" }]);
        const again = (await runs.claim("w", 60_000))!;
        await runs.releaseLease(again.id, again.leaseToken!, { kind: "shutdown" });
        assert.equal((await runs.get(queued.id))!.preemptions, 1, "a deploy handback is not a park");
      } finally {
        await runs.close?.();
      }
    },
  );
}

function scripted(log: string[]): Orchestrator {
  return {
    async handleTurn(input: OrchestratorInput): Promise<TurnResult> {
      log.push(`start ${input.text} #${input.attempt}${input.resumeCause ? ` after ${input.resumeCause.kind}` : ""}`);
      const [mode] = input.text.split(" ");
      if (mode === "forever" || (input.attempt === 1 && mode !== "quick")) {
        await new Promise<void>((resolve) =>
          input.shutdown?.addEventListener("abort", () => resolve(), { once: true }),
        );
        if (mode === "slow") await sleep(150);
        return { status: "silent", sessionId: "x", stopped: true };
      }
      log.push(`finish ${input.text}`);
      return { status: "ok", sessionId: "x", reply: input.text };
    },
  } as unknown as Orchestrator;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await check()); i++) await sleep(10);
  assert.ok(await check(), "timed out");
}

async function withWorkers(
  count: number,
  body: (ctx: { runs: RunStore; log: string[]; sweep: () => Promise<boolean> }) => Promise<void>,
  maxClaims?: number,
): Promise<void> {
  const { runs } = createMemoryRunStore(maxClaims ? { maxClaims } : undefined);
  const log: string[] = [];
  const workers = Array.from({ length: count }, () =>
    createWorker({ runs, orchestrator: scripted(log), leaseTtlMs: 60_000, pollMs: 5 }),
  );
  const preemption = createRunPreemption({ runs, workers, graceMs: 0 });
  for (const worker of workers) worker.start();
  try {
    await body({ runs, log, sweep: () => preemption.sweep() });
  } finally {
    await Promise.all(workers.map((worker) => worker.releaseInFlight()));
  }
}

const status = (runs: RunStore, run: Run, want: string) => async () => (await runs.get(run.id))?.status === want;

test("a busy worker parks a cron turn for a person's turn, then resumes it", () =>
  withWorkers(
    1,
    async ({ runs, log, sweep }) => {
      const background = (await runs.enqueue({ sessionId: "cron", request: cron("long cron") })).run;
      await until(status(runs, background, "running"));
      await runs.enqueue({ sessionId: "dm", request: request("quick person") });
      assert.equal(await sweep(), true);
      await until(status(runs, background, "done"));
      assert.equal((await runs.get(background.id))?.preemptions, 1);
      assert.deepEqual(log, [
        "start long cron #1",
        "start quick person #1",
        "finish quick person",
        "start long cron #2 after parked",
        "finish long cron",
      ]);
    },
    1,
  ));

test("one waiting turn parks one run, even while that run is slow to stop", () =>
  withWorkers(3, async ({ runs, sweep }) => {
    const crons: Run[] = [];
    for (const name of ["a", "b", "c"])
      crons.push((await runs.enqueue({ sessionId: name, request: cron(`slow ${name}`) })).run);
    for (const run of crons) await until(status(runs, run, "running"));
    const person = (await runs.enqueue({ sessionId: "dm", request: request("quick person") })).run;
    assert.deepEqual([await sweep(), await sweep(), await sweep()], [true, false, false]);
    await until(status(runs, person, "done"));
    const parks = await Promise.all(crons.map(async (run) => (await runs.get(run.id))!.preemptions));
    assert.deepEqual(parks.sort(), [0, 0, 1]);
  }));

test("subagents of a person's turn and thrice-parked runs keep their worker", () =>
  withWorkers(2, async ({ runs, sweep }) => {
    const parent = (await runs.enqueue({ sessionId: "parent", request: request("quick parent") })).run;
    await until(status(runs, parent, "done"));
    const capped = (
      await runs.enqueue({ sessionId: "cron", request: { ...cron("forever cron"), swarm, turnWallClockMs: 60_000 } })
    ).run;
    for (let i = 0; i < 3; i++) {
      const lease = (await runs.claim("w", 60_000))!;
      await runs.releaseLease(lease.id, lease.leaseToken!, { kind: "parked" });
    }
    const child = (await runs.enqueue({ sessionId: "child", request: subagentOf(parent, "forever child") })).run;
    await until(status(runs, capped, "running"));
    await until(status(runs, child, "running"));
    await runs.enqueue({ sessionId: "dm", request: request("quick person") });
    assert.equal(await sweep(), false);
    assert.equal((await runs.get(capped.id))?.attempts, 4, "parks don't spend a swarm worker's claim budget");
  }));

test("a tool result written after a park records the park, not a deploy", () => {
  const parked = new AbortController();
  parked.abort(PARKED);
  const deploy = new AbortController();
  deploy.abort();
  assert.deepEqual(
    [handbackStop(parked.signal), handbackStop(deploy.signal)],
    [{ kind: "parked" }, { kind: "shutdown" }],
  );
});
