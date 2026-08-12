import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slackReplyArgs,
  botIdentityArgs,
  botIdentityFromEnv,
  encodeDeliveryTarget,
  parseDeliveryTarget,
  deliveryCandidatesFor,
  createDeliveryTracker,
  deliverWithRetry,
  postWithVerify,
  channelSurfaceUrl,
  channelWelcomeMessage,
  surfaceHeaderText,
  headerUpdate,
  isSurfaceHeaderMessage,
  findHeaderPin,
  createSurfaceHeaderEnsurer,
  scopeSurfaceUrl,
  onBotJoinedChannel,
} from "../src/slack/lib.ts";

test("slackReplyArgs keeps channel replies thread-only and never broadcasts them", () => {
  assert.deepEqual(slackReplyArgs("C1", "reply", "123.45", { threadOnly: true }), {
    channel: "C1",
    text: "reply",
    thread_ts: "123.45",
    reply_broadcast: false,
  });
  assert.deepEqual(slackReplyArgs("D1", "reply", "123.45"), {
    channel: "D1",
    text: "reply",
    thread_ts: "123.45",
  });
});

test("botIdentityFromEnv reads the display-name/icon knobs and trims them", () => {
  assert.deepEqual(botIdentityFromEnv({} as NodeJS.ProcessEnv), {});
  assert.deepEqual(
    botIdentityFromEnv({ SLACK_BOT_DISPLAY_NAME: "  agent · singapore-v2  " } as unknown as NodeJS.ProcessEnv),
    { username: "agent · singapore-v2" },
  );
  assert.deepEqual(
    botIdentityFromEnv({
      SLACK_BOT_DISPLAY_NAME: "agent · singapore-v2",
      SLACK_BOT_ICON_EMOJI: ":robot_face:",
    } as unknown as NodeJS.ProcessEnv),
    { username: "agent · singapore-v2", icon_emoji: ":robot_face:" },
  );
});

test("botIdentityArgs/slackReplyArgs stay a no-op without an env override", () => {
  assert.deepEqual(botIdentityArgs(), {});
  assert.deepEqual(slackReplyArgs("C1", "reply", undefined), {
    channel: "C1",
    text: "reply",
  });
});

test("slackReplyArgs can suppress Slack link and media unfurls per message", () => {
  assert.deepEqual(slackReplyArgs("C1", "see https://x.com/a/status/1", undefined, { unfurlLinks: false }), {
    channel: "C1",
    text: "see https://x.com/a/status/1",
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.deepEqual(slackReplyArgs("C1", "see https://x.com/a/status/1", undefined), {
    channel: "C1",
    text: "see https://x.com/a/status/1",
  });
});

test("delivery target round-trips channel + thread, and channel-only when not threaded", () => {
  const threaded = encodeDeliveryTarget("C123", "1699999999.001200");
  assert.equal(threaded, "C123:1699999999.001200");
  assert.deepEqual(parseDeliveryTarget(threaded), { channel: "C123", threadTs: "1699999999.001200" });

  const root = encodeDeliveryTarget("D456");
  assert.equal(root, "D456");
  assert.deepEqual(parseDeliveryTarget(root), { channel: "D456" });
});

test("parseDeliveryTarget splits only on the first ':' and tolerates a bare channel", () => {
  assert.deepEqual(parseDeliveryTarget("C9:1.2"), { channel: "C9", threadTs: "1.2" });
  assert.deepEqual(parseDeliveryTarget("C9"), { channel: "C9" });
});

test("deliveryCandidatesFor: a channel offers this-thread (default) and the-whole-channel", () => {
  const cands = deliveryCandidatesFor("channel", "C123", "1699999999.001200", "eng");
  assert.ok(cands);
  assert.equal(cands.length, 2);
  assert.deepEqual(cands[0], { target: "C123:1699999999.001200", label: "this thread" });
  assert.equal(cands[1]!.target, "C123");
  assert.equal(cands[1]!.label, "#eng (the whole channel)");
  assert.deepEqual(parseDeliveryTarget(cands[1]!.target), { channel: "C123" });
  assert.notEqual(cands[0]!.target, cands[1]!.target);
});

test("deliveryCandidatesFor: a DM has a single destination → no menu", () => {
  assert.equal(deliveryCandidatesFor("dm", "D1", "1.2", undefined), undefined);
});

test("deliveryCandidatesFor: missing channel name falls back to a generic label", () => {
  const cands = deliveryCandidatesFor("channel", "C7", undefined, undefined);
  assert.ok(cands);
  assert.equal(cands[1]!.label, "the whole channel");
});

test("deliveryCandidatesFor: a group DM offers this-thread and group-DM destinations", () => {
  const cands = deliveryCandidatesFor("group", "G123", "1699999999.001200", undefined);
  assert.ok(cands);
  assert.deepEqual(cands[0], { target: "G123:1699999999.001200", label: "this thread" });
  assert.deepEqual(cands[1], { target: "G123", label: "the group DM" });
});

interface DeliveryLogEntry {
  stage: "post" | "ack";
  gaveUp: boolean;
}

function deliveryHarness(opts: { postFails?: number; ackFails?: number; maxAttempts?: number } = {}) {
  const tracker = createDeliveryTracker({ maxAttempts: opts.maxAttempts ?? 5 });
  let postFails = opts.postFails ?? 0;
  let ackFails = opts.ackFails ?? 0;
  const posts: number[] = [];
  const acks: unknown[] = [];
  const errors: DeliveryLogEntry[] = [];
  const cycle = async (ackBody?: unknown): Promise<void> =>
    deliverWithRetry({
      tracker,
      id: "d1",
      post: async () => {
        if (postFails > 0) {
          postFails--;
          throw new Error("slack 429");
        }
        posts.push(1);
        return ackBody;
      },
      ack: async (body) => {
        if (ackFails > 0) {
          ackFails--;
          throw new Error("core 503");
        }
        acks.push(body);
      },
      onError: (stage, _err, gaveUp) => errors.push({ stage, gaveUp }),
    });
  return { tracker, cycle, posts, acks, errors };
}

test("deliverWithRetry: happy path posts once, acks once, and clears its state", async () => {
  const h = deliveryHarness();
  await h.cycle({ recipientThreadRef: "dm:D1" });
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.acks, [{ recipientThreadRef: "dm:D1" }]);
  assert.deepEqual(h.errors, []);
});

test("deliverWithRetry: a failed ack does NOT re-post on the next cycle — only the ack retries (no duplicate message)", async () => {
  const h = deliveryHarness({ ackFails: 1 });
  await h.cycle({ recipientThreadRef: "dm:D1" });
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.errors, [{ stage: "ack", gaveUp: false }]);

  await h.cycle();
  assert.equal(h.posts.length, 1, "message was already posted — never duplicated");
  assert.deepEqual(h.acks, [{ recipientThreadRef: "dm:D1" }], "the original ack body is retried");
});

