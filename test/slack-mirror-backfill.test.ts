import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { createSlackHistoryReader } from "../src/slack/history.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";
import type { BotIdentity } from "../src/slack/directory.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT" } as BotIdentity;

function fixture(fail?: Error) {
  const cache = createMemorySurfaceCache();
  const core = {
    readSurfaceMessages: cache.readMessages,
    rememberSurfaceHistory: async (events) => {
      await cache.ingest(events);
    },
  } as SlackCoreClient;
  const calls: string[] = [];
  const historyClient = {
    conversations: {
      history: async (args: any) => {
        calls.push(`history:${args.latest ?? ""}`);
        if (fail) throw fail;
        return {
          messages: [
            { ts: "20.000000", text: "root", user: "U1", thread_ts: "20.000000", reply_count: 1 },
            { ts: "10.000000", text: "earlier plan", user: "U2" },
          ],
        };
      },
      replies: async (args: any) => {
        calls.push(`replies:${args.ts}`);
        if (fail) throw fail;
        return {
          messages: [
            { ts: "20.000000", text: "root", user: "U1", thread_ts: "20.000000" },
            { ts: "21.000000", text: "what did we decide above?", user: "U1", thread_ts: "20.000000" },
          ],
        };
      },
    },
  };
  const readHistory = createSlackHistoryReader({ core, ids, source: "mirror", historyClient });
  return { cache, calls, readHistory };
}

async function joinedLate(cache: ReturnType<typeof createMemorySurfaceCache>) {
  await cache.ingest([
    { container: "C1", ts: "20.000000", text: "root", authorId: "U1" },
    { container: "C1", ts: "21.000000", sub: "20.000000", text: "what did we decide above?", authorId: "U1" },
  ]);
}

test("a late-joined mirror backfills the thread and earlier channel history once", async () => {
  const { cache, calls, readHistory } = fixture();
  await joinedLate(cache);
  const thread = await readHistory({}, "C1", "20.000000", undefined, true);
  assert.deepEqual(thread.raw.map((m) => m.ts).sort(), ["20.000000", "21.000000"]);
  assert.deepEqual(calls, ["replies:20.000000", "history:20.000000"]);
  const channel = await readHistory({}, "C1");
  assert.ok(channel.raw.some((m) => m.text === "earlier plan"));
  await readHistory({}, "C1", "20.000000", undefined, true);
  assert.equal(calls.length, 2);
});

test("a failed backfill is not retried and falls back to the mirror", async () => {
  const limited = Object.assign(new Error("rate limited"), {
    code: "slack_webapi_rate_limited_error",
    retryAfter: 30,
  });
  const { cache, calls, readHistory } = fixture(limited);
  await joinedLate(cache);
  const first = await readHistory({}, "C1", "20.000000", undefined, true);
  assert.deepEqual(first.raw.map((m) => m.ts).sort(), ["20.000000", "21.000000"]);
  assert.deepEqual(calls, ["replies:20.000000"]);
  const again = await readHistory({}, "C1", "20.000000", undefined, true);
  assert.deepEqual(again.raw.map((m) => m.ts).sort(), ["20.000000", "21.000000"]);
  await readHistory({}, "C1");
  assert.equal(calls.length, 1);
});

test("a thread read before its root is mirrored still fetches only once", async () => {
  const { cache, calls, readHistory } = fixture(new Error("unavailable"));
  await cache.ingest([
    { container: "C1", ts: "21.000000", sub: "20.000000", text: "what did we decide above?", authorId: "U1" },
  ]);
  await readHistory({}, "C1", "20.000000");
  const again = await readHistory({}, "C1", "20.000000");
  assert.deepEqual(
    again.raw.map((m) => m.ts),
    ["21.000000"],
  );
  assert.deepEqual(calls, ["replies:20.000000"]);
});

test("an older-page read does not use up the latest-page backfill", async () => {
  const { cache, calls, readHistory } = fixture();
  await joinedLate(cache);
  await readHistory({}, "C1", undefined, "15.000000");
  await readHistory({}, "C1");
  assert.deepEqual(calls, ["history:15.000000", "history:"]);
});
