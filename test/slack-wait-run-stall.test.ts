import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createSlackCoreClient } from "../src/api/slack-core-client.ts";
import { createTurnStream } from "../src/runs/turn-stream.ts";

const MIN = 60_000;

/** Drive waitRun under a mocked clock: each step lets pending promises settle, runs `onPoll`
 *  hooks via the run getter, then advances simulated time by one poll interval. */
async function drive(opts: {
  lease: "renewing" | "frozen";
  onTick?: (minute: number, stream: ReturnType<typeof createTurnStream>, activity: unknown[]) => void;
  maxMinutes: number;
}): Promise<{ outcome: "stalled" | "pending" | "other"; atMinute: number }> {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const turnStream = createTurnStream();
    const activity: unknown[] = [];
    const frozenLease = 30_000;
    let finished = false;
    const client = createSlackCoreClient({
      turnStream,
      runs: {
        onTerminal() {},
        get: async () => ({
          id: "r1",
          status: finished ? "done" : "running",
          attempts: 1,
          leaseExpiresAt: opts.lease === "renewing" ? Date.now() + 30_000 : frozenLease,
        }),
      },
      runActivity: { append: async () => {}, list: async () => activity },
      app: { getRun: async () => ({ result: { status: "ok", reply: "done" } }) },
    } as any);
    let settled: { code?: string } | null | undefined;
    const p = client.waitRun("r1").then(
      () => {
        settled = null;
      },
      (e: { code?: string }) => {
        settled = e;
      },
    );
    let lastMinute = -1;
    for (let ms = 0; ms <= opts.maxMinutes * MIN; ms += 1_000) {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      if (settled !== undefined) break;
      const minute = Math.floor(ms / MIN);
      if (minute !== lastMinute) {
        lastMinute = minute;
        opts.onTick?.(minute, turnStream, activity);
      }
      mock.timers.tick(1_000);
    }
    const atMinute = Math.floor(Date.now() / MIN);
    if (settled === undefined) {
      finished = true;
      for (let i = 0; i < 5 && settled === undefined; i++) {
        mock.timers.tick(1_000);
        for (let j = 0; j < 5; j++) await new Promise((r) => setImmediate(r));
      }
      await p;
      return { outcome: "pending", atMinute };
    }
    return { outcome: settled?.code === "run_stalled" ? "stalled" : "other", atMinute };
  } finally {
    mock.timers.reset();
  }
}

test("#1561: a worker that keeps renewing its lease but makes no progress still trips the stall watchdog", async () => {
  const r = await drive({ lease: "renewing", maxMinutes: 120 });
  assert.equal(r.outcome, "stalled", "lease renewal alone must not count as answer progress");
  assert.ok(r.atMinute <= 30, `stalled only after ${r.atMinute} min`);
});

test("a live worker running a long tool is not flagged before the budget", async () => {
  const r = await drive({ lease: "renewing", maxMinutes: 8 });
  assert.equal(r.outcome, "pending");
});

test("streamed text keeps resetting progress, even after the text buffer caps", async () => {
  const r = await drive({
    lease: "renewing",
    maxMinutes: 60,
    onTick: (_m, stream) => {
      stream.publish("r1", "x".repeat(250_000));
    },
  });
  assert.equal(r.outcome, "pending");
});

test("new run activity (tool calls) keeps resetting progress", async () => {
  const r = await drive({
    lease: "renewing",
    maxMinutes: 60,
    onTick: (m, _s, activity) => {
      activity.push({ seq: m, parentSeq: null, type: "tool", payload: {}, createdAt: Date.now() });
    },
  });
  assert.equal(r.outcome, "pending");
});
