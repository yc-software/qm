import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxRoutes } from "../src/api/routes/inbox.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { uiStateId } from "../src/surfaces/ui-state.ts";
import type { PersistedUiState } from "../src/surfaces/ui-state.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { LoopItemVerdict, LoopVerdictState } from "../src/loops/types.ts";
import { ensureDefaultInboxLoops } from "../src/loops/inbox-loop.ts";
import { testConfigStore, testMap, testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";

function world(enabled = true) {
  const deps = {
    store: createLoopStore(testMap()),
    items: createLoopItemLedger(testMap()),
    outputs: createLoopOutputStore(testMap()),
    grants: createShipGrantStore(testMap()),
    crons: createCronStore(testMap(), { fires: createPostgresCronFireStore(testDatabaseUrl()) }),
    config: testConfigStore("org"),
  };
  const uiState = testMap<PersistedUiState>();
  const call = async (method = "GET", body: unknown = null, query = "", actor = "alice") => {
    let status = 0;
    let data: any;
    await inboxRoutes
      .find((route) => "method" in route && route.method === method)!
      .handle({
        method,
        body,
        url: new URL(`http://local/v1/inbox?${query}`),
        actor: { p: actor },
        capability: null,
        deps: {
          loops: deps,
          uiState,
          featureFlags: { enabled: async () => enabled },
        },
        app: {
          samePerson: async (a: string, b: string) => a === b,
          membershipControlsScope: async () => false,
          managesScope: async () => false,
        },
        res: {
          getHeader: () => undefined,
          writeHead: (value: number) => {
            status = value;
          },
          end: (value: string) => {
            data = JSON.parse(value);
          },
        },
      } as unknown as ApiCtx);
    return { status, data };
  };
  const verdict = async (loopId: string, dedupeKey: string, state: LoopVerdictState, sourceAt = 1000) => {
    const item = (await deps.items.byLoop(loopId)).find((entry) => entry.sourceKey === dedupeKey)!;
    const value: LoopItemVerdict = {
      state,
      reason: `${state} because`,
      waitingTs: null,
      lastSeenTs: "1.0",
      at: sourceAt,
    };
    return (await deps.items.recordVerdict(item.id, {
      verdict: value,
      sourcePayload: item.sourcePayload ?? {},
      sourceAt,
    }))!;
  };
  return { deps, uiState, call, verdict };
}

test("default Loops are distinct, stable, and deliberate empty selections survive refresh", async () => {
  const w = world();
  const first = await w.call();
  assert.deepEqual(
    first.data.selected.map((loop: any) => loop.name),
    ["Email", "Slack"],
  );
  assert.notEqual(first.data.selected[0].id, first.data.selected[1].id);
  await w.call();
  assert.equal((await w.deps.store.list()).length, 2);
  assert.equal((await w.call("POST", { loopIds: [] })).status, 200);
  assert.deepEqual((await w.call()).data.selected, []);
});

test("archived Loops are neither offered nor selectable in the Inbox", async () => {
  const w = world();
  const { loop } = await w.deps.store.create({
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: "personal:alice",
    name: "Retired",
    playbook: "Read messages",
    successCondition: "Messages reviewed",
  });
  await w.deps.items.ingest([{ loopId: loop.id, dedupeKey: "old", source: "gmail", sourcePayload: {} }]);
  assert.ok((await w.call()).data.available.some((entry: any) => entry.id === loop.id));
  await w.deps.store.setState(loop.id, "archived");
  assert.ok((await w.call()).data.available.every((entry: any) => entry.id !== loop.id));
  assert.equal((await w.call("POST", { loopIds: [loop.id] })).status, 403);
});

test("selection reuses original items, counts items, omits heavy fields, and enforces access", async () => {
  const w = world();
  const { loop } = await w.deps.store.create({
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: "personal:alice",
    name: "QM error repairs",
    icon: "bug",
    sources: ["gmail"],
    playbook: "Repair",
    successCondition: "Fixed",
  });
  await w.deps.items.ingest([
    {
      loopId: loop.id,
      dedupeKey: "error-1",
      sourcePayload: { title: "Repair timeout" },
      proposal: { data: { body: "large proposal" }, by: "agent" },
    },
  ]);
  const [item] = await w.deps.items.byLoop(loop.id);
  for (let ordinal = 0; ordinal < 3; ordinal++)
    await w.deps.outputs.capture({
      loopId: loop.id,
      itemId: item!.id,
      attemptId: "a",
      ordinal,
      shipAction: "open_pr",
      title: "Patch",
      capturedBy: "agent",
    });
  const selected = await w.call("POST", { loopIds: [loop.id] });
  assert.equal(selected.data.total, 1);
  assert.equal(selected.data.selected[0].icon, "bug");
  assert.deepEqual(selected.data.selected[0].sources, ["gmail"]);
  assert.deepEqual(selected.data.available.find((entry: any) => entry.id === loop.id).sources, ["gmail"]);
  assert.equal(selected.data.available.find((entry: any) => entry.id === loop.id).icon, "bug");
  assert.equal(selected.data.items[0].id, item!.id);
  assert.equal(selected.data.items[0].proposal, undefined);
  const detail = await w.call("GET", null, `itemId=${item!.id}`);
  assert.equal(detail.data.outputs.length, 3);
  assert.equal(detail.data.item.proposal.data.body, "large proposal");
  await w.call("POST", { loopIds: [] });
  assert.equal((await w.deps.store.get(loop.id))!.state, "enabled");
  assert.equal((await w.call("POST", { loopIds: [loop.id] })).data.total, 1);
  assert.equal((await w.call("POST", { loopIds: [loop.id] }, "", "mallory")).status, 403);
  assert.equal((await w.call("GET", null, `itemId=${item!.id}`, "mallory")).status, 404);
});

test("pagination is stable across equal timestamps and counts exceed the loaded page", async () => {
  const w = world();
  const [loop] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  for (let n = 0; n < 65; n++)
    await w.deps.items.ingest([
      {
        loopId: loop!.id,
        dedupeKey: String(n),
        sourcePayload: { title: String(n), snippet: String(n) },
        proposal: { data: {}, by: "agent" },
      },
    ]);
  const first = (await w.call()).data;
  const second = (await w.call("GET", null, `cursor=${first.nextCursor}`)).data;
  assert.equal(first.total, 65);
  assert.equal(first.items.length, 40);
  assert.equal(second.items.length, 25);
  assert.equal(new Set([...first.items, ...second.items].map((item: any) => item.id)).size, 65);
});

test("disabled rollout cannot create defaults or update selection", async () => {
  const w = world(false);
  for (const method of ["GET", "POST"]) assert.equal((await w.call(method, { loopIds: [] })).status, 403);
  assert.equal((await w.deps.store.list()).length, 0);
});

test("Sent chat items stay out of Inbox counts and handled history remains readable", async () => {
  const w = world();
  const [loop] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  await w.deps.items.ingest([
    {
      loopId: loop!.id,
      dedupeKey: "sent",
      source: "gmail",
      sourcePayload: { sentChat: true },
      proposal: { by: "human", data: { body: "" } },
    },
    {
      loopId: loop!.id,
      dedupeKey: "dismissed",
      source: "gmail",
      sourcePayload: { title: "Handled" },
      proposal: { by: "agent", data: { body: "draft" } },
    },
  ]);
  const item = (await w.deps.items.byLoop(loop!.id)).find((entry) => entry.sourceKey === "dismissed")!;
  await w.deps.items.recordAction(item.id, { kind: "dismiss", outcome: "dismissed" });
  assert.equal((await w.call()).data.total, 0);
  assert.deepEqual((await w.call()).data.items, []);
  const handled = await w.call("GET", null, "view=handled");
  assert.deepEqual(
    handled.data.items.map((entry: any) => entry.id),
    [item.id],
  );
});

test("verdicts decide visibility per filter while source counts include every open conversation", async () => {
  const w = world();
  const [email, slack] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  for (const [key, state, draft] of [
    ["question", "needs_reply", true],
    ["thanks", "resolved", true],
    ["receipt", "noise", false],
    ["pending", undefined, false],
    ["unverdicted", undefined, true],
    ["handled", "needs_reply", true],
  ] as const) {
    await w.deps.items.ingest([
      {
        loopId: email!.id,
        dedupeKey: key,
        source: "gmail",
        sourcePayload: { title: key, ...(key === "pending" ? {} : { snippet: `${key} body` }) },
        ...(draft ? { proposal: { by: "agent" as const, data: { body: "Draft" } } } : {}),
      },
    ]);
    if (state) await w.verdict(email!.id, key, state);
  }
  const handled = (await w.deps.items.byLoop(email!.id)).find((item) => item.sourceKey === "handled")!;
  await w.deps.items.recordAction(handled.id, { kind: "dismiss", outcome: "dismissed" });
  await w.deps.items.ingest([
    { loopId: slack!.id, dedupeKey: "slack-pending", source: "slack", sourcePayload: {} },
    ...(["slack-question", "slack-resolved", "slack-bot"] as const).map((key) => ({
      loopId: slack!.id,
      dedupeKey: key,
      source: "slack",
      sourcePayload: { snippet: `${key} body` },
      proposal: { by: "agent" as const, data: { body: "Draft" } },
    })),
  ]);
  await w.verdict(slack!.id, "slack-question", "needs_reply");
  await w.verdict(slack!.id, "slack-resolved", "resolved");
  await w.verdict(slack!.id, "slack-bot", "noise");
  const keys = (feed: any) => feed.items.map((item: any) => item.dedupeKey).sort();
  const initial = (await w.call()).data;
  assert.equal(initial.filter, "human");
  assert.deepEqual(keys(initial), ["question", "slack-question", "slack-resolved", "thanks", "unverdicted"]);
  const triaged = (await w.call("GET", null, "filter=triaged")).data;
  assert.equal(triaged.filter, "triaged");
  assert.deepEqual(keys(triaged), ["question", "slack-question", "unverdicted"]);
  assert.equal(triaged.total, 9);
  const sourceCounts = (feed: any) => feed.selected.map((loop: any) => [loop.id, loop.count]);
  assert.deepEqual(sourceCounts(triaged), [
    [email!.id, 5],
    [slack!.id, 4],
  ]);
  for (const [filter, expected] of [
    ["triaged", ["question", "slack-question", "unverdicted"]],
    ["human", ["question", "slack-question", "slack-resolved", "thanks", "unverdicted"]],
    ["all", ["question", "receipt", "slack-bot", "slack-question", "slack-resolved", "thanks", "unverdicted"]],
  ] as const) {
    await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: filter, updatedAt: Date.now() });
    const feed = (await w.call()).data;
    assert.equal(feed.filter, filter);
    assert.deepEqual(keys(feed), expected);
    assert.equal(feed.total, 9);
    assert.deepEqual(sourceCounts(feed), sourceCounts(triaged));
    assert.equal(
      feed.selected.reduce((sum: number, loop: any) => sum + loop.count, 0),
      9,
    );
    assert.deepEqual(
      keys((await w.call("GET", null, `loopId=${slack!.id}`)).data),
      expected.filter((key) => key.startsWith("slack-")),
    );
    assert.deepEqual(keys((await w.call("GET", null, "view=handled")).data), ["handled"]);
    assert.deepEqual(
      keys((await w.call("GET", null, `loopId=${email!.id}`)).data),
      expected.filter((key) => !key.startsWith("slack-")),
    );
    assert.equal((await w.call("GET", null, "", "mallory")).data.filter, "human");
  }
  const feed = (await w.call()).data.items;
  const receipt = feed.find((item: any) => item.dedupeKey === "receipt");
  assert.equal(receipt.verdict.state, "noise");
  assert.equal(receipt.state, "held");
  assert.equal(receipt.proposal, undefined);
  assert.equal(feed.find((item: any) => item.dedupeKey === "thanks").verdict.reason, "resolved because");
  assert.equal(feed.find((item: any) => item.dedupeKey === "unverdicted").verdict, undefined);
  await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: "invalid", updatedAt: Date.now() });
  assert.equal((await w.call()).data.filter, "human");
  const question = (await w.deps.items.byLoop(email!.id)).find((item) => item.sourceKey === "question")!;
  await w.deps.items.recordAction(question.id, { kind: "dismiss", outcome: "dismissed" });
  const afterDismiss = (await w.call()).data;
  assert.equal(afterDismiss.total, 8);
  assert.deepEqual(sourceCounts(afterDismiss), [
    [email!.id, 4],
    [slack!.id, 4],
  ]);
});

