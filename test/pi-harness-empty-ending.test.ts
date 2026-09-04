import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyEndingNote,
  EMPTY_ENDING_NOTE,
  EMPTY_ENDING_NOTE_POLL,
  EMPTY_ENDING_MIN_BUDGET_MS,
} from "../src/harness/pi-harness.ts";

type Opts = Parameters<typeof emptyEndingNote>[0];

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
    pollFire: true,
    ref: { modelCalls: 48 },
    session: session(""),
    turnWallClockMs: 1_800_000,
    elapsedMs: 60_000,
    ...over,
  };
}

test("the prod signature — poll fire ends empty mid-work — gets the poll note", () => {
  assert.equal(emptyEndingNote(base()), EMPTY_ENDING_NOTE_POLL);
});

test("a non-poll turn ending empty mid-work gets the plain note", () => {
  assert.equal(emptyEndingNote(base({ pollFire: false })), EMPTY_ENDING_NOTE);
});

test("a non-empty final reply is accepted", () => {
  assert.equal(emptyEndingNote(base({ session: session("Heartbeat — all healthy.") })), null);
});

test("whitespace-only counts as empty", () => {
  assert.equal(emptyEndingNote(base({ session: session("  \n ") })), EMPTY_ENDING_NOTE_POLL);
});

test("explicit finish_silently is intentional silence, never nudged", () => {
  assert.equal(emptyEndingNote(base({ ref: { modelCalls: 48, silentRequested: true } })), null);
});

test("a paused turn (approval or input wall) ends mid-loop legitimately", () => {
  assert.equal(emptyEndingNote(base({ ref: { modelCalls: 48, pausedOnApproval: true } })), null);
  assert.equal(emptyEndingNote(base({ ref: { modelCalls: 48, pendingApprovals: [{}] } })), null);
});

test("a poll fire whose first response is empty is the silence contract, not an anomaly", () => {
  assert.equal(emptyEndingNote(base({ ref: { modelCalls: 1 } })), null);
  assert.equal(emptyEndingNote(base({ ref: {} })), null);
});

test("an addressed turn whose first response is empty ('(no response)') IS recovered", () => {
  assert.equal(emptyEndingNote(base({ pollFire: false, ref: { modelCalls: 1 } })), EMPTY_ENDING_NOTE);
  assert.equal(emptyEndingNote(base({ pollFire: false, ref: {} })), null);
});

test("spine turns are excluded — the orchestrator's reply-or-decline nudge owns them", () => {
  assert.equal(emptyEndingNote(base({ surfaceTools: true })), null);
});

test("a capped, aborted, abandoned, or cancelled turn is not re-prompted", () => {
  assert.equal(emptyEndingNote(base({ wallClock: "aborted" })), null);
  assert.equal(emptyEndingNote(base({ wallClock: "abandoned" })), null);
  assert.equal(emptyEndingNote(base({ userAborted: true })), null);
  assert.equal(emptyEndingNote(base({ cancelled: true })), null);
});

test("an error ending must throw upstream, not be nudged", () => {
  assert.equal(emptyEndingNote(base({ session: session("", "error") })), null);
});

test("no re-prompt without wall-clock budget left; disabled cap always has budget", () => {
  assert.equal(
    emptyEndingNote(base({ turnWallClockMs: 60_000, elapsedMs: 60_000 - EMPTY_ENDING_MIN_BUDGET_MS + 1 })),
    null,
  );
  assert.equal(
    emptyEndingNote(base({ turnWallClockMs: 60_000, elapsedMs: 60_000 - EMPTY_ENDING_MIN_BUDGET_MS })),
    EMPTY_ENDING_NOTE_POLL,
  );
  assert.equal(emptyEndingNote(base({ turnWallClockMs: 0, elapsedMs: 10_000_000 })), EMPTY_ENDING_NOTE_POLL);
});