test("deliverWithRetry: a poison delivery is given up on after the attempt cap, then skipped for free", async () => {
  const h = deliveryHarness({ postFails: 100, maxAttempts: 3 });
  for (let i = 0; i < 5; i++) await h.cycle();
  assert.equal(h.posts.length, 0);
  assert.deepEqual(h.errors, [
    { stage: "post", gaveUp: false },
    { stage: "post", gaveUp: false },
    { stage: "post", gaveUp: true },
  ]);
  assert.ok(h.tracker.givenUp("d1"), "later cycles skip the poison delivery without attempting it");
});

test("deliverWithRetry: transient post failures recover before the cap", async () => {
  const h = deliveryHarness({ postFails: 2, maxAttempts: 5 });
  for (let i = 0; i < 3; i++) await h.cycle();
  assert.equal(h.posts.length, 1);
  assert.equal(h.acks.length, 1);
  assert.ok(!h.tracker.givenUp("d1"));
});

test("createDeliveryTracker: a posted-but-unacked entry evicted by the cap is given up on, never re-posted", () => {
  const t = createDeliveryTracker({ maxAttempts: 5, maxTracked: 2 });
  t.markPosted("a");
  t.markPosted("b");
  t.markPosted("c");
  assert.equal(t.posted("a"), undefined);
  assert.ok(t.givenUp("a"), "evicted posted entry becomes dead — duplicate post is impossible");
  assert.ok(t.posted("b") && t.posted("c"), "entries within the cap keep their posted state");
});

const WEB_BASE = "https://portal.example.com/web-ui";
const BOT = "UBOT";

function fakeJoinClient(
  opts: {
    postMessageFails?: boolean;
    extShared?: boolean;
  } = {},
) {
  const calls = {
    posted: [] as Array<{ channel: string; text: string }>,
  };
  return {
    calls,
    client: {
      chat: {
        postMessage: async (args: { channel: string; text: string }) => {
          if (opts.postMessageFails) {
            const err = new Error("ratelimited") as Error & { data?: unknown };
            err.data = { error: "ratelimited" };
            throw err;
          }
          calls.posted.push({ channel: args.channel, text: args.text });
          return {};
        },
      },
      conversations: {
        info: async (_args: { channel: string }) => ({
          channel: {
            is_ext_shared: Boolean(opts.extShared),
          },
        }),
      },
    },
  };
}

