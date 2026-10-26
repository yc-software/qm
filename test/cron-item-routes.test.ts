import assert from "node:assert/strict";
import { test } from "node:test";
import { cronItemRoutes } from "../src/api/routes/cron-items.ts";
import { findRoute, run, type ApiCtx } from "../src/api/routes/route.ts";
import { createInboxLedger, type InboxLedger } from "../src/inbox/ledger.ts";
import { ensureInboxCron, INBOX_SYNC_TASK_VERSION, renderSourceInboxTask } from "../src/inbox/sync-task.ts";
import { createInboxSourceRefresh, type InboxSourceRefresh } from "../src/inbox/source-refresh.ts";
import type { InboxChat } from "../src/inbox/item-chat.ts";
import type { Cron } from "../src/types.ts";
import type { LedgerItemView } from "../src/inbox/view.ts";
import type { SlackUserClient } from "../src/inbox/sources/adapter.ts";
import { sleep } from "../src/util/async.ts";
import { inboxApp } from "./support/inbox-app.ts";

function fakeRes() {
  const out = { status: 0, body: undefined as unknown };
  return {
    res: {
      getHeader() {},
      setHeader() {},
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
  sourceRefresh?: InboxSourceRefresh;
  items: InboxLedger;
  chat?: InboxChat;
  crons: ReturnType<typeof inboxApp>["crons"];
  app: ReturnType<typeof inboxApp>["app"];
  sent: Array<{ host: string; body: unknown }>;
  slackOk: boolean;
  followUps: Array<{ itemId: string; message: string; actorId: string }>;
  tokens: boolean;
}

function world(over: { tokens?: boolean; chat?: boolean } = {}): World {
  const { crons, app } = inboxApp();
  const w: World = {
    items: createInboxLedger(),
    crons,
    app,
    sent: [],
    slackOk: true,
    followUps: [],
    tokens: over.tokens !== false,
  };
  if (over.chat !== false) {
    w.chat = {
      followUp: async (_cron, item, message, actorId) => {
        w.followUps.push({ itemId: item.id, message, actorId });
        await w.items.appendThread(item.id, [{ role: "human", text: message, actorId }]);
        await w.items.appendThread(item.id, [{ role: "agent", text: "shortened it" }]);
        await w.items.setProposal(item.id, { data: { body: "shorter" }, by: "agent" });
        return w.items.get(item.id);
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
    sessionForThread?: string;
    flagEnabled?: (flag: string, scope: string) => Promise<boolean>;
  },
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`http://x${over.path}`);
  const found = findRoute(cronItemRoutes, over.method, url.pathname);
  assert.ok(found, `${over.method} ${over.path} should match a cron item route`);
  const { res, out } = fakeRes();
  const ctx = {
    res,
    url,
    pathname: url.pathname,
    method: over.method,
    body: over.body ?? null,
    params: found.params,
    capability: over.capability === undefined ? CAP : over.capability,
    deps: {
      featureFlags: { enabled: over.flagEnabled ?? (async () => true) },
      inbox: { items: w.items, record: async () => {}, ...(w.chat ? { chat: w.chat } : {}) },
      ...(w.sourceRefresh ? { inboxSourceRefresh: w.sourceRefresh } : {}),
      sessions: {
        getByThread: async (threadRef: string) =>
          over.sessionForThread && threadRef === "thread-9" ? { id: over.sessionForThread } : null,
      },
      inboxSlackClient: slackClientFor(w),
      ...(w.tokens ? { inboxSourceTokens: { connectorAccessToken: async () => "tok" } } : {}),
    },
    app: w.app,
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
  slack: { channelId: "C1", ts: "1.2", isDirectMessage: false },
};

async function inboxCron(w: World, source = "slack"): Promise<Cron> {
  return ensureInboxCron(w.crons, "josh", source);
}

async function plainCron(w: World, inbox: Cron["inbox"], ownerScopeId = "personal:josh"): Promise<Cron> {
  return w.crons.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId,
    schedule: { everyMs: 60 * 60 * 1000 },
    enabled: false,
    title: "Triage",
    action: "triage",
    ...(inbox ? { inbox } : {}),
  });
}

async function seed(
  w: World,
  item: Record<string, unknown> = ITEM,
): Promise<{ w: World; cron: Cron; item: LedgerItemView }> {
  const cron = await inboxCron(w);
  const out = await call(w, { method: "POST", path: `/v1/crons/${cron.id}/items`, body: { items: [item] } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const listed = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items` });
  const items = (listed.body as { items: LedgerItemView[] }).items;
  return { w, cron, item: items[0]! };
}

test("ingest needs an agent capability, not a portal session", async () => {
  const w = world();
  const cron = await inboxCron(w);
  const fromPortal = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items?principalId=josh`,
    body: { items: [ITEM] },
    capability: PORTAL,
  });
  assert.equal(fromPortal.status, 403);
  const ok = await call(w, { method: "POST", path: `/v1/crons/${cron.id}/items`, body: { items: [ITEM] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { created: 1, updated: 0, skipped: 0 });
});

test("a personal inbox's items stay out of a shared-scope capability's reach", async () => {
  const w = world();
  const cron = await inboxCron(w);
  const shared = { ...CAP, privateScope: false, scopeId: "channel:C9" };
  assert.equal(
    (await call(w, { method: "POST", path: `/v1/crons/${cron.id}/items`, body: { items: [ITEM] }, capability: shared }))
      .status,
    403,
  );
  assert.equal((await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items`, capability: shared })).status, 403);
});

test("another person cannot read the ledger at all", async () => {
  const w = world();
  const cron = await inboxCron(w);
  const out = await call(w, {
    method: "GET",
    path: `/v1/crons/${cron.id}/items`,
    capability: { ...CAP, actorId: "ada", scopeId: "personal:ada" },
  });
  assert.equal(out.status, 404);
});

test("ingest stamps the drafting session from the caller's thread", async () => {
  const w = world();
  const cron = await inboxCron(w);
  await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: { items: [ITEM] },
    capability: { ...CAP, threadRef: "thread-9" },
    sessionForThread: "sess-42",
  });
  const [item] = await w.items.byCron(cron.id);
  assert.equal(item?.proposal?.sessionId, "sess-42");
});

test("ingest rejects malformed items with a pointed message", async () => {
  const w = world();
  const cron = await inboxCron(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: { items: [{ ...ITEM, slack: undefined }] },
  });
  assert.equal(out.status, 400);
  assert.match(String((out.body as { message: string }).message), /items\[0\]: slack items need/);
});

test("ingest refuses a source this inbox does not declare", async () => {
  const w = world();
  const cron = await inboxCron(w, "gmail");
  const out = await call(w, { method: "POST", path: `/v1/crons/${cron.id}/items`, body: { items: [ITEM] } });
  assert.equal(out.status, 400);
  assert.match(String((out.body as { message: string }).message), /does not accept "slack"/);
});

test("an inbox with no source adapter ingests an opaque payload", async () => {
  const w = world();
  const cron = await plainCron(w, {});
  const ok = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
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
  const [item] = await w.items.byCron(cron.id);
  assert.deepEqual(item?.sourcePayload, { issue: "SENTRY-42", culprit: "checkout.ts", events: 12 });
  assert.deepEqual(item?.proposal?.data, { plan: "guard the null" });
  assert.equal(item?.status, "ready");
});

test("an opaque item needs a dedupe key and an object payload", async () => {
  const w = world();
  const cron = await plainCron(w, {});
  const noKey = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: { items: [{ sourcePayload: {} }] },
  });
  assert.equal(noKey.status, 400);
  const huge = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: { items: [{ dedupeKey: "k", sourcePayload: { blob: "x".repeat(70_000) } }] },
  });
  assert.equal(huge.status, 400);
  assert.match(String((huge.body as { message: string }).message), /sourcePayload must be under/);
  const unknownSource = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: { items: [{ source: "front", dedupeKey: "k", sourcePayload: {} }] },
  });
  assert.equal(unknownSource.status, 400);
});

test("listing returns the ledger view with per-state counts and filters", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const listed = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items` });
  const body = listed.body as { items: LedgerItemView[]; counts: Record<string, number> };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]!.state, "held");
  assert.equal(body.items[0]!.dedupeKey, "C1:1.2");
  assert.deepEqual(body.items[0]!.sourcePayload.slack, { channelId: "C1", ts: "1.2", isDirectMessage: false });
  assert.deepEqual(body.counts, { held: 1 });
  const heldOnly = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items?state=held` });
  assert.equal((heldOnly.body as { items: unknown[] }).items.length, 1);
  const pendingOnly = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items?state=pending` });
  assert.equal((pendingOnly.body as { items: unknown[] }).items.length, 0);
  const junk = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items?state=nonsense` });
  assert.equal(junk.status, 400);
  const one = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items/${item.id}` });
  assert.equal((one.body as { item: LedgerItemView }).item.id, item.id);
  const missing = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items/nope` });
  assert.equal(missing.status, 404);
});

test("edit replaces the proposal and marks it the person's own", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action?principalId=josh`,
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
  const { cron, item } = await seed(w);
  const sent = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
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
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(again.status, 409);
  assert.equal(w.sent.length, 1, "a resend never reaches the source");
});

