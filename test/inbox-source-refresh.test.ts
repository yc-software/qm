import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxSourceRefresh as createRefresh } from "../src/loops/inbox-source-refresh.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import type { IngressEntry } from "../src/loops/ingress.ts";

async function fixture(source = "gmail", meta: Record<string, unknown> = { threadId: "t1" }) {
  const items = createLoopItemLedger();
  await items.ingest([
    {
      loopId: "inbox",
      dedupeKey: "ask",
      source,
      sourceAt: 1000,
      sourcePayload: { source, [source]: meta, context: [{ author: "Elsewhere", text: "UNRELATED CHANNEL TAIL" }] },
      proposal: { by: "human", data: { body: "Keep my edit" } },
    },
  ]);
  return { items, item: (await items.byLoop("inbox"))[0]! };
}
const featureFlags = { enabled: async () => true };
const createInboxSourceRefresh = (
  deps: Omit<Parameters<typeof createRefresh>[0], "enqueue"> & {
    enqueue?: Parameters<typeof createRefresh>[0]["enqueue"];
  },
) => createRefresh({ enqueue: async () => undefined, ...deps });
function recorder() {
  const events: unknown[] = [];
  const enqueue = async (_loop: unknown, entries: IngressEntry[]) => {
    events.push(...entries.map((entry) => entry.sourcePayload?.latestEvent));
  };
  return { events, enqueue };
}
const tokens = { connectorAccessToken: async () => "synthetic-token" };
const json = (body: unknown) => Response.json(body);
const ALEX = "https://avatars.slack-edge.com/alex.png";
function directoryOf(
  people: Record<string, { displayName: string; avatarUrl?: string }>,
  onLookup?: (id: string) => unknown,
) {
  return {
    getBySlackId: async (id: string) => {
      await onLookup?.(id);
      const person = people[id];
      return person ? { principalId: `${id}@x.com`, slackId: id, type: "internal" as const, ...person } : null;
    },
  };
}
const directory = directoryOf({ U1: { displayName: "Alex", avatarUrl: ALEX }, U2: { displayName: "Taylor" } });

test("Gmail reply sent outside QM becomes an owner event, ignoring drafts and recognizing send-as aliases", async () => {
  const { items, item } = await fixture();
  let reads = 0;
  const queue = recorder();
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    enqueue: queue.enqueue,
    tokens,
    directory,
    fetchImpl: async (url) => {
      reads++;
      assert.match(String(url), /threads\/t1\?format=metadata$/);
      return json({
        messages: [
          { id: "in", internalDate: "1000", labelIds: ["INBOX"] },
          { id: "out", internalDate: "2000", labelIds: ["SENT"], snippet: "Handled elsewhere" },
          { id: "draft", internalDate: "3000", labelIds: ["DRAFT"] },
        ],
      });
    },
  });
  await Promise.all([refresh("owner@example.com", [item]), refresh("owner@example.com", [item])]);
  await refresh("owner@example.com", [item]);
  assert.deepEqual(queue.events, [{ author: "owner", at: 2000, text: "Handled elsewhere" }]);
  assert.equal((await items.get(item.id))!.proposal?.data.body, "Keep my edit");
  assert.equal(reads, 1);
});

test("an old sent message or a newer inbound message does not close a Gmail item", async () => {
  for (const messages of [
    [{ internalDate: "900", labelIds: ["SENT"] }],
    [
      { internalDate: "1500", labelIds: ["SENT"] },
      { internalDate: "2000", labelIds: ["INBOX"] },
    ],
    [{ internalDate: "2000", labelIds: ["DRAFT"] }],
  ]) {
    const { items, item } = await fixture();
    const queue = recorder();
    await createInboxSourceRefresh({
      featureFlags,
      items,
      enqueue: queue.enqueue,
      tokens,
      directory,
      fetchImpl: async () => json({ messages }),
    })("owner", [item]);
    assert.deepEqual(queue.events, []);
  }
});

test("provider failure or missing connection preserves the item with an explicit refresh warning", async () => {
  for (const connected of [true, false]) {
    const { items, item } = await fixture();
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens: { connectorAccessToken: async () => (connected ? "test" : null) },
      directory,
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    })("owner", [item]);
    const after = (await items.get(item.id))!;
    assert.equal(after.status, "ready");
    assert.equal(after.proposal?.data.body, "Keep my edit");
    assert.ok(after.sourcePayload?.sourceRefreshError);
  }
});

