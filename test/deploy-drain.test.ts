import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorker } from "../src/runs/worker.ts";
import { createDrainController } from "../src/runs/drain.ts";
import { createPostgresInstanceRegistry } from "../src/runs/instance-registry.ts";
import { createSlackRuntimeReconciler } from "../src/surfaces/slack-runtime.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { settle } from "./support/settle.ts";

const actor: Principal = { id: "internal:U1", type: "internal" };
const turn = (threadRef: string): OrchestratorInput => ({
  actor,
  conversation: { kind: "dm", threadRef, audience: [actor] },
  origin: { kind: "direct" },
  text: "x",
});

const live = { slack: 0, maxSlack: 0, cron: 0, maxCron: 0 };

function bootBuild(url: string, deploymentKey: string, startedAt: number) {
  const { runs } = createPostgresRunStore(url);
  const handled: string[] = [];
  const cron = { running: false, starts: 0 };
  const slack = { connected: false, connects: 0 };
  const slackRuntime = createSlackRuntimeReconciler({
    startPaused: true,
    intervalMs: 20,
    load: async () => ({ version: "environment", config: deploymentKey }),
    startPlugin: async () => {
      slack.connected = true;
      slack.connects++;
      live.maxSlack = Math.max(live.maxSlack, ++live.slack);
      return {
        stop: async () => {
          slack.connected = false;
          live.slack--;
        },
      };
    },
  });
  const drain = createDrainController({
    registry: createPostgresInstanceRegistry(createPostgresMapFactory(url).pool, {
      instanceId: `${deploymentKey}-1`,
      deploymentKey,
      startedAt,
      livenessMs: 5_000,
    }),
    sweepMs: 25,
  });
  const orchestrator = {
    handleTurn: async (input: OrchestratorInput) => {
      handled.push(input.conversation.threadRef);
      return { status: "ok", reply: "done" };
    },
  } as unknown as Orchestrator;
  const worker = createWorker({ runs, orchestrator, leaseTtlMs: 10_000, pollMs: 5, canClaim: () => drain.canClaim() });
  worker.start();
  drain.start({
    resume() {
      cron.running = true;
      cron.starts++;
      live.maxCron = Math.max(live.maxCron, ++live.cron);
      slackRuntime.start();
    },
    async standDown() {
      if (cron.running) live.cron--;
      cron.running = false;
      await slackRuntime.stop();
    },
  });
  return {
    runs,
    handled,
    cron,
    slack,
    async stop() {
      if (cron.running) live.cron--;
      cron.running = false;
      await slackRuntime.stop();
      await drain.stop();
      await worker.stop();
    },
  };
}

test("starting a newer build stands the older one down; stopping it brings the older one back", async () => {
  const url = testDatabaseUrl();
  const a = bootBuild(url, "deployment-a", 1_000);
  try {
    await settle(async () => a.cron.running && a.slack.connected);
    assert.ok(a.cron.running && a.slack.connected, "the only build runs cron and holds the Slack connection");
    const first = (await a.runs.enqueue({ sessionId: "s1", request: turn("t1"), maxAttempts: 3 })).run;
    assert.equal((await a.runs.waitFor(first.id, 15_000)).status, "done");
    assert.deepEqual(a.handled, ["t1"]);

    const b = bootBuild(url, "deployment-b", 2_000);
    try {
      await settle(async () => !a.cron.running && !a.slack.connected && b.cron.running && b.slack.connected);
      assert.equal(a.cron.running, false, "the older build stopped its cron scheduler");
      assert.equal(a.slack.connected, false, "the older build closed its Slack connection");
      assert.ok(b.cron.running && b.slack.connected, "the newer build runs cron and holds Slack");
      const second = (await b.runs.enqueue({ sessionId: "s2", request: turn("t2"), maxAttempts: 3 })).run;
      assert.equal((await b.runs.waitFor(second.id, 15_000)).status, "done");
      assert.deepEqual(a.handled, ["t1"], "the older build claimed no new turn");
      assert.deepEqual(b.handled, ["t2"]);
    } finally {
      await b.stop();
    }
    const stoppedAt = Date.now();

    await settle(async () => a.cron.running && a.slack.connected);
    assert.ok(a.cron.running && a.slack.connected, "the older build resumed cron and Slack once the newer one stopped");
    assert.ok(
      Date.now() - stoppedAt < 5_000,
      "a cleanly stopped build hands back without waiting for its heartbeat to expire",
    );
    assert.equal(a.cron.starts, 2);
    assert.equal(a.slack.connects, 2);
    const third = (await a.runs.enqueue({ sessionId: "s3", request: turn("t3"), maxAttempts: 3 })).run;
    assert.equal((await a.runs.waitFor(third.id, 15_000)).status, "done");
    assert.deepEqual(a.handled, ["t1", "t3"]);
    assert.equal(live.maxSlack, 1, "the two builds never held Slack connections at the same time");
    assert.equal(live.maxCron, 1, "the two builds never ran cron schedulers at the same time");
  } finally {
    await a.stop();
  }
});