test("send takes a final edit in the same call and a refusal leaves the item held", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  w.slackOk = false;
  const blocked = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: { body: "Final words." } } },
  });
  assert.equal(blocked.status, 502);
  const stored = await w.items.get(item.id);
  assert.equal(stored?.status, "ready", "a refused send leaves the item held");
  assert.deepEqual(stored?.proposal?.data, { body: "Final words." }, "the edit still persisted");
  w.slackOk = true;
  const ok = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(ok.status, 200);
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Final words.");
});

test("dismiss, reopen and the actioned end-state", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const dismissed = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "dismiss" },
  });
  assert.equal((dismissed.body as { item: LedgerItemView }).item.state, "dismissed");
  const reopened = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "reopen" },
  });
  assert.equal((reopened.body as { item: LedgerItemView }).item.state, "held");
  await w.items.recordAction(item.id, { kind: "send", outcome: "actioned" });
  const again = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(again.status, 409);
});

test("react adds the emoji, records it on the item, and leaves the item held", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
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
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "react", args: { name: "tada" } },
  });
  assert.deepEqual((again.body as { item: LedgerItemView }).item.sourcePayload.reactions, ["eyes", "tada"]);
});

test("a reaction slack refuses leaves the item untouched", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  w.slackOk = false;
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "react", args: { name: "eyes" } },
  });
  assert.equal(out.status, 502);
  const stored = await w.items.get(item.id);
  assert.equal(stored?.status, "ready");
  assert.equal(stored?.sourcePayload?.reactions, undefined);
});