test("a new inbound message during a provider read wins over the older own reply", async () => {
  const { items, item } = await fixture();
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    fetchImpl: async () => {
      await items.ingest([
        {
          loopId: "inbox",
          dedupeKey: "ask",
          source: "gmail",
          sourceAt: 3000,
          sourcePayload: { gmail: { threadId: "t1" } },
        },
      ]);
      return json({ messages: [{ internalDate: "2000", labelIds: ["SENT"] }] });
    },
  })("owner", [item]);
  assert.equal((await items.get(item.id))!.status, "queued");
  assert.equal((await items.get(item.id))!.sourceAt, 3000);
});

function slackFetch(
  calls: string[],
  options: { direct?: boolean; partial?: boolean; own?: boolean } = {},
): typeof fetch {
  return async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    if (u.pathname.endsWith("conversations.info"))
      return json({ ok: true, channel: { is_mpim: options.direct === true } });
    if (u.pathname.endsWith("users.info"))
      return json({
        ok: true,
        user: { profile: { display_name: u.searchParams.get("user") === "U1" ? "Alex" : "Taylor" } },
      });
    if (u.pathname.endsWith("auth.test")) return json({ ok: true, user_id: "U2" });
    return json({
      ok: true,
      has_more: options.partial ?? false,
      messages: [
        { ts: "2.0", thread_ts: "1.0", user: options.own ? "U2" : "U1", text: "Thread reply" },
        { ts: "1.0", user: "U1", text: "Original mention" },
        ...(options.direct ? [] : [{ ts: "99.0", thread_ts: "88.0", user: "U2", text: "UNRELATED OTHER THREAD" }]),
      ],
    });
  };
}

test("top-level/private-channel mentions fetch just their root and replies, never channel history", async () => {
  for (const meta of [
    { channelId: "GPRIVATE", ts: "1.0" },
    { channelId: "C1", ts: "2.0", threadTs: "1.0" },
  ]) {
    const { items, item } = await fixture("slack", meta);
    const calls: string[] = [];
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens,
      directory,
      fetchImpl: slackFetch(calls),
    })("owner", [item]);
    const after = (await items.get(item.id))!;
    assert.deepEqual(
      (after.sourcePayload!.context as Array<{ text: string }>).map((m) => m.text),
      ["Original mention", "Thread reply"],
    );
    assert.ok(calls.some((p) => p.includes("conversations.replies?") && p.includes("ts=1.0")));
    assert.ok(calls.every((p) => !p.includes("conversations.history")));
    assert.equal(after.sourcePayload!.sourceContextFetched, true);
    assert.equal(after.proposal?.data.body, "Keep my edit");
  }
});

test("Slack detects group DMs by conversation metadata, including C-prefixed IDs", async () => {
  const { items, item } = await fixture("slack", { channelId: "C_GROUP_DM", ts: "1.0" });
  const calls: string[] = [];
  const queue = recorder();
  await createInboxSourceRefresh({
    featureFlags,
    items,
    enqueue: queue.enqueue,
    tokens,
    directory,
    fetchImpl: slackFetch(calls, { direct: true, own: true }),
  })("owner", [item]);
  assert.ok(calls.some((p) => p.includes("conversations.history")));
  assert.deepEqual(queue.events, [{ author: "owner", at: 2000, text: "Thread reply" }]);
});

test("a partial Slack thread is displayed as partial but cannot resolve an item", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0" });
  const queue = recorder();
  await createInboxSourceRefresh({
    featureFlags,
    items,
    enqueue: queue.enqueue,
    tokens,
    directory,
    fetchImpl: slackFetch([], { partial: true, own: true }),
  })("owner", [item]);
  const after = (await items.get(item.id))!;
  assert.deepEqual(queue.events, []);
  assert.equal(after.sourcePayload!.sourceContextPartial, true);
});

test("rate limiting is respected across different Slack items and never triggers a history fallback", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0" });
  let reads = 0;
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    fetchImpl: async (url) => {
      if (String(url).includes("conversations.info")) return json({ ok: true, channel: {} });
      reads++;
      return new Response("limited", { status: 429, headers: { "retry-after": "120" } });
    },
  });
  await refresh("owner", [item]);
  await refresh("owner", [{ ...item, id: "second" }]);
  assert.equal(reads, 1);
  assert.equal((await items.get(item.id))!.status, "ready");
});

