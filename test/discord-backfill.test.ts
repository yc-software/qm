import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKFILL_GAP_NOTE, createBackfill, DISCORD_BACKFILL_PAGE } from "../src/discord/backfill.ts";
import { snowflakeAt, snowflakeMs } from "../src/util/snowflake.ts";

const NOW = 1_800_000_000_000;
const FLOOR = "1593449644032000000";

interface Msg {
  id: string;
}

function harness(opts: {
  marks?: Array<{ container: string; lastTs: string }>;
  pages?: Record<string, Msg[]>;
  lastMessageId?: string | null;
  failOpen?: string[];
  onDispatch?: (id: string, seen: (channel: string, id: string) => void) => void;
}) {
  const fetches: Array<{ channel: string; limit: number }> = [];
  const gate = { wait: null as Promise<void> | null };
  let inFlight = 0;
  let maxInFlight = 0;
  const dispatched: string[] = [];
  const gaps: Array<{ channel: string; note: string }> = [];
  const backfill = createBackfill<Msg>({
    now: () => NOW,
    watermarks: async () => opts.marks ?? [],
    open: async (channel) => {
      if (opts.failOpen?.includes(channel)) throw new Error("Missing Access");
      return {
        baseChannelId: `base-${channel}`,
        lastMessageId: opts.lastMessageId ?? null,
        newest: async (limit) => {
          fetches.push({ channel, limit });
          return opts.pages?.[channel] ?? [];
        },
      };
    },
    dispatch: async (m) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.wait;
      await Promise.resolve();
      dispatched.push(m.id);
      opts.onDispatch?.(m.id, (channel, id) => backfill.seen(channel, id));
      inFlight--;
    },
    noteGap: async (channel, note) => void gaps.push({ channel, note }),
  });
  return { backfill, fetches, dispatched, gaps, gate, maxInFlight: () => maxInFlight };
}

test("snowflakeAt is the inverse of snowflakeMs at a hand-computed value", () => {
  assert.equal(snowflakeAt(1_420_070_400_001), "4194304");
  assert.equal(snowflakeMs(snowflakeAt(NOW)), NOW);
});

test("only ids above the newer of the mirrored id and the age floor are dispatched, comparing ids as numbers", async () => {
  const floor = BigInt(FLOOR);
  const above = (floor + 5n).toString();
  const h = harness({
    marks: [
      { container: "old", lastTs: "999999999999999999" },
      { container: "fresh", lastTs: (floor + 4n).toString() },
    ],
    pages: {
      old: [{ id: "999999999999999999" }, { id: above }],
      fresh: [{ id: (floor + 4n).toString() }, { id: above }],
    },
  });
  await h.backfill.run();
  assert.deepEqual(h.dispatched, [above, above]);
});

test("an 18-digit id older than the floor never beats a 19-digit floor", async () => {
  const h = harness({
    marks: [{ container: "c", lastTs: "999999999999999999" }],
    pages: { c: [{ id: "999999999999999998" }, { id: (BigInt(FLOOR) + 1n).toString() }] },
  });
  await h.backfill.run();
  assert.deepEqual(h.dispatched, [(BigInt(FLOOR) + 1n).toString()]);
});

test("a page older than the cursor is filtered out and raises no gap", async () => {
  const floor = BigInt(FLOOR);
  const page = Array.from({ length: DISCORD_BACKFILL_PAGE }, (_, i) => ({ id: (floor + BigInt(i + 1)).toString() }));
  const h = harness({ marks: [{ container: "c", lastTs: (floor + 50n).toString() }], pages: { c: page } });
  await h.backfill.run();
  assert.equal(h.dispatched.length, DISCORD_BACKFILL_PAGE - 50);
  assert.equal(h.dispatched[0], (floor + 51n).toString());
  assert.deepEqual(h.gaps, []);
});

test("dispatch is awaited one message at a time, oldest first", async () => {
  const floor = BigInt(FLOOR);
  const ids = [3n, 1n, 2n].map((n) => (floor + n).toString());
  const h = harness({ marks: [{ container: "c", lastTs: floor.toString() }], pages: { c: ids.map((id) => ({ id })) } });
  await h.backfill.run();
  assert.equal(h.maxInFlight(), 1);
  assert.deepEqual(
    h.dispatched,
    [1n, 2n, 3n].map((n) => (floor + n).toString()),
  );
});

test("overlapping runs coalesce into one extra sweep", async () => {
  const floor = BigInt(FLOOR);
  const h = harness({
    marks: [{ container: "c", lastTs: floor.toString() }],
    pages: { c: [{ id: (floor + 1n).toString() }] },
  });
  await Promise.all([h.backfill.run(), h.backfill.run(), h.backfill.run()]);
  assert.equal(h.fetches.length, 2);
});