test("channelSurfaceUrl builds the project deep link and degrades when unset", () => {
  assert.equal(channelSurfaceUrl(WEB_BASE, "C123"), `${WEB_BASE}/projects/channel/C123`);
  assert.equal(channelSurfaceUrl("https://x/web-ui/", "C9"), "https://x/web-ui/projects/channel/C9");
  assert.equal(channelSurfaceUrl(undefined, "C1"), undefined);
  assert.equal(channelSurfaceUrl("", "C1"), undefined);
});

test("channelWelcomeMessage includes the link when present, omits it cleanly when not", () => {
  const url = channelSurfaceUrl(WEB_BASE, "C1")!;
  assert.ok(channelWelcomeMessage(url).includes(url));
  const linkless = channelWelcomeMessage(undefined);
  assert.ok(!linkless.includes("http"));
  assert.ok(linkless.length > 0);
});

test("onBotJoinedChannel: posts welcome with the deep link and asks the ensurer to pin the header", async () => {
  const { client, calls } = fakeJoinClient();
  let synced = 0;
  const ensured: string[] = [];
  await onBotJoinedChannel({
    client,
    channel: "C123",
    joinerUserId: BOT,
    botUserId: BOT,
    webUiPublicUrl: WEB_BASE,
    syncDirectory: async () => {
      synced++;
    },
    ensureHeader: (channel) => ensured.push(channel),
  });
  const expectedUrl = `${WEB_BASE}/projects/channel/C123`;
  assert.equal(calls.posted.length, 1);
  assert.equal(calls.posted[0]!.channel, "C123");
  assert.ok(calls.posted[0]!.text.includes(expectedUrl), "welcome message must contain the channel surface deep link");
  assert.deepEqual(ensured, ["C123"], "the pinned header is the ensurer's to post, not join's");
  assert.equal(synced, 1, "directory sync must run on bot join");
});

test("onBotJoinedChannel: ignores a human joining (only the bot itself triggers it)", async () => {
  const { client, calls } = fakeJoinClient();
  let synced = 0;
  await onBotJoinedChannel({
    client,
    channel: "C123",
    joinerUserId: "UHUMAN",
    botUserId: BOT,
    webUiPublicUrl: WEB_BASE,
    syncDirectory: async () => {
      synced++;
    },
  });
  assert.equal(calls.posted.length, 0);
  assert.equal(synced, 0);
});

test("onBotJoinedChannel: an ensureHeader failure is swallowed and never blocks the welcome or sync", async () => {
  const { client, calls } = fakeJoinClient();
  let synced = 0;
  await assert.doesNotReject(
    onBotJoinedChannel({
      client,
      channel: "C123",
      joinerUserId: BOT,
      botUserId: BOT,
      webUiPublicUrl: WEB_BASE,
      syncDirectory: async () => {
        synced++;
      },
      ensureHeader: () => {
        throw new Error("missing_scope");
      },
    }),
  );
  assert.equal(calls.posted.length, 1, "welcome still lands even when the header hook throws");
  assert.equal(synced, 1, "directory sync still runs after a swallowed header error");
});

test("onBotJoinedChannel: a welcome-post failure still runs the directory sync", async () => {
  const { client, calls } = fakeJoinClient({ postMessageFails: true });
  let synced = 0;
  await assert.doesNotReject(
    onBotJoinedChannel({
      client,
      channel: "C123",
      joinerUserId: BOT,
      botUserId: BOT,
      webUiPublicUrl: WEB_BASE,
      syncDirectory: async () => {
        synced++;
      },
    }),
  );
  assert.equal(calls.posted.length, 0, "the welcome post threw");
  assert.equal(synced, 1, "directory sync still runs so members can reach the surface even if the welcome failed");
});

test("onBotJoinedChannel: stays silent in an externally-shared (Slack Connect) channel — no welcome, no purpose", async () => {
  const { client, calls } = fakeJoinClient({ extShared: true });
  let synced = 0;
  await onBotJoinedChannel({
    client,
    channel: "C123",
    joinerUserId: BOT,
    botUserId: BOT,
    webUiPublicUrl: WEB_BASE,
    syncDirectory: async () => {
      synced++;
    },
  });
  assert.equal(calls.posted.length, 0, "the bot never posts into a Connect channel (an external could see it)");
  assert.equal(synced, 1, "directory sync (which never emits into the channel) still runs");
});

