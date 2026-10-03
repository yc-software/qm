import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxRoutes } from "../src/api/routes/inbox.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { uiStateId } from "../src/surfaces/ui-state.ts";
import type { PersistedUiState } from "../src/surfaces/ui-state.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { ensureDefaultInboxLoops } from "../src/loops/inbox-loop.ts";

function world(enabled = true, sourceRefresh?: ApiCtx["deps"]["inboxSourceRefresh"]) {
  const deps = {
    store: createLoopStore(),
    items: createLoopItemLedger(),
    outputs: createLoopOutputStore(),
    grants: createShipGrantStore(),
    crons: createCronStore(),
    config: createMemoryConfigStore("org"),
  };
  const uiState = createMemoryMap<PersistedUiState>();
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
          inboxSourceRefresh: sourceRefresh,
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
  return { deps, uiState, call };
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
  assert.equal((await w.call("PUT", { loopIds: [] })).status, 200);
  assert.deepEqual((await w.call()).data.selected, []);
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
  const selected = await w.call("PUT", { loopIds: [loop.id] });
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
  await w.call("PUT", { loopIds: [] });
  assert.equal((await w.deps.store.get(loop.id))!.state, "enabled");
  assert.equal((await w.call("PUT", { loopIds: [loop.id] })).data.total, 1);
  assert.equal((await w.call("PUT", { loopIds: [loop.id] }, "", "mallory")).status, 403);
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
        sourcePayload: { title: String(n) },
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
  for (const method of ["GET", "PUT"]) assert.equal((await w.call(method, { loopIds: [] })).status, 403);
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

test("the inbox feed reconciles selected owner Gmail loops before counting summaries", async () => {
  const refreshed: string[] = [];
  const w = world(true, async (owner, items) => {
    assert.equal(owner, "alice");
    for (const item of items) {
      refreshed.push(item.id);
      await w.deps.items.recordAction(item.id, { kind: "replied", outcome: "dismissed", sourceAt: 2000 });
    }
  });
  const loops = await ensureDefaultInboxLoops(w.deps.store, "alice");
  const mail = loops.find((loop) => loop.sources?.includes("gmail"))!;
  await w.deps.items.ingest([
    {
      loopId: mail.id,
      dedupeKey: "waiting",
      source: "gmail",
      sourceAt: 1000,
      sourcePayload: { gmail: { threadId: "t1" } },
      proposal: { by: "agent", data: { body: "Draft" } },
    },
  ]);
  const item = (await w.deps.items.byLoop(mail.id))[0]!;
  const feed = await w.call();
  assert.deepEqual(refreshed, [item.id]);
  assert.equal(feed.data.total, 0);
  assert.deepEqual(feed.data.items, []);
  refreshed.length = 0;
  await w.call("PUT", { loopIds: [] });
  await w.call();
  assert.deepEqual(refreshed, []);
});

test("email filters leave Slack unchanged while source counts include all open conversations", async () => {
  const w = world();
  const [email, slack] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  for (const [key, payload, draft] of [
    ["question", {}, true],
    ["thanks", { probablyResolved: true }, true],
    ["receipt", { automated: true }, false],
    ["pending", {}, false],
    ["handled", {}, true],
  ] as const) {
    await w.deps.items.ingest([
      {
        loopId: email!.id,
        dedupeKey: key,
        source: "gmail",
        sourcePayload: { title: key, ...payload },
        ...(draft ? { proposal: { by: "agent" as const, data: { body: "Draft" } } } : {}),
      },
    ]);
  }
  const receiptItem = (await w.deps.items.byLoop(email!.id)).find((item) => item.sourceKey === "receipt")!;
  const claimed = await w.deps.items.claim(receiptItem.id);
  await w.deps.items.markReady(receiptItem.id, [], claimed!.claimToken!);
  const handled = (await w.deps.items.byLoop(email!.id)).find((item) => item.sourceKey === "handled")!;
  await w.deps.items.recordAction(handled.id, { kind: "dismiss", outcome: "dismissed" });
  await w.deps.items.ingest([
    { loopId: slack!.id, dedupeKey: "slack-pending", source: "slack", sourcePayload: {} },
    ...(
      [
        ["slack-question", {}],
        ["slack-resolved", { probablyResolved: true }],
        ["slack-bot", { automated: true }],
      ] as const
    ).map(([key, payload]) => ({
      loopId: slack!.id,
      dedupeKey: String(key),
      source: "slack",
      sourcePayload: payload,
      proposal: { by: "agent" as const, data: { body: "Draft" } },
    })),
  ]);
  const keys = (feed: any) => feed.items.map((item: any) => item.dedupeKey).sort();
  const initial = (await w.call()).data;
  assert.equal(initial.filter, "human");
  assert.deepEqual(keys(initial), ["pending", "question", "slack-bot", "slack-question", "slack-resolved", "thanks"]);
  const triaged = (await w.call("GET", null, "filter=triaged")).data;
  assert.equal(triaged.filter, "triaged");
  assert.deepEqual(keys(triaged), ["question", "slack-bot", "slack-question", "slack-resolved"]);
  assert.equal(triaged.total, 8);
  const sourceCounts = (feed: any) => feed.selected.map((loop: any) => [loop.id, loop.count]);
  assert.deepEqual(sourceCounts(triaged), [
    [email!.id, 4],
    [slack!.id, 4],
  ]);
  for (const [filter, expected] of [
    ["triaged", ["question", "slack-bot", "slack-question", "slack-resolved"]],
    ["human", ["pending", "question", "slack-bot", "slack-question", "slack-resolved", "thanks"]],
    ["all", ["pending", "question", "receipt", "slack-bot", "slack-question", "slack-resolved", "thanks"]],
  ] as const) {
    await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: filter, updatedAt: Date.now() });
    const feed = (await w.call()).data;
    assert.equal(feed.filter, filter);
    assert.deepEqual(keys(feed), expected);
    assert.equal(feed.total, 8);
    assert.deepEqual(sourceCounts(feed), sourceCounts(triaged));
    assert.equal(
      feed.selected.reduce((sum: number, loop: any) => sum + loop.count, 0),
      8,
    );
    assert.deepEqual(keys((await w.call("GET", null, `loopId=${slack!.id}`)).data), [
      "slack-bot",
      "slack-question",
      "slack-resolved",
    ]);
    assert.deepEqual(keys((await w.call("GET", null, "view=handled")).data), ["handled"]);
    assert.deepEqual(
      keys((await w.call("GET", null, `loopId=${email!.id}`)).data),
      expected.filter((key) => !key.startsWith("slack-")),
    );
    assert.equal((await w.call("GET", null, "", "mallory")).data.filter, "human");
  }
  const receipt = (await w.call()).data.items.find((item: any) => item.dedupeKey === "receipt");
  assert.equal(receipt.sourcePayload.automated, true);
  assert.equal(receipt.state, "held");
  assert.equal(receipt.proposal, undefined);
  await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: "invalid", updatedAt: Date.now() });
  assert.equal((await w.call()).data.filter, "human");
  const question = (await w.deps.items.byLoop(email!.id)).find((item) => item.sourceKey === "question")!;
  await w.deps.items.recordAction(question.id, { kind: "dismiss", outcome: "dismissed" });
  const afterDismiss = (await w.call()).data;
  assert.equal(afterDismiss.total, 7);
  assert.deepEqual(sourceCounts(afterDismiss), [
    [email!.id, 3],
    [slack!.id, 4],
  ]);
});

