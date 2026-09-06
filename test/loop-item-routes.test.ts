import assert from "node:assert/strict";
import { test } from "node:test";
import { loopItemRoutes } from "../src/api/routes/loop-items.ts";
import type { LoopServiceDeps } from "../src/api/routes/loops.ts";
import { findRoute, run, type ApiCtx } from "../src/api/routes/route.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { ensureInboxLoop, INBOX_SYNC_TASK_VERSION, renderInboxSyncTask } from "../src/loops/inbox-loop.ts";
import type { Cron, Loop, LoopItem } from "../src/types.ts";
import type { LedgerItemView } from "../src/loops/ledger-view.ts";
import type { SlackUserClient } from "../src/loops/sources/adapter.ts";
import { sleep } from "../src/util/async.ts";

function fakeRes() {
  const out = { status: 0, body: undefined as unknown };
  return {
    res: {
      writeHead(status: number) {
        out.status = status;
        return this;
      },
      end(data?: string) {
        out.body = data ? JSON.parse(data) : undefined;
      },
    } as unknown as ApiCtx["res"],
    out,
  };
}

interface World {
  loops: LoopServiceDeps;
  crons: Map<string, Cron>;
  sent: Array<{ host: string; body: unknown }>;
  slackOk: boolean;
  followUps: Array<{ itemId: string; message: string; actorId: string }>;
  actions: Array<{ kind: string; args: Record<string, unknown> }>;
  tokens: boolean;
}

let cronSeq = 0;

function world(over: { tokens?: boolean; fire?: boolean } = {}): World {
  const w: World = {
    loops: {
      store: createLoopStore(),
      items: createLoopItemLedger(),
      outputs: createLoopOutputStore(),
      grants: createShipGrantStore(),
      crons: createCronStore(),
      config: createMemoryConfigStore("org"),
    },
    crons: new Map(),
    sent: [],
    slackOk: true,
    followUps: [],
    actions: [],
    tokens: over.tokens !== false,
  };
  if (over.fire !== false) {
    w.loops.fire = {
      fire: async () => ({ status: "ok" as const }),
      shipOutput: async () => null,
      returnOutput: async () => null,
      sweepStale: async () => {},
      followUp: async (loop: Loop, item: LoopItem, message: string, actorId: string) => {
        w.followUps.push({ itemId: item.id, message, actorId });
        await w.loops.items.appendThread(item.id, [{ role: "human", text: message, actorId }]);
        await w.loops.items.appendThread(item.id, [{ role: "agent", text: "shortened it" }]);
        await w.loops.items.setProposal(item.id, { data: { body: "shorter" }, by: "agent" });
        return w.loops.items.get(item.id);
      },
      itemAction: async (_loop: Loop, _item: LoopItem, kind: string, args: Record<string, unknown>) => {
        w.actions.push({ kind, args });
        return { ok: true, reply: `did ${kind}` };
      },
    };
  }
  return w;
}

function slackClientFor(w: World): (token: string) => SlackUserClient {
  const call = (api: string) => async (args: Record<string, unknown>) => {
    w.sent.push({ host: api, body: args });
    if (!w.slackOk) {
      throw Object.assign(new Error("An API error occurred"), { data: { ok: false, error: "not_in_channel" } });
    }
    return { ok: true };
  };
  return () => ({ chat: { postMessage: call("chat.postMessage") }, reactions: { add: call("reactions.add") } });
}

