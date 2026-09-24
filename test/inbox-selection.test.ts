import { boundLoopCron } from "../src/loops/authority.ts";
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
import { ensureDefaultInboxLoops, ensureInboxLoop } from "../src/loops/inbox-loop.ts";
import { migrateInbox } from "../src/loops/inbox-migration.ts";

function world(enabled = true) {
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
        deps: { loops: deps, uiState, featureFlags: { enabled: async () => enabled } },
        app: {
          samePerson: async (a: string, b: string) => a === b,
          membershipControlsScope: async () => false,
          managesScope: async () => false,
        },
        res: {
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

test("migration preserves human edits, item and output IDs, dedupe and paused automation", async () => {
  const w = world();
  const legacy = await ensureInboxLoop(w.deps.store, "alice");
  const cron = await w.deps.crons.create({
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: "personal:alice",
    schedule: { everyMs: 900000 },
    enabled: false,
  });
  await w.deps.store.update(legacy.id, { cronId: cron.id });
  await w.deps.items.ingest([
    {
      loopId: legacy.id,
      dedupeKey: "thread",
      source: "gmail",
      sourcePayload: { title: "Edited draft" },
      proposal: { data: { body: "My words" }, by: "human" },
    },
  ]);
  const [item] = await w.deps.items.byLoop(legacy.id);
  await w.deps.items.appendThread(item!.id, [{ role: "human", text: "Keep this wording" }]);
  const output = await w.deps.outputs.capture({
    loopId: legacy.id,
    itemId: item!.id,
    attemptId: "a",
    shipAction: "send",
    title: "Reply",
    capturedBy: "agent",
  });
  const defaults = await ensureDefaultInboxLoops(w.deps.store, "alice");
  assert.equal(await migrateInbox(w.deps, w.uiState, (await w.deps.store.get(legacy.id))!, defaults), true);
  assert.equal(await migrateInbox(w.deps, w.uiState, legacy, defaults), true);
  const moved = (await w.deps.items.get(item!.id))!;
  assert.equal(moved.loopId, defaults[0]!.id);
  assert.equal(moved.proposal!.data.body, "My words");
  assert.equal(moved.thread![0]!.text, "Keep this wording");
  assert.equal((await w.deps.outputs.get(output.id))!.loopId, moved.loopId);
  await w.deps.items.ingest([
    {
      loopId: moved.loopId,
      dedupeKey: "thread",
      source: "gmail",
      sourcePayload: {},
      proposal: { data: { body: "Overwrite" }, by: "agent" },
    },
  ]);
  assert.equal((await w.deps.items.byLoop(moved.loopId)).length, 1);
  assert.equal((await w.deps.items.get(item!.id))!.proposal!.data.body, "My words");
  assert.ok((await w.deps.crons.list()).every((entry) => !entry.enabled));
  for (const loop of defaults) assert.ok(await boundLoopCron((await w.deps.store.get(loop.id))!, w.deps.crons));
});

test("moving records refuses collisions and a cached worker cannot claim a moved item", async () => {
  const w = world();
  const legacy = await ensureInboxLoop(w.deps.store, "alice");
  const [target] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  await w.deps.items.ingest([{ loopId: legacy.id, dedupeKey: "same", source: "gmail", sourcePayload: {} }]);
  const [item] = await w.deps.items.byLoop(legacy.id);
  await w.deps.items.moveSource(legacy.id, target!.id, "gmail");
  assert.equal(await w.deps.items.claim(item!.id, undefined, legacy.id), null);
  await w.deps.items.ingest([{ loopId: legacy.id, dedupeKey: "collision", source: "gmail", sourcePayload: {} }]);
  await w.deps.items.ingest([{ loopId: target!.id, dedupeKey: "collision", source: "gmail", sourcePayload: {} }]);
  await w.deps.items.moveSource(legacy.id, target!.id, "gmail");
  assert.equal((await w.deps.items.byLoop(legacy.id)).length, 1);
});

test("disabled rollout cannot create defaults, migrate legacy Inbox, or update selection", async () => {
  const w = world(false);
  const legacy = await ensureInboxLoop(w.deps.store, "alice");
  for (const method of ["GET", "PUT"]) assert.equal((await w.call(method, { loopIds: [] })).status, 403);
  assert.equal((await w.deps.store.list()).length, 1);
  assert.equal((await w.deps.store.get(legacy.id))?.state, "enabled");
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

for (const completed of [false, true]) {
  test(`payload-only source migration repairs ${completed ? "completed" : "pending"} accounts without losing drafts`, async () => {
    const w = world();
    const legacy = await ensureInboxLoop(w.deps.store, "alice");
    const defaults = await ensureDefaultInboxLoops(w.deps.store, "alice");
    const cron = await w.deps.crons.create({
      owner: "alice",
      createdBy: "alice",
      ownerScopeId: "personal:alice",
      schedule: { everyMs: 900000 },
      enabled: false,
    });
    await w.deps.store.update(legacy.id, { cronId: cron.id });
    if (completed) {
      await w.deps.store.setState(legacy.id, "archived");
      await w.uiState.put(uiStateId("alice", "inbox-migration"), {
        value: { phase: "complete", enabled: false },
        updatedAt: Date.now(),
      });
    }
    await w.uiState.put(uiStateId("alice", "inbox-loops"), {
      value: [...defaults.map((loop) => loop.id), legacy.id],
      updatedAt: Date.now(),
    });
    if (completed) {
      for (const [index, loop] of defaults.entries()) {
        const sourceCron = await w.deps.crons.create({
          loopId: loop.id,
          owner: "alice",
          createdBy: "alice",
          ownerScopeId: "personal:alice",
          schedule: { everyMs: 120000 + index * 60000 },
          enabled: index === 0,
          runAs: "owner",
        });
        await w.deps.store.update(loop.id, { cronId: sourceCron.id, runAs: "owner" });
        if (index === 1) await w.deps.store.setState(loop.id, "paused");
      }
    }
    const beforeCrons = await Promise.all(
      defaults.map(async (loop) => {
        const current = await w.deps.store.get(loop.id);
        return current?.cronId ? w.deps.crons.get(current.cronId) : null;
      }),
    );
    const beforeDefaults = await Promise.all(defaults.map((loop) => w.deps.store.get(loop.id)));
    for (const source of ["gmail", "slack"]) {
      await w.deps.items.ingest([
        {
          loopId: legacy.id,
          dedupeKey: source,
          sourcePayload: { source, title: `${source} draft` },
          proposal: { by: "human", data: { body: "Keep my words" } },
        },
      ]);
    }
    const originals = await w.deps.items.byLoop(legacy.id);
    for (const item of originals) {
      await w.deps.items.appendThread(item.id, [{ role: "human", text: "Preserve history" }]);
      await w.deps.outputs.capture({
        loopId: legacy.id,
        itemId: item.id,
        attemptId: "a",
        shipAction: "send",
        title: "Draft",
        capturedBy: "agent",
      });
    }
    const result = (await w.call()).data;
    assert.equal(result.migrationPending, false);
    assert.equal(result.total, 2);
    assert.deepEqual(
      result.selected.map((loop: any) => loop.id),
      defaults.map((loop) => loop.id),
    );
    for (const original of originals) {
      const item = (await w.deps.items.get(original.id))!;
      assert.equal(item.source, original.sourcePayload!.source);
      assert.equal(item.loopId, defaults.find((loop) => loop.sources![0] === item.source)!.id);
      assert.equal(item.proposal!.data.body, "Keep my words");
      assert.equal(item.thread![0]!.text, "Preserve history");
      assert.equal((await w.deps.outputs.byItem(item.id))[0]!.loopId, item.loopId);
      assert.equal(result.items.find((entry: any) => entry.id === item.id).source, item.source);
    }
    if (completed)
      assert.deepEqual(await Promise.all(defaults.map((loop) => w.deps.store.get(loop.id))), beforeDefaults);
    if (completed)
      assert.deepEqual(
        await Promise.all(
          defaults.map(async (loop) => {
            const current = await w.deps.store.get(loop.id);
            return current?.cronId ? w.deps.crons.get(current.cronId) : null;
          }),
        ),
        beforeCrons,
      );
    assert.deepEqual((await w.call()).data.items, result.items);
    assert.equal((await w.deps.items.byLoop(legacy.id)).length, 0);
  });
}

test("completed repair keeps conflicting drafts visible while moving unrelated items", async () => {
  const w = world();
  const legacy = await ensureInboxLoop(w.deps.store, "alice");
  const defaults = await ensureDefaultInboxLoops(w.deps.store, "alice");
  await w.deps.store.setState(legacy.id, "archived");
  await w.uiState.put(uiStateId("alice", "inbox-migration"), {
    value: { phase: "complete", enabled: true },
    updatedAt: Date.now(),
  });
  for (const [loopId, key, body] of [
    [legacy.id, "collision", "Human draft"],
    [defaults[0]!.id, "collision", "New draft"],
    [legacy.id, "unrelated", "Other draft"],
  ]) {
    await w.deps.items.ingest([
      {
        loopId: loopId!,
        dedupeKey: key!,
        sourcePayload: { source: "gmail", title: body },
        proposal: { by: "human", data: { body } },
      },
    ]);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await w.call();
    assert.equal(result.status, 200);
    assert.equal(result.data.migrationPending, false);
    assert.equal(result.data.total, 3);
    assert.equal(result.data.selected.find((loop: any) => loop.id === legacy.id).count, 1);
    assert.equal(result.data.selected.find((loop: any) => loop.id === defaults[0]!.id).count, 2);
    assert.equal((await w.deps.items.byLoop(legacy.id))[0]!.proposal!.data.body, "Human draft");
  }
});

test("inbox filters retain automated messages and resolved human conversations with matching counts", async () => {
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
    {
      loopId: slack!.id,
      dedupeKey: "bot",
      source: "slack",
      sourcePayload: { automated: true },
    },
  ]);
  const keys = (feed: any) => feed.items.map((item: any) => item.dedupeKey).sort();
  const triaged = (await w.call()).data;
  assert.equal(triaged.filter, "triaged");
  assert.deepEqual(keys(triaged), ["question"]);
  assert.equal(triaged.total, 1);
  for (const [filter, expected] of [
    ["human", ["pending", "question", "thanks"]],
    ["all", ["bot", "pending", "question", "receipt", "thanks"]],
  ] as const) {
    await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: filter, updatedAt: Date.now() });
    const feed = (await w.call()).data;
    assert.equal(feed.filter, filter);
    assert.deepEqual(keys(feed), expected);
    assert.equal(feed.total, expected.length);
    assert.equal(
      feed.selected.reduce((sum: number, loop: any) => sum + loop.count, 0),
      expected.length,
    );
    assert.deepEqual(keys((await w.call("GET", null, "view=handled")).data), ["handled"]);
    assert.deepEqual(
      keys((await w.call("GET", null, `loopId=${email!.id}`)).data),
      expected.filter((key) => key !== "bot"),
    );
    assert.equal((await w.call("GET", null, "", "mallory")).data.filter, "triaged");
  }
  const receipt = (await w.call()).data.items.find((item: any) => item.dedupeKey === "receipt");
  assert.equal(receipt.sourcePayload.automated, true);
  assert.equal(receipt.state, "held");
  assert.equal(receipt.proposal, undefined);
  await w.uiState.put(uiStateId("alice", "inbox-filter"), { value: "invalid", updatedAt: Date.now() });
  assert.equal((await w.call()).data.filter, "triaged");
});

