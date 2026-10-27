import { test } from "node:test";
import assert from "node:assert/strict";
import {
  raceTurnWallClock,
  emptyEndingNote,
  EMPTY_ENDING_NOTE,
  EMPTY_ENDING_MIN_BUDGET_MS,
} from "../../src/harness/pi-turn-clock.ts";
import { createTurnToolState } from "../../src/harness/turn-tool-state.ts";

const never = new Promise<void>(() => {});

test("prompt that settles before the cap → ok, abort never called", async () => {
  let aborted = false;
  const outcome = await raceTurnWallClock(Promise.resolve(), {
    capMs: 1_000,
    graceMs: 10,
    abort: async () => {
      aborted = true;
    },
  });
  assert.equal(outcome, "ok");
  assert.equal(aborted, false);
});

test("cap disabled (<=0) just awaits the prompt", async () => {
  const outcome = await raceTurnWallClock(Promise.resolve(), { capMs: 0, abort: async () => {} });
  assert.equal(outcome, "ok");
});

test("pre-cap rejection propagates unchanged", async () => {
  await assert.rejects(
    raceTurnWallClock(Promise.reject(new Error("api blew up")), { capMs: 1_000, graceMs: 10, abort: async () => {} }),
    /api blew up/,
  );
});

test("cap hit, abort unwinds the prompt → aborted", async () => {
  let release!: () => void;
  const prompting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcome = await raceTurnWallClock(prompting, {
    capMs: 20,
    graceMs: 5_000,
    abort: async () => release(),
  });
  assert.equal(outcome, "aborted");
});

test("cap hit, prompt rejects after abort → still aborted (we fail the turn ourselves)", async () => {
  let reject!: (e: Error) => void;
  const prompting = new Promise<void>((_resolve, rej) => {
    reject = rej;
  });
  const outcome = await raceTurnWallClock(prompting, {
    capMs: 20,
    graceMs: 5_000,
    abort: async () => reject(new Error("aborted by user")),
  });
  assert.equal(outcome, "aborted");
});

test("cap hit, prompt pinned past the grace period → abandoned", async () => {
  let aborted = false;
  const outcome = await raceTurnWallClock(never, {
    capMs: 20,
    graceMs: 20,
    abort: async () => {
      aborted = true;
    },
  });
  assert.equal(outcome, "abandoned");
  assert.equal(aborted, true);
});

test("a hanging abort() does not block the grace race", async () => {
  const outcome = await raceTurnWallClock(never, {
    capMs: 20,
    graceMs: 20,
    abort: () => never,
  });
  assert.equal(outcome, "abandoned");
});

test("extendMs pushes the deadline while it returns time; prompt settling during an extension → ok", async () => {
  let release!: () => void;
  const prompting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = 0;
  const outcome = await raceTurnWallClock(prompting, {
    capMs: 20,
    graceMs: 10,
    abort: async () => {},
    extendMs: () => {
      asked++;
      setTimeout(release, 10);
      return 50;
    },
  });
  assert.equal(outcome, "ok");
  assert.equal(asked, 1);
});

test("extendMs can extend repeatedly, then expiring (0) runs the normal abort path", async () => {
  let release!: () => void;
  const prompting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = 0;
  const outcome = await raceTurnWallClock(prompting, {
    capMs: 10,
    graceMs: 5_000,
    abort: async () => release(),
    extendMs: () => (++asked < 3 ? 10 : 0),
  });
  assert.equal(outcome, "aborted");
  assert.equal(asked, 3);
});

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
    pollFire: false,
    halted: false,
    modelCalls: 48,
    session: session(""),
    turnWallClockMs: 1_800_000,
    elapsedMs: 60_000,
    ...over,
  };
}

test("a poll fire ending empty is the silence contract — never nudged into narration", () => {
  assert.equal(emptyEndingNote(base({ pollFire: true })), null);
  assert.equal(emptyEndingNote(base({ pollFire: true, modelCalls: 1 })), null);
  assert.equal(emptyEndingNote(base({ pollFire: true, modelCalls: 0 })), null);
  assert.equal(emptyEndingNote(base({ pollFire: true, session: session("  \n ") })), null);
});

test("a non-poll turn ending empty mid-work gets the plain note", () => {
  assert.equal(emptyEndingNote(base()), EMPTY_ENDING_NOTE);
});

test("a non-empty final reply is accepted", () => {
  assert.equal(emptyEndingNote(base({ session: session("Heartbeat — all healthy.") })), null);
});

test("whitespace-only counts as empty", () => {
  assert.equal(emptyEndingNote(base({ session: session("  \n ") })), EMPTY_ENDING_NOTE);
});

test("explicit finish_silently is intentional silence, never nudged", () => {
  const { halt } = createTurnToolState({ current: null, silentRequested: true });
  assert.equal(emptyEndingNote(base({ halted: halt.halted() })), null);
});

test("a paused turn (approval or input wall) ends mid-loop legitimately", () => {
  const paused = createTurnToolState({ current: null, pausedOnApproval: true }).halt;
  assert.equal(emptyEndingNote(base({ halted: paused.halted() })), null);
  const approval = createTurnToolState({ current: null }).halt;
  approval.pauseForApproval({ command: "deploy", reason: "needs approval" });
  assert.equal(emptyEndingNote(base({ halted: approval.halted() })), null);
});

test("an addressed turn whose first response is empty ('(no response)') IS recovered", () => {
  assert.equal(emptyEndingNote(base({ modelCalls: 1 })), EMPTY_ENDING_NOTE);
  assert.equal(emptyEndingNote(base({ modelCalls: 0 })), null);
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
    EMPTY_ENDING_NOTE,
  );
  assert.equal(emptyEndingNote(base({ turnWallClockMs: 0, elapsedMs: 10_000_000 })), EMPTY_ENDING_NOTE);
});