async function call(
  w: World,
  over: {
    method: string;
    path: string;
    body?: unknown;
    capability?: Record<string, unknown> | null;
    actor?: string;
    sessionForThread?: string;
  },
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`http://x${over.path}`);
  const found = findRoute(loopItemRoutes, over.method, url.pathname);
  assert.ok(found, `${over.method} ${over.path} should match a loop item route`);
  const { res, out } = fakeRes();
  const app = {
    membershipControlsScope: async () => false,
    managesScope: async () => false,
    samePerson: async (a: string, b: string) => a === b,
    getCron: async (id: string) => w.crons.get(id) ?? null,
    createCron: async (input: Record<string, unknown>) => {
      const cron = { id: `cron-${++cronSeq}`, enabled: true, ...input } as unknown as Cron;
      w.crons.set(cron.id, cron);
      return cron;
    },
    updateCron: async (id: string, patch: Record<string, unknown>) => {
      const cur = w.crons.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch } as Cron;
      w.crons.set(id, next);
      return next;
    },
    setCronEnabled: async (id: string, enabled: boolean) => {
      const cur = w.crons.get(id);
      if (cur) w.crons.set(id, { ...cur, enabled });
    },
  };
  const ctx = {
    res,
    url,
    pathname: url.pathname,
    method: over.method,
    body: over.body ?? null,
    params: found.params,
    capability: over.capability === undefined ? CAP : over.capability,
    deps: {
      loops: w.loops,
      sessions: {
        getByThread: async (threadRef: string) =>
          over.sessionForThread && threadRef === "thread-9" ? { id: over.sessionForThread } : null,
      },
      loopSlackClient: slackClientFor(w),
      ...(w.tokens
        ? {
            loopSourceTokens: { connectorAccessToken: async () => "tok" },
          }
        : {}),
    },
    app,
  } as unknown as ApiCtx;
  await run(found.route, found.params, ctx);
  return out;
}

const CAP = { actorId: "josh", privateScope: true, scopeId: "personal:josh", liveActor: true, exp: 0 };

const PORTAL = null;

const ITEM = {
  source: "slack",
  sourceKey: "C1:1.2",
  title: "#launches",
  from: "Ada",
  snippet: "can you review my launch post?",
  receivedAt: 1234,
  draft: { body: "Looking now — back to you within the hour." },
  slack: { channelId: "C1", ts: "1.2" },
};

async function inboxLoop(w: World): Promise<Loop> {
  return ensureInboxLoop(w.loops.store, "josh");
}

async function seed(
  w: World,
  item: Record<string, unknown> = ITEM,
): Promise<{ w: World; loop: Loop; item: LedgerItemView }> {
  const loop = await inboxLoop(w);
  const out = await call(w, { method: "POST", path: `/v1/loops/${loop.id}/items`, body: { items: [item] } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const listed = await call(w, { method: "GET", path: `/v1/loops/${loop.id}/items` });
  const items = (listed.body as { items: LedgerItemView[] }).items;
  return { w, loop, item: items[0]! };
}

test("ingest needs an agent capability, not a portal session", async () => {
  const w = world();
  const loop = await inboxLoop(w);
  const fromPortal = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items?principalId=josh`,
    body: { items: [ITEM] },
    capability: PORTAL,
  });
  assert.equal(fromPortal.status, 403);
  const ok = await call(w, { method: "POST", path: `/v1/loops/${loop.id}/items`, body: { items: [ITEM] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { created: 1, updated: 0, skipped: 0 });
});

test("a personal loop's items stay out of a shared-scope capability's reach", async () => {
  const w = world();
  const loop = await inboxLoop(w);
  const shared = { ...CAP, privateScope: false, scopeId: "channel:C9" };
  assert.equal(
    (await call(w, { method: "POST", path: `/v1/loops/${loop.id}/items`, body: { items: [ITEM] }, capability: shared }))
      .status,
    403,
  );
  assert.equal((await call(w, { method: "GET", path: `/v1/loops/${loop.id}/items`, capability: shared })).status, 403);
});

test("another person cannot read the ledger at all", async () => {
  const w = world();
  const loop = await inboxLoop(w);
  const out = await call(w, {
    method: "GET",
    path: `/v1/loops/${loop.id}/items`,
    capability: { ...CAP, actorId: "ada", scopeId: "personal:ada" },
  });
  assert.equal(out.status, 403);
});

test("ingest stamps the drafting session from the caller's thread", async () => {
  const w = world();
  const loop = await inboxLoop(w);
  await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items`,
    body: { items: [ITEM] },
    capability: { ...CAP, threadRef: "thread-9" },
    sessionForThread: "sess-42",
  });
  const [item] = await w.loops.items.byLoop(loop.id);
  assert.equal(item?.proposal?.sessionId, "sess-42");
});