test("an action kind the source does not know is refused", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "escalate", args: { to: "ada" } },
  });
  assert.equal(out.status, 400);
  assert.equal((await w.items.get(item.id))?.status, "ready");
  assert.deepEqual(w.sent, []);
});

test("a deployment without connectors answers 404 rather than pretending to send", async () => {
  const w = world({ tokens: false });
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(out.status, 404);
});

test("an action with no kind is refused", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { args: {} },
  });
  assert.equal(out.status, 400);
});

test("follow-up runs an agent turn scoped to the item and lands on its thread", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/followup`,
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

test("follow-up needs a message and a wired chat service", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const empty = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/followup`,
    body: { message: "   " },
  });
  assert.equal(empty.status, 400);
  const long = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/followup`,
    body: { message: "x".repeat(4_001) },
  });
  assert.equal(long.status, 400);
  const unwired = world({ chat: false });
  const seeded = await seed(unwired);
  const out = await call(unwired, {
    method: "POST",
    path: `/v1/crons/${seeded.cron.id}/items/${seeded.item.id}/followup`,
    body: { message: "hi" },
  });
  assert.equal(out.status, 404);
});

test("sync-cron is created once, refreshes stale task text, and disables on request", async () => {
  const w = world();
  const created = await call(w, { method: "POST", path: "/v1/inbox/sync-cron", body: {} });
  assert.equal(created.status, 200);
  const syncCron = (created.body as { syncCron: { id: string } }).syncCron;
  const stored = (await w.crons.get(syncCron.id))!;
  assert.equal(stored.ownerScopeId, "personal:josh");
  assert.equal(stored.owner, "josh");
  assert.equal((stored.destination as { target: string }).target, "josh");
  assert.deepEqual(stored.inbox, { source: "gmail" });
  const current = renderSourceInboxTask("gmail");
  assert.equal(stored.action, current);
  await w.crons.update(syncCron.id, {
    action: current.replace(
      `Inbox sync v${INBOX_SYNC_TASK_VERSION}.`,
      `Inbox sync v${INBOX_SYNC_TASK_VERSION}. Older wording.`,
    ),
  });
  await w.crons.setEnabled(syncCron.id, false);
  const refreshed = await call(w, { method: "POST", path: "/v1/inbox/sync-cron", body: {} });
  const after = (refreshed.body as { syncCron: { id: string; enabled: boolean } }).syncCron;
  assert.equal(after.id, syncCron.id);
  assert.equal((await w.crons.get(syncCron.id))!.action, current);
  assert.equal(after.enabled, true);
  assert.equal((await w.crons.list()).length, 2);
  const disabled = await call(w, { method: "POST", path: "/v1/inbox/sync-cron", body: { enabled: false } });
  assert.equal((disabled.body as { syncCron: { enabled: boolean } }).syncCron.enabled, false);
});

test("a send carrying the draft it saw is refused when the agent redrafted in between", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const seenAt = (await w.items.get(item.id))!.proposal!.at;
  await sleep(2);
  await w.items.setProposal(item.id, { data: { body: "newer agent draft" }, by: "agent" });
  const stale = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: { body: "what I saw" }, expectedProposalAt: seenAt } },
  });
  assert.equal(stale.status, 409);
  assert.equal((stale.body as { error: string }).error, "draft_changed");
  assert.equal(w.sent.length, 0, "nothing reached Slack");
  const fresh = (await w.items.get(item.id))!.proposal!;
  assert.equal(fresh.by, "agent", "the stale edit did not overwrite the newer draft");
  const ok = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: { body: "newer agent draft" }, expectedProposalAt: fresh.at } },
  });
  assert.equal(ok.status, 200);
});

test("sending the agent's draft unchanged keeps it attributed to the agent", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const held = (await w.items.get(item.id))!;
  const sent = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: held.proposal!.data, expectedProposalAt: held.proposal!.at } },
  });
  assert.equal(sent.status, 200);
  assert.equal((await w.items.get(item.id))!.proposal!.by, "agent");
});

test("an edit carrying the draft it was based on is refused when the agent redrafted in between", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const basedOn = (await w.items.get(item.id))!.proposal!.at;
  await sleep(2);
  await w.items.setProposal(item.id, { data: { body: "newer agent draft" }, by: "agent" });
  const stale = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "edit", args: { proposal: { body: "typed over the old one" }, expectedProposalAt: basedOn } },
  });
  assert.equal(stale.status, 409);
  assert.equal((stale.body as { error: string }).error, "draft_changed");
  assert.deepEqual((await w.items.get(item.id))!.proposal!.data, { body: "newer agent draft" });
});

test("a person's own typed mention stays live, while a capability caller's is disarmed", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const human = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action?principalId=josh`,
    body: { kind: "send", args: { proposal: { body: "Heads up <!channel>" } } },
    capability: PORTAL,
  });
  assert.equal(human.status, 200, JSON.stringify(human.body));
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Heads up <!channel>");
  const second = await seed(w, {
    ...ITEM,
    sourceKey: "t2",
    slack: { channelId: "C1", ts: "9.9", isDirectMessage: false },
  });
  const agent = await call(w, {
    method: "POST",
    path: `/v1/crons/${second.cron.id}/items/${second.item.id}/action`,
    body: { kind: "send", args: { body: "Heads up <!channel>" } },
  });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Heads up @\u200bchannel");
});

