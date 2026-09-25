import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { createSlackHistoryReader } from "../src/slack/history.ts";
import type { BotIdentity } from "../src/slack/directory.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";

const ids: BotIdentity = {
  botUserId: "UBOT",
  ownBotId: "BBOT",
  ownTeamId: "T1",
  botHandle: "qm",
  ownWorkspaceUrl: "https://example.slack.com",
  identityMode: "slack-id",
};
const ts = (n: number) => `1000.${String(n).padStart(6, "0")}`;

for (const size of [199, 200, 201]) {
  test(`thread pagination includes parent in the ${size}-message boundary`, async () => {
    const cache = createMemorySurfaceCache();
    await cache.ingest(
      Array.from({ length: size }, (_, i) => ({
        container: "C1",
        ts: ts(i),
        text: `message ${i}`,
        ...(i ? { sub: ts(0) } : {}),
      })),
    );
    const core = { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient;
    const page = await createSlackHistoryReader({ core, ids, source: "mirror" })({}, "C1", ts(0));
    assert.deepEqual(
      page.raw.map((m) => m.ts),
      Array.from({ length: Math.min(size, 200) }, (_, i) => ts(i)),
    );
    assert.equal(page.hasMore, size > 200);
    await cache.close();
  });
}

test("before excludes future replies and a parent outside the requested window", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest(
    Array.from({ length: 205 }, (_, i) => ({
      container: "C1",
      ts: ts(i),
      text: "message",
      ...(i ? { sub: ts(0) } : {}),
    })),
  );
  const core = { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient;
  const read = createSlackHistoryReader({ core, ids, source: "mirror" });
  const bounded = await read({}, "C1", ts(0), ts(199));
  assert.equal(bounded.raw.length, 199);
  assert.equal(bounded.raw.at(-1)?.ts, ts(198));
  assert.equal(bounded.hasMore, false);
  const empty = await read({ conversations: { replies: async () => ({ messages: [] }) } }, "C1", ts(0), ts(0));
  assert.deepEqual(empty.raw, []);
  await cache.close();
});

test("missing parent does not consume a reply slot when a bounded read permits mirror use", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest(
    Array.from({ length: 201 }, (_, i) => ({ container: "C1", ts: ts(i + 1), sub: ts(0), text: "reply" })),
  );
  const core = { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient;
  const page = await createSlackHistoryReader({ core, ids, source: "mirror" })({}, "C1", ts(0), ts(999));
  assert.equal(page.raw.length, 200);
  assert.equal(page.raw[0]?.ts, ts(1));
  assert.equal(page.raw.at(-1)?.ts, ts(200));
  assert.equal(page.hasMore, true);
  await cache.close();
});

test("channel pagination counts roots before expanding a truncated thread", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([{ container: "C1", ts: ts(0), text: "root" }]);
  await cache.ingest(
    Array.from({ length: 201 }, (_, i) => ({ container: "C1", ts: ts(i + 1), sub: ts(0), text: "reply" })),
  );
  const core = { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient;
  const page = await createSlackHistoryReader({ core, ids, source: "mirror" })({}, "C1", undefined, undefined, true);
  assert.equal(page.raw.length, 200);
  assert.equal(page.hasMore, false);
  assert.equal(page.truncatedExpansions, 1);
  await cache.close();
});

test("channel overflow keeps newest roots, excludes deletions and preserves visible system entries", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest(
    Array.from({ length: 202 }, (_, i) => ({
      container: "C1",
      ts: ts(i),
      text: "root",
      ...(i === 2 ? { subtype: "channel_topic" } : {}),
    })),
  );
  await cache.ingest([{ container: "C1", ts: ts(201), deleted: true }]);
  const core = { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient;
  const page = await createSlackHistoryReader({ core, ids, source: "mirror" })({}, "C1");
  assert.equal(page.hasMore, true);
  assert.deepEqual(
    page.raw.map((m) => m.ts),
    Array.from({ length: 200 }, (_, i) => ts(i + 1)),
  );
  assert.equal(page.raw[1]?.subtype, "channel_topic");
  await cache.close();
});
