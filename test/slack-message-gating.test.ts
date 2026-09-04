import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  shouldProcessMessage,
  isGroupMembershipMessage,
  channelPrivacyChange,
  createRefreshCoalescer,
  hasContent,
  dmThreadRef,
  mentionsBot,
  threadHasBotStake,
  isThreadReply,
  createThreadTracker,
  createDeduper,
  dedupedRun,
  dedupeKey,
  isBareStop,
  maybeInterceptStop,
  createInFlightThreadMap,
} from "../src/slack/lib.ts";

test("shouldProcessMessage allows file_share and thread_broadcast but drops other subtypes and the bot's own", () => {
  assert.equal(shouldProcessMessage({ subtype: "file_share", user: "U1" }, "BOT"), true);
  assert.equal(shouldProcessMessage({ subtype: "thread_broadcast", user: "U1" }, "BOT"), true);
  assert.equal(shouldProcessMessage({ user: "U1" }, "BOT"), true);
  assert.equal(shouldProcessMessage({ subtype: "message_changed", user: "U1" }, "BOT"), false);
  assert.equal(shouldProcessMessage({ subtype: "channel_join", user: "U1" }, "BOT"), false);
  assert.equal(shouldProcessMessage({ subtype: "file_share", bot_id: "B1", user: "BOT" }, "BOT"), false);
  assert.equal(shouldProcessMessage({ user: "BOT" }, "BOT"), false);
});

test("shouldProcessMessage processes peer-bot messages but drops the bot's own bot_id/user", () => {
  assert.equal(shouldProcessMessage({ bot_id: "B1", user: "U1" }, "BOT"), true);
  assert.equal(shouldProcessMessage({ subtype: "bot_message", bot_id: "B1", user: "U2" }, "BOT"), true);
  assert.equal(shouldProcessMessage({ bot_id: "B1" }, "BOT"), true);
  assert.equal(shouldProcessMessage({ bot_id: "OWN", user: "BOT" }, "BOT", "OWN"), false);
  assert.equal(shouldProcessMessage({ bot_id: "OWN" }, "BOT", "OWN"), false);
  assert.equal(shouldProcessMessage({ bot_id: "B1", subtype: "message_changed", user: "U1" }, "BOT"), false);
});

test("group-DM membership messages trigger an immediate directory refresh", () => {
  assert.equal(isGroupMembershipMessage({ channel_type: "mpim", subtype: "group_join" }), true);
  assert.equal(isGroupMembershipMessage({ channel_type: "mpim", subtype: "group_leave" }), true);
  assert.equal(isGroupMembershipMessage({ channel_type: "group", subtype: "group_leave" }), false);
  assert.equal(isGroupMembershipMessage({ channel_type: "mpim" }), false);
});

test("channel privacy conversions invalidate the cached authorization classification", () => {
  const knownPublic = new Set(["C1"]);
  const converted = channelPrivacyChange({ channel: "C1", subtype: "channel_convert_to_private" });
  assert.deepEqual(converted, { channel: "C1", isPrivate: true });
  if (converted?.isPrivate) knownPublic.delete(converted.channel);
  assert.equal(knownPublic.has("C1"), false, "a later member-left event is no longer filtered as public");
  assert.deepEqual(channelPrivacyChange({ channel: "C1", subtype: "channel_convert_to_public" }), {
    channel: "C1",
    isPrivate: false,
  });
  assert.equal(channelPrivacyChange({ channel: "C1", subtype: "channel_leave" }), null);
});