test("onBotJoinedChannel: welcomes a normal internal channel and hands the pinned header to the ensurer", async () => {
  const { client, calls } = fakeJoinClient();
  let synced = 0;
  const ensured: string[] = [];
  await onBotJoinedChannel({
    client,
    channel: "C123",
    joinerUserId: BOT,
    botUserId: BOT,
    webUiPublicUrl: WEB_BASE,
    syncDirectory: async () => {
      synced++;
    },
    ensureHeader: (channel) => ensured.push(channel),
  });
  const expectedUrl = `${WEB_BASE}/projects/channel/C123`;
  assert.equal(calls.posted.length, 1, "welcome lands on a normal internal channel");
  assert.ok(calls.posted[0]!.text.includes(expectedUrl), "welcome message contains the project deep link");
  assert.deepEqual(ensured, ["C123"], "join triggers exactly one header ensure");
  assert.equal(synced, 1, "directory sync runs");
});

function verifyHarness(
  opts: {
    postResults?: Array<{ ok?: { ts: string; channel?: string }; err?: unknown }>;
    historyMessages?: unknown[];
    historyThrows?: boolean;
  } = {},
) {
  const results = opts.postResults ?? [{ ok: { ts: "1.1", channel: "C1" } }];
  let postCall = 0;
  const postArgs: any[] = [];
  let historyArgs: any;
  let repliesArgs: any;
  const scan = async () => {
    if (opts.historyThrows) throw new Error("history read failed");
    return { messages: opts.historyMessages ?? [] };
  };
  const client = {
    chat: {
      postMessage: async (args: any) => {
        postArgs.push(args);
        const r = results[Math.min(postCall, results.length - 1)]!;
        postCall++;
        if (r.err) throw r.err;
        return r.ok;
      },
    },
    conversations: {
      history: async (args: any) => {
        historyArgs = args;
        return scan();
      },
      replies: async (args: any) => {
        repliesArgs = args;
        return scan();
      },
    },
  } as any;
  return {
    client,
    postArgs,
    get postCalls() {
      return postArgs.length;
    },
    get historyCalled() {
      return historyArgs !== undefined;
    },
    get repliesCalled() {
      return repliesArgs !== undefined;
    },
  };
}

const KEY = "run:abc";
const foundMsg = { ts: "9.9", metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: KEY } } };

test("postWithVerify: posts once and returns ts on success", async () => {
  const h = verifyHarness();
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.deepEqual(res, { ts: "1.1", channel: "C1" });
  assert.equal(h.postCalls, 1);
  assert.equal(h.historyCalled, false, "no verify on a clean success");
});

test("postWithVerify: stamps metadata with the idempotency key", async () => {
  const h = verifyHarness();
  await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.deepEqual(h.postArgs[0].metadata, {
    event_type: "qm_delivery",
    event_payload: { idempotency_key: KEY },
  });
});

test("postWithVerify: platform error rethrows without retry", async () => {
  const err = { code: "slack_webapi_platform_error", data: { error: "channel_not_found" } };
  const h = verifyHarness({ postResults: [{ err }] });
  await assert.rejects(
    () => postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY),
    (e: any) => e === err,
  );
  assert.equal(h.postCalls, 1);
  assert.equal(h.historyCalled, false);
});

test("postWithVerify: rate limit retries without verify", async () => {
  const h = verifyHarness({
    postResults: [
      { err: { code: "slack_webapi_rate_limited_error", retryAfter: 0 } },
      { ok: { ts: "2.2", channel: "C1" } },
    ],
  });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.equal(res.ts, "2.2");
  assert.equal(h.postCalls, 2);
  assert.equal(h.historyCalled, false, "a 429 didn't execute — no verify needed");
});

test("postWithVerify: ambiguous error + message found on verify returns existing ts, no re-post", async () => {
  const h = verifyHarness({
    postResults: [{ err: { code: "slack_webapi_request_error", original: { code: "ETIMEDOUT" } } }],
    historyMessages: [foundMsg],
  });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.deepEqual(res, { ts: "9.9", channel: "C1" });
  assert.equal(h.postCalls, 1, "the post landed — never re-sent");
  assert.equal(h.historyCalled, true);
});

test("postWithVerify: recovery preflight returns an existing keyed post without posting again", async () => {
  const h = verifyHarness({ historyMessages: [foundMsg] });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY, { verifyFirst: true });
  assert.deepEqual(res, { ts: "9.9", channel: "C1" });
  assert.equal(h.postCalls, 0, "fresh-process recovery reuses the live post");
  assert.equal(h.historyCalled, true);
});