test("slow Gmail reads have a total batch budget and later cards are visited on the next refresh", async () => {
  const { items, item } = await fixture();
  let clock = 0;
  let reads = 0;
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    now: () => clock,
    fetchImpl: async () => {
      reads++;
      clock += 1000;
      return json({ messages: [] });
    },
  });
  const cards = Array.from({ length: 12 }, (_, i) => ({ ...item, id: `item-${i}` }));
  await refresh("owner", cards);
  assert.equal(reads, 4);
  await refresh("owner", cards);
  assert.equal(reads, 8);
  await refresh("owner", cards);
  assert.equal(reads, 12);
});

test("Slack avatars come from the org directory without the owner's Slack login or conversation reads", async () => {
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
  const looked: string[] = [];
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens: { connectorAccessToken: async () => null },
    directory: directoryOf({ U1: { displayName: "Alex", avatarUrl: ALEX } }, (id) => looked.push(id)),
    fetchImpl: async () => assert.fail("no Slack reads"),
  });
  await refresh("owner", [item], "avatars");
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload?.participants, [{ id: "U1", name: "Alex", avatarUrl: ALEX }]);
  assert.equal(after.inboxPreview?.participants, undefined);
  assert.deepEqual(after.proposal, item.proposal);
  assert.deepEqual(after.sourcePayload?.context, item.sourcePayload?.context);
  await refresh("owner", [after], "avatars");
  assert.deepEqual(looked, ["U1"]);
});

test("missing or unsafe directory photos retain initials", async () => {
  for (const avatarUrl of [undefined, "http://example.com/photo.png", "javascript:alert(1)"]) {
    const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens,
      directory: directoryOf({ U1: { displayName: "Alex", ...(avatarUrl ? { avatarUrl } : {}) } }),
    })("owner", [item], "avatars");
    assert.deepEqual((await items.get(item.id))!.sourcePayload!.participants, [{ id: "U1", name: "Alex" }]);
  }
});

test("avatar-only refresh does not suppress full Slack context refresh", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U1" });
  const refresh = createInboxSourceRefresh({ featureFlags, items, tokens, directory, fetchImpl: slackFetch([]) });
  await refresh("owner", [item], "avatars");
  await refresh("owner", [(await items.get(item.id))!]);
  const after = (await items.get(item.id))!;
  assert.equal(after.sourcePayload?.sourceContextFetched, true);
  assert.equal((after.sourcePayload!.context as Array<{ authorId: string }>)[0]!.authorId, "U1");
  assert.equal((after.sourcePayload!.context as Array<{ avatarUrl: string }>)[0]!.avatarUrl, ALEX);
  assert.equal(after.inboxPreview?.participants, undefined);
});

test("a newer message during an avatar lookup cannot acquire the previous sender's photo", async () => {
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf({ U1: { displayName: "Alex", avatarUrl: ALEX } }, () =>
      items.ingest([
        {
          loopId: "inbox",
          dedupeKey: "ask",
          source: "slack",
          sourceAt: 2000,
          sourcePayload: { slack: { channelId: "D1", ts: "2.0", userId: "U2" } },
        },
      ]),
    ),
  })("owner", [item], "avatars");
  assert.equal((await items.get(item.id))!.sourcePayload?.participants, undefined);
});

test("concurrent list and detail refreshes preserve the authoritative Slack thread metadata", async () => {
  const { items, item } = await fixture("slack", { channelId: "C_GROUP_DM", ts: "1.0", userId: "U1" });
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    fetchImpl: slackFetch([], { direct: true }),
  });
  await Promise.all([refresh("owner", [item]), refresh("owner", [item], "avatars")]);
  const after = (await items.get(item.id))!;
  assert.equal((after.sourcePayload!.slack as { isDirectMessage: boolean }).isDirectMessage, true);
  assert.equal(after.sourcePayload!.sourceContextFetched, true);
});

test("partial profile failures keep saved photos and names while saving successful lookups", async () => {
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
  const saved = { id: "U2", name: "Taylor", avatarUrl: "https://avatars.slack-edge.com/taylor.png" };
  await items.annotate(item.id, { participants: [{ id: "U1", name: "Alex" }, saved] });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf({ U1: { displayName: "Alex", avatarUrl: ALEX } }, (id) => {
      if (id === "U2") throw new Error("directory unavailable");
    }),
    now: () => 1000,
  })("owner", [(await items.get(item.id))!], "avatars");
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, [{ id: "U1", name: "Alex", avatarUrl: ALEX }, saved]);
  assert.equal(after.sourcePayload!.slackAvatarsRefreshAt, 61_000);
  assert.deepEqual(after.proposal, item.proposal);
  const looked: string[] = [];
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf({ U2: { displayName: "Taylor" } }, (id) => looked.push(id)),
    now: () => 62_000,
  })("owner", [after], "avatars");
  assert.deepEqual(looked, ["U1", "U2"]);
});

