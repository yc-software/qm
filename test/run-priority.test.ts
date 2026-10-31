import { test } from "node:test";
import assert from "node:assert/strict";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { handbackStop, PARKED, runPriority, type Run, type RunStore } from "../src/runs/run-store.ts";
import { TURN_QUEUES } from "../src/turns/absurd-schema.ts";
import { createTurnRunner } from "../src/turns/turn-runner.ts";
import type { TurnLedger } from "../src/turns/turn-ledger.ts";
import type { Principal, TurnResult } from "../src/types.ts";
import { sleep } from "../src/util/async.ts";
import { eventually } from "./support/settle.ts";
import { claimTurn, finishTurn, testRunStore } from "./support/turns.ts";
import { taskQueues } from "./support/absurd-clock.ts";

const actor: Principal = { id: "internal:U1", type: "internal" };
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

async function claimAll(ledger: TurnLedger): Promise<string[]> {
  const order: string[] = [];
  for (let claimed = await claimTurn(ledger); claimed; claimed = await claimTurn(ledger)) {
    order.push(claimed.run.request.text);
    await finishTurn(claimed, { status: "ok", sessionId: claimed.run.sessionId, reply: "" });
  }
  return order;
}

test("run priority ranks people first, then subagents, then crons and swarms", () => {
  assert.equal(runPriority(request("person"), null), 0);
  assert.equal(runPriority({ ...cron("sub"), delegatingRunId: "r0" }, 0), 1);
  assert.equal(runPriority({ ...cron("subsub"), delegatingRunId: "r1" }, 1), 1);
  assert.equal(runPriority(cron("cron"), null), 2);
  assert.equal(runPriority({ ...cron("swarm"), swarm, delegatingRunId: "r0" }, 0), 2);
  assert.equal(runPriority({ ...cron("cron sub"), delegatingRunId: "r2" }, 2), 2);
});

test("people's turns run first, then their subagents, then background work", async () => {
  const { runs, ledger, databaseUrl, close } = testRunStore();
  try {
    const nightly = (await runs.enqueue({ sessionId: "cron", request: cron("cron") })).run;
    const human = (await runs.enqueue({ sessionId: "dm", request: request("person") })).run;
    const child = (await runs.enqueue({ sessionId: "c", request: subagentOf(human, "subagent") })).run;
    const grandchild = (await runs.enqueue({ sessionId: "g", request: subagentOf(child, "sub-subagent") })).run;
    const cronChild = (await runs.enqueue({ sessionId: "nc", request: subagentOf(nightly, "cron subagent") })).run;
    const worker = (await runs.enqueue({ sessionId: "sw", request: { ...subagentOf(human, "swarm worker"), swarm } }))
      .run;
    const background = (
      await runs.enqueue({ sessionId: "shared", request: cron("background first in its conversation") })
    ).run;
    const person = (await runs.enqueue({ sessionId: "shared", request: request("person second in its conversation") }))
      .run;
    assert.deepEqual(
      await taskQueues(
        databaseUrl,
        await Promise.all(
          [nightly, human, child, grandchild, cronChild, worker, background, person].map(
            async (run) => (await runs.get(run.id))!.absurdTaskId,
          ),
        ),
      ),
      [
        "turns_background",
        "turns_people",
        "turns_delegated",
        "turns_delegated",
        "turns_background",
        "turns_background",
        "turns_background",
        "turns_people",
      ],
    );
    assert.deepEqual(
      (await runs.get(background.id))?.lastStop,
      PARKED,
      "a person writing into a conversation parks its background turn that has not started",
    );
    assert.deepEqual(await claimAll(ledger), [
      "person",
      "person second in its conversation",
      "subagent",
      "sub-subagent",
      "cron",
      "cron subagent",
      "swarm worker",
      "background first in its conversation",
    ]);
  } finally {
    await close();
  }
});

test("a parked run records why it stopped and is not charged a claim", async () => {
  const { runs, ledger, close } = testRunStore();
  try {
    const queued = (await runs.enqueue({ sessionId: "cron", request: cron("cron") })).run;
    const lease = (await claimTurn(ledger, queued.id))!;
    assert.equal(await ledger.handBack(lease.run, lease.token, { stop: PARKED }), true);
    const parked = (await runs.get(queued.id))!;
    assert.deepEqual([parked.status, parked.preemptions, parked.lastStop], ["pending", 1, { kind: "parked" }]);
    const again = (await claimTurn(ledger, queued.id))!;
    assert.equal(again.run.attempts, 2);
    await ledger.handBack(again.run, again.token, { stop: { kind: "shutdown" } });
    assert.equal((await runs.get(queued.id))!.preemptions, 1, "a deploy handback is not a park");
  } finally {
    await close();
  }
});

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