test("postWithVerify: threaded recovery paginates within the delivery window before posting", async () => {
  let replyReads = 0;
  const client = {
    chat: { postMessage: async () => assert.fail("an existing recovery post must not be posted again") },
    conversations: {
      history: async () => assert.fail("thread recovery must read replies"),
      replies: async () => {
        replyReads++;
        return replyReads === 1
          ? { messages: [], response_metadata: { next_cursor: "next" } }
          : { messages: [foundMsg], response_metadata: { next_cursor: "" } };
      },
    },
  } as any;
  const res = await postWithVerify(client, { channel: "C1", text: "hi", thread_ts: "5.5" }, KEY, {
    verifyFirst: true,
    verifyOldest: "100.0",
  });
  assert.deepEqual(res, { ts: "9.9", channel: "C1" });
  assert.equal(replyReads, 2);
});

test("postWithVerify: ambiguous error + not found retries the post", async () => {
  const h = verifyHarness({
    postResults: [
      { err: { code: "slack_webapi_request_error", original: { code: "ECONNRESET" } } },
      { ok: { ts: "3.3", channel: "C1" } },
    ],
    historyMessages: [],
  });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.equal(res.ts, "3.3");
  assert.equal(h.postCalls, 2);
});

test("postWithVerify: ambiguous error + verify read fails rethrows without re-post", async () => {
  const err = { code: "slack_webapi_request_error", original: { code: "ETIMEDOUT" } };
  const h = verifyHarness({ postResults: [{ err }], historyThrows: true });
  await assert.rejects(
    () => postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY),
    (e: any) => e === err,
  );
  assert.equal(h.postCalls, 1, "at-most-once: never re-sent when we can't confirm");
});

test("postWithVerify: threaded post verifies via conversations.replies", async () => {
  const h = verifyHarness({
    postResults: [{ err: { code: "slack_webapi_request_error", original: { code: "ETIMEDOUT" } } }],
    historyMessages: [foundMsg],
  });
  await postWithVerify(h.client, { channel: "C1", text: "hi", thread_ts: "5.5" } as any, KEY);
  assert.equal(h.repliesCalled, true);
  assert.equal(h.historyCalled, false, "threaded verify reads replies, not history");
});