test("opening a thread retains cached photos and author names when profile reads fail", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U1" });
  const saved = { id: "U1", name: "Alex", avatarUrl: ALEX };
  await items.annotate(item.id, { participants: [saved], slackAvatarsRefreshAt: 99_000_000 });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf({}, () => {
      throw new Error("directory unavailable");
    }),
    now: () => 1000,
    fetchImpl: slackFetch([]),
  })("owner", [(await items.get(item.id))!]);
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, [saved]);
  assert.equal(after.sourcePayload!.slackAvatarsRefreshAt, 61_000);
  for (const message of after.sourcePayload!.context as Array<Record<string, unknown>>) {
    assert.equal(message.author, "Alex");
    assert.equal(message.authorId, "U1");
    assert.equal(message.avatarUrl, saved.avatarUrl);
  }
});

test("thread profile limits prioritize the waiting sender and latest visible authors", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U1" });
  const lookedUp: string[] = [];
  const people = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `U${i + 1}`,
      { displayName: `U${i + 1}`, avatarUrl: `https://avatars.slack-edge.com/U${i + 1}.png` },
    ]),
  );
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf(people, (id) => lookedUp.push(id)),
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("conversations.info")) return json({ ok: true, channel: {} });
      if (u.pathname.endsWith("auth.test")) return json({ ok: true, user_id: "OWNER" });
      return json({
        ok: true,
        messages: Array.from({ length: 12 }, (_, i) => ({
          ts: `${i + 1}.0`,
          thread_ts: "1.0",
          user: `U${i + 1}`,
          text: "Message",
        })),
      });
    },
  })("owner", [item]);
  assert.deepEqual(lookedUp, ["U1", "U12", "U11", "U10", "U9", "U8", "U7", "U6"]);
  const after = (await items.get(item.id))!;
  assert.equal((after.sourcePayload!.participants as Array<{ id: string }>)[0]!.id, "U1");
  const latest = (after.sourcePayload!.context as Array<{ avatarUrl?: string }>).slice(-6);
  assert.ok(latest.every((message) => message.avatarUrl));
});

test("bot and external-user messages use profiles already returned by Slack", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0" });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname;
      assert.ok(!path.endsWith("users.info") && !path.endsWith("bots.info"));
      if (path.endsWith("conversations.info")) return json({ ok: true, channel: {} });
      if (path.endsWith("auth.test")) return json({ ok: true, user_id: "OWNER" });
      return json({
        ok: true,
        messages: [
          {
            ts: "1.0",
            bot_id: "B1",
            bot_profile: { name: "Build bot", icons: { image_48: "https://avatars.slack-edge.com/build.png" } },
            text: "Build finished",
          },
        ],
      });
    },
  })("owner", [item]);
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, [
    { id: "bot:B1", name: "Build bot", avatarUrl: "https://avatars.slack-edge.com/build.png" },
  ]);
  const message = (after.sourcePayload!.context as Array<Record<string, unknown>>)[0]!;
  assert.equal(message.author, "Build bot");
  assert.equal(message.authorId, "bot:B1");
  assert.equal(message.avatarUrl, "https://avatars.slack-edge.com/build.png");
});

test("a partial source page cannot replace the waiting sender with an unrelated author", async () => {
  for (const userId of [undefined, "U1"]) {
    const { items, item } = await fixture("slack", { channelId: "D1", ts: "0.5", ...(userId ? { userId } : {}) });
    await items.annotate(item.id, {
      participants: [{ id: "U1", name: "Alex", avatarUrl: "https://avatars.slack-edge.com/alex.png" }],
    });
    const sourceFetch = slackFetch([], { direct: true });
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await sourceFetch(url, init);
      if (!String(url).includes("conversations.history")) return response;
      return json({ ok: true, messages: [{ ts: "2.0", user: "U_OTHER", text: "Newer message" }] });
    };
    await createInboxSourceRefresh({ featureFlags, items, tokens, directory, fetchImpl })("owner", [
      (await items.get(item.id))!,
    ]);
    assert.equal(((await items.get(item.id))!.sourcePayload!.participants as Array<{ id: string }>)[0]!.id, "U1");
  }
});

