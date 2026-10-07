import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { createSlackHistoryReader } from "../src/slack/history.ts";
import { createSlackCoreClient, type SlackCoreClient } from "../src/api/slack-core-client.ts";
import { createTurnStream } from "../src/runs/turn-stream.ts";
import type { BotIdentity } from "../src/slack/directory.ts";
import { registerSlackEvents } from "../src/slack/events.ts";
import { createDeduper } from "../src/slack/lib.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT" } as BotIdentity;

function fixture(fail?: Error) {
  const cache = createMemorySurfaceCache();
  const notes: string[] = [];
  const core = {
    noteSurfaceHistoryGap: async (container: string, note: string) => {
      notes.push(`${container}:${note}`);
    },
    readSurfaceMessages: cache.readMessages,
    rememberSurfaceHistory: async (events) => {
      await cache.ingest(events);
    },
  } as SlackCoreClient;
  const calls: string[] = [];
  const historyClient = {
    conversations: {
      history: async (args: any) => {
        calls.push(`history:${args.latest ?? ""}:${args.limit}`);
        if (fail) throw fail;
        return {
          messages: [
            { ts: "20.000000", text: "root", user: "U1", thread_ts: "20.000000", reply_count: 1 },
            { ts: "10.000000", text: "earlier plan", user: "U2" },
          ],
        };
      },
      replies: async (args: any) => {
        calls.push(`replies:${args.ts}:${args.limit}`);
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
  return { cache, calls, notes, readHistory };
}

async function joinedLate(cache: ReturnType<typeof createMemorySurfaceCache>) {
  await cache.ingest([
    { container: "C1", ts: "20.000000", text: "root", authorId: "U1" },
    { container: "C1", ts: "21.000000", sub: "20.000000", text: "what did we decide above?", authorId: "U1" },
  ]);
}

test("a late-joined thread backfills its last 15 replies once", async () => {
  const { cache, calls, readHistory } = fixture();
  await joinedLate(cache);
  const thread = await readHistory({}, "C1", "20.000000", undefined, true);
  assert.deepEqual(thread.raw.map((m) => m.ts).sort(), ["20.000000", "21.000000"]);
  assert.deepEqual(calls, ["replies:20.000000:15"]);
  await readHistory({}, "C1", "20.000000", undefined, true);
  assert.equal(calls.length, 1);
  const channel = await readHistory({}, "C1");
  assert.ok(channel.raw.some((m) => m.text === "earlier plan"));
  await readHistory({}, "C1");
  assert.deepEqual(calls, ["replies:20.000000:15", "history::15"]);
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
  assert.deepEqual(calls, ["replies:20.000000:15"]);
  const again = await readHistory({}, "C1", "20.000000", undefined, true);
  assert.deepEqual(again.raw.map((m) => m.ts).sort(), ["20.000000", "21.000000"]);
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
  assert.deepEqual(calls, ["replies:20.000000:200"]);
});

test("an older-page read does not use up the latest-page backfill", async () => {
  const { cache, calls, readHistory } = fixture();
  await joinedLate(cache);
  await readHistory({}, "C1", undefined, "15.000000");
  await readHistory({}, "C1");
  assert.deepEqual(calls, ["history:15.000000:200", "history::15"]);
});

test("a rate-limited backfill notes the gap in the channel's memory once", async () => {
  const limited = Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error" });
  const { cache, notes, readHistory } = fixture(limited);
  await joinedLate(cache);
  await readHistory({}, "C1", "20.000000", undefined, true);
  await readHistory({}, "C1", "20.000000", undefined, true);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /^C1:Slack rate-limited the initial history pull/);
});

test("a non-rate-limit backfill failure writes no memory note", async () => {
  const { cache, notes, readHistory } = fixture(new Error("boom"));
  await joinedLate(cache);
  await readHistory({}, "C1", "20.000000", undefined, true);
  assert.deepEqual(notes, []);
});

test("the history gap note lands in the conversation's own scope memory", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([
    { container: "C1", ts: "1.000000", text: "hi", authorId: "U1", kind: "channel" },
    { container: "G1", ts: "1.000000", text: "hi", authorId: "U1", kind: "group" },
  ]);
  const captured: string[] = [];
  const client = createSlackCoreClient({
    surfaceCache: cache,
    memory: {
      capture: async (scope: string, facts: string[]) => {
        captured.push(`${scope}=${facts.join()}`);
        return facts.length;
      },
    },
    turnStream: createTurnStream(),
    runs: { onTerminal() {} },
  } as any);
  await client.noteSurfaceHistoryGap!("C1", "gap");
  await client.noteSurfaceHistoryGap!("G1", "gap");
  assert.deepEqual(captured, ["channel:C1=gap", "group:G1=gap"]);
});

test("the bot joining a channel backfills it once, and a failed pull never blocks the join", async () => {
  const events = new Map<string, (args: any) => Promise<void>>();
  const pulled: string[] = [];
  let synced = 0;
  registerSlackEvents({ event: (n: string, h: any) => void events.set(n, h), message: () => {} } as any, {
    handler: {} as any,
    mirror: {} as any,
    directory: {
      forceDirectorySync: async () => {
        synced++;
      },
    } as any,
    ids,
    deduper: createDeduper(),
    allowActor: () => true,
    backfillHistory: async (_client, channel) => {
      pulled.push(channel);
      if (channel === "C2") throw new Error("rate limited");
    },
  });
  const join = (channel: string, user: string) =>
    events.get("member_joined_channel")!({
      event: { channel, user, event_ts: `${channel}${user}` },
      body: {},
      client: {},
    });
  await join("C1", "UBOT");
  await join("C1", "U9");
  await join("C2", "UBOT");
  assert.deepEqual(pulled, ["C1", "C2"]);
  assert.equal(synced, 3);
});