test("surfaceHeaderText names the model and the project link without branding — degrading gracefully", () => {
  assert.equal(
    surfaceHeaderText({ modelName: "Claude Opus 4.8" }, "https://claw.acme.dev/projects/channel/C1"),
    "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  );
  assert.equal(surfaceHeaderText({ modelName: "Claude Opus 4.8" }, undefined), "Using Claude Opus 4.8 here.");
  assert.equal(surfaceHeaderText({}, "https://claw.acme.dev"), "<https://claw.acme.dev|More settings>");
  assert.equal(surfaceHeaderText({ modelName: "  " }, "  "), undefined);
});

test("isSurfaceHeaderMessage recognizes only the bot's own header shapes", () => {
  assert.ok(isSurfaceHeaderMessage("Using Claude Opus 4.8 here. <https://claw.acme.dev|More settings>"));
  assert.ok(isSurfaceHeaderMessage("Using Claude Opus 4.8 here."));
  assert.ok(isSurfaceHeaderMessage("<https://claw.acme.dev|More settings>"));
  assert.ok(!isSurfaceHeaderMessage("Reminder: standup at 10"));
  assert.ok(!isSurfaceHeaderMessage(""));
  assert.ok(!isSurfaceHeaderMessage(undefined));
});

test("findHeaderPin picks only the bot's own pinned header message", () => {
  const items = [
    { message: { ts: "1.0", user: "U0HUMAN", text: "Using X here." } },
    { message: { ts: "2.0", user: "U0BOT", text: "team norms doc" } },
    {
      message: { ts: "3.0", user: "U0BOT", text: "Using Claude Opus 4.8 here. <https://claw.acme.dev|More settings>" },
    },
  ];
  assert.deepEqual(findHeaderPin(items, "U0BOT"), {
    ts: "3.0",
    text: "Using Claude Opus 4.8 here. <https://claw.acme.dev|More settings>",
  });
  assert.equal(findHeaderPin(items, "U0OTHER"), undefined);
  assert.equal(findHeaderPin(undefined, "U0BOT"), undefined);
});

test("headerUpdate rewrites only an empty or self-authored header", () => {
  const BOT = "U0BOT";
  const desired = "Using Claude Opus 4.8 here. <https://claw.acme.dev|More settings>";
  assert.equal(headerUpdate(undefined, BOT, desired), "set");
  assert.equal(headerUpdate({ value: "" }, BOT, desired), "set");
  assert.equal(headerUpdate({ value: "Model: Claude Sonnet 5", creator: BOT }, BOT, desired), "set");
  assert.equal(headerUpdate({ value: desired, creator: BOT }, BOT, desired), "skip");
  assert.equal(headerUpdate({ value: "my own notes", creator: "U0HUMAN" }, BOT, desired), "skip");
  assert.equal(
    headerUpdate({ value: "Using Claude Opus 4.8 here. <https://claw.acme.dev>", creator: BOT }, BOT, desired),
    "skip",
  );
});

function headerHarness(
  existing?: { value?: string; creator?: string },
  model = "Claude Opus 4.8",
  kind: "dm" | "channel" = "dm",
  pinnedText?: string,
) {
  const calls = {
    info: 0,
    set: 0,
    pinsListed: 0,
    posted: [] as string[],
    updated: [] as string[],
    pinned: [] as string[],
    unpinned: [] as string[],
    deleted: [] as string[],
  };
  let current = existing;
  let pinned = pinnedText !== undefined ? { ts: "42.0", user: "U0BOT", text: pinnedText } : undefined;
  const client = {
    chat: {
      postMessage: async ({ text }: { text: string }) => {
        calls.posted.push(text);
        pinned = { ts: "99.0", user: "U0BOT", text };
        return { ts: "99.0" };
      },
      update: async ({ ts, text }: { ts: string; text: string }) => {
        calls.updated.push(text);
        if (pinned && pinned.ts === ts) pinned = { ...pinned, text };
        return {};
      },
      delete: async ({ ts }: { ts: string }) => {
        calls.deleted.push(ts);
        if (pinned && pinned.ts === ts) pinned = undefined;
        return {};
      },
    },
    pins: {
      list: async () => {
        calls.pinsListed += 1;
        return { items: pinned ? [{ message: pinned }] : [] };
      },
      add: async ({ timestamp }: { timestamp: string }) => {
        calls.pinned.push(timestamp);
        return {};
      },
      remove: async ({ timestamp }: { timestamp: string }) => {
        calls.unpinned.push(timestamp);
        return {};
      },
    },
    conversations: {
      info: async () => {
        calls.info += 1;
        if (!current) return { channel: {} };
        return { channel: kind === "dm" ? { topic: current } : {} };
      },
      setTopic: async ({ topic: value }: { channel: string; topic: string }) => {
        calls.set += 1;
        current = { value, creator: "U0BOT" };
        return {};
      },
    },
  };
  const flags = { channelPinEnabled: true };
  const raw = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: model }),
    channelPinEnabled: async () => flags.channelPinEnabled,
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  const scope = kind === "dm" ? "personal:josh@acme.dev" : "channel:C1";
  const ensure = (c: unknown, channel: string, ensureOpts?: { pinNew?: boolean }) =>
    raw(c as never, channel, scope, kind, ensureOpts);
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  return { client, calls, ensure, flush, read: () => current, readPin: () => pinned, scope, flags };
}

test("surface header ensurer writes the header once, then goes quiet", async () => {
  const h = headerHarness();
  h.ensure(h.client, "D1");
  await h.flush();
  assert.equal(h.calls.set, 1);
  assert.equal(h.read()?.value, "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/josh|More settings>");
  h.ensure(h.client, "D1");
  await h.flush();
  assert.equal(h.calls.info, 1, "the settled memo spares a steady-state DM both calls");
  assert.equal(h.calls.set, 1);
});

test("surface header ensurer collapses a burst on one channel into a single write", async () => {
  let infos = 0;
  let sets = 0;
  const client = {
    conversations: {
      info: async () => {
        infos += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { channel: {} };
      },
      setTopic: async () => {
        sets += 1;
        return {};
      },
    },
  };
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: "Claude Opus 4.8" }),
    channelPinEnabled: async () => true,
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  for (let i = 0; i < 5; i++) ensure(client as any, "D1", "personal:user.one@acme.dev", "dm");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(infos, 1, "the in-flight guard spares the concurrent probes");
  assert.equal(sets, 1);
});

