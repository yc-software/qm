import { test } from "node:test";
import assert from "node:assert/strict";
import { endingNote, EMPTY_ENDING_NOTE, EMPTY_ENDING_MIN_BUDGET_MS } from "../src/agent/agent-run.ts";

type Opts = Parameters<typeof endingNote>[0];

function session(text: string | undefined, stopReason?: string): Opts["session"] {
  return {
    getLastAssistantText: () => text,
    messages: [{ role: "assistant", stopReason: stopReason ?? "stop" }] as unknown as Opts["session"]["messages"],
  } as Opts["session"];
}

function base(over: Partial<Opts> = {}): Opts {
  return {
    wallClock: "ok",
    userAborted: false,
    cancelled: false,
    surfaceTools: false,
    pollFire: false,
    ref: { modelCalls: 48 },
    session: session(""),
    turnWallClockMs: 1_800_000,
    elapsedMs: 60_000,
    ...over,
  };
}

test("a poll fire ending empty is the silence contract — never nudged into narration", async () => {
  assert.equal(await endingNote(base({ pollFire: true })), null);
  assert.equal(await endingNote(base({ pollFire: true, ref: { modelCalls: 1 } })), null);
  assert.equal(await endingNote(base({ pollFire: true, ref: {} })), null);
  assert.equal(await endingNote(base({ pollFire: true, session: session("  \n ") })), null);
});

test("a non-poll turn ending empty mid-work gets the plain note", async () => {
  assert.equal(await endingNote(base()), EMPTY_ENDING_NOTE);
});

test("a non-empty final reply is accepted", async () => {
  assert.equal(await endingNote(base({ session: session("Heartbeat — all healthy.") })), null);
});

test("whitespace-only counts as empty", async () => {
  assert.equal(await endingNote(base({ session: session("  \n ") })), EMPTY_ENDING_NOTE);
});

test("explicit finish_silently is intentional silence, never nudged", async () => {
  assert.equal(await endingNote(base({ ref: { modelCalls: 48, silentRequested: true } })), null);
});

test("a paused turn (approval or input wall) ends mid-loop legitimately", async () => {
  assert.equal(await endingNote(base({ ref: { modelCalls: 48, pausedOnApproval: true } })), null);
  assert.equal(await endingNote(base({ ref: { modelCalls: 48, pendingApprovals: [{}] } })), null);
});

test("an addressed turn whose first response is empty ('(no response)') IS recovered", async () => {
  assert.equal(await endingNote(base({ ref: { modelCalls: 1 } })), EMPTY_ENDING_NOTE);
  assert.equal(await endingNote(base({ ref: {} })), null);
});

test("spine turns are excluded — the orchestrator's reply-or-decline nudge owns them", async () => {
  assert.equal(await endingNote(base({ surfaceTools: true })), null);
});

test("a capped, aborted, abandoned, or cancelled turn is not re-prompted", async () => {
  assert.equal(await endingNote(base({ wallClock: "aborted" })), null);
  assert.equal(await endingNote(base({ wallClock: "abandoned" })), null);
  assert.equal(await endingNote(base({ userAborted: true })), null);
  assert.equal(await endingNote(base({ cancelled: true })), null);
});

test("an error ending must throw upstream, not be nudged", async () => {
  assert.equal(await endingNote(base({ session: session("", "error") })), null);
});

test("no re-prompt without wall-clock budget left; disabled cap always has budget", async () => {
  assert.equal(
    await endingNote(base({ turnWallClockMs: 60_000, elapsedMs: 60_000 - EMPTY_ENDING_MIN_BUDGET_MS + 1 })),
    null,
  );
  assert.equal(
    await endingNote(base({ turnWallClockMs: 60_000, elapsedMs: 60_000 - EMPTY_ENDING_MIN_BUDGET_MS })),
    EMPTY_ENDING_NOTE,
  );
  assert.equal(await endingNote(base({ turnWallClockMs: 0, elapsedMs: 10_000_000 })), EMPTY_ENDING_NOTE);
});

test("a non-empty ending goes to the turn's ending check, whose note is the re-prompt", async () => {
  const seen: string[] = [];
  const checkEnding = async (reply: string) => {
    seen.push(reply);
    return reply.startsWith("Next") ? "NOTE" : undefined;
  };
  assert.equal(await endingNote(base({ session: session("  Next I'll open the PR. "), checkEnding })), "NOTE");
  assert.equal(await endingNote(base({ session: session("The PR is open."), checkEnding })), null);
  assert.deepEqual(seen, ["Next I'll open the PR.", "The PR is open."]);
});

test("the ending check is never consulted on a stopped, cancelled, capped, paused, silent, poll, spine or empty ending", async () => {
  let consulted = 0;
  const checkEnding = async () => {
    consulted++;
    return "NOTE";
  };
  const announced = session("I'll now run the tests.");
  const skipped: Partial<Opts>[] = [
    { userAborted: true },
    { cancelled: true },
    { wallClock: "aborted" },
    { pollFire: true },
    { surfaceTools: true },
    { ref: { modelCalls: 3, silentRequested: true } },
    { ref: { modelCalls: 3, pausedOnApproval: true } },
    { ref: { modelCalls: 3, pendingApprovals: [{}] } },
    { turnWallClockMs: 60_000, elapsedMs: 59_000 },
  ];
  for (const over of skipped) assert.equal(await endingNote(base({ session: announced, ...over, checkEnding })), null);
  assert.equal(await endingNote(base({ checkEnding })), EMPTY_ENDING_NOTE);
  assert.equal(consulted, 0);
});
