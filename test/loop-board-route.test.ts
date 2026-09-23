import assert from "node:assert/strict";
import { test } from "node:test";
import { loopRoutes, type LoopServiceDeps } from "../src/api/routes/loops.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger, loopItemId, type LoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { findRoute } from "../src/api/routes/route.ts";
import type { ApiCtx, Route } from "../src/api/routes/route.ts";
import { userScopedField } from "../src/api/user-scoped-routes.ts";
import { scopeId, type LoopItem, type LoopOutput, type LoopThreadMessage } from "../src/types.ts";

interface Snapshot {
  updatedAt: number;
  tickets: Array<Record<string, unknown> & { id: string; status: string }>;
  queue: Array<Record<string, unknown>>;
  feed: Array<{ ts: number; text: string }>;
}

function fakeRes() {
  const out = {
    status: 0,
    headers: {} as Record<string, string>,
    raw: "",
    body: undefined as unknown,
    writes: 0,
  };
  return {
    res: {
      writeHead(status: number, headers: Record<string, string>) {
        out.status = status;
        out.headers = headers;
        out.writes += 1;
        return this;
      },
      end(data?: string) {
        out.raw = data ?? "";
        out.body = data ? JSON.parse(data) : undefined;
      },
    } as unknown as ApiCtx["res"],
    out,
  };
}

interface Harness {
  deps: LoopServiceDeps;
  items: LoopItemLedger;
  itemMap: DurableMap<LoopItem>;
  outputMap: DurableMap<LoopOutput>;
}

function harness(): Harness {
  const itemMap = createMemoryMap<LoopItem>();
  const outputMap = createMemoryMap<LoopOutput>();
  const items = createLoopItemLedger(itemMap);
  return {
    deps: {
      store: createLoopStore(),
      items,
      outputs: createLoopOutputStore(outputMap),
      grants: createShipGrantStore(),
      config: createMemoryConfigStore("org"),
    },
    items,
    itemMap,
    outputMap,
  };
}

async function makeLoop(h: Harness, name: string): Promise<string> {
  const { loop } = await h.deps.store.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId: scopeId("personal", "josh"),
    name,
    playbook: "work the queue",
    successCondition: "a PR is open",
    shipActions: [{ action: "open_pr", gate: "hold" }],
  });
  return loop.id;
}