test("cosmetic avatar refresh never waits for an in-flight full conversation refresh", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U1" });
  let begin!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sourceFetch = slackFetch([]);
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    fetchImpl: async (url, init) => {
      if (String(url).includes("conversations.info")) {
        begin();
        await blocked;
      }
      return sourceFetch(url, init);
    },
  });
  const source = refresh("owner", [item]);
  await started;
  try {
    const finished = await Promise.race([
      refresh("owner", [item], "avatars").then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(finished, true);
  } finally {
    release();
    await source;
  }
  assert.equal((await items.get(item.id))!.sourcePayload!.sourceContextFetched, true);
});

test("a second core's full refresh wins over a stale cosmetic profile refresh", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U1" });
  let begin!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const avatars = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf(
      { U1: { displayName: "Stale", avatarUrl: "https://avatars.slack-edge.com/stale.png" } },
      () => {
        begin();
        return blocked;
      },
    ),
  })("owner", [item], "avatars");
  await started;
  const sourceFetch = slackFetch([], { own: true });
  try {
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens,
      directory,
      fetchImpl: async (url, init) => {
        if (String(url).includes("auth.test")) return json({ ok: true, user_id: "OWNER" });
        return sourceFetch(url, init);
      },
    })("owner", [item]);
  } finally {
    release();
    await avatars;
  }
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, [
    { id: "U1", name: "Alex", avatarUrl: ALEX },
    { id: "U2", name: "Taylor" },
  ]);
  assert.equal(after.sourcePayload!.sourceContextFetched, true);
  assert.equal((after.sourcePayload!.context as unknown[]).length, 2);
});

test("unverified waiting senders never inherit another context author's avatar", async () => {
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0" });
  const people = directoryOf({
    U_OTHER: { displayName: "Someone Else", avatarUrl: "https://avatars.slack-edge.com/other.png" },
  });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: people,
    fetchImpl: async (url) => {
      if (String(url).includes("conversations.info")) return json({ ok: true, channel: { is_im: true } });
      if (String(url).includes("auth.test")) return json({ ok: true, user_id: "OWNER" });
      return json({ ok: true, messages: [{ ts: "2.0", user: "U_OTHER", text: "Another message" }] });
    },
  })("owner", [item]);
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, []);
  assert.equal(after.sourcePayload!.slackAvatarsRefreshAt, 0);
  assert.equal(
    (after.sourcePayload!.context as Array<{ avatarUrl: string }>)[0]!.avatarUrl,
    "https://avatars.slack-edge.com/other.png",
  );
});

test("saved participants do not supply a missing sender identity", async () => {
  for (const mode of [undefined, "avatars"] as const) {
    const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0" });
    const saved = { id: "U1", name: "Previously saved sender" };
    await items.annotate(item.id, { participants: [saved] });
    const before = (await items.get(item.id))!;
    const looked: string[] = [];
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens,
      directory: directoryOf({ U1: { displayName: "Alex", avatarUrl: ALEX } }, (id) => looked.push(id)),
      fetchImpl: async (url) => {
        assert.notEqual(mode, "avatars");
        if (String(url).includes("conversations.info")) return json({ ok: true, channel: { is_im: true } });
        return json({ ok: true, messages: [] });
      },
    })("owner", [before], mode);
    const after = (await items.get(item.id))!;
    assert.deepEqual(looked, []);
    assert.deepEqual(after.sourcePayload!.participants, [saved]);
    if (mode === "avatars") assert.deepEqual(after, before);
    else assert.equal(after.sourcePayload!.slackAvatarsRefreshAt, 0);
  }
});

test("profile failures retain diagnostics without exposing credentials", async () => {
  const { createErrorLog } = await import("../src/admin/error-log.ts");
  for (const mode of [undefined, "avatars"] as const) {
    const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
    const errors = createErrorLog();
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens,
      directory: directoryOf({}, () => {
        throw new Error("lookup failed token=xoxb-private-credential");
      }),
      errors,
      fetchImpl: slackFetch([]),
    })("owner", [item], mode);
    const events = await errors.list();
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.scopeLabel === "personal:owner"));
    assert.match(events[0]!.message, /Slack profile U1: lookup failed/);
    assert.doesNotMatch(JSON.stringify(events), /private-credential/);
    assert.equal((await items.get(item.id))!.status, "ready");
  }
});

