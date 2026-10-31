import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createMemberHydrator } from "../src/discord/member-hydrator.ts";
import { DISCORD_RETRY_BASE_MS } from "../src/discord/config.ts";

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  mock.method(Math, "random", () => 0.999999);
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});
const tick = () => new Promise((r) => setImmediate(r));

test("guilds are not ready until their one full fetch succeeds", async () => {
  let fail = true;
  const fetched: string[] = [];
  const h = createMemberHydrator({
    guildIds: new Set(["900", "901"]),
    fetchAll: async (g) => {
      fetched.push(g);
      if (g === "901" && fail) throw new Error("gateway timeout");
    },
  });
  assert.equal(h.allReady(), false);
  h.hydrate();
  await tick();
  assert.equal(h.ready("900"), true);
  assert.equal(h.ready("901"), false);
  assert.equal(h.allReady(), false);
  fail = false;
  mock.timers.tick(DISCORD_RETRY_BASE_MS - 1);
  await tick();
  assert.deepEqual(fetched, ["900", "901"]);
  mock.timers.tick(1);
  await tick();
  assert.equal(h.allReady(), true);
  assert.deepEqual(fetched, ["900", "901", "901"]);
});

test("a disconnect makes every guild unknown until the next hydrate", async () => {
  const h = createMemberHydrator({ guildIds: new Set(["900"]), fetchAll: async () => {} });
  h.hydrate();
  await tick();
  assert.equal(h.ready("900"), true);
  h.invalidate();
  assert.equal(h.ready("900"), false);
  h.hydrate();
  await tick();
  assert.equal(h.ready("900"), true);
});

test("stop cancels a pending retry", async () => {
  let fetches = 0;
  const h = createMemberHydrator({
    guildIds: new Set(["900"]),
    fetchAll: async () => {
      fetches += 1;
      throw new Error("x");
    },
  });
  h.hydrate();
  await tick();
  h.stop();
  mock.timers.tick(DISCORD_RETRY_BASE_MS);
  await tick();
  assert.equal(fetches, 1);
});

test("onAllReady fires once every guild has hydrated, again after a re-hydrate, and not for a failed guild", async () => {
  let fail = true;
  let ready = 0;
  const h = createMemberHydrator({
    guildIds: new Set(["900", "901"]),
    fetchAll: async (g) => {
      if (g === "901" && fail) throw new Error("gateway timeout");
    },
    onAllReady: () => void (ready += 1),
  });
  h.hydrate();
  await tick();
  assert.equal(ready, 0);
  fail = false;
  mock.timers.tick(DISCORD_RETRY_BASE_MS);
  await tick();
  assert.equal(ready, 1);
  h.hydrate();
  await tick();
  assert.equal(ready, 2);
  h.stop();
});

test("a rate-limited fetch retries no sooner than the retry_after Discord reported", async () => {
  let fetches = 0;
  const h = createMemberHydrator({
    guildIds: new Set(["900"]),
    fetchAll: async () => {
      fetches += 1;
      if (fetches === 1) throw Object.assign(new Error("rate limited"), { data: { opcode: 8, retry_after: 30 } });
    },
  });
  h.hydrate();
  await tick();
  mock.timers.tick(29_999);
  await tick();
  assert.equal(fetches, 1);
  mock.timers.tick(1);
  await tick();
  assert.equal(fetches, 2);
  assert.equal(h.allReady(), true);
});