test("a capability caller's edit is stored as the agent's draft, so its mentions stay in the disarm set", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const edited = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "edit", args: { proposal: { body: "Everyone <!here> please look" } } },
  });
  assert.equal(edited.status, 200);
  const stored = (await w.items.get(item.id))!;
  assert.equal(stored.proposal!.by, "agent");
  assert.deepEqual(stored.agentMentionKeys, ["!here"]);
  const sent = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action?principalId=josh`,
    body: { kind: "send" },
    capability: PORTAL,
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Everyone @\u200bhere please look");
});

test("concurrent source sends share a durable decision claim", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const send = () =>
    call(w, { method: "POST", path: `/v1/crons/${cron.id}/items/${item.id}/action`, body: { kind: "send" } });
  const outcomes = await Promise.all([send(), send()]);
  assert.deepEqual(outcomes.map((out) => out.status).sort(), [200, 409]);
  assert.equal(w.sent.length, 1);
  assert.equal((await w.items.get(item.id))!.decisionToken, undefined);
});

test("a conversational send refuses a stale draft before starting an agent turn", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/followup`,
    body: { message: "Send it", expectedProposalAt: item.proposal!.at - 1 },
  });
  assert.equal(out.status, 409);
  assert.equal((out.body as { error: string }).error, "draft_changed");
  assert.deepEqual(w.followUps, []);
  assert.deepEqual(w.sent, []);
  const accepted = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/followup`,
    body: { message: "Send it", expectedProposalAt: item.proposal!.at },
  });
  assert.equal(accepted.status, 200);
  assert.equal(w.followUps.length, 1);
});

test("inbox list refreshes open Gmail items before returning, but not another owner's inbox", async () => {
  const w = world();
  const cron = await inboxCron(w, "gmail");
  const refreshes: string[] = [];
  const queued: unknown[] = [];
  w.sourceRefresh = createInboxSourceRefresh({
    featureFlags: { enabled: async () => true },
    items: w.items,
    record: async (_item, event) => {
      queued.push(event);
    },
    tokens: { connectorAccessToken: async () => "synthetic" },
    directory: { getBySlackId: async () => null },
    fetchImpl: async (url) => {
      refreshes.push(String(url));
      return Response.json({ messages: [{ internalDate: "2000", labelIds: ["SENT"], snippet: "Already replied" }] });
    },
  });
  await w.items.ingest([
    {
      cronId: cron.id,
      dedupeKey: "gmail",
      source: "gmail",
      sourceAt: 1000,
      sourcePayload: { gmail: { threadId: "thread" } },
      proposal: { by: "agent", data: { body: "Draft" } },
    },
  ]);
  const denied = await call(w, {
    method: "GET",
    path: `/v1/crons/${cron.id}/items?principalId=outsider`,
    capability: null,
  });
  assert.equal(denied.status, 404);
  assert.equal(refreshes.length, 0);
  const result = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items` });
  assert.equal(result.status, 200);
  assert.deepEqual(queued, [{ author: "owner", at: 2000, text: "Already replied" }]);
  assert.equal(refreshes.length, 1);
});