test("cosmetic refresh records ledger failures without rejecting the inbox request", async () => {
  const { createErrorLog } = await import("../src/admin/error-log.ts");
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
  const errors = createErrorLog();
  await createInboxSourceRefresh({
    featureFlags,
    items: {
      ...items,
      annotate: async () => {
        throw new Error("database unavailable");
      },
    },
    tokens,
    directory,
    errors,
    fetchImpl: async () => json({ ok: true, user: { name: "Alex" } }),
  })("owner", [item], "avatars");
  const events = await errors.list();
  assert.equal(events.length, 1);
  assert.match(events[0]!.message, new RegExp(item.id));
  assert.match(events[0]!.message, /database unavailable/);
  assert.equal(events[0]!.scopeLabel, "personal:owner");
});

test("Inbox source refresh checks the owner rollout before credentials, reads, or writes in either mode", async () => {
  const { createFeatureFlagStore } = await import("../src/feature-flags.ts");
  const { createMemoryMap } = await import("../src/persistence/durable-map.ts");
  const flags = createFeatureFlagStore(createMemoryMap());
  await flags.setEnabled("inbox_loops", "personal:someone-else", true, "admin");
  for (const mode of [undefined, "avatars"] as const) {
    const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
    const before = structuredClone(item);
    const calls: string[] = [];
    let credentials = 0;
    const refresh = createInboxSourceRefresh({
      items,
      featureFlags: flags,
      tokens: {
        connectorAccessToken: async () => {
          credentials++;
          return "synthetic-token";
        },
      },
      directory,
      fetchImpl: slackFetch(calls),
    });
    await refresh("owner", [item], mode);
    assert.equal(credentials, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(await items.get(item.id), before);
    await flags.setEnabled("inbox_loops", "personal:owner", true, "admin");
    await refresh("owner", [item], mode);
    assert.equal(credentials > 0 && calls.length > 0, mode === undefined);
    const enriched = (await items.get(item.id))!;
    assert.ok(enriched.sourcePayload?.participants);
    await flags.setEnabled("inbox_loops", "personal:owner", false, "admin");
    credentials = 0;
    calls.length = 0;
    await refresh("owner", [{ ...enriched, sourceAt: 3000 }], mode);
    assert.equal(credentials, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(await items.get(item.id), enriched);
  }
});

test("Slack-id principals and items without a known sender use only the directory", async () => {
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
  const fetchImpl: typeof fetch = async () => assert.fail("no Slack reads");
  const slackIdMode = {
    getBySlackId: async (id: string) =>
      id === "U1" ? { principalId: "U1", displayName: "Alex", type: "internal" as const, avatarUrl: ALEX } : null,
  };
  await createInboxSourceRefresh({ featureFlags, items, tokens, directory: slackIdMode, fetchImpl })(
    "owner",
    [item],
    "avatars",
  );
  assert.deepEqual((await items.get(item.id))!.sourcePayload!.participants, [
    { id: "U1", name: "Alex", avatarUrl: ALEX },
  ]);
  const legacy = await fixture("slack", { channelId: "D2", ts: "1.0" });
  await createInboxSourceRefresh({ featureFlags, items: legacy.items, tokens, directory, fetchImpl })(
    "owner",
    [legacy.item],
    "avatars",
  );
  assert.deepEqual(await legacy.items.get(legacy.item.id), legacy.item);
});

test("people outside the directory keep the profile Slack returned with their message", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0" });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("conversations.info")) return json({ ok: true, channel: {} });
      if (path.endsWith("auth.test")) return json({ ok: true, user_id: "OWNER" });
      return json({
        ok: true,
        messages: [
          {
            ts: "1.0",
            user: "U_EXT",
            user_profile: { display_name: "Pat Partner", image_72: "https://avatars.slack-edge.com/pat.png" },
            text: "Hello from Slack Connect",
          },
        ],
      });
    },
  })("owner", [item]);
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, [
    { id: "U_EXT", name: "Pat Partner", avatarUrl: "https://avatars.slack-edge.com/pat.png" },
  ]);
  assert.equal((after.sourcePayload!.context as Array<{ author: string }>)[0]!.author, "Pat Partner");
});

test("people outside the directory without message profiles keep initials and never trigger profile API calls", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U_EXT" });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("conversations.info")) return json({ ok: true, channel: {} });
      if (path.endsWith("auth.test")) return json({ ok: true, user_id: "OWNER" });
      assert.ok(path.endsWith("conversations.replies"));
      return json({ ok: true, messages: [{ ts: "1.0", user: "U_EXT", text: "Hello" }] });
    },
  })("owner", [item]);
  assert.deepEqual((await items.get(item.id))!.sourcePayload!.participants, [{ id: "U_EXT", name: "U_EXT" }]);
});