test("ingest rejects malformed items with a pointed message", async () => {
  const w = world();
  const loop = await inboxLoop(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items`,
    body: { items: [{ ...ITEM, slack: undefined }] },
  });
  assert.equal(out.status, 400);
  assert.match(String((out.body as { message: string }).message), /items\[0\]: slack items need/);
});

test("ingest refuses a source this loop does not declare", async () => {
  const w = world();
  const { loop } = await w.loops.store.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId: "personal:josh",
    name: "Sentry triage",
    sources: ["gmail"],
    playbook: "triage",
    successCondition: "fixed",
  });
  const out = await call(w, { method: "POST", path: `/v1/loops/${loop.id}/items`, body: { items: [ITEM] } });
  assert.equal(out.status, 400);
  assert.match(String((out.body as { message: string }).message), /does not accept "slack"/);
});

test("a loop with no source adapter ingests an opaque payload", async () => {
  const w = world();
  const { loop } = await w.loops.store.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId: "personal:josh",
    name: "Sentry triage",
    playbook: "triage",
    successCondition: "fixed",
  });
  const ok = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items`,
    body: {
      items: [
        {
          dedupeKey: "SENTRY-42",
          summary: "TypeError in checkout",
          sourceAt: 99,
          sourcePayload: { issue: "SENTRY-42", culprit: "checkout.ts", events: 12 },
          proposal: { plan: "guard the null" },
        },
      ],
    },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const [item] = await w.loops.items.byLoop(loop.id);
  assert.deepEqual(item?.sourcePayload, { issue: "SENTRY-42", culprit: "checkout.ts", events: 12 });
  assert.deepEqual(item?.proposal?.data, { plan: "guard the null" });
  assert.equal(item?.status, "ready");
});

test("an opaque item needs a dedupe key and an object payload", async () => {
  const w = world();
  const { loop } = await w.loops.store.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId: "personal:josh",
    name: "Sentry triage",
    playbook: "triage",
    successCondition: "fixed",
  });
  const noKey = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items`,
    body: { items: [{ sourcePayload: {} }] },
  });
  assert.equal(noKey.status, 400);
  const huge = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items`,
    body: { items: [{ dedupeKey: "k", sourcePayload: { blob: "x".repeat(70_000) } }] },
  });
  assert.equal(huge.status, 400);
  assert.match(String((huge.body as { message: string }).message), /sourcePayload must be under/);
  const unknownSource = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items`,
    body: { items: [{ source: "front", dedupeKey: "k", sourcePayload: {} }] },
  });
  assert.equal(unknownSource.status, 400);
});

test("listing returns the ledger view with per-state counts and filters", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const listed = await call(w, { method: "GET", path: `/v1/loops/${loop.id}/items` });
  const body = listed.body as { items: LedgerItemView[]; counts: Record<string, number> };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]!.state, "held");
  assert.equal(body.items[0]!.dedupeKey, "C1:1.2");
  assert.deepEqual(body.items[0]!.sourcePayload.slack, { channelId: "C1", ts: "1.2" });
  assert.deepEqual(body.counts, { held: 1 });
  const heldOnly = await call(w, { method: "GET", path: `/v1/loops/${loop.id}/items?state=held` });
  assert.equal((heldOnly.body as { items: unknown[] }).items.length, 1);
  const pendingOnly = await call(w, { method: "GET", path: `/v1/loops/${loop.id}/items?state=pending` });
  assert.equal((pendingOnly.body as { items: unknown[] }).items.length, 0);
  const junk = await call(w, { method: "GET", path: `/v1/loops/${loop.id}/items?state=nonsense` });
  assert.equal(junk.status, 400);
  const one = await call(w, { method: "GET", path: `/v1/loops/${loop.id}/items/${item.id}` });
  assert.equal((one.body as { item: LedgerItemView }).item.id, item.id);
  const missing = await call(w, { method: "GET", path: `/v1/loops/${loop.id}/items/nope` });
  assert.equal(missing.status, 404);
});

test("edit replaces the proposal and marks it the person's own", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action?principalId=josh`,
    body: { kind: "edit", args: { proposal: { body: "Shorter." } } },
    capability: PORTAL,
  });
  assert.equal(out.status, 200);
  const view = (out.body as { item: LedgerItemView }).item;
  assert.deepEqual(view.proposal?.data, { body: "Shorter." });
  assert.equal(view.proposal?.by, "human");
});