test("directory refreshes coalesce bursts without losing a request that lands mid-refresh", async () => {
  const releases: Array<() => void> = [];
  let runs = 0;
  const refresh = createRefreshCoalescer(async () => {
    runs++;
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  const first = refresh();
  const second = refresh();
  assert.equal(runs, 1);
  releases.shift()!();
  while (runs < 2) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runs, 2);
  releases.shift()!();
  await Promise.all([first, second]);
  assert.equal(runs, 2);
});

test("hasContent is true with text OR with files, false when truly empty (scenarios 02, 29)", () => {
  assert.equal(hasContent("hi", []), true);
  assert.equal(hasContent("", [{}]), true);
  assert.equal(hasContent("   ", []), false);
});

test("dmThreadRef gives the DM main pane one continuous lane and each thread its own", () => {
  assert.equal(dmThreadRef("D1"), "dm:D1");
  assert.equal(dmThreadRef("D1", "1699999999.000100"), "dm:D1:1699999999.000100");
  assert.notEqual(dmThreadRef("D1", "1699999999.000100"), dmThreadRef("D1", "1700000000.000200"));
  assert.notEqual(dmThreadRef("D1", "1699999999.000100"), dmThreadRef("D1"));
});

test("mentionsBot detects the bot @mention so thread-follow leaves those to app_mention", () => {
  assert.equal(mentionsBot("hey <@BOT> do this", "BOT"), true);
  assert.equal(mentionsBot("just a follow-up", "BOT"), false);
  assert.equal(mentionsBot("<@OTHER> not me", "BOT"), false);
  assert.equal(mentionsBot("anything", ""), false);
});

test("threadHasBotStake counts either a bot-authored message or a prior real mention", () => {
  assert.equal(threadHasBotStake([{ user: "BOT", text: "done" }], "BOT"), true);
  assert.equal(threadHasBotStake([{ bot_id: "B123", text: "done" }], "BOT", "B123"), true);
  assert.equal(threadHasBotStake([{ user: "U1", text: "hey <@BOT> can you look?" }], "BOT"), true);
  assert.equal(threadHasBotStake([{ user: "U1", text: "agent prod can you look?" }], "BOT"), false);
  assert.equal(threadHasBotStake([{ user: "U1", text: "hey <@OTHER>" }], "BOT"), false);
});

test("isThreadReply is true only for replies inside a thread, not parents or plain posts", () => {
  assert.equal(isThreadReply({ ts: "2", thread_ts: "1" }), true);
  assert.equal(isThreadReply({ ts: "1", thread_ts: "1" }), false);
  assert.equal(isThreadReply({ ts: "1" }), false);
});

test("createThreadTracker caches participation and never time-expires a positive stake", () => {
  const t = createThreadTracker();
  assert.equal(t.get("C", "1"), undefined);
  t.mark("C", "1", true);
  assert.equal(t.get("C", "1"), true);
  t.mark("C", "2", false);
  assert.equal(t.get("C", "2"), false);
  t.mark("C", "3", true);
  assert.equal(t.get("C", "1"), true);
  assert.equal(t.get("C", "3"), true);
});

test("createThreadTracker expires a NEGATIVE entry after its TTL (the bot can gain a stake later, e.g. a cron delivery)", async () => {
  const t = createThreadTracker({ negativeTtlMs: 120 });
  t.mark("C", "1", false);
  t.mark("C", "2", true);
  assert.equal(t.get("C", "1"), false, "negative still cached inside the TTL");
  await sleep(250);
  assert.equal(t.get("C", "1"), undefined, "negative expires → next reply re-checks the thread");
  assert.equal(t.get("C", "2"), true, "positive survives past the negative TTL");
});

test("createThreadTracker: marking a stake true overrides a cached negative (delivery posted into the thread)", async () => {
  const t = createThreadTracker({ negativeTtlMs: 120 });
  t.mark("C", "1", false);
  t.mark("C", "1", true);
  await sleep(250);
  assert.equal(t.get("C", "1"), true);
});

test("createDeduper drops a repeated event_id once seen (scenario 28)", () => {
  const d = createDeduper(10);
  const ev = { event_id: "Ev123", channel: "C", ts: "1.2" };
  assert.equal(d.seen(dedupeKey(ev)), false);
  assert.equal(d.seen(dedupeKey(ev)), true);
});

test("createDeduper evicts the oldest key past its max", () => {
  const d = createDeduper(2);
  assert.equal(d.seen("a"), false);
  assert.equal(d.seen("b"), false);
  assert.equal(d.seen("c"), false);
  assert.equal(d.seen("a"), false);
  assert.equal(d.seen("c"), true);
});

test("createDeduper.forget re-admits a failed event so a withheld-ack redelivery reprocesses", () => {
  const d = createDeduper(10);
  const key = dedupeKey({ event_id: "Ev9", channel: "C", ts: "5.5" });
  assert.equal(d.seen(key), false);
  d.forget(key);
  assert.equal(d.seen(key), false);
  assert.equal(d.seen(key), true);
});

test("dedupedRun (the dispatch flow): handler failure un-marks the key so a same-process redelivery reprocesses", async () => {
  const d = createDeduper(10);
  const key = dedupeKey({ event_id: "Ev1", channel: "C", ts: "1.1" });
  let attempts = 0;
  const errors: unknown[] = [];
  const flaky = async (): Promise<void> => {
    attempts++;
    if (attempts === 1) throw new Error("core unavailable");
  };
  const onError = (e: unknown): void => {
    errors.push(e);
  };
  await dedupedRun(d, key, flaky, onError);
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1, "failure must surface to onError");
  await dedupedRun(d, key, flaky, onError);
  assert.equal(attempts, 2, "redelivery after a failed handler must reprocess — forget is dead code otherwise");
  assert.equal(errors.length, 1);
  await dedupedRun(d, key, flaky, onError);
  assert.equal(attempts, 2, "successful handling must still dedupe a true duplicate");
});

