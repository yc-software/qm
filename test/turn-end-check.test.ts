import { test } from "node:test";
import assert from "node:assert/strict";
import { announcesNextStep, turnEndCheck } from "../src/core/orchestrator/turn-end-check.ts";
import type { ProcessRecord } from "../src/processes/process-registry.ts";
import type { Monitor } from "../src/triggers/types.ts";

test("a reply whose last sentence announces the next step, or that ends on a colon, is an unfinished ending", () => {
  for (const reply of [
    "Tests pass on the branch. I'll now open the PR.",
    "Found the leak in the pool.\n\nNext, I will write the regression test.",
    "Build is green. Let me check the deploy logs.",
    "- **Now I\u2019ll** merge it.",
    "I'm going to rerun the flaky shard",
    "Running the migration against staging:",
  ])
    assert.equal(announcesNextStep(reply), true, reply);
});

test("a finished reply, an offer to the reader, or an announcement earlier in the reply is accepted", () => {
  for (const reply of [
    "The PR is open: https://example.test/pr/1. All checks pass.",
    "I'll now summarize. Three jobs failed, all on the same flaky test.",
    "Done. Let me know if you want the logs.",
    "I'm going.",
    "",
  ])
    assert.equal(announcesNextStep(reply), false, reply);
});

function job(processId: string, over: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    processId,
    scopeId: "personal:tester",
    kind: "background",
    command: "npm test",
    startedAt: 2_000,
    expiresAt: Date.now() + 60_000,
    status: "running",
    sessionRef: "thread-1",
    ...over,
  };
}

function watch(processId: string, over: Partial<Monitor> = {}): Monitor {
  return {
    id: `mon-${processId}`,
    owner: "tester",
    createdBy: "tester",
    createdAt: 1_000,
    ownerScopeId: "personal:tester",
    enabled: true,
    processId,
    command: "npm test",
    threadRef: "thread-1",
    cursor: 0,
    expiresAt: Date.now() + 60_000,
    ...over,
  };
}

const place = {
  processScopeId: "personal:tester",
  monitorScopeId: "personal:tester",
  threadRef: "thread-1",
  turnStartedAt: 1_000,
};

test("only this turn's own unwatched, still-running background jobs make a finished reply unfinished", async () => {
  const check = turnEndCheck(
    {
      processes: {
        liveByScope: async () => [
          job("p-mine"),
          job("p-watched"),
          job("p-expired-watch"),
          job("p-other-thread", { sessionRef: "thread-2" }),
          job("p-earlier-turn", { startedAt: 500 }),
          job("p-build", { kind: "build" }),
        ],
      },
      monitors: {
        ownedBy: async () => [watch("p-watched"), watch("p-expired-watch", { expiresAt: Date.now() - 1 })],
      },
    },
    place,
  );
  const note = await check("All three shards are running.");
  assert.ok(note?.includes("p-mine"));
  assert.ok(note?.includes("p-expired-watch"));
  for (const id of ["p-watched", "p-other-thread", "p-earlier-turn", "p-build"]) assert.ok(!note?.includes(id), id);
});

test("a finished reply with no jobs of its own passes, and a failing job lookup falls back to the reply alone", async () => {
  assert.equal(await turnEndCheck({}, place)("All checks pass."), undefined);
  const broken = turnEndCheck(
    {
      processes: {
        liveByScope: async () => {
          throw new Error("db down");
        },
      },
    },
    place,
  );
  assert.equal(await broken("All checks pass."), undefined);
  assert.ok(await broken("I'll now open the PR."));
});
