import assert from "node:assert/strict";
import { test } from "node:test";
import { createPostgresErrorLog } from "../src/admin/postgres-error-log.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createInboxSourceRefresh, featureFlags, fixture, json, tokens } from "./support/inbox-source-refresh.ts";

const directory = { getBySlackId: async () => null };

async function refreshTwice(fixed: Awaited<ReturnType<typeof fixture>>, fetchImpl: typeof fetch) {
  const errors = createPostgresErrorLog(testDatabaseUrl());
  let annotations = 0;
  const items = {
    ...fixed.items,
    annotate: (...args: Parameters<typeof fixed.items.annotate>) => {
      annotations++;
      return fixed.items.annotate(...args);
    },
  };
  for (let core = 0; core < 2; core++) {
    const latest = (await fixed.items.get(fixed.item.id))!;
    await createInboxSourceRefresh({ featureFlags, items, tokens, directory, errors, fetchImpl })("owner", [latest]);
  }
  return { errors: await errors.list(), annotations, after: (await fixed.items.get(fixed.item.id))! };
}

test("a deleted Gmail thread is read once, marked unavailable once, and never logged as a failure", async () => {
  let reads = 0;
  const { errors, annotations, after } = await refreshTwice(await fixture(), async () => {
    reads++;
    return new Response("not found", { status: 404 });
  });
  assert.equal(reads, 1);
  assert.equal(annotations, 1);
  assert.deepEqual(errors, []);
  assert.equal(after.status, "ready");
  assert.equal(after.proposal?.data.body, "Keep my edit");
  assert.equal(
    after.sourcePayload?.sourceRefreshError,
    "The original message is no longer available. Your item has not been dismissed.",
  );
  assert.match(String(after.sourcePayload?.sourceGone), /threads\/t1 returned 404/);
});

test("a transient Gmail failure is logged and retried on the next refresh", async () => {
  let reads = 0;
  const { errors, after } = await refreshTwice(await fixture(), async () => {
    reads++;
    return new Response("unavailable", { status: 500 });
  });
  assert.equal(reads, 2);
  assert.equal(errors.length, 2);
  assert.match(errors[0]!.message, /returned 500/);
  assert.equal(
    after.sourcePayload?.sourceRefreshError,
    "Couldn't refresh the source. Your item has not been dismissed.",
  );
});

test("a deleted Slack conversation, thread or root message is read once and never logged as a failure", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ok: false, error: "channel_not_found" }, /conversations\.info: channel_not_found/],
    [{ ok: false, error: "thread_not_found" }, /conversations\.replies: thread_not_found/],
    [{ ok: true, messages: [{ ts: "2.0", thread_ts: "1.0", user: "U1" }] }, /root message missing/],
  ];
  for (const [replies, detail] of cases) {
    let reads = 0;
    const { errors, annotations, after } = await refreshTwice(
      await fixture("slack", { channelId: "C1", ts: "1.0" }),
      async (url) => {
        reads++;
        if (String(url).includes("conversations.info") && replies.error !== "channel_not_found")
          return json({ ok: true, channel: {} });
        return json(replies);
      },
    );
    assert.equal(reads, replies.error === "channel_not_found" ? 1 : 2);
    assert.equal(annotations, 1);
    assert.deepEqual(errors, []);
    assert.match(String(after.sourcePayload?.sourceRefreshError), /no longer available/);
    assert.match(String(after.sourcePayload?.sourceGone), detail);
  }
});

test("a partial Slack page without the root message is not treated as gone", async () => {
  const { errors, after } = await refreshTwice(await fixture("slack", { channelId: "C1", ts: "1.0" }), async (url) =>
    String(url).includes("conversations.info")
      ? json({ ok: true, channel: {} })
      : json({ ok: true, has_more: true, messages: [{ ts: "2.0", thread_ts: "1.0", user: "U1" }] }),
  );
  assert.deepEqual(errors, []);
  assert.equal(after.sourcePayload?.sourceGone, undefined);
  assert.equal(after.sourcePayload?.sourceContextPartial, true);
});

test("a newer source message reopens a source that was gone", async () => {
  const fixed = await fixture();
  let reads = 0;
  await refreshTwice(fixed, async () => {
    reads++;
    return new Response("gone", { status: 404 });
  });
  await fixed.items.ingest([
    {
      loopId: "inbox",
      dedupeKey: "ask",
      source: "gmail",
      sourceAt: 2000,
      sourcePayload: { gmail: { threadId: "t1" } },
    },
  ]);
  await createInboxSourceRefresh({
    featureFlags,
    items: fixed.items,
    tokens,
    directory,
    fetchImpl: async () => {
      reads++;
      return json({ messages: [] });
    },
  })("owner", [(await fixed.items.get(fixed.item.id))!]);
  assert.equal(reads, 2);
});