test("inbox filters apply before pagination even when noise fills multiple pages", async () => {
  const w = world();
  const [loop] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  await w.deps.items.ingest(
    Array.from({ length: 85 }, (_, n) => ({
      loopId: loop!.id,
      dedupeKey: String(n),
      source: "gmail",
      sourcePayload: { snippet: String(n) },
      proposal: { by: "agent" as const, data: { body: "Draft" } },
    })),
  );
  for (let n = 0; n < 85; n++) await w.verdict(loop!.id, String(n), n >= 5 ? "noise" : "needs_reply");
  const triaged = (await w.call("GET", null, "filter=triaged")).data;
  assert.equal(triaged.total, 85);
  assert.equal(triaged.items.length, 5);
  assert.equal(triaged.nextCursor, null);
  await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: "all", updatedAt: Date.now() });
  const first = (await w.call()).data;
  const second = (await w.call("GET", null, `cursor=${first.nextCursor}`)).data;
  const third = (await w.call("GET", null, `cursor=${second.nextCursor}`)).data;
  assert.equal(first.total, 85);
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [40, 40, 5]);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map((item: any) => item.id)).size, 85);
});

test("explicit refresh filters stay consistent across saved preference changes without overwriting them", async () => {
  const w = world();
  const [loop] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  await w.deps.items.ingest([
    { loopId: loop!.id, dedupeKey: "receipt", source: "gmail", sourcePayload: { snippet: "Your receipt" } },
    { loopId: loop!.id, dedupeKey: "question", source: "gmail", sourcePayload: { snippet: "Quick question" } },
  ]);
  await w.verdict(loop!.id, "receipt", "noise");
  await w.verdict(loop!.id, "question", "needs_reply");
  await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: "all", updatedAt: Date.now() });
  const first = (await w.call()).data;
  await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: "human", updatedAt: Date.now() + 1 });
  const pinned = (await w.call("GET", null, `filter=${first.filter}`)).data;
  assert.equal(pinned.filter, "all");
  assert.equal(pinned.total, 2);
  assert.equal(pinned.items.length, 2);
  const latest = (await w.call()).data;
  assert.equal(latest.filter, "human");
  assert.equal(latest.total, 2);
  assert.equal(latest.items.length, 1);
  assert.equal((await w.call("GET", null, "filter=invalid")).status, 400);
});