test("a model change during an in-flight ensure is re-run, not dropped", async () => {
  let model = "Claude Opus 4.8";
  const writes: string[] = [];
  let pinned: { ts: string; user: string; text: string } | undefined;
  const client = {
    chat: {
      postMessage: async ({ text }: { text: string }) => {
        writes.push(text);
        pinned = { ts: "9.0", user: "U0BOT", text };
        return { ts: "9.0" };
      },
      update: async ({ text }: { text: string }) => {
        writes.push(text);
        if (pinned) pinned = { ...pinned, text };
        return {};
      },
    },
    pins: {
      list: async () => ({ items: pinned ? [{ message: pinned }] : [] }),
      add: async () => ({}),
    },
    conversations: {
      info: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return { channel: {} };
      },
      setTopic: async () => ({}),
    },
  };
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: model }),
    channelPinEnabled: async () => true,
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  ensure(client as any, "C1", "channel:C1", "channel", { pinNew: true });
  model = "Claude Haiku 4.5";
  ensure(client as any, "C1", "channel:C1", "channel");
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(
    writes.map((p) => p.split(" <")[0]),
    ["Using Claude Opus 4.8 here.", "Using Claude Haiku 4.5 here."],
    "the change that landed mid-probe still reaches the pinned header",
  );
});

test("surface header ensurer caps its per-channel memo", async () => {
  const client = {
    conversations: { info: async () => ({ channel: {} }), setTopic: async () => ({}) },
  };
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: "Claude Opus 4.8" }),
    channelPinEnabled: async () => true,
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
    maxTracked: 3,
  });
  for (let i = 0; i < 10; i++) {
    ensure(client as any, `D${i}`, "personal:user.one@acme.dev", "dm");
    await new Promise((r) => setTimeout(r, 2));
  }
  let reprobed = 0;
  const spy = {
    conversations: {
      info: async () => {
        reprobed += 1;
        return { channel: {} };
      },
      setTopic: async () => ({}),
    },
  };
  ensure(spy as any, "D0", "personal:user.one@acme.dev", "dm");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reprobed, 1, "an evicted channel is re-probed, so the map cannot grow forever");
});