const status = (runs: RunStore, run: Run, want: string) => () =>
  eventually(async () => (await runs.get(run.id))?.status, {
    until: (s) => s === want,
    label: `${run.request.text} ${want}`,
  });

async function withRunner(
  slots: number,
  body: (ctx: { runs: RunStore; log: string[] }) => Promise<void>,
  opts: { maxClaims?: number; setup?: (ctx: { runs: RunStore; ledger: TurnLedger }) => Promise<void> } = {},
): Promise<void> {
  const store = testRunStore();
  const log: string[] = [];
  const runner = createTurnRunner({
    ledger: store.ledger,
    orchestrator: scripted(log),
    queues: TURN_QUEUES,
    slots,
    pollMs: 20,
    ...(opts.maxClaims !== undefined ? { maxClaims: opts.maxClaims } : {}),
  });
  try {
    await opts.setup?.(store);
    runner.start();
    await body({ runs: store.runs, log });
  } finally {
    await runner.stopClaims();
    await runner.releaseInFlight();
    await store.close();
  }
}

test("a busy runner parks a cron turn for a person's turn, then resumes it", () =>
  withRunner(
    1,
    async ({ runs, log }) => {
      const background = (await runs.enqueue({ sessionId: "cron", request: cron("long cron") })).run;
      await status(runs, background, "running")();
      await runs.enqueue({ sessionId: "dm", request: request("quick person") });
      await status(runs, background, "done")();
      assert.equal((await runs.get(background.id))?.preemptions, 1);
      assert.deepEqual(log, [
        "start long cron #1",
        "start quick person #1",
        "finish quick person",
        "start long cron #2 after parked",
        "finish long cron",
      ]);
    },
    { maxClaims: 1 },
  ));

test("one waiting turn parks one run, even while that run is slow to stop", () =>
  withRunner(3, async ({ runs }) => {
    const crons: Run[] = [];
    for (const name of ["a", "b", "c"])
      crons.push((await runs.enqueue({ sessionId: name, request: cron(`slow ${name}`) })).run);
    for (const run of crons) await status(runs, run, "running")();
    const person = (await runs.enqueue({ sessionId: "dm", request: request("quick person") })).run;
    await status(runs, person, "done")();
    const parks = await Promise.all(crons.map(async (run) => (await runs.get(run.id))!.preemptions));
    assert.deepEqual(parks.sort(), [0, 0, 1]);
    assert.equal((await runs.get(crons[2]!.id))!.preemptions, 1, "the newest background turn is the one parked");
  }));

test("subagents of a person's turn and thrice-parked runs keep their slot", () => {
  let capped!: Run;
  return withRunner(
    2,
    async ({ runs, log }) => {
      const parent = (await runs.enqueue({ sessionId: "parent", request: request("quick parent") })).run;
      await status(runs, parent, "done")();
      const child = (await runs.enqueue({ sessionId: "child", request: subagentOf(parent, "forever child") })).run;
      await status(runs, capped, "running")();
      await status(runs, child, "running")();
      const person = (await runs.enqueue({ sessionId: "dm", request: request("quick person") })).run;
      await status(runs, person, "done")();
      assert.equal((await runs.get(child.id))?.status, "running", "a subagent of a person's turn is never parked");
      assert.equal((await runs.get(capped.id))?.status, "running", "a thrice-parked run is not parked again");
      assert.equal((await runs.get(capped.id))?.preemptions, 3);
      assert.equal((await runs.get(capped.id))?.attempts, 4, "parks don't spend a swarm worker's claim budget");
      assert.ok(!log.some((line) => line.includes("#2")), `nothing was restarted: ${log.join(", ")}`);
    },
    {
      setup: async ({ runs, ledger }) => {
        capped = (
          await runs.enqueue({
            sessionId: "cron",
            request: { ...cron("forever cron"), swarm, turnWallClockMs: 60_000 },
          })
        ).run;
        for (let i = 0; i < 3; i++) {
          const lease = (await claimTurn(ledger, capped.id))!;
          await ledger.handBack(lease.run, lease.token, { stop: PARKED });
        }
      },
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
