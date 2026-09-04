import { test } from "node:test";
import assert from "node:assert/strict";
import { raceTurnWallClock } from "../src/harness/pi-harness.ts";

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
