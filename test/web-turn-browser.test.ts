import "./support/auto-fake-sprites.ts";
import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import type { App } from "../src/api/app-types.ts";
import { ensureDefaultInboxLoops } from "../src/loops/inbox-loop.ts";
import type { RunSignal } from "../src/runs/run-signal-store.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp, stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

const config = testConfig({ signingSecret: "web-turn-browser-signing-secret-0123456" });
const built = stopAtEnd(buildApp(config));

const turns: TurnRequest[] = [];
const signals: Array<{ runId: string; signal: RunSignal & { tree?: boolean }; viewer?: string }> = [];

const stored: TurnRequest = {
  surface: "web",
  actor: { externalId: "alice" },
  conversation: { kind: "dm", threadRef: "web:alice:default" },
  text: "run the flagged command",
  clientSurface: "desktop",
  attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 4, blobId: "blob-original" }],
  idempotencyKey: "web:alice:original-send",
};
const swarm = { ...stored, surface: "swarm", conversation: { kind: "dm" as const, threadRef: "swarm:root:worker" } };
const child = { ...stored, conversation: { kind: "dm" as const, threadRef: "agent:main:subagent:c1" } };
const inbox = (threadRef: string, kind: "dm" | "channel" = "dm"): TurnRequest => ({
  ...stored,
  conversation: kind === "dm" ? { kind, threadRef } : { kind, threadRef, channelRef: "C1" },
  conversationHeader: "Stored inbox snapshot",
});

const approvals: Record<string, { sessionId: string; request: TurnRequest }> = {
  "a-1": { sessionId: "s-1", request: stored },
  "a-theirs": { sessionId: "s-2", request: { ...stored, actor: { externalId: "bob" } } },
  "a-slack": { sessionId: "s-3", request: { ...stored, conversation: { kind: "dm", threadRef: "dm:D1" } } },
  "a-swarm": { sessionId: "worker", request: swarm },
  "a-swarm-hidden": { sessionId: "hidden", request: swarm },
  "a-swarm-mismatch": { sessionId: "mismatch", request: swarm },
  "a-swarm-wrong-surface": { sessionId: "wrong-surface", request: swarm },
  "a-sub": { sessionId: "child", request: child },
  "a-sub-hidden": { sessionId: "hidden", request: child },
  "a-sub-mismatch": { sessionId: "child-mismatch", request: child },
  "a-inbox": { sessionId: "inbox", request: inbox("web:alice:inbox") },
  "a-inbox-other": { sessionId: "inbox", request: inbox("web:bob:inbox") },
  "a-inbox-channel": { sessionId: "inbox", request: inbox("web:alice:inbox", "channel") },
};
const sessions: Record<string, { surface: string; threadRef: string }> = {
  worker: { surface: "swarm", threadRef: "swarm:root:worker" },
  mismatch: { surface: "swarm", threadRef: "swarm:other:worker" },
  "wrong-surface": { surface: "web", threadRef: "swarm:root:worker" },
  child: { surface: "web", threadRef: "agent:main:subagent:c1" },
  "child-mismatch": { surface: "web", threadRef: "agent:main:subagent:other" },
};

const app = {
  ...built.app,
  turn: async (request: TurnRequest) => {
    turns.push(request);
    return { status: "queued", runId: `run-${turns.length}` };
  },
  signalRun: async (runId: string, signal: RunSignal & { tree?: boolean }, viewer?: string) => {
    signals.push({ runId, signal, viewer });
    return { accepted: true };
  },
  getApproval: async (requestId: string, viewer?: string) => {
    const record = viewer === "alice" ? approvals[requestId] : undefined;
    return record ? { requestId, command: "git push", ...record } : null;
  },
  getSessionForViewer: async (sessionId: string, viewer: string) => {
    const session = viewer === "alice" ? sessions[sessionId] : undefined;
    return session ? { session: { id: sessionId, ...session } } : null;
  },
} as unknown as App;

const portalSession: NonNullable<ServerDeps["portalSession"]> = { ...browserSessionDeps.portalSession };
const admin = {
  adminStatusOf: async (_tenant: unknown, { id }: { id: string }) => ({ isAdmin: id.startsWith("admin-") }),
};