test("send posts through the source adapter, records the outcome, and refuses a resend", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const sent = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const view = (sent.body as { item: LedgerItemView }).item;
  assert.equal(view.state, "actioned");
  assert.equal(view.actionResult, "Looking now — back to you within the hour.");
  assert.deepEqual(w.sent, [
    {
      host: "chat.postMessage",
      body: { channel: "C1", text: "Looking now — back to you within the hour.", parse: "none", thread_ts: "1.2" },
    },
  ]);
  const again = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(again.status, 409);
  assert.equal(w.sent.length, 1, "a resend never reaches the source");
});

test("send takes a final edit in the same call and a refusal leaves the item held", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  w.slackOk = false;
  const blocked = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: { body: "Final words." } } },
  });
  assert.equal(blocked.status, 502);
  const stored = await w.loops.items.get(item.id);
  assert.equal(stored?.status, "ready", "a refused send leaves the item held");
  assert.deepEqual(stored?.proposal?.data, { body: "Final words." }, "the edit still persisted");
  w.slackOk = true;
  const ok = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(ok.status, 200);
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Final words.");
});

test("a send with no connected account reads as a conflict, not a crash", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  w.tokens = false;
  const out = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(out.status, 404);
});

test("dismiss, reopen and the actioned end-state", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const dismissed = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "dismiss" },
  });
  assert.equal((dismissed.body as { item: LedgerItemView }).item.state, "dismissed");
  const reopened = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "reopen" },
  });
  assert.equal((reopened.body as { item: LedgerItemView }).item.state, "held");
  await w.loops.items.recordAction(item.id, { kind: "send", outcome: "actioned" });
  const again = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(again.status, 409);
});

test("react adds the emoji, records it on the item, and leaves the item held", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "react", args: { name: ":eyes:" } },
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const view = (out.body as { item: LedgerItemView }).item;
  assert.equal(view.state, "held", "reacting never resolves the item");
  assert.deepEqual(view.sourcePayload.reactions, ["eyes"]);
  assert.equal(view.actionKind, undefined);
  assert.deepEqual(w.sent, [{ host: "reactions.add", body: { channel: "C1", timestamp: "1.2", name: "eyes" } }]);
  const again = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "react", args: { name: "tada" } },
  });
  assert.deepEqual((again.body as { item: LedgerItemView }).item.sourcePayload.reactions, ["eyes", "tada"]);
});

test("a reaction slack refuses leaves the item untouched", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  w.slackOk = false;
  const out = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "react", args: { name: "eyes" } },
  });
  assert.equal(out.status, 502);
  const stored = await w.loops.items.get(item.id);
  assert.equal(stored?.status, "ready");
  assert.equal(stored?.sourcePayload?.reactions, undefined);
});

test("replied closes an item the person answered outside QM and keeps their words", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "replied", args: { text: "  Answered in the thread.  " } },
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const view = (out.body as { item: LedgerItemView }).item;
  assert.equal(view.state, "dismissed");
  assert.equal(view.actionKind, "replied");
  assert.equal(view.actionResult, "Answered in the thread.");
  assert.equal(w.sent.length, 0, "closing a loop externally never touches the source");
});

test("replied reopens like any dismissal and never demotes what was sent from here", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "replied", args: { text: "handled it" } },
  });
  const reopened = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "reopen" },
  });
  const view = (reopened.body as { item: LedgerItemView }).item;
  assert.equal(view.state, "held");
  assert.equal(view.actionKind, undefined);
  assert.equal(view.actionResult, undefined);

  await w.loops.items.recordAction(item.id, { kind: "send", outcome: "actioned" });
  const late = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "replied", args: { text: "too late" } },
  });
  assert.equal(late.status, 409);
  assert.equal((await w.loops.items.get(item.id))?.actionKind, "send");
});

test("a replied text longer than the cap is clipped, and an absent one still closes the item", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const clipped = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "replied", args: { text: "x".repeat(900) } },
  });
  assert.equal((clipped.body as { item: LedgerItemView }).item.actionResult?.length, 500);

  const bare = await seed(world());
  const out = await call(bare.w, {
    method: "POST",
    path: `/v1/loops/${bare.loop.id}/items/${bare.item.id}/action`,
    body: { kind: "replied" },
  });
  const view = (out.body as { item: LedgerItemView }).item;
  assert.equal(view.state, "dismissed");
  assert.equal(view.actionResult, undefined);
});