test("a live older id never moves the watermark backwards", async () => {
  const floor = BigInt(FLOOR);
  const high = (floor + 10n).toString();
  const h = harness({ pages: { c: [{ id: (floor + 5n).toString() }, { id: (floor + 12n).toString() }] } });
  h.backfill.seen("c", high);
  h.backfill.seen("c", (floor + 3n).toString());
  await h.backfill.run();
  assert.deepEqual(h.dispatched, [(floor + 12n).toString()]);
});

test("fetched messages are dispatched in order", async () => {
  const floor = BigInt(FLOOR);
  const ids = [1n, 2n, 3n].map((n) => (floor + n).toString());
  const h = harness({ marks: [{ container: "c", lastTs: floor.toString() }], pages: { c: ids.map((id) => ({ id })) } });
  await h.backfill.run();
  assert.deepEqual(h.dispatched, ids);
  assert.deepEqual(h.gaps, []);
});

test("a live message advances the watermark of a channel the cache never mirrored", async () => {
  const live = (BigInt(FLOOR) + 10n).toString();
  const after = (BigInt(FLOOR) + 11n).toString();
  const h = harness({ pages: { c: [{ id: live }, { id: after }] } });
  h.backfill.seen("c", live);
  h.backfill.seen("c", "1");
  await h.backfill.run();
  assert.deepEqual(h.fetches, [{ channel: "c", limit: DISCORD_BACKFILL_PAGE }]);
  assert.deepEqual(h.dispatched, [after]);
});

test("a channel whose newest message is not past the watermark is not fetched", async () => {
  const floor = FLOOR;
  const h = harness({ marks: [{ container: "c", lastTs: "1" }], lastMessageId: floor });
  await h.backfill.run();
  assert.deepEqual(h.fetches, []);
});

test("a full page notes a history gap on the base channel", async () => {
  const floor = BigInt(FLOOR);
  const page = Array.from({ length: DISCORD_BACKFILL_PAGE }, (_, i) => ({ id: (floor + BigInt(i + 1)).toString() }));
  const h = harness({ marks: [{ container: "c", lastTs: "1" }], pages: { c: page } });
  await h.backfill.run();
  assert.deepEqual(h.gaps, [{ channel: "base-c", note: BACKFILL_GAP_NOTE }]);
});

test("one channel that cannot be read does not stop the others", async () => {
  const floor = BigInt(FLOOR);
  const id = (floor + 1n).toString();
  const h = harness({
    marks: [
      { container: "locked", lastTs: "1" },
      { container: "open", lastTs: "1" },
    ],
    pages: { open: [{ id }] },
    failOpen: ["locked"],
  });
  await h.backfill.run();
  assert.deepEqual(h.dispatched, [id]);
});

test("a run requested mid-sweep triggers one more sweep", async () => {
  const floor = BigInt(FLOOR);
  const id = (floor + 1n).toString();
  let again: Promise<void> | undefined;
  const h: ReturnType<typeof harness> = harness({
    marks: [{ container: "c", lastTs: floor.toString() }],
    pages: { c: [{ id }] },
    onDispatch: () => void (again ??= h.backfill.run()),
  });
  await h.backfill.run();
  await again;
  assert.equal(h.fetches.length, 2);
});

test("a live id above the page that arrives during the sweep is kept for the next run", async () => {
  const floor = BigInt(FLOOR);
  const ids = [1n, 2n].map((n) => (floor + n).toString());
  const live = (floor + 50n).toString();
  const h = harness({
    marks: [{ container: "c", lastTs: floor.toString() }],
    pages: {
      c: [...ids, (floor + 30n).toString(), (floor + 60n).toString(), (floor + 70n).toString()].map((id) => ({ id })),
    },
    onDispatch: (id, seen) => {
      if (id === ids[0]) seen("c", live);
      if (id === ids[1]) seen("c", id);
    },
  });
  await h.backfill.run();
  h.dispatched.length = 0;
  await h.backfill.run();
  assert.deepEqual(h.dispatched, [(floor + 60n).toString(), (floor + 70n).toString()]);
});

test("a run() arriving at any microtask while a sweep winds down is never lost", async () => {
  for (let tick = 0; tick < 12; tick++) {
    let sweeps = 0;
    const backfill = createBackfill<Msg>({
      now: () => NOW,
      watermarks: async () => {
        sweeps += 1;
        return [];
      },
      open: async () => null,
      dispatch: async () => {},
      noteGap: async () => {},
    });
    const first = backfill.run();
    let hop = Promise.resolve();
    for (let i = 0; i < tick; i++) hop = hop.then(() => {});
    void hop.then(() => backfill.run());
    await first;
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(sweeps, 2, `tick ${tick}`);
  }
});