async function seedItem(
  h: Harness,
  loopId: string,
  over: Partial<LoopItem> & Pick<LoopItem, "sourceKey">,
): Promise<LoopItem> {
  const item: LoopItem = {
    id: loopItemId(loopId, over.sourceKey),
    loopId,
    status: "queued",
    attempts: 0,
    runIds: [],
    outputIds: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
  await h.itemMap.put(item.id, item);
  return item;
}

async function seedOutput(
  h: Harness,
  loopId: string,
  over: Partial<LoopOutput> & Pick<LoopOutput, "id" | "itemId">,
): Promise<void> {
  await h.outputMap.put(over.id, {
    loopId,
    attemptId: "attempt-1",
    shipAction: "open_pr",
    title: "a pull request",
    state: "ready",
    capturedBy: "agent",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  });
}

interface CallOptions {
  actor?: string;
  anonymous?: boolean;
  wired?: boolean;
}

async function board(h: Harness, path: string, opts: CallOptions = {}) {
  const url = new URL(`http://x${path}`);
  const found = findRoute(loopRoutes as ReadonlyArray<Route<ApiCtx>>, "GET", url.pathname);
  assert.ok(found, `no route for GET ${url.pathname}`);
  const { res, out } = fakeRes();
  const actor = opts.actor ?? "josh";
  const ctx = {
    res,
    url,
    body: undefined,
    params: found.params,
    capability: opts.anonymous
      ? null
      : { actorId: actor, scopeId: scopeId("personal", actor), liveActor: true, destinations: [] },
    app: {
      membershipControlsScope: async () => false,
      managesScope: async () => false,
      samePerson: async (a: string, b: string) => a === b,
    },
    deps: { loops: opts.wired === false ? undefined : h.deps },
  } as unknown as ApiCtx;
  await found.route.handle(ctx);
  return out;
}

const snapshotOf = (out: { body: unknown }): Snapshot => out.body as Snapshot;

const ticket = (snapshot: Snapshot, id: string) => snapshot.tickets.find((entry) => entry.id === id);

const STAGES = [
  { name: "Setup", state: "done", ts: 10 },
  { name: "Implement", state: "active", ts: 20 },
];

test("every item status lands in the right array with the right status, terminalKind, mr and createdAt order", async () => {
  const h = harness();
  const loopId = await makeLoop(h, "Factory");
  await seedItem(h, loopId, { sourceKey: "QM-73", status: "failed", createdAt: 100, updatedAt: 110 });
  const shipped = await seedItem(h, loopId, {
    sourceKey: "QM-72",
    sourceSummary: "Shipped one",
    status: "shipped",
    createdAt: 200,
    updatedAt: 900,
    sourcePayload: { url: "https://linear.app/x/issue/QM-72", assignee: "Grace", project: "Factory" },
  });
  await seedItem(h, loopId, {
    sourceKey: "QM-71",
    sourceSummary: "In flight",
    status: "in_progress",
    createdAt: 300,
    updatedAt: 310,
    sourcePayload: { url: "https://linear.app/x/issue/QM-71", assignee: "Ada", project: "Factory", stages: STAGES },
  });
  await seedItem(h, loopId, {
    sourceKey: "QM-70",
    sourceSummary: "Queued one",
    status: "queued",
    createdAt: 400,
    updatedAt: 410,
    sourcePayload: { url: "https://linear.app/x/issue/QM-70", assignee: "Ada", project: "Factory" },
  });
  await seedOutput(h, loopId, {
    id: "out-pr-7",
    itemId: shipped.id,
    externalRef: "https://github.com/o/r/pull/7",
    createdAt: 500,
    updatedAt: 500,
  });
  const backingOrder = (await h.itemMap.all()).map((item) => item.sourceKey);
  assert.notDeepEqual(backingOrder, ["QM-73", "QM-72", "QM-71", "QM-70"]);

  const out = await board(h, `/v1/loops/${loopId}/board`);

  assert.equal(out.status, 200);
  assert.equal(out.writes, 1);
  assert.equal(out.headers["cache-control"], "no-store");
  assert.equal(out.headers["content-type"], "application/json");
  const snapshot = snapshotOf(out);
  assert.equal(snapshot.updatedAt, 900);
  assert.deepEqual(snapshot.queue, [
    { id: "QM-70", title: "Queued one", url: "https://linear.app/x/issue/QM-70", assignee: "Ada" },
  ]);
  assert.deepEqual(snapshot.tickets, [
    {
      id: "QM-73",
      title: "",
      url: "",
      project: "",
      assignee: "",
      status: "failed",
      stages: [],
    },
    {
      id: "QM-72",
      title: "Shipped one",
      url: "https://linear.app/x/issue/QM-72",
      project: "Factory",
      assignee: "Grace",
      status: "done",
      stages: [],
      mr: "https://github.com/o/r/pull/7",
      terminalKind: "ready_for_review",
    },
    {
      id: "QM-71",
      title: "In flight",
      url: "https://linear.app/x/issue/QM-71",
      project: "Factory",
      assignee: "Ada",
      status: "working",
      stages: STAGES,
    },
  ]);
  for (const leaked of ["in_progress", "skipped", "externalRef", "sourcePayload"]) {
    assert.equal(out.raw.includes(leaked), false, `the snapshot leaks loop-internal vocabulary: ${leaked}`);
  }

  const emptyLoopId = await makeLoop(h, "Empty");
  const empty = snapshotOf(await board(h, `/v1/loops/${emptyLoopId}/board`));
  assert.deepEqual([empty.tickets, empty.queue, empty.feed], [[], [], []]);
  assert.ok(Number.isFinite(empty.updatedAt) && empty.updatedAt > 0);
});

test("items enqueued in the same millisecond sort by sourceKey, not by the backing store's key order", async () => {
  const h = harness();
  const loopId = await makeLoop(h, "Factory");
  for (const sourceKey of ["QM-14", "QM-15", "QM-16"]) {
    await seedItem(h, loopId, { sourceKey, sourceSummary: sourceKey, status: "in_progress", createdAt: 700 });
  }
  const backingOrder = (await h.itemMap.all()).map((item) => item.sourceKey);
  assert.notDeepEqual(backingOrder, ["QM-14", "QM-15", "QM-16"]);

  const snapshot = snapshotOf(await board(h, `/v1/loops/${loopId}/board`));

  assert.deepEqual(
    snapshot.tickets.map((entry) => entry.id),
    ["QM-14", "QM-15", "QM-16"],
  );
});

test("updatedAt is the newest stamp across items and outputs, not across items alone", async () => {
  const h = harness();
  const loopId = await makeLoop(h, "Factory");
  const item = await seedItem(h, loopId, { sourceKey: "QM-60", status: "shipped", createdAt: 100, updatedAt: 200 });
  await seedOutput(h, loopId, {
    id: "out-pr-60",
    itemId: item.id,
    externalRef: "https://github.com/o/r/pull/60",
    createdAt: 150,
    updatedAt: 800,
  });

  const snapshot = snapshotOf(await board(h, `/v1/loops/${loopId}/board`));

  assert.equal(snapshot.updatedAt, 800);
});

test("a dismissed item is absent from tickets, queue and feed, while a parked ready item still reads as working", async () => {
  const h = harness();
  const loopId = await makeLoop(h, "Factory");
  const dismissed = await seedItem(h, loopId, {
    sourceKey: "QM-80",
    sourceSummary: "Dismissed one",
    createdAt: 100,
    sourcePayload: { stages: [{ name: "Setup", state: "done", ts: 5 }] },
    thread: [{ id: "m1", role: "agent", text: "looked at it", at: 6 }],
  });
  await seedItem(h, loopId, { sourceKey: "QM-81", sourceSummary: "Ready one", status: "ready", createdAt: 200 });
  const parked = await seedItem(h, loopId, {
    sourceKey: "QM-82",
    sourceSummary: "Parked ready one",
    status: "ready",
    createdAt: 300,
  });
  assert.ok(await h.items.recordAction(dismissed.id, { kind: "dismiss", outcome: "dismissed" }));
  assert.ok(await h.items.park(parked.id, "waiting on a human"));

  const snapshot = snapshotOf(await board(h, `/v1/loops/${loopId}/board`));

  assert.deepEqual(
    snapshot.tickets.map((entry) => [entry.id, entry.status, "terminalKind" in entry]),
    [
      ["QM-81", "working", false],
      ["QM-82", "working", false],
    ],
  );
  assert.deepEqual(snapshot.queue, []);
  assert.deepEqual(snapshot.feed, []);

  assert.ok(await h.items.reopen(dismissed.id));
  const reopened = snapshotOf(await board(h, `/v1/loops/${loopId}/board`));
  assert.deepEqual(
    reopened.queue.map((entry) => entry.id),
    ["QM-80"],
  );
});

test("mr is the newest open_pr output of that item whatever order the store hands rows back, and the feed merges thread and stages ascending", async () => {
  const h = harness();
  const loopId = await makeLoop(h, "Factory");
  const retried = await seedItem(h, loopId, { sourceKey: "QM-90", status: "shipped", createdAt: 100 });
  const commented = await seedItem(h, loopId, { sourceKey: "QM-91", status: "shipped", createdAt: 200 });
  await seedItem(h, loopId, {
    sourceKey: "QM-92",
    status: "in_progress",
    createdAt: 300,
    sourcePayload: {
      stages: [
        { name: "Setup", state: "done", ts: 75 },
        { name: "Ship", state: "active", ts: 175 },
      ],
    },
    thread: [
      { id: "m1", role: "agent", text: "picked it up", at: 50 },
      { id: "m2", role: "human", text: "ship it", at: 150 },
    ],
  });
  await seedOutput(h, loopId, {
    id: "out-pr-a",
    itemId: retried.id,
    externalRef: "https://github.com/o/r/pull/2",
    createdAt: 200,
  });
  await seedOutput(h, loopId, {
    id: "out-pr-b",
    itemId: retried.id,
    externalRef: "https://github.com/o/r/pull/1",
    createdAt: 100,
  });
  await seedOutput(h, loopId, {
    id: "out-comment",
    itemId: commented.id,
    shipAction: "comment",
    externalRef: "https://github.com/o/r/issues/9#issuecomment-1",
    createdAt: 300,
  });
  const backingOrder = (await h.outputMap.all()).map((output) => output.createdAt);
  assert.deepEqual(backingOrder, [300, 200, 100]);

  const out = await board(h, `/v1/loops/${loopId}/board`);
  const snapshot = snapshotOf(out);

  assert.equal(ticket(snapshot, "QM-90")?.mr, "https://github.com/o/r/pull/2");
  assert.equal("mr" in (ticket(snapshot, "QM-91") ?? {}), false);
  assert.equal("mr" in (ticket(snapshot, "QM-92") ?? {}), false);
  assert.deepEqual(snapshot.feed, [
    { ts: 50, text: "picked it up" },
    { ts: 75, text: "QM-92 Setup" },
    { ts: 150, text: "ship it" },
    { ts: 175, text: "QM-92 Ship" },
  ]);

  const limited = await board(h, `/v1/loops/${loopId}/board?limit=1`);
  assert.deepEqual(limited.body, out.body);
});

test("the feed keeps the newest 200 events across items and drops the oldest", async () => {
  const h = harness();
  const loopId = await makeLoop(h, "Busy");
  for (const [index, sourceKey] of ["QM-93", "QM-94", "QM-95"].entries()) {
    const base = index * 100;
    const thread: LoopThreadMessage[] = [];
    for (let n = 1; n <= 60; n += 1) {
      thread.push({ id: `m${base + n}`, role: "agent", text: `note ${base + n}`, at: base + n });
    }
    const stages = [];
    for (let n = 61; n <= 100; n += 1) stages.push({ name: `Step ${base + n}`, state: "active", ts: base + n });
    await seedItem(h, loopId, { sourceKey, status: "in_progress", createdAt: base, thread, sourcePayload: { stages } });
  }

  const snapshot = snapshotOf(await board(h, `/v1/loops/${loopId}/board`));

  assert.equal(snapshot.feed.length, 200);
  assert.deepEqual(snapshot.feed.at(0), { ts: 101, text: "note 101" });
  assert.deepEqual(snapshot.feed.at(-1), { ts: 300, text: "QM-95 Step 300" });
});

test("a sourcePayload whose stages are not a well-formed trail yields an empty trail rather than garbage", async () => {
  const h = harness();
  const loopId = await makeLoop(h, "Factory");
  await seedItem(h, loopId, { sourceKey: "QM-96", status: "in_progress", sourcePayload: { stages: "Setup" } });
  await seedItem(h, loopId, {
    sourceKey: "QM-97",
    status: "in_progress",
    sourcePayload: { stages: { name: "Setup" } },
  });
  await seedItem(h, loopId, {
    sourceKey: "QM-98",
    status: "in_progress",
    sourcePayload: { stages: [{}, "Setup", { name: "Setup" }, { name: "Setup", state: "paused", ts: 1 }] },
  });

  const snapshot = snapshotOf(await board(h, `/v1/loops/${loopId}/board`));

  assert.deepEqual(
    snapshot.tickets.map((entry) => entry.stages),
    [[], [], []],
  );
  assert.deepEqual(snapshot.feed, []);
});

test("the board route is gated exactly like the loop detail route", async () => {
  const h = harness();
  const loopId = await makeLoop(h, "Factory");

  const anonymous = await board(h, `/v1/loops/${loopId}/board`, { anonymous: true });
  assert.equal(anonymous.status, 403);
  assert.deepEqual(anonymous.body, {
    error: "forbidden",
    message: "loops need an agent capability or a principalId",
  });
  assert.equal(anonymous.writes, 1);

  const stranger = await board(h, `/v1/loops/${loopId}/board`, { actor: "mallory" });
  assert.equal(stranger.status, 403);
  assert.deepEqual(stranger.body, { error: "forbidden", message: "you may not administer this loop" });
  assert.equal(stranger.writes, 1);

  const missing = await board(h, "/v1/loops/does-not-exist/board");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "not_found", message: "no such loop" });
  assert.equal(missing.writes, 1);

  const unwired = await board(h, `/v1/loops/${loopId}/board`, { wired: false });
  assert.equal(unwired.status, 404);
  assert.deepEqual(unwired.body, { error: "not_found", message: "loops are not wired on this deployment" });
  assert.equal(unwired.writes, 1);

  assert.deepEqual(userScopedField("GET", "/v1/loops/x123/board"), { in: "query", name: "principalId" });
});