test("the feed projects only summary payload fields and the flag-disabled endpoint reads nothing", async (t) => {
  const w = world();
  const [email, slack] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  await w.deps.items.ingest([
    {
      loopId: email!.id,
      dedupeKey: "receipt",
      source: "gmail",
      sourcePayload: { snippet: "Your receipt", privateDetail: "hidden" },
    },
    {
      loopId: slack!.id,
      dedupeKey: "slack-1",
      source: "slack",
      sourcePayload: {
        from: "Alex",
        snippet: "hello",
        slack: { channelId: "D1", ts: "1.0", userId: "U1" },
        participants: [{ id: "U1", name: "Alex", avatarUrl: "https://avatars.slack-edge.com/alex.png" }],
        context: [{ author: "Alex", text: "private context" }],
      },
      proposal: { by: "agent", data: { body: "draft" } },
    },
  ]);
  await w.verdict(email!.id, "receipt", "noise");
  const summaries = await w.deps.items.summaries([email!.id, slack!.id]);
  assert.ok(summaries.every((summary) => summary.sourcePayload?.privateDetail === undefined));
  assert.ok(summaries.every((summary) => summary.sourcePayload?.context === undefined));
  const feed = (await w.call("GET", null, "filter=all")).data;
  const receipt = feed.items.find((item: any) => item.dedupeKey === "receipt");
  assert.equal(receipt.verdict.state, "noise");
  assert.equal(receipt.sourcePayload.snippet, "Your receipt");
  assert.equal(receipt.sourcePayload.privateDetail, undefined);
  const slackItem = feed.items.find((item: any) => item.dedupeKey === "slack-1");
  assert.equal(slackItem.sourcePayload.participants[0].avatarUrl, "https://avatars.slack-edge.com/alex.png");
  assert.equal(slackItem.sourcePayload.from, "Alex");
  assert.equal(slackItem.sourcePayload.context, undefined);
  assert.equal(slackItem.sourcePayload.slack, undefined);
  const detail = (await w.call("GET", null, `itemId=${slackItem.id}`)).data;
  assert.equal(detail.item.sourcePayload.context[0].text, "private context");
  const disabled = world(false);
  t.mock.method(disabled.deps.items, "byLoop", async () => {
    assert.fail("flag-disabled inbox read payloads");
  });
  t.mock.method(disabled.deps.items, "summaries", async () => {
    assert.fail("flag-disabled inbox read summaries");
  });
  for (const filter of ["all", "human", "triaged"]) {
    assert.equal((await disabled.call("GET", null, `filter=${filter}`)).status, 403);
  }
});