test("a stand-down that fails while the newer build disappears is settled before resuming", async () => {
  let superseded = false;
  const calls: string[] = [];
  let failNext = false;
  const drain = createDrainController({
    registry: { beat: async () => ({ superseded, olderRunning: false }), retire: async () => {} },
    sweepMs: 10,
  });
  drain.start({
    resume: () => calls.push("resume"),
    async standDown() {
      calls.push("standDown");
      if (!failNext) return;
      failNext = false;
      superseded = false;
      throw new Error("scheduler stop failed");
    },
  });
  await settle(async () => calls.length === 1);
  failNext = true;
  superseded = true;
  await settle(async () => calls.length === 4);
  assert.deepEqual(calls, ["resume", "standDown", "standDown", "resume"]);
  await drain.stop();
});

test("a newer build waits for the older one to stand down before it resumes anything", async () => {
  let olderRunning = true;
  const calls: string[] = [];
  const drain = createDrainController({
    registry: { beat: async () => ({ superseded: false, olderRunning }), retire: async () => {} },
    sweepMs: 10,
  });
  drain.start({ resume: () => calls.push("resume"), standDown: async () => void calls.push("standDown") });
  await settle(async () => calls.length === 1);
  assert.equal(drain.canClaim(), false, "no run claims while the older build still runs background work");
  olderRunning = false;
  await settle(async () => calls.includes("resume"));
  assert.equal(drain.canClaim(), true);
  olderRunning = true;
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, ["standDown", "resume"], "a running build never stands down for an older one");
  await drain.stop();
});

test("a build records itself running before it resumes, and backs off if another build got there first", async () => {
  const calls: string[] = [];
  let rival = false;
  const drain = createDrainController({
    registry: {
      beat: async (running) => {
        calls.push(`beat:${running}`);
        return { superseded: false, olderRunning: running && rival };
      },
      retire: async () => void calls.push("retire"),
    },
    sweepMs: 10,
  });
  rival = true;
  drain.start({ resume: () => calls.push("resume"), standDown: async () => void calls.push("standDown") });
  await settle(async () => calls.filter((call) => call === "beat:true").length >= 2);
  assert.ok(!calls.includes("resume"), "an older build that started first keeps background work");
  assert.equal(drain.canClaim(), false);
  rival = false;
  await settle(async () => calls.includes("resume"));
  assert.equal(calls[calls.indexOf("resume") - 1], "beat:true", "the running flag is written before resuming");
  await drain.stop();
  assert.deepEqual(calls.slice(-2), ["standDown", "retire"], "stopping stands down before the heartbeat is retired");
});

test("a build waiting for an older one rechecks quickly instead of on the regular sweep", async () => {
  let rival = true;
  let resumed = false;
  const drain = createDrainController({
    registry: {
      beat: async () => ({ superseded: false, olderRunning: rival }),
      retire: async () => {},
    },
    sweepMs: 60_000,
    waitingSweepMs: 10,
  });
  drain.start({ resume: () => (resumed = true), standDown: async () => {} });
  await settle(async () => !drain.canClaim());
  rival = false;
  await settle(async () => resumed && drain.canClaim());
  assert.ok(resumed && drain.canClaim(), "the waiting build resumed on the short interval");
  await drain.stop();
});

test("a build keeps its running heartbeat fresh while a slow stand-down is still in progress", async () => {
  const beats: boolean[] = [];
  let newer = false;
  let finishStandDown!: () => void;
  const drain = createDrainController({
    registry: {
      beat: async (running) => {
        beats.push(running);
        return { superseded: newer, olderRunning: false };
      },
      retire: async () => {},
    },
    sweepMs: 10,
  });
  let standingDown = false;
  drain.start({
    resume: () => {},
    standDown: () => {
      if (!newer) return Promise.resolve();
      standingDown = true;
      return new Promise<void>((resolve) => (finishStandDown = resolve));
    },
  });
  await settle(async () => beats.includes(true));
  newer = true;
  await settle(async () => standingDown);
  const during = beats.length;
  await settle(async () => beats.length >= during + 3);
  assert.ok(beats.length >= during + 3, "heartbeats continue during a slow stand-down");
  assert.ok(
    beats.slice(during).every((running) => running),
    "heartbeats keep reporting running until the stand-down finishes",
  );
  finishStandDown();
  await settle(async () => beats.at(-1) === false);
  await drain.stop();
});