test("Slack thread keys reuse a legacy item's identity and edits", async () => {
  const w = world();
  const cron = await inboxCron(w);
  await w.items.ingest([
    {
      cronId: cron.id,
      dedupeKey: "D1",
      source: "slack",
      sourceAt: 2000,
      sourcePayload: { slack: { channelId: "D1", ts: "1.0", threadTs: "1.0" } },
      proposal: { by: "human", data: { body: "Keep this edit" } },
    },
  ]);
  const [original] = await w.items.byCron(cron.id);
  const ingest = () =>
    call(w, {
      method: "POST",
      path: `/v1/crons/${cron.id}/items`,
      body: {
        items: [
          {
            ...ITEM,
            sourceKey: "D1:1.0",
            receivedAt: 2000,
            slack: { channelId: "D1", ts: "2.0", threadTs: "1.0", isDirectMessage: true },
            draft: { body: "Agent replacement" },
          },
        ],
      },
    });
  assert.equal((await ingest()).status, 200);
  assert.equal((await w.items.byCron(cron.id)).length, 1);
  assert.equal((await w.items.get(original!.id))!.proposal!.data.body, "Keep this edit");
});

test("ordinary item reads only hydrate Slack with the refresh flag", async () => {
  const w = world();
  const cron = await inboxCron(w);
  await w.items.ingest([{ cronId: cron.id, dedupeKey: "slack", source: "slack", sourcePayload: {} }]);
  const [item] = await w.items.byCron(cron.id);
  let refreshes = 0;
  w.sourceRefresh = async () => {
    refreshes++;
  };
  await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items/${item!.id}` });
  assert.equal(refreshes, 0);
  await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items/${item!.id}?refreshSource=1` });
  assert.equal(refreshes, 1);
});

