import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxSourceRefresh } from "../src/loops/inbox-source-refresh.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";

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
const tokens = { connectorAccessToken: async () => "synthetic-token" };
const json = (body: unknown) => Response.json(body);

test("Gmail reply sent outside QM closes the card, ignores drafts and recognizes send-as aliases", async () => {
  const { items, item } = await fixture();
  let reads = 0;
  const refresh = createInboxSourceRefresh({
    items,
    tokens,
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
  const after = (await items.get(item.id))!;
  assert.equal(after.status, "skipped");
  assert.equal(after.actionKind, "replied");
  assert.equal(after.sourceAt, 2000);
  assert.equal(after.actionResult, "Handled elsewhere");
  assert.equal(after.proposal?.data.body, "Keep my edit");
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
    await createInboxSourceRefresh({ items, tokens, fetchImpl: async () => json({ messages }) })("owner", [item]);
    assert.equal((await items.get(item.id))!.status, "ready");
  }
});

test("provider failure or missing connection preserves the item with an explicit refresh warning", async () => {
  for (const connected of [true, false]) {
    const { items, item } = await fixture();
    await createInboxSourceRefresh({
      items,
      tokens: { connectorAccessToken: async () => (connected ? "test" : null) },
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
    items,
    tokens,
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
  assert.equal((await items.get(item.id))!.status, "ready");
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
    await createInboxSourceRefresh({ items, tokens, fetchImpl: slackFetch(calls) })("owner", [item]);
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
  await createInboxSourceRefresh({ items, tokens, fetchImpl: slackFetch(calls, { direct: true, own: true }) })(
    "owner",
    [item],
  );
  assert.ok(calls.some((p) => p.includes("conversations.history")));
  assert.equal((await items.get(item.id))!.actionKind, "replied");
});

test("a partial Slack thread is displayed as partial but cannot resolve an item", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0" });
  await createInboxSourceRefresh({ items, tokens, fetchImpl: slackFetch([], { partial: true, own: true }) })("owner", [
    item,
  ]);
  const after = (await items.get(item.id))!;
  assert.equal(after.status, "ready");
  assert.equal(after.sourcePayload!.sourceContextPartial, true);
});

test("rate limiting is respected across different Slack items and never triggers a history fallback", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0" });
  let reads = 0;
  const refresh = createInboxSourceRefresh({
    items,
    tokens,
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
    items,
    tokens,
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