test("an action kind the source does not know is handed to the agent", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "escalate", args: { to: "ada" } },
  });
  assert.equal(out.status, 200);
  assert.deepEqual(w.actions, [{ kind: "escalate", args: { to: "ada" } }]);
  const view = (out.body as { item: LedgerItemView }).item;
  assert.equal(view.state, "actioned");
  assert.equal(view.actionKind, "escalate");
  assert.equal(view.thread.at(-1)?.text, "did escalate");
});

test("an action carrying a final edit persists it before acting", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action?principalId=josh`,
    body: { kind: "escalate", args: { proposal: { body: "Final words." } } },
    capability: PORTAL,
  });
  const stored = await w.loops.items.get(item.id);
  assert.deepEqual(stored?.proposal?.data, { body: "Final words." });
  assert.equal(stored?.proposal?.by, "human");
});

test("a deployment without connectors answers 404 rather than pretending to send", async () => {
  const w = world({ tokens: false });
  const { loop, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(out.status, 404);
});

test("an action with no kind is refused", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { args: {} },
  });
  assert.equal(out.status, 400);
});

test("follow-up runs an agent turn scoped to the item and lands on its thread", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/followup`,
    body: { message: "make it shorter" },
  });
  assert.equal(out.status, 200);
  assert.deepEqual(w.followUps, [{ itemId: item.id, message: "make it shorter", actorId: "josh" }]);
  const view = (out.body as { item: LedgerItemView }).item;
  assert.deepEqual(
    view.thread.map((m) => [m.role, m.text]),
    [
      ["human", "make it shorter"],
      ["agent", "shortened it"],
    ],
  );
  assert.deepEqual(view.proposal?.data, { body: "shorter" });
});

test("follow-up needs a message and a wired fire service", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const empty = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/followup`,
    body: { message: "   " },
  });
  assert.equal(empty.status, 400);
  const long = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/followup`,
    body: { message: "x".repeat(4_001) },
  });
  assert.equal(long.status, 400);
  const unwired = world({ fire: false });
  const seeded = await seed(unwired);
  const out = await call(unwired, {
    method: "POST",
    path: `/v1/loops/${seeded.loop.id}/items/${seeded.item.id}/followup`,
    body: { message: "hi" },
  });
  assert.equal(out.status, 404);
});

test("the inbox resolver reports no loop until sync is set up", async () => {
  const w = world();
  const before = await call(w, { method: "GET", path: "/v1/loops/inbox" });
  assert.equal(before.status, 200);
  assert.equal((before.body as { loop: Loop | null }).loop, null);
  const created = await call(w, { method: "POST", path: "/v1/loops/inbox/sync-cron", body: {} });
  assert.equal(created.status, 200);
  const body = created.body as { loop: Loop; syncCron: { id: string; taskVersion: number } };
  assert.equal(body.syncCron.taskVersion, INBOX_SYNC_TASK_VERSION);
  assert.equal(body.loop.surface, "inbox");
  const stored = w.crons.get(body.syncCron.id)!;
  assert.equal(stored.ownerScopeId, "personal:josh");
  assert.equal(stored.owner, "josh");
  assert.equal((stored.destination as { target: string }).target, "josh");
  assert.equal(stored.action, renderInboxSyncTask(body.loop.id));
  const after = await call(w, { method: "GET", path: "/v1/loops/inbox" });
  assert.equal((after.body as { loop: Loop }).loop.id, body.loop.id);
});

test("sync-cron is created once, refreshes stale task text, and disables on request", async () => {
  const w = world();
  const created = await call(w, { method: "POST", path: "/v1/loops/inbox/sync-cron", body: {} });
  const syncCron = (created.body as { syncCron: { id: string } }).syncCron;
  const stored = w.crons.get(syncCron.id)!;
  w.crons.set(syncCron.id, { ...stored, action: "Inbox sync v0. old", enabled: false });
  const refreshed = await call(w, { method: "POST", path: "/v1/loops/inbox/sync-cron", body: {} });
  const after = (refreshed.body as { syncCron: { id: string; taskVersion: number; enabled: boolean } }).syncCron;
  assert.equal(after.id, syncCron.id);
  assert.equal(after.taskVersion, INBOX_SYNC_TASK_VERSION);
  assert.equal(after.enabled, true);
  assert.equal(w.crons.size, 1);
  const disabled = await call(w, { method: "POST", path: "/v1/loops/inbox/sync-cron", body: { enabled: false } });
  assert.equal((disabled.body as { syncCron: { enabled: boolean } }).syncCron.enabled, false);
});