test("a new Slack thread cannot overwrite an unrelated unthreaded DM card", async () => {
  const w = world();
  const cron = await inboxCron(w);
  await w.items.ingest([
    {
      cronId: cron.id,
      dedupeKey: "D1",
      source: "slack",
      sourceAt: 2000,
      sourcePayload: { slack: { channelId: "D1", ts: "2.0", isDirectMessage: true } },
      proposal: { by: "human", data: { body: "Keep this edit" } },
    },
  ]);
  const [original] = await w.items.byCron(cron.id);
  const result = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: {
      items: [
        {
          ...ITEM,
          sourceKey: "D1:1.0",
          receivedAt: 3000,
          slack: { channelId: "D1", ts: "3.0", threadTs: "1.0", isDirectMessage: true },
          draft: { body: "Other ask" },
        },
      ],
    },
  });
  assert.equal(result.status, 200);
  assert.equal((await w.items.byCron(cron.id)).length, 2);
  assert.equal((await w.items.get(original!.id))!.proposal!.data.body, "Keep this edit");
});

test("followup accepts only typed runtime and staged attachment fields", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const path = `/v1/crons/${cron.id}/items/${item.id}/followup`;
  let received: unknown;
  w.chat!.followUp = async (_cron, held, _message, _actor, options) => {
    received = options;
    return held;
  };
  const options = {
    model: "gpt-5.6-terra",
    harness: "pi",
    thinkingLevel: "high",
    fastMode: true,
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 20, blobId: "opaque-upload" }],
  };
  const out = await call(w, {
    method: "POST",
    path,
    body: {
      message: "",
      ...options,
      model: ` ${options.model} `,
      harness: " pi ",
      thinkingLevel: " high ",
      attachments: [{ ...options.attachments[0], path: "/ignored" }],
      scopeId: "personal:other",
    },
  });
  assert.equal(out.status, 200);
  assert.deepEqual(received, options);
  for (const invalid of [
    { model: 5 },
    { model: " " },
    { harness: " " },
    { thinkingLevel: " " },
    { fastMode: null },
    { attachments: null },
    { attachments: [null] },
    { attachments: [{ ...options.attachments[0], name: "" }] },
    { attachments: [{ ...options.attachments[0], blobId: "" }] },
    { attachments: [{ ...options.attachments[0], sizeBytes: 1.5 }] },
    { attachments: [{ ...options.attachments[0], sizeBytes: 1_000_000_001 }] },
    { harness: "unknown" },
    { thinkingLevel: "unsupported" },
    { fastMode: "true" },
    { attachments: [{ path: "/etc/passwd" }] },
    { attachments: [{ ...options.attachments[0], sizeBytes: -1 }] },
    { attachments: Array(11).fill(options.attachments[0]) },
  ]) {
    received = undefined;
    const bad = await call(w, { method: "POST", path, body: { message: "hello", ...invalid } });
    assert.equal(bad.status, 400, JSON.stringify(invalid));
    assert.equal(received, undefined);
  }
});