test("surface header ensurer posts and pins a channel's header message when asked to create it", async () => {
  const h = headerHarness(undefined, "Claude Opus 4.8", "channel");
  h.ensure(h.client, "C1", { pinNew: true });
  await h.flush();
  assert.equal(h.calls.set, 0, "a channel's topic and description are left alone");
  assert.deepEqual(h.calls.posted, [
    "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  ]);
  assert.deepEqual(h.calls.pinned, ["99.0"], "the posted header message is pinned");
});

test("surface header ensurer updates an existing pinned header in place instead of reposting", async () => {
  const h = headerHarness(
    undefined,
    "Claude Haiku 4.5",
    "channel",
    "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  );
  h.ensure(h.client, "C1");
  await h.flush();
  assert.deepEqual(h.calls.posted, [], "no new message when a pinned header already exists");
  assert.deepEqual(h.calls.updated, [
    "Using Claude Haiku 4.5 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  ]);
  assert.equal(h.readPin()?.text.startsWith("Using Claude Haiku 4.5"), true);
});

test("the pinned header is off by default — join creates nothing until the scope opts in", async () => {
  let wrote = 0;
  const client = {
    chat: {
      postMessage: async () => {
        wrote += 1;
        return { ts: "1.0" };
      },
      update: async () => {
        wrote += 1;
        return {};
      },
      delete: async () => ({}),
    },
    pins: {
      list: async () => ({ items: [] }),
      add: async () => {
        wrote += 1;
        return {};
      },
      remove: async () => ({}),
    },
    conversations: { info: async () => ({ channel: {} }), setTopic: async () => ({}) },
  };
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: "Claude Opus 4.8" }),
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  ensure(client as any, "C1", "channel:C1", "channel", { pinNew: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(wrote, 0, "without an opt-in the join posts no header at all");
});

test("disabling the toggle unpins and deletes the bot's header message", async () => {
  const h = headerHarness(
    undefined,
    "Claude Opus 4.8",
    "channel",
    "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  );
  h.flags.channelPinEnabled = false;
  h.ensure(h.client, "C1");
  await h.flush();
  assert.deepEqual(h.calls.unpinned, ["42.0"], "the header pin is removed");
  assert.deepEqual(h.calls.deleted, ["42.0"], "the header message is deleted");
  assert.equal(h.readPin(), undefined);
  assert.deepEqual(h.calls.posted, []);
});

test("re-enabling the toggle re-creates the pinned header on the next create-flagged ensure", async () => {
  const h = headerHarness(undefined, "Claude Opus 4.8", "channel");
  h.flags.channelPinEnabled = false;
  h.ensure(h.client, "C1", { pinNew: true });
  await h.flush();
  assert.deepEqual(h.calls.posted, [], "disabled: nothing posted");
  h.flags.channelPinEnabled = true;
  h.ensure(h.client, "C1", { pinNew: true });
  await h.flush();
  assert.deepEqual(h.calls.posted, [
    "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  ]);
  assert.deepEqual(h.calls.pinned, ["99.0"]);
});

test("a DM topic ignores the channel toggle entirely", async () => {
  const h = headerHarness();
  h.flags.channelPinEnabled = false;
  h.ensure(h.client, "D1");
  await h.flush();
  assert.equal(h.calls.set, 1, "the DM topic is still written with the toggle off");
});

test("surface header ensurer never posts into an existing channel without the create flag", async () => {
  const h = headerHarness(undefined, "Claude Opus 4.8", "channel");
  h.ensure(h.client, "C1");
  await h.flush();
  assert.deepEqual(h.calls.posted, [], "no pinned header exists, and none may be created mid-conversation");
  assert.deepEqual(h.calls.updated, []);
  assert.deepEqual(h.calls.pinned, []);
});

test("surface header ensurer writes no channel header where an external member could read it", async () => {
  for (const shape of [{ is_ext_shared: true }, { is_mpim: true }]) {
    let writes = 0;
    const client = {
      chat: {
        postMessage: async () => {
          writes += 1;
          return { ts: "1.0" };
        },
        update: async () => {
          writes += 1;
          return {};
        },
      },
      pins: {
        list: async () => {
          writes += 1;
          return { items: [] };
        },
        add: async () => {
          writes += 1;
          return {};
        },
      },
      conversations: {
        info: async () => ({ channel: { ...shape } }),
        setTopic: async () => ({}),
      },
    };
    const ensure = createSurfaceHeaderEnsurer({
      headerFacts: async () => ({ modelName: "Claude Opus 4.8" }),
      channelPinEnabled: async () => true,
      webUiPublicUrl: "https://claw.acme.dev",
      ids: { botUserId: "U0BOT" },
    });
    ensure(client as any, "C1", "channel:C1", "channel", { pinNew: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(writes, 0, `a ${JSON.stringify(shape)} conversation is not the bot's to post a header into`);
  }
});

test("surface header ensurer never edits a pinned message the bot does not own", async () => {
  let updates = 0;
  const client = {
    chat: {
      postMessage: async () => ({ ts: "1.0" }),
      update: async () => {
        updates += 1;
        return {};
      },
    },
    pins: {
      list: async () => ({ items: [{ message: { ts: "5.0", user: "U0HUMAN", text: "Where we plan the launch" } }] }),
      add: async () => ({}),
    },
    conversations: {
      info: async () => ({ channel: {} }),
      setTopic: async () => ({}),
    },
  };
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: "Claude Opus 4.8" }),
    channelPinEnabled: async () => true,
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  ensure(client as any, "C1", "channel:C1", "channel");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(updates, 0, "a message a human pinned is theirs");
});

test("scopeSurfaceUrl deep-links each context to its own project page", () => {
  assert.equal(scopeSurfaceUrl("https://claw.acme.dev/", "channel:C1"), "https://claw.acme.dev/projects/channel/C1");
  assert.equal(
    scopeSurfaceUrl("https://claw.acme.dev", "personal:user.one@acme.dev"),
    "https://claw.acme.dev/projects/user.one",
  );
  assert.equal(
    scopeSurfaceUrl("https://claw.acme.dev", "personal:User.Two@acme.dev"),
    "https://claw.acme.dev/projects/user.two",
  );
  assert.equal(
    scopeSurfaceUrl("https://claw.acme.dev", "personal:unsafe+slug@acme.dev"),
    "https://claw.acme.dev/contexts?scope=personal%3Aunsafe%2Bslug%40acme.dev",
  );
  assert.equal(scopeSurfaceUrl("https://claw.acme.dev", "group:G1"), "https://claw.acme.dev/projects/group/G1");
  assert.equal(scopeSurfaceUrl("https://claw.acme.dev", "team:T1"), "https://claw.acme.dev/contexts?scope=team%3AT1");
  assert.equal(scopeSurfaceUrl(undefined, "channel:C1"), undefined);
  assert.equal(scopeSurfaceUrl("https://claw.acme.dev", ""), undefined);
});

test("surface header ensurer never clobbers a human-written topic", async () => {
  const h = headerHarness({ value: "standup notes", creator: "U0HUMAN" });
  h.ensure(h.client, "D1");
  await h.flush();
  assert.equal(h.calls.set, 0);
  assert.equal(h.read()?.value, "standup notes");
});

test("surface header ensurer swallows a Slack failure instead of surfacing it to the turn", async () => {
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => {
      throw new Error("core unreachable");
    },
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  assert.doesNotThrow(() => ensure({} as any, "D1", "personal:user.one@acme.dev", "dm"));
  for (let i = 0; i < 12; i++) await Promise.resolve();
});
