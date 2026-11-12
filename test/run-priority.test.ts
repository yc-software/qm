import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createRunPreemption, createWorker, type Worker } from "../src/runs/worker.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { handbackStop, PARKED, type Run, type RunStore } from "../src/runs/run-store.ts";
import type { Principal, TurnResult } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

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
  { name: "postgres", skip: false, make: async () => createPostgresRunStore(testDatabaseUrl()).runs },
];

async function claimAll(runs: RunStore): Promise<string[]> {
  const order: string[] = [];
  for (let run = (await runs.claim("w", 60_000))[0] ?? null; run; run = (await runs.claim("w", 60_000))[0] ?? null) {
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
        await runs.enqueue({ sessionId: "th", request: request("reply", { origin: { kind: "ambient", live: true } }) });
        const child = (await runs.enqueue({ sessionId: "c", request: subagentOf(human, "subagent") })).run;
        await runs.enqueue({ sessionId: "g", request: subagentOf(child, "sub-subagent") });
        await runs.enqueue({ sessionId: "nc", request: subagentOf(nightly, "cron subagent") });
        await runs.enqueue({ sessionId: "sw", request: { ...subagentOf(human, "swarm worker"), swarm } });
        await runs.enqueue({ sessionId: "shared", request: cron("background first in its conversation") });
        await runs.enqueue({ sessionId: "shared", request: request("person second in its conversation") });
        await runs.enqueue({ sessionId: "shared", request: cron("background third in its conversation") });
        assert.equal(await runs.personWaiting(Date.now() - 60_000), false, "only turns past the grace period count");
        assert.equal(await runs.personWaiting(Date.now()), true);
        assert.deepEqual(await runs.personWaitingIn(["shared", "cron", "absent"], Date.now() - 60_000), new Set());
        assert.deepEqual(
          await runs.personWaitingIn(["shared", "cron", "absent"], Date.now()),
          new Set(),
          "a person queued behind work that never started waits its turn",
        );
        assert.deepEqual(
          (await runs.inFlightForThread("shared")).map((run) => run.request.text),
          [
            "background first in its conversation",
            "person second in its conversation",
            "background third in its conversation",
          ],
          "runs that never started keep their order",
        );
        assert.deepEqual(await claimAll(runs), [
          "person",
          "reply",
          "subagent",
          "sub-subagent",
          "cron",
          "cron subagent",
          "swarm worker",
          "background first in its conversation",
          "person second in its conversation",
          "background third in its conversation",
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
        const lease = ((await runs.claim("w", 60_000))[0] ?? null)!;
        assert.equal(await runs.releaseLease(lease.id, lease.leaseToken!, { kind: "parked" }), true);
        const parked = (await runs.get(queued.id))!;
        assert.deepEqual(
          [parked.status, parked.preemptions, parked.handbacks, parked.lastStop],
          ["pending", 1, 1, { kind: "parked" }],
        );
        const again = ((await runs.claim("w", 60_000))[0] ?? null)!;
        await runs.releaseLease(again.id, again.leaseToken!, { kind: "shutdown" });
        const handedBack = (await runs.get(queued.id))!;
        assert.deepEqual([handedBack.preemptions, handedBack.handbacks], [1, 2], "a deploy handback is not a park");
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
      if (mode === "forever" || mode === "busy" || (input.attempt === 1 && mode !== "quick")) {
        await new Promise<void>((resolve) => {
          input.shutdown?.addEventListener("abort", () => resolve(), { once: true });
          const step = setInterval(() => {
            if (mode === "busy" || !input.park?.requested()) return;
            clearInterval(step);
            void sleep(mode === "slow" ? 150 : 0).then(() => input.park!.now());
          }, 5);
          input.shutdown?.addEventListener("abort", () => clearInterval(step), { once: true });
        });
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
  slots: number,
  body: (ctx: {
    runs: RunStore;
    log: string[];
    sweep: () => Promise<boolean>;
    worker: Worker;
    running: (run: Run) => () => Promise<boolean>;
  }) => Promise<void>,
  maxClaims?: number,
  setup?: (runs: RunStore) => Promise<void>,
): Promise<void> {
  const { runs } = createPostgresRunStore(testDatabaseUrl(), maxClaims ? { maxClaims } : undefined);
  await setup?.(runs);
  const log: string[] = [];
  const worker = createWorker({ runs, orchestrator: scripted(log), leaseTtlMs: 60_000, pollMs: 5, slots });
  const preemption = createRunPreemption({ runs, worker, graceMs: 0 });
  worker.start();
  try {
    const running = (run: Run) => async () =>
      (await status(runs, run, "running")()) && worker.held().some((held) => held.run.id === run.id);
    await body({ runs, log, sweep: () => preemption.sweep(), worker, running });
  } finally {
    await worker.releaseInFlight();
  }
}

const status = (runs: RunStore, run: Run, want: string) => async () => (await runs.get(run.id))?.status === want;

test("a person's run goes ahead of started background runs only, keeping later work behind the parked run", async () => {
  const { runs, close } = createPostgresRunStore(testDatabaseUrl());
  try {
    const parked = (await runs.enqueue({ sessionId: "c", request: cron("parked cron") })).run;
    const claimed = (await runs.claimById(parked.id, "w", 60_000))!;
    await runs.releaseLease(claimed.id, claimed.leaseToken!, PARKED);
    await runs.enqueue({ sessionId: "c", request: request("person") });
    await runs.enqueue({ sessionId: "c", request: cron("later cron") });
    assert.deepEqual(await runs.personWaitingIn(["c"], Date.now()), new Set(["c"]));
    assert.deepEqual(
      (await runs.inFlightForThread("c")).map((run) => run.request.text),
      ["person", "parked cron", "later cron"],
    );
    assert.deepEqual(await claimAll(runs), ["person", "parked cron", "later cron"]);

    await runs.enqueue({ sessionId: "d", request: cron("unstarted cron") });
    await runs.enqueue({ sessionId: "d", request: request("person behind it") });
    assert.deepEqual(await runs.personWaitingIn(["d"], Date.now()), new Set());
    assert.deepEqual(await claimAll(runs), ["unstarted cron", "person behind it"]);

    const handedBack = (await runs.enqueue({ sessionId: "e", request: cron("cron handed back by a deploy") })).run;
    const running = (await runs.claimById(handedBack.id, "w", 60_000))!;
    await runs.releaseLease(running.id, running.leaseToken!, { kind: "shutdown" });
    await runs.enqueue({ sessionId: "e", request: request("person behind the deploy") });
    assert.deepEqual(await runs.personWaitingIn(["e"], Date.now()), new Set());
    assert.deepEqual(await claimAll(runs), ["cron handed back by a deploy", "person behind the deploy"]);
  } finally {
    await close();
  }
});

test("a busy worker parks a cron turn for a person's turn, then resumes it", () =>
  withWorkers(
    1,
    async ({ runs, log, sweep, running }) => {
      const background = (await runs.enqueue({ sessionId: "cron", request: cron("long cron") })).run;
      await until(running(background));
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

test("a park waiting for its step does not hold back a park for a person in another conversation", () =>
  withWorkers(2, async ({ runs, sweep, running }) => {
    const busy = (await runs.enqueue({ sessionId: "dm", request: cron("busy cron") })).run;
    const other = (await runs.enqueue({ sessionId: "other", request: cron("forever other") })).run;
    await until(running(busy));
    await until(running(other));
    await runs.enqueue({ sessionId: "dm", request: request("quick person in its conversation") });
    assert.equal(await sweep(), true);
    assert.equal((await runs.get(busy.id))!.status, "running", "the busy cron is still inside its step");
    await runs.enqueue({ sessionId: "elsewhere", request: request("quick person elsewhere") });
    assert.equal(await sweep(), true, "the full worker parks another run for the second person");
    await until(async () => (await runs.get(other.id))!.preemptions === 1);
  }));

test("a park request is withdrawn when the person it was for no longer waits", () =>
  withWorkers(2, async ({ runs, sweep, worker, running }) => {
    const busy = (await runs.enqueue({ sessionId: "dm", request: cron("busy cron") })).run;
    await until(running(busy));
    const person = (await runs.enqueue({ sessionId: "dm", request: request("quick person") })).run;
    assert.equal(await sweep(), true);
    assert.equal(worker.held()[0]!.parkRequested, true);
    assert.equal(await runs.withdraw(person.id), true);
    assert.equal(await sweep(), false);
    assert.equal(worker.held()[0]!.parkRequested, false, "the cron keeps running when nobody waits");
  }));

test("a run parked to free a slot and claimed again can be parked again", () =>
  withWorkers(1, async ({ runs, sweep, running }) => {
    const background = (await runs.enqueue({ sessionId: "c", request: cron("forever cron") })).run;
    await until(running(background));
    const first = (await runs.enqueue({ sessionId: "p1", request: request("quick first person") })).run;
    assert.equal(await sweep(), true);
    await until(status(runs, first, "done"));
    await until(async () => (await runs.get(background.id))!.attempts === 2);
    await until(running(background));
    await runs.enqueue({ sessionId: "p2", request: request("quick second person") });
    assert.equal(await sweep(), true, "the re-claimed run is not mistaken for the earlier park");
  }));

test("a person's turn parks the background turn running in its conversation, which then resumes once", () =>
  withWorkers(2, async ({ runs, log, sweep, running }) => {
    const background = (await runs.enqueue({ sessionId: "dm", request: cron("long cron") })).run;
    await until(running(background));
    assert.equal(await sweep(), false, "nothing waits behind it yet");
    await runs.enqueue({ sessionId: "dm", request: request("quick person") });
    assert.equal(await sweep(), true);
    await until(status(runs, background, "done"));
    const resumed = (await runs.get(background.id))!;
    assert.deepEqual([resumed.preemptions, resumed.attempts], [1, 2]);
    assert.deepEqual(log, [
      "start long cron #1",
      "start quick person #1",
      "finish quick person",
      "start long cron #2 after parked",
      "finish long cron",
    ]);
  }));

test("one waiting turn parks one run, even while that run is slow to stop", () =>
  withWorkers(3, async ({ runs, sweep, running }) => {
    const crons: Run[] = [];
    for (const name of ["a", "b", "c"])
      crons.push((await runs.enqueue({ sessionId: name, request: cron(`slow ${name}`) })).run);
    for (const run of crons) await until(running(run));
    const person = (await runs.enqueue({ sessionId: "dm", request: request("quick person") })).run;
    assert.deepEqual([await sweep(), await sweep(), await sweep()], [true, false, false]);
    await until(status(runs, person, "done"));
    const parks = await Promise.all(crons.map(async (run) => (await runs.get(run.id))!.preemptions));
    assert.deepEqual(parks.sort(), [0, 0, 1]);
  }));

test("subagents of a person's turn and thrice-parked runs keep their worker", () => {
  let capped!: Run;
  return withWorkers(
    2,
    async ({ runs, sweep, running }) => {
      const parent = (await runs.enqueue({ sessionId: "parent", request: request("quick parent") })).run;
      await until(status(runs, parent, "done"));
      const child = (await runs.enqueue({ sessionId: "child", request: subagentOf(parent, "forever child") })).run;
      await until(running(capped));
      await until(running(child));
      await runs.enqueue({ sessionId: "dm", request: request("quick person") });
      assert.equal(await sweep(), false);
      assert.equal((await runs.get(capped.id))?.attempts, 4, "parks don't spend a swarm worker's claim budget");
    },
    undefined,
    async (runs) => {
      capped = (
        await runs.enqueue({ sessionId: "cron", request: { ...cron("forever cron"), swarm, turnWallClockMs: 60_000 } })
      ).run;
      for (let i = 0; i < 3; i++) {
        const lease = ((await runs.claim("w", 60_000))[0] ?? null)!;
        await runs.releaseLease(lease.id, lease.leaseToken!, { kind: "parked" });
      }
    },
  );
});

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

test("each run in a batch claim gets its own lease token", async () => {
  const { runs, close } = createPostgresRunStore(testDatabaseUrl());
  try {
    for (const sessionId of ["b1", "b2", "b3"]) await runs.enqueue({ sessionId, request: cron(sessionId) });
    const batch = await runs.claim("w", 60_000, 3);
    assert.equal(batch.length, 3);
    assert.equal(new Set(batch.map((run) => run.leaseToken)).size, 3);
  } finally {
    await close();
  }
});
