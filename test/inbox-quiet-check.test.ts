import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxQuietCheck } from "../src/loops/inbox-quiet-check.ts";
import type { Loop, LoopItem } from "../src/loops/types.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const LAST_SCAN = NOW - 15 * 60 * 1000;
const slackTs = (ms: number) => (ms / 1000).toFixed(6);

function loop(source: string, over: Partial<Loop> = {}): Loop {
  return {
    id: "l1",
    owner: "owner@example.com",
    surface: `inbox:${source}`,
    sources: [source],
    lastScanAt: LAST_SCAN,
    ...over,
  } as Loop;
}

function item(source: "slack" | "gmail", meta: Record<string, unknown>, over: Partial<LoopItem> = {}): LoopItem {
  return {
    id: `i-${JSON.stringify(meta)}`,
    loopId: "l1",
    sourceKey: "k",
    source,
    sourceSummary: "needs a reply",
    sourcePayload: { title: "t", snippet: "s", [source]: meta },
    proposal: { data: { body: "draft" }, by: "agent", at: 1 },
    status: "ready",
    attempts: 0,
    runIds: [],
    outputIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as LoopItem;
}

type Route = (params: URLSearchParams) => unknown;

function slackError(error: string) {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error },
  });
}

function harness(routes: Record<string, Route>, tokens: Record<string, string> = { personal: "tok" }) {
  const calls: string[] = [];
  const route = (key: string) => Object.entries(routes).find(([prefix]) => key.startsWith(prefix))?.[1];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    const key = url.pathname.split("/me/")[1]!;
    calls.push(key);
    const body = route(key)?.(url.searchParams);
    if (body === undefined) return new Response("{}", { status: 404 });
    return body instanceof Response ? body : Response.json(body);
  }) as typeof fetch;
  const slackClient = () => ({
    apiCall: async (method: string, params?: Record<string, unknown>) => {
      calls.push(method);
      const handler = route(method);
      if (!handler) throw slackError("unknown_method");
      const body = handler(new URLSearchParams(params as Record<string, string>)) as { ok?: boolean; error?: string };
      if (body.ok === false) throw slackError(body.error ?? "not ok");
      return body as never;
    },
  });
  const check = createInboxQuietCheck({
    tokens: { connectorAccessToken: async (_host, _owner, type) => tokens[type ?? "default"] ?? null },
    fetchImpl,
    slackClient,
  });
  return { check, calls };
}

function search(matches: Record<string, unknown[]>): Route {
  return (params) => {
    const query = params.get("query") ?? "";
    const key = Object.keys(matches).find((prefix) => query.startsWith(prefix));
    const found = key ? matches[key]! : [];
    return { ok: true, messages: { matches: found, paging: { pages: 1 } } };
  };
}

const slackBase = {
  "auth.test": () => ({ ok: true, user_id: "UME", team_id: "T1" }),
  "users.info": (params: URLSearchParams) => ({
    ok: true,
    user: { id: params.get("user"), is_bot: params.get("user") === "UBOT" },
  }),
};

const old = { ts: slackTs(LAST_SCAN - 60 * 60 * 1000), user: "UPAL", channel: { id: "D1" } };

test("a quiet Slack inbox skips the sync turn", async () => {
  const { check } = harness({
    ...slackBase,
    "search.messages": search({ "with:me": [old], "from:me": [old] }),
    "conversations.replies": () => ({ ok: true, messages: [{ ts: "1.000000" }] }),
  });
  const tracked = item("slack", { channelId: "C1", ts: "1.000000" });
  assert.deepEqual(await check(loop("slack"), [tracked]), { quiet: true });
});

test("a new Slack DM from a person runs the sync turn", async () => {
  const fresh = { ts: slackTs(NOW - 60_000), user: "UPAL", channel: { id: "D9" } };
  const { check } = harness({ ...slackBase, "search.messages": search({ "with:me": [fresh, old] }) });
  assert.deepEqual(await check(loop("slack"), []), { quiet: false, reason: "new Slack message for the user" });
});

test("a new bot DM alone stays quiet, but not in a conversation the ledger tracks", async () => {
  const bot = { ts: slackTs(NOW - 60_000), user: "UBOT", channel: { id: "D9" } };
  const { check } = harness({ ...slackBase, "search.messages": search({ "with:me": [bot] }) });
  assert.deepEqual(await check(loop("slack"), []), { quiet: true });
  const tracked = item("slack", { channelId: "D9", ts: "1.000000", isDirectMessage: true });
  assert.equal((await check(loop("slack"), [tracked])).quiet, false);
});

test("a new @mention runs the sync turn", async () => {
  const mention = { ts: slackTs(NOW - 60_000), user: "UPAL", channel: { id: "C7" } };
  const { check } = harness({ ...slackBase, "search.messages": search({ "<@UME>": [mention] }) });
  assert.equal((await check(loop("slack"), [])).quiet, false);
});

test("the user's own reply in a tracked DM runs the sync turn", async () => {
  const mine = { ts: slackTs(NOW - 60_000), user: "UME", channel: { id: "D1" } };
  const { check } = harness({ ...slackBase, "search.messages": search({ "from:me": [mine] }) });
  const tracked = item("slack", { channelId: "D1", ts: "1.000000", isDirectMessage: true });
  assert.deepEqual(await check(loop("slack"), [tracked]), {
    quiet: false,
    reason: "the user replied in a tracked Slack conversation",
  });
});