test("inbox filters apply before pagination even when automated messages fill multiple pages", async () => {
  const w = world();
  const [loop] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  for (let n = 0; n < 85; n++) {
    await w.deps.items.ingest([
      {
        loopId: loop!.id,
        dedupeKey: String(n),
        sourcePayload: { automated: n >= 5 },
        proposal: { by: "agent", data: { body: "Draft" } },
      },
    ]);
  }
  const triaged = (await w.call()).data;
  assert.equal(triaged.total, 5);
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
  assert.equal(latest.total, 1);
  assert.equal((await w.call("GET", null, "filter=invalid")).status, 400);
});

test("reading the inbox expires untouched automated messages without waiting for another ingest", async () => {
  const w = world();
  const [loop] = await ensureDefaultInboxLoops(w.deps.store, "alice");
  await w.deps.items.ingest([
    { loopId: loop!.id, dedupeKey: "old", source: "gmail", sourceAt: 1, sourcePayload: { automated: true } },
    {
      loopId: loop!.id,
      dedupeKey: "recent",
      source: "gmail",
      sourceAt: Date.now(),
      sourcePayload: { automated: true },
    },
    { loopId: loop!.id, dedupeKey: "human", source: "gmail", sourceAt: 1, sourcePayload: { automated: false } },
  ]);
  const feed = (await w.call("GET", null, "filter=all")).data;
  assert.equal(feed.total, 2);
  assert.deepEqual((await w.deps.items.byLoop(loop!.id)).map((item) => item.sourceKey).sort(), ["human", "recent"]);
});