test("inbox filters apply before pagination even when automated messages fill multiple pages", async () => {
  const w = world();
  const [loop] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  for (let n = 0; n < 85; n++) {
    await w.deps.items.ingest([
      {
        loopId: loop!.id,
        dedupeKey: String(n),
        source: "gmail",
        sourcePayload: { automated: n >= 5 },
        proposal: { by: "agent", data: { body: "Draft" } },
      },
    ]);
  }
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
    { loopId: loop!.id, dedupeKey: "receipt", source: "gmail", sourcePayload: { automated: true } },
    { loopId: loop!.id, dedupeKey: "question", source: "gmail", sourcePayload: { automated: false } },
  ]);
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

test("email classification is projected only by the flagged inbox endpoint", async (t) => {
  const w = world();
  const [loop] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  await w.deps.items.ingest([
    {
      loopId: loop!.id,
      dedupeKey: "receipt",
      source: "gmail",
      sourcePayload: { automated: true, privateDetail: "hidden" },
    },
  ]);
  const [before] = await w.deps.items.summaries([loop!.id]);
  assert.equal(before!.inboxPreview!.automated, undefined);
  const feed = (await w.call("GET", null, "filter=all")).data;
  assert.equal(feed.items[0].sourcePayload.automated, true);
  assert.equal(feed.items[0].sourcePayload.privateDetail, undefined);
  assert.deepEqual((await w.deps.items.summaries([loop!.id]))[0], before);
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