test("email classification is scoped to the owner's flagged personal inbox", async () => {
  for (const inboxSource of [undefined, "gmail", "slack"]) {
    for (const enabled of [false, true]) {
      for (const source of ["gmail", "slack"]) {
        if (inboxSource && inboxSource !== source) continue;
        const w = world();
        const cron = await plainCron(w, inboxSource ? { source: inboxSource } : {});
        const classified = enabled && source === "gmail" && inboxSource === "gmail";
        const flagEnabled = async (flag: string, scope: string) => {
          assert.equal(flag, "inbox_loops");
          assert.equal(scope, "personal:josh");
          return enabled;
        };
        for (const automated of [true, false]) {
          const receivedAt = automated ? 1234 : 2345;
          const item =
            source === "slack"
              ? ITEM
              : {
                  ...ITEM,
                  source: "gmail",
                  sourceKey: "thread-1",
                  gmail: { threadId: "thread-1" },
                };
          const response = await call(w, {
            method: "POST",
            path: `/v1/crons/${cron.id}/items`,
            flagEnabled,
            body: { items: [{ ...item, receivedAt, automated, probablyResolved: false }] },
          });
          assert.equal(response.status, 200);
          const [stored] = await w.items.byCron(cron.id);
          assert.equal(stored!.sourcePayload!.automated, classified ? automated : undefined);
          assert.equal(stored!.sourcePayload!.probablyResolved, classified ? false : undefined);
          assert.equal(stored!.status, "ready");
          assert.equal(stored!.proposal!.data.body, ITEM.draft.body);
          const [summary] = await w.items.summaries([cron.id]);
          assert.equal(summary!.inboxPreview!.automated, undefined);
        }
      }
    }
  }
});

test("a company inbox cannot opt into personal inbox classification", async () => {
  const w = world();
  const cron = await plainCron(w, { source: "gmail" }, "company:org");
  const response = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    flagEnabled: async () => {
      assert.fail("company inbox must not read a personal flag");
    },
    body: {
      items: [
        {
          ...ITEM,
          source: "gmail",
          sourceKey: "mail",
          gmail: { threadId: "mail" },
          automated: true,
          probablyResolved: false,
        },
      ],
    },
  });
  assert.equal(response.status, 200);
  const [item] = await w.items.byCron(cron.id);
  assert.equal(item!.sourcePayload!.automated, undefined);
  assert.equal(item!.sourcePayload!.probablyResolved, undefined);
});

test("an owner cannot trigger Slack avatar enrichment through item detail when Inbox is disabled", async () => {
  const w = world();
  const cron = await inboxCron(w);
  await w.items.ingest([
    {
      cronId: cron.id,
      dedupeKey: "D1",
      source: "slack",
      sourceAt: 1000,
      sourcePayload: { slack: { channelId: "D1", ts: "1.0", userId: "U1" } },
    },
  ]);
  const [item] = await w.items.byCron(cron.id);
  const before = structuredClone(item);
  const enabled = async (flag: string, scope: string) => {
    assert.equal(flag, "inbox_loops");
    assert.equal(scope, "personal:josh");
    return false;
  };
  w.sourceRefresh = createInboxSourceRefresh({
    items: w.items,
    record: async () => undefined,
    featureFlags: { enabled },
    tokens: { connectorAccessToken: async () => assert.fail("disabled Inbox must not read credentials") },
    directory: { getBySlackId: async () => assert.fail("disabled Inbox must not read the directory") },
    fetchImpl: async () => assert.fail("disabled Inbox must not call Slack"),
  });
  const result = await call(w, {
    method: "GET",
    path: `/v1/crons/${cron.id}/items/${item!.id}?refreshSource=1`,
    flagEnabled: enabled,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await w.items.get(item!.id), before);
});