async function serve(deps: Partial<ServerDeps> = {}, t?: TestContext): Promise<string> {
  const server = createServer(app, {
    ...serverDeps(config, built),
    ...browserSessionDeps,
    portalSession,
    admin,
    ...deps,
  } as ServerDeps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  if (t) t.after(close);
  else after(close);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const base = await serve();

interface As {
  user?: string;
  headers?: Record<string, string>;
  cookie?: string;
  at?: string;
}

function post(path: string, body: unknown, { user = "alice", headers = {}, cookie, at = base }: As = {}) {
  return fetch(`${at}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: browserSessionDeps.portalUrl,
      cookie: cookie ?? browserSessionCookie(user),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function sentTurn(body: Record<string, unknown>, user = "alice"): Promise<TurnRequest> {
  const count = turns.length;
  const response = await post("/api/turn", { text: "hello", threadRef: `web:${user}:t1`, ...body }, { user });
  assert.equal(response.status, 202, await response.text());
  assert.equal(turns.length, count + 1);
  return turns.at(-1)!;
}

async function refused(path: string, body: unknown, status: number, user = "alice"): Promise<string | undefined> {
  const turnCount = turns.length;
  const signalCount = signals.length;
  const response = await post(path, body, { user });
  assert.equal(response.status, status, `${path} ${JSON.stringify(body)}`);
  assert.equal(turns.length, turnCount, `${path} reached app.turn`);
  assert.equal(signals.length, signalCount, `${path} reached signalRun`);
  return ((await response.json()) as { error?: string }).error;
}

async function withInbox(enabled: readonly string[], run: () => Promise<void>): Promise<void> {
  const flag = (user: string, on: boolean) =>
    built.featureFlags.setEnabled("inbox_loops", scopeId("personal", user), on, "test");
  for (const user of enabled) await flag(user, true);
  try {
    await run();
  } finally {
    for (const user of enabled) await flag(user, false);
  }
}

async function seedInbox(user: string, count: number, snippet = "Please review by Friday."): Promise<void> {
  const [loop] = await ensureDefaultInboxLoops(built.loops.store, user);
  await built.loops.items.ingest(
    Array.from({ length: count }, (_, n) => ({
      loopId: loop!.id,
      dedupeKey: `${user}-${n}`,
      sourcePayload: { from: "Taylor", title: `Review the proposal ${n}`, snippet },
      proposal: { data: {}, by: "agent" as const },
    })),
  );
}

test("the server writes who sent a turn and where it goes; the browser's own claims never reach the agent", async () => {
  const cookie = browserSessionCookie("alice", { name: "Alice Example" });
  const response = await post(
    "/api/turn",
    {
      text: "hello there",
      threadRef: "web:alice:claims",
      surface: "slack",
      actor: { externalId: "mallory" },
      conversation: { kind: "channel", channelRef: "C9", threadRef: "web:alice:claims" },
      deliveryTarget: "dm:D9",
      origin: { kind: "cron" },
      conversationHeader: "injected",
    },
    { cookie },
  );
  assert.equal(response.status, 202);
  assert.equal(((await response.json()) as { runId?: string }).runId, `run-${turns.length}`);
  const turn = turns.at(-1)!;
  assert.equal(turn.surface, "web");
  assert.deepEqual(turn.actor, { externalId: "alice", displayName: "Alice Example" });
  assert.deepEqual(turn.conversation, { kind: "dm", threadRef: "web:alice:claims" });
  assert.equal(turn.deliveryTarget, "web:alice:claims");
  assert.deepEqual(turn.origin, { kind: "human" });
  assert.equal(turn.text, "hello there");
  assert.equal(turn.conversationHeader, undefined);
  assert.equal(turn.async, true);
  assert.equal((await sentTurn({ threadRef: "dm:D1" })).conversation.threadRef, "web:alice:default");
});

test("a turn with nothing to send is refused before it reaches the agent", async () => {
  for (const body of ["", "{not json", "null", "{}", JSON.stringify({ text: "   " })])
    assert.equal(await refused("/api/turn", body, 400), body === "{not json" ? "bad_request" : "empty message");
  assert.equal(await refused("/api/turn", { text: "x", pad: "x".repeat(1_000_001) }, 413), "payload_too_large");
});

test("client idempotency keys reach the agent namespaced to the signed-in person", async () => {
  assert.equal((await sentTurn({ idempotencyKey: "gesture-123" })).idempotencyKey, "web:alice:gesture-123");
  assert.ok(!("idempotencyKey" in (await sentTurn({}))));
  for (const bad of ["", "   ", 42, "x".repeat(129), "a:b", "approval:a-1:true", "a b", "a\nb"])
    assert.ok(!("idempotencyKey" in (await sentTurn({ idempotencyKey: bad }))), JSON.stringify(bad));
});

const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const QM_IOS = "QM/42 CFNetwork/3826.500.62 Darwin/25.0.0";

test("each web turn and steer records the client surface it was sent from", async () => {
  for (const [headers, surface] of [
    [{ "x-qm-client": "ios", "user-agent": SAFARI_IPHONE }, "ios"],
    [{ "x-qm-client": "desktop", "user-agent": SAFARI_IPHONE }, "desktop"],
    [{ "x-qm-client": "browser", "user-agent": QM_IOS }, "browser"],
    [{ "user-agent": QM_IOS }, "ios"],
    [{ "x-qm-client": "watch", "user-agent": QM_IOS }, "ios"],
    [{ "user-agent": SAFARI_IPHONE }, "browser"],
  ] as const) {
    assert.equal((await post("/api/turn", { text: "hello" }, { headers })).status, 202);
    assert.equal(turns.at(-1)!.clientSurface, surface, JSON.stringify(headers));
  }
  const steer = await post(
    "/api/runs/run-1/signal",
    { kind: "steer", text: "left", threadRef: "web:alice:default" },
    { headers: { "x-qm-client": "ios" } },
  );
  assert.equal(steer.status, 200);
  assert.equal(signals.at(-1)!.signal.request?.clientSurface, "ios");
});

test("attachments ride as blob references, junk attachments are dropped, and the chosen model is kept", async () => {
  const turn = await sentTurn({
    text: "here is a file",
    model: "gpt-5.6-sol",
    attachments: [
      { name: "big.bin", mimetype: "application/octet-stream", sizeBytes: 5242880, blobId: "blob-abc123" },
      { name: "no-blob.txt", mimetype: "text/plain", sizeBytes: 3 },
      { name: "bytes.txt", blobId: "blob-def", contentBase64: "aGk=" },
    ],
  });
  assert.deepEqual(turn.attachments, [
    { name: "big.bin", mimetype: "application/octet-stream", sizeBytes: 5242880, blobId: "blob-abc123" },
    { name: "bytes.txt", mimetype: "application/octet-stream", sizeBytes: 0, blobId: "blob-def" },
  ]);
  assert.equal(turn.model, "gpt-5.6-sol");
  for (const model of ["gpt-5.5", "claude-sonnet-4-6"]) assert.equal((await sentTurn({ model })).model, model);
});

test("app editing adds app context beside the exact message, only on the person's own app thread", async () => {
  const turn = await sentTurn({ text: "Make the title smaller", threadRef: "web:alice:app-edit:sample-app" });
  assert.equal(turn.text, "Make the title smaller");
  assert.match(turn.conversationHeader ?? "", /deployed app "sample-app"/);
  for (const threadRef of ["web:alice:ordinary", "web:alice:app-edit:bad/name", "web:bob:app-edit:sample-app"])
    assert.equal((await sentTurn({ threadRef, conversationHeader: "injected" })).conversationHeader, undefined);
});

const scroll = { name: "ui__scroll", description: "Scroll", inputSchema: { type: "object", properties: {} } };

test("client tools and a surface briefing reach the agent only from the person's own private chat", async () => {
  const own = await sentTurn({ clientTools: [scroll], surfaceBriefing: { name: "Panel", state: "URL: /inbox" } });
  assert.deepEqual(own.clientTools, [scroll]);
  assert.match(own.conversationHeader ?? "", /## Surface: Panel[\s\S]*URL: \/inbox/);
  for (const bad of [
    { clientTools: { name: "x" }, surfaceBriefing: "x" },
    { surfaceBriefing: ["x"] },
    { surfaceBriefing: null },
  ]) {
    const turn = await sentTurn(bad);
    assert.equal(turn.clientTools, undefined);
    assert.equal(turn.conversationHeader, undefined);
  }
  for (const shared of [{ threadRef: "web:bob:app-edit:sample-app" }, { scopeId: "channel:shared" }]) {
    const turn = await sentTurn({ clientTools: [scroll], surfaceBriefing: { name: "Panel" }, ...shared });
    assert.equal(turn.clientTools, undefined, JSON.stringify(shared));
    assert.doesNotMatch(turn.conversationHeader ?? "", /Surface: Panel/, JSON.stringify(shared));
  }
});

test("steers without conversation context and aborts are forwarded bare", async () => {
  for (const body of [
    { kind: "steer", text: "louder" },
    { kind: "steer", text: "louder", threadRef: "" },
    { kind: "steer", text: "louder", threadRef: "invalid" },
    { kind: "steer", text: "louder", tree: true },
    { kind: "abort", tree: "yes" },
  ]) {
    assert.equal((await post("/api/runs/r1/signal", body)).status, 200);
    assert.deepEqual(signals.at(-1)!.signal, { kind: body.kind, ...("text" in body ? { text: body.text } : {}) });
  }
  assert.equal((await post("/api/runs/r1/signal", { kind: "abort", tree: true })).status, 200);
  assert.deepEqual(signals.at(-1)!.signal, { kind: "abort", tree: true });
  assert.equal((await post("/api/runs/r1/signal", { kind: "steer", text: "", queuedRunId: "q1" })).status, 200);
  assert.deepEqual(signals.at(-1)!.signal, { kind: "steer", text: "", queuedRunId: "q1" });
  for (const body of ["", "{}", JSON.stringify({ kind: "nudge" })])
    assert.equal(await refused("/api/runs/r1/signal", body, 400), "bad_request");
});

test("an approval replays the stored request with the decision, the approver's client and a namespaced key", async () => {
  const response = await post(
    "/api/approvals/a-1",
    { approved: true, scope: "session", idempotencyKey: "gesture-1" },
    { headers: { "x-qm-client": "ios" } },
  );
  assert.equal(response.status, 202);
  assert.equal(((await response.json()) as { runId?: string }).runId, `run-${turns.length}`);
  const turn = turns.at(-1)!;
  assert.deepEqual(turn.approval, { requestId: "a-1", approved: true, scope: "session" });
  assert.equal(turn.idempotencyKey, "web:alice:gesture-1");
  assert.equal(turn.clientSurface, "ios");
  for (const field of ["surface", "actor", "conversation", "text", "attachments"] as const)
    assert.deepEqual(turn[field], stored[field], field);
  for (const key of [undefined, "a:b", "approval:a-1:true", "x".repeat(129), 42]) {
    const count = turns.length;
    const again = await post("/api/approvals/a-1", { approved: false, scope: "forever", idempotencyKey: key });
    assert.equal(again.status, 202);
    assert.equal(turns.length, count + 1);
    assert.ok(!("idempotencyKey" in turns.at(-1)!), `key ${JSON.stringify(key)}`);
    assert.deepEqual(turns.at(-1)!.approval, { requestId: "a-1", approved: false });
  }
});

test("a malformed approval or one that is not the approver's own is refused, never resolved as a denial", async () => {
  for (const raw of ["", "{not json", "null", '"approve"', JSON.stringify({ approved: "true" }), "{}"])
    assert.equal(await refused("/api/approvals/a-1", raw, 400), "bad_request", JSON.stringify(raw));
  for (const id of ["a-missing", "a-theirs", "a-slack"])
    assert.equal(await refused(`/api/approvals/${id}`, { approved: true }, 404), "not_found", id);
});

test("worker and subagent approvals replay onto their own thread only when that session is visible", async () => {
  for (const [id, threadRef, surface] of [
    ["a-swarm", "swarm:root:worker", "swarm"],
    ["a-sub", "agent:main:subagent:c1", "web"],
  ] as const) {
    assert.equal((await post(`/api/approvals/${id}`, { approved: true, scope: "once" })).status, 202);
    const turn = turns.at(-1)!;
    assert.equal(turn.conversation.threadRef, threadRef);
    assert.equal(turn.surface, surface);
    assert.deepEqual(turn.attachments, stored.attachments);
    assert.deepEqual(turn.approval, { requestId: id, approved: true, scope: "once" });
  }
  for (const id of ["a-swarm-hidden", "a-swarm-mismatch", "a-swarm-wrong-surface", "a-sub-hidden", "a-sub-mismatch"])
    assert.equal(await refused(`/api/approvals/${id}`, { approved: true }, 404), "not_found", id);
});

test("inbox chat loads fresh previews for the caller separately from the message", async () => {
  await seedInbox("ivy", 1);
  await withInbox(["ivy"], async () => {
    const turn = await sentTurn(
      { text: "What needs my attention?", threadRef: "web:ivy:inbox", conversationHeader: "injected" },
      "ivy",
    );
    assert.equal(turn.text, "What needs my attention?");
    assert.match(turn.conversationHeader ?? "", /untrusted data/);
    assert.match(turn.conversationHeader ?? "", /Review the proposal 0/);
    assert.doesNotMatch(turn.conversationHeader ?? "", /injected/);
    const steer = { kind: "steer", text: "Prioritize", threadRef: "web:ivy:inbox" };
    assert.equal((await post("/api/runs/r1/signal", steer, { user: "ivy" })).status, 200);
    assert.equal(signals.at(-1)!.signal.request?.text, "Prioritize");
    assert.match(signals.at(-1)!.signal.request?.conversationHeader ?? "", /Review the proposal 0/);
    const foreign = { kind: "steer", text: "hello", threadRef: "web:bob:inbox" };
    assert.equal(await refused("/api/turn", foreign, 403, "ivy"), "forbidden_thread");
    assert.equal(await refused("/api/runs/r1/signal", foreign, 403, "ivy"), "forbidden_thread");
    for (const scopeId of ["channel:shared", "group:shared"]) {
      const shared = { ...steer, scopeId };
      assert.equal(await refused("/api/turn", shared, 403, "ivy"), "forbidden_scope");
      assert.equal(await refused("/api/runs/r1/signal", shared, 403, "ivy"), "forbidden_scope");
    }
  });
});

test("inbox context follows pages, bounds previews, and discloses incomplete coverage", async () => {
  for (const [user, items, included] of [
    ["pat", 41, 41],
    ["quinn", 241, 200],
  ] as const) {
    await seedInbox(user, items, "x".repeat(10_000));
    await withInbox([user], async () => {
      const context = (await sentTurn({ text: "Summarize", threadRef: `web:${user}:inbox` }, user)).conversationHeader!;
      const snapshot = JSON.parse(context.slice(context.indexOf('{"attentionCount"')));
      assert.equal(snapshot.attentionCount, items);
      assert.equal(snapshot.includedItems, included);
      assert.equal(snapshot.hasMore, items > included);
      assert.equal(snapshot.items[0].snippet.length, 500);
      assert.match(context, new RegExp(`newest ${included} items, not the entire inbox`));
    });
  }
});

test("inbox turns, steers and approvals need the inbox feature flag", async () => {
  await seedInbox("alice", 1);
  const steer = { kind: "steer", text: "Summarize", threadRef: "web:alice:inbox" };
  await withInbox(["bob"], async () => {
    assert.equal(await refused("/api/turn", steer, 403), "feature_disabled");
    assert.equal(await refused("/api/runs/run-1/signal", steer, 403), "feature_disabled");
    assert.equal(await refused("/api/approvals/a-inbox", { approved: true }, 403), "feature_disabled");
    await sentTurn({ text: "Hello", threadRef: "web:alice:ordinary" });
  });
  await withInbox(["alice"], async () => {
    assert.equal(await refused("/api/approvals/a-inbox-other", { approved: true }, 403), "forbidden_thread");
    assert.equal(await refused("/api/approvals/a-inbox-channel", { approved: true }, 403), "forbidden_scope");
    assert.equal((await post("/api/approvals/a-inbox", { approved: true })).status, 202);
    assert.equal(turns.at(-1)!.conversationHeader, "Stored inbox snapshot");
  });
});

test("inbox chat fails closed when the flag service is missing or the inbox cannot be read", async (t) => {
  const unflagged = await serve({ featureFlags: undefined }, t);
  const unreadable = await serve({ loops: undefined }, t);
  await withInbox(["alice"], async () => {
    for (const [at, status] of [
      [unflagged, 403],
      [unreadable, 500],
    ] as const) {
      const count = turns.length;
      const response = await post("/api/turn", { text: "Summarize", threadRef: "web:alice:inbox" }, { at });
      assert.equal(response.status, status);
      assert.equal(turns.length, count);
    }
  });
});

test("a chat embed on a listed API origin can send turns and run signals, and no other browser writes", async () => {
  portalSession.apiOrigins = new Set(["https://embed.example"]);
  try {
    const listed = { headers: { origin: "https://embed.example" } };
    const count = turns.length;
    assert.equal((await post("/api/turn", { text: "from the embed" }, listed)).status, 202);
    assert.equal(turns.length, count + 1);
    assert.equal((await post("/api/runs/r1/signal", { kind: "abort" }, listed)).status, 200);
    const other = await post("/api/sessions/s1/title", { title: "x" }, listed);
    assert.equal(other.status, 403);
    assert.equal(((await other.json()) as { message?: string }).message, "cross-origin request refused");
  } finally {
    delete portalSession.apiOrigins;
  }
});