test("the sync cron the loop points at drives the ledger it names", async () => {
  const w = world();
  const created = await call(w, { method: "POST", path: "/v1/loops/inbox/sync-cron", body: {} });
  const { loop, syncCron } = created.body as { loop: Loop; syncCron: { id: string } };
  assert.equal(loop.cronId, syncCron.id);
  assert.match(w.crons.get(syncCron.id)!.action ?? "", new RegExp(`/v1/loops/${loop.id}/items`));
});

test("a send carrying the draft it saw is refused when the agent redrafted in between", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const seenAt = (await w.loops.items.get(item.id))!.proposal!.at;
  await sleep(2);
  await w.loops.items.setProposal(item.id, { data: { body: "newer agent draft" }, by: "agent" });
  const stale = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: { body: "what I saw" }, expectedProposalAt: seenAt } },
  });
  assert.equal(stale.status, 409);
  assert.match((stale.body as { message: string }).message, /draft changed/);
  assert.equal(w.sent.length, 0, "nothing reached Slack");
  const fresh = (await w.loops.items.get(item.id))!.proposal!;
  assert.equal(fresh.by, "agent", "the stale edit did not overwrite the newer draft");
  const ok = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: { body: "newer agent draft" }, expectedProposalAt: fresh.at } },
  });
  assert.equal(ok.status, 200);
});

test("sending the agent's draft unchanged keeps it attributed to the agent", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const held = (await w.loops.items.get(item.id))!;
  const sent = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: held.proposal!.data, expectedProposalAt: held.proposal!.at } },
  });
  assert.equal(sent.status, 200);
  assert.equal((await w.loops.items.get(item.id))!.proposal!.by, "agent");
});

test("an edit carrying the draft it was based on is refused when the agent redrafted in between", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const basedOn = (await w.loops.items.get(item.id))!.proposal!.at;
  await sleep(2);
  await w.loops.items.setProposal(item.id, { data: { body: "newer agent draft" }, by: "agent" });
  const stale = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "edit", args: { proposal: { body: "typed over the old one" }, expectedProposalAt: basedOn } },
  });
  assert.equal(stale.status, 409);
  assert.match((stale.body as { message: string }).message, /draft changed/);
  assert.deepEqual((await w.loops.items.get(item.id))!.proposal!.data, { body: "newer agent draft" });
});

test("a person's own typed mention stays live, while a capability caller's is disarmed", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const human = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action?principalId=josh`,
    body: { kind: "send", args: { proposal: { body: "Heads up <!channel>" } } },
    capability: PORTAL,
  });
  assert.equal(human.status, 200, JSON.stringify(human.body));
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Heads up <!channel>");
  const second = await seed(w, { ...ITEM, sourceKey: "t2", slack: { channelId: "C1", ts: "9.9" } });
  const agent = await call(w, {
    method: "POST",
    path: `/v1/loops/${second.loop.id}/items/${second.item.id}/action`,
    body: { kind: "send", args: { body: "Heads up <!channel>" } },
  });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Heads up @\u200bchannel");
});

test("a capability caller's edit is stored as the agent's draft, so its mentions stay in the disarm set", async () => {
  const w = world();
  const { loop, item } = await seed(w);
  const edited = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action`,
    body: { kind: "edit", args: { proposal: { body: "Everyone <!here> please look" } } },
  });
  assert.equal(edited.status, 200);
  const stored = (await w.loops.items.get(item.id))!;
  assert.equal(stored.proposal!.by, "agent");
  assert.deepEqual(stored.agentMentionKeys, ["!here"]);
  const sent = await call(w, {
    method: "POST",
    path: `/v1/loops/${loop.id}/items/${item.id}/action?principalId=josh`,
    body: { kind: "send" },
    capability: PORTAL,
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Everyone @\u200bhere please look");
});