test("dedupeKey keys on the stable channel:ts identity, not the delivery envelope", () => {
  assert.equal(dedupeKey({ event_id: "E1", client_msg_id: "C1", channel: "CH", ts: "9.9" }), "CH:9.9");
  assert.equal(dedupeKey({ event_id: "E2", channel: "CH", ts: "9.9" }), "CH:9.9");
  assert.equal(dedupeKey({ channel: "CH", ts: "9.9" }), "CH:9.9");
  assert.equal(dedupeKey({ event_id: "E" }), "E");
  assert.equal(dedupeKey({ client_msg_id: "C" }), "C");
});

test("createDeduper suppresses a redelivery of the same message with a different envelope (incident regression)", () => {
  const d = createDeduper(10);
  assert.equal(d.seen(dedupeKey({ event_id: "Ev1", client_msg_id: "CM", channel: "D0", ts: "111.222" })), false);
  assert.equal(d.seen(dedupeKey({ event_id: "Ev2", channel: "D0", ts: "111.222" })), true);
});

test("isBareStop accepts case-insensitive stop with optional trailing . or !", () => {
  for (const t of ["stop", "Stop", "STOP", " stop ", "stop.", "stop!"]) assert.equal(isBareStop(t), true, t);
  for (const t of ["please stop the job", "stop it", "stop?", "stopping", ""]) assert.equal(isBareStop(t), false, t);
});

test("maybeInterceptStop: bare stop with in-flight run signals abort and suppresses the turn", async () => {
  const signaled: string[] = [];
  const runs = createInFlightThreadMap();
  runs.set("dm:C1", "run-1");
  const intercepted = await maybeInterceptStop({
    text: "stop",
    threadRef: "dm:C1",
    getInFlightRun: (ref) => runs.get(ref),
    signalAbort: async (runId) => {
      signaled.push(runId);
    },
  });
  assert.equal(intercepted, true);
  assert.deepEqual(signaled, ["run-1"]);
});

test("maybeInterceptStop: stop with no in-flight run flows through as a normal turn", async () => {
  const signaled: string[] = [];
  const intercepted = await maybeInterceptStop({
    text: "stop",
    threadRef: "dm:C1",
    getInFlightRun: () => undefined,
    signalAbort: async (runId) => {
      signaled.push(runId);
    },
  });
  assert.equal(intercepted, false);
  assert.deepEqual(signaled, []);
});

test("maybeInterceptStop: async getInFlightRun fallback (map miss) still aborts and intercepts", async () => {
  const signaled: string[] = [];
  const intercepted = await maybeInterceptStop({
    text: "stop",
    threadRef: "dm:C1",
    getInFlightRun: async (ref) => (ref === "dm:C1" ? "run-async" : undefined),
    signalAbort: async (runId) => {
      signaled.push(runId);
    },
  });
  assert.equal(intercepted, true);
  assert.deepEqual(signaled, ["run-async"]);
});

test("maybeInterceptStop: async getInFlightRun resolving undefined flows through as a normal turn", async () => {
  const signaled: string[] = [];
  const intercepted = await maybeInterceptStop({
    text: "stop",
    threadRef: "dm:C1",
    getInFlightRun: async () => undefined,
    signalAbort: async (runId) => {
      signaled.push(runId);
    },
  });
  assert.equal(intercepted, false);
  assert.deepEqual(signaled, []);
});

test("maybeInterceptStop: non-bare stop text flows through even with an in-flight run", async () => {
  const signaled: string[] = [];
  const intercepted = await maybeInterceptStop({
    text: "please stop the job",
    threadRef: "dm:C1",
    getInFlightRun: () => "run-1",
    signalAbort: async (runId) => {
      signaled.push(runId);
    },
  });
  assert.equal(intercepted, false);
  assert.deepEqual(signaled, []);
});

test("createInFlightThreadMap: clear is runId-guarded so a finished run can't unpin a newer one", () => {
  const runs = createInFlightThreadMap();
  runs.set("dm:C1", "run-1");
  runs.set("dm:C1", "run-2");
  runs.clear("dm:C1", "run-1");
  assert.equal(runs.get("dm:C1"), "run-2");
  runs.clear("dm:C1", "run-2");
  assert.equal(runs.get("dm:C1"), undefined);
});