test("a new reply in a tracked Slack thread runs the sync turn; unreadable threads do not", async () => {
  const replies = new Map([
    ["C1", { ok: true, messages: [{ ts: "1.000000" }, { ts: slackTs(NOW - 1000) }] }],
    ["C2", { ok: false, error: "channel_not_found" }],
  ]);
  const { check } = harness({
    ...slackBase,
    "search.messages": search({}),
    "conversations.replies": (params) => replies.get(params.get("channel")!),
  });
  const gone = item("slack", { channelId: "C2", ts: "1.000000" });
  assert.deepEqual(await check(loop("slack"), [gone]), { quiet: true });
  const live = item("slack", { channelId: "C1", ts: "1.000000" });
  assert.deepEqual(await check(loop("slack"), [gone, live]), {
    quiet: false,
    reason: "new reply in a tracked Slack thread",
  });
});

test("a Slack connector error runs the sync turn", async () => {
  const revoked = harness({ "auth.test": () => ({ ok: false, error: "token_revoked" }) });
  assert.deepEqual(await revoked.check(loop("slack"), []), {
    quiet: false,
    reason: "pre-check failed: An API error occurred: token_revoked",
  });
  const limited = harness({
    ...slackBase,
    "search.messages": search({}),
    "conversations.replies": () => {
      throw Object.assign(new Error("A rate-limit has been reached"), { code: "slack_webapi_rate_limited_error" });
    },
  });
  assert.equal((await limited.check(loop("slack"), [item("slack", { channelId: "C1", ts: "1.0" })])).quiet, false);
});

test("a full page of new Slack matches runs the sync turn", async () => {
  const bots = Array.from({ length: 100 }, (_, i) => ({
    ts: slackTs(NOW - 1000 - i),
    user: "UBOT",
    channel: { id: "D9" },
  }));
  const { check } = harness({ ...slackBase, "search.messages": search({ "with:me": bots }) });
  assert.deepEqual(await check(loop("slack"), []), {
    quiet: false,
    reason: "more than 100 Slack messages since the last pass",
  });
});

function gmail(recent: Array<{ threadId: string }>, addressed: Array<{ threadId: string }> = []) {
  const queries: string[] = [];
  const routes: Record<string, Route> = {
    "settings/sendAs": () => ({ sendAs: [{ sendAsEmail: "user@example.com" }, { sendAsEmail: "alias@example.org" }] }),
    messages: (params) => {
      const q = params.get("q") ?? "";
      queries.push(q);
      return { messages: q.startsWith("in:inbox") ? addressed : recent };
    },
  };
  return { routes, queries };
}

test("a quiet Gmail inbox skips the sync turn", async () => {
  const { routes, queries } = gmail([{ threadId: "other" }]);
  const { check } = harness(routes);
  assert.deepEqual(await check(loop("gmail"), [item("gmail", { threadId: "t1" })]), { quiet: true });
  const after = `after:${Math.floor((LAST_SCAN - 5 * 60 * 1000) / 1000)} -in:drafts`;
  assert.deepEqual(queries, [
    after,
    `in:inbox -from:me {to:me cc:me to:user@example.com cc:user@example.com to:alias@example.org cc:alias@example.org} ${after}`,
  ]);
});

test("new inbound Gmail mail addressed to the user runs the sync turn", async () => {
  const { routes } = gmail([{ threadId: "x4" }], [{ threadId: "x4" }]);
  const { check } = harness(routes);
  assert.deepEqual(await check(loop("gmail"), []), {
    quiet: false,
    reason: "new inbound Gmail message addressed to the user",
  });
});

test("any new message on a tracked Gmail thread runs the sync turn", async () => {
  const { routes } = gmail([{ threadId: "t1" }]);
  const { check } = harness(routes);
  assert.deepEqual(await check(loop("gmail"), [item("gmail", { threadId: "t1" })]), {
    quiet: false,
    reason: "new message on a tracked Gmail thread",
  });
});

test("a Gmail connector error or overflow runs the sync turn", async () => {
  const failing = harness({ messages: () => new Response("nope", { status: 401 }) });
  assert.match(JSON.stringify(await failing.check(loop("gmail"), [])), /pre-check failed: Gmail messages returned 401/);
  const overflow = harness({ messages: () => ({ messages: [], nextPageToken: "more" }) });
  assert.match(JSON.stringify(await overflow.check(loop("gmail"), [])), /more than 500 Gmail messages/);
});

test("unsupported loops, first passes, open repairs and missing connections run the sync turn", async () => {
  const { check, calls } = harness({}, {});
  const reasons = [
    await check(loop("linear"), []),
    await check({ id: "l2", owner: "owner@example.com", sources: ["sentry"], lastScanAt: LAST_SCAN } as Loop, []),
    await check(loop("slack", { lastScanAt: undefined }), []),
    await check(loop("slack"), [item("slack", { channelId: "C1", ts: "1.0" }, { proposal: undefined })]),
    await check(loop("slack"), []),
    await check(loop("gmail"), []),
  ].map((verdict) => (verdict.quiet ? "quiet" : verdict.reason));
  assert.deepEqual(reasons, [
    "unsupported inbox source linear",
    "unsupported inbox source none",
    "no previous clean pass",
    "an open item needs repair",
    "Slack not connected",
    "Gmail not connected",
  ]);
  assert.deepEqual(calls, []);
});

test("resolved items are not re-read and each connected account is checked once", async () => {
  const { check, calls } = harness(
    {
      ...slackBase,
      "search.messages": search({}),
    },
    { personal: "tok", default: "tok", company: "tok2" },
  );
  const resolved = item("slack", { channelId: "C1", ts: "1.0" }, { status: "skipped", proposal: undefined });
  assert.deepEqual(await check(loop("slack"), [resolved]), { quiet: true });
  assert.equal(calls.filter((call) => call === "auth.test").length, 2);
  assert.ok(!calls.includes("conversations.replies"));
});
