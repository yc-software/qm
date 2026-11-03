import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import type { IngestEvent } from "../src/surface-cache/types.ts";
import { partnerChatPrincipal, createPartnerChatSurface } from "../src/surfaces/partner-chat/adapter.ts";
import { createPartnerChatDeliveries } from "../src/surfaces/partner-chat/outbound.ts";
import { signPartnerChat } from "../src/surfaces/partner-chat/protocol.ts";
import { buildApp } from "./support/build-app.ts";
import { runNowSettled, settle } from "./support/settle.ts";
import { testConfig } from "./support/test-config.ts";
import { loadConfig } from "../src/config.ts";
import { scopeId } from "../src/types.ts";
import { createPartnerChatLiveReply } from "../src/surfaces/partner-chat/live-reply.ts";
import type { RunStreamEvent } from "../src/runs/run-stream-events.ts";
import type { Run } from "../src/runs/run-store.ts";

const SECRET = "partner-chat-test-secret-0123456789abcdef";
const PROVENANCE = { trigger: "cron", surface: "partner-chat", fireKey: "f", sourceScopeId: "s", sourceThreadRef: "t" };

interface Received {
  path: string;
  body: Record<string, unknown>;
  timestamp: string;
  signature: string;
  raw: string;
}

async function fakePartnerChat(status = 200) {
  const received: Received[] = [];
  const messages = new Map<string, { chat_id: unknown; thread_id: unknown; body: unknown }>();
  let next = 41;
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({
        path: req.url ?? "",
        body: JSON.parse(raw) as Record<string, unknown>,
        timestamp: String(req.headers["x-qm-timestamp"]),
        signature: String(req.headers["x-qm-signature"]),
        raw,
      });
      const id = String(++next);
      const body = received.at(-1)!.body;
      const edited = /^\/qm_surface\/messages\/(\d+)\/update$/.exec(req.url ?? "")?.[1];
      if (status === 200 && edited && messages.has(edited)) messages.get(edited)!.body = body.body;
      else if (status === 200 && !edited)
        messages.set(id, { chat_id: body.chat_id, thread_id: body.thread_id, body: body.body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { message_id: id } : { error: "nope" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const shown = () => [...messages.entries()].map(([id, m]) => ({ id, ...m }));
  return { url, received, shown, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function event(
  overrides: {
    body?: string;
    mentions?: boolean;
    eventId?: string;
    messageId?: string;
    thread?: string;
    bot?: boolean;
  } = {},
) {
  return {
    event_id: overrides.eventId ?? "ev-1",
    type: "message.created",
    account: "7001",
    chat: {
      id: "88",
      kind: "group",
      name: "Launch crew",
      members: [
        { id: "5", email: "ada@example.com", name: "Ada Lovelace" },
        { id: "6", email: "grace@example.com", name: "Grace Hopper" },
        { id: "9", name: "QM", bot: true },
      ],
    },
    ...(overrides.thread ? { thread_id: overrides.thread } : {}),
    message: {
      id: overrides.messageId ?? "1001",
      user: overrides.bot
        ? { id: "9", name: "QM", bot: true }
        : { id: "5", email: "ada@example.com", name: "Ada Lovelace" },
      body: overrides.body ?? "hello there",
      mentions_agent: overrides.mentions ?? false,
      created_at: "2026-11-02T20:00:00Z",
    },
  };
}

function signed(payload: unknown, at = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(payload);
  const ts = String(at);
  return [ts, signPartnerChat(SECRET, ts, raw), raw] as const;
}

async function partnerChatApp() {
  const partnerChat = await fakePartnerChat();
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "partner-chat-surface-")),
      partnerChat: { url: partnerChat.url, secret: SECRET },
      emailAuthDomain: "example.com",
    }),
  );
  built.runtime.start();
  const deliver = (payload: unknown, at?: number) => built.partnerChatEvents!(...signed(payload, at));
  return { built, partnerChat, deliver };
}

const CONTAINER = "partner-chat:7001:group:88";

test("partner-chat events are rejected unless signed with the shared secret inside five minutes", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    const [ts, , raw] = signed(event());
    assert.equal((await built.partnerChatEvents!(ts, "v1=00", raw)).status, 401);
    assert.equal((await built.partnerChatEvents!(ts, signPartnerChat("other-secret", ts, raw), raw)).status, 401);
    assert.equal((await deliver(event(), Math.floor(Date.now() / 1000) - 301)).status, 401);
    assert.equal((await deliver({ event_id: "x" })).status, 400);
    assert.deepEqual(await deliver(event()), { status: 200, body: { ok: true } });
    const rows = await built.surfaceCache.readMessages(CONTAINER, { surface: "partner-chat", noFallback: true });
    assert.deepEqual(
      rows.map((m) => [m.ts, m.authorId, m.authorName, m.text, Boolean(m.self)]),
      [["1793649600.00000000000000001001", "ada@example.com", "Ada Lovelace", "hello there", false]],
    );
    assert.deepEqual(await built.surfaceCache.members(CONTAINER, { surface: "partner-chat" }), [
      "ada@example.com",
      "grace@example.com",
    ]);
  } finally {
    await partnerChat.close();
  }
});

test("an @-mention starts a turn whose reply lands in the chat once, even when the event is redelivered", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    const mention = event({ body: "!post on it", mentions: true, eventId: "ev-mention", messageId: "1002" });
    assert.equal((await deliver(mention)).status, 200);
    assert.equal((await deliver(mention)).status, 200);
    await settle(async () => partnerChat.shown().some((m) => m.body === "on it"));
    await new Promise((r) => setTimeout(r, 1_000));
    assert.deepEqual(
      partnerChat.shown().map((m) => [m.chat_id, m.thread_id, m.body]),
      [["88", "1002", "on it"]],
    );
    assert.ok(partnerChat.received.every((r) => r.signature === signPartnerChat(SECRET, r.timestamp, r.raw)));
    const session = await built.sessions.getByThread(CONTAINER);
    assert.equal(session?.surface, "partner-chat");
  } finally {
    await partnerChat.close();
  }
});

test("unmentioned chatter goes to the ambient judge, whose worker posts into the chat", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    await built.app.setChannelPolicy(CONTAINER, "!engage !post ambient reply", "U-admin");
    assert.equal(
      (await deliver(event({ body: "did the launch slip?", eventId: "ev-amb", messageId: "1003" }))).status,
      200,
    );
    await settle(async () => partnerChat.received.some((r) => r.body.body === "ambient reply"));
    const posted = partnerChat.received.find((r) => r.body.body === "ambient reply");
    assert.equal(posted?.body.chat_id, "88");
    assert.ok(await built.sessions.getByThread(`partner-chat:${CONTAINER}:ambient:1793649600.00000000000000001003`));
  } finally {
    await partnerChat.close();
  }
});

test("a reply in a thread the agent already posted in is addressed without a mention", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    const bodies = () => partnerChat.shown().map((m) => [m.thread_id, m.body]);
    await deliver(event({ body: "!post first answer", mentions: true, eventId: "ev-m", messageId: "1008" }));
    const own = async () =>
      (await built.surfaceCache.readMessages(CONTAINER, { surface: "partner-chat", self: true, noFallback: true }))
        .map((m) => [m.sub, m.text])
        .sort();
    await settle(async () => (await own()).some(([, text]) => text === "first answer"));
    await deliver(event({ body: "!post following up", eventId: "ev-thread", messageId: "1011", thread: "1008" }));
    await settle(async () => bodies().some(([, b]) => b === "following up"));
    assert.deepEqual(bodies(), [
      ["1008", "first answer"],
      ["1008", "following up"],
    ]);
    await settle(async () => (await own()).some(([, text]) => text === "following up"));
    assert.deepEqual(await own(), [
      ["1008", "first answer"],
      ["1008", "following up"],
    ]);
    const root = partnerChat.shown()[0]!.id;
    await deliver(event({ body: "!post under your post", eventId: "ev-root", messageId: "1012", thread: root }));
    await settle(async () => bodies().some(([, b]) => b === "under your post"));
    assert.deepEqual(bodies().at(-1), [root, "under your post"]);
    await deliver(event({ body: "!post nobody asked", eventId: "ev-other", messageId: "1013", thread: "1001" }));
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(partnerChat.shown().length, 3);
  } finally {
    await partnerChat.close();
  }
});

test("a post into another message's thread keeps the chat id", async () => {
  const { partnerChat, deliver } = await partnerChatApp();
  try {
    await deliver(
      event({
        body: "!postthread 1793649600.00000000000000001001 over there",
        mentions: true,
        eventId: "ev-pt",
        messageId: "1014",
      }),
    );
    await settle(async () => partnerChat.shown().some((m) => m.body === "over there"));
    assert.ok(partnerChat.shown().some((m) => m.chat_id === "88" && m.thread_id === "1001" && m.body === "over there"));
  } finally {
    await partnerChat.close();
  }
});

test("a cron created in a partner chat posts into that chat when it fires", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    await deliver(event({ body: "!post sure", mentions: true, eventId: "ev-c", messageId: "1030" }));
    await settle(async () => partnerChat.received.some((r) => r.body.body === "sure"));
    const cron = await built.crons.create({
      schedule: { everyMs: 60_000 },
      message: "standup time",
      owner: "ada@example.com",
      createdBy: "ada@example.com",
      ownerScopeId: scopeId("group", CONTAINER),
      destination: { type: "partner-chat", target: CONTAINER, audienceScopeId: scopeId("group", CONTAINER) },
    });
    await runNowSettled(built.scheduler, cron.id);
    await settle(async () => partnerChat.received.some((r) => r.body.body === "standup time"));
    assert.equal(partnerChat.received.find((r) => r.body.body === "standup time")?.body.chat_id, "88");
  } finally {
    await partnerChat.close();
  }
});

test("partner-chat conversation reads are answered from the mirror", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    await deliver(event({ body: "first", eventId: "e1", messageId: "1020" }));
    await deliver(event({ body: "second", eventId: "e2", messageId: "1021" }));
    const request = await built.app.createContextRequest("partner-chat", { conversationTarget: CONTAINER, count: 10 });
    let result: unknown;
    await settle(async () => {
      const r = await built.app.getContextRequest(request.id);
      result = r?.result;
      return r?.status === "done";
    });
    assert.deepEqual(
      (result as { messages: Array<{ text: string; author: string }> }).messages.map((m) => [m.author, m.text]),
      [
        ["Ada Lovelace", "first"],
        ["Ada Lovelace", "second"],
      ],
    );
  } finally {
    await partnerChat.close();
  }
});

test("partner-chat deliveries are signed, idempotent by key, and an acknowledged run is finished in place", async () => {
  const partnerChat = await fakePartnerChat();
  const deliveries = createDeliveryStore();
  const editRefs: Array<[string, unknown]> = [];
  const mirrored: IngestEvent[] = [];
  const outbound = createPartnerChatDeliveries({
    url: `${partnerChat.url}/`,
    secret: SECRET,
    deliveries,
    app: {
      setRunDeliveryState: async (runId, state) => (editRefs.push([runId, state]), true),
      ingestSurfaceEvents: async (events) => (mirrored.push(...events), { upserted: events.length }),
    },
    runs: { get: async () => null },
    surfaceCache: {
      readMessages: async () =>
        mirrored.map((m) => ({
          container: m.container,
          ts: m.ts,
          text: m.text ?? "",
          createdAt: m.createdAt ?? 0,
          ...(m.sub ? { sub: m.sub } : {}),
        })),
    },
  });
  try {
    const surface = createPartnerChatSurface({ deliveries });
    await surface.post(
      { surface: "partner-chat", account: "7001", kind: "group", container: "88", thread: "1009" },
      { text: "scheduled hello", provenance: PROVENANCE },
      "cron:fire-1",
    );
    await deliveries.enqueue({
      destination: { type: "partner-chat", target: CONTAINER },
      text: "Looking into it",
      idempotencyKey: "ack:run-1",
    });
    await outbound.drain();
    assert.deepEqual(
      partnerChat.received.map((r) => [r.path, r.body, r.signature === signPartnerChat(SECRET, r.timestamp, r.raw)]),
      [
        [
          "/qm_surface/messages",
          { client_message_id: "cron:fire-1", chat_id: "88", thread_id: "1009", body: "scheduled hello" },
          true,
        ],
        ["/qm_surface/messages", { client_message_id: "ack:run-1", chat_id: "88", body: "Looking into it" }, true],
      ],
    );
    assert.deepEqual(editRefs, [["run-1", { editRef: "43" }]]);
    await deliveries.enqueue({
      destination: { type: "partner-chat", target: CONTAINER, editRef: "43" },
      text: "Here is the full answer",
      idempotencyKey: "post:run-1:1",
    });
    await deliveries.enqueue({
      destination: { type: "partner-chat", target: CONTAINER, editRef: "1793649600.00000000000000001021" },
      text: "edited by ref",
      idempotencyKey: "post:run-1:2",
    });
    await outbound.drain();
    assert.deepEqual(
      partnerChat.received.slice(2).map((r) => [r.path, r.body]),
      [
        ["/qm_surface/messages/43/update", { body: "Here is the full answer" }],
        ["/qm_surface/messages/1021/update", { body: "edited by ref" }],
      ],
    );
    assert.deepEqual(editRefs.at(-1), ["run-1", { editRef: "" }]);
    assert.deepEqual(
      mirrored.map((m) => [m.ts.split(".")[1]!.replace(/^0+/, ""), m.sub, m.text, m.self, Boolean(m.editedAt)]),
      [
        ["42", "1009", "scheduled hello", true, false],
        ["43", null, "Looking into it", true, false],
        ["43", null, "Here is the full answer", true, true],
      ],
    );
    assert.equal((await deliveries.pending("partner-chat")).length, 0);
  } finally {
    await partnerChat.close();
  }
});

test("partner-chat rejections fail the delivery while server errors leave it for retry", async () => {
  for (const [status, failed] of [
    [404, true],
    [503, false],
  ] as const) {
    const partnerChat = await fakePartnerChat(status);
    const deliveries = createDeliveryStore();
    const outbound = createPartnerChatDeliveries({
      url: partnerChat.url,
      secret: SECRET,
      deliveries,
      app: { setRunDeliveryState: async () => true, ingestSurfaceEvents: async () => ({ upserted: 0 }) },
      runs: { get: async () => null },
      surfaceCache: { readMessages: async () => [] },
    });
    try {
      const d = await deliveries.enqueue({
        destination: { type: "partner-chat", target: CONTAINER },
        text: "hi",
        idempotencyKey: `k-${status}`,
      });
      await outbound.drain();
      const after = await deliveries.get(d.id);
      assert.equal(Boolean(after?.failedReason), failed, String(status));
      assert.equal(after?.deliveredAt, null);
    } finally {
      await partnerChat.close();
    }
  }
});

test("partner-chat principals are internal only when vouched for, otherwise external guests", () => {
  assert.deepEqual(partnerChatPrincipal({ id: "5", email: " Ada@Example.com ", name: "Ada" }, true), {
    externalId: "ada@example.com",
    displayName: "Ada",
  });
  assert.deepEqual(partnerChatPrincipal({ id: "5", email: "ada@startup.dev", name: "Ada" }, false), {
    externalId: "ada@startup.dev",
    isExternalGuest: true,
    displayName: "Ada",
  });
  assert.deepEqual(partnerChatPrincipal({ id: "6", name: "Guest" }, true), {
    externalId: "partner-chat:6",
    isExternalGuest: true,
    displayName: "Guest",
  });
  const surface = createPartnerChatSurface({ deliveries: createDeliveryStore() });
  const principal = partnerChatPrincipal({ id: "5", name: "Ada Lovelace" }, false);
  assert.equal(surface.mention({ surface: "partner-chat", account: "7001", id: "5", principal }), "@Ada Lovelace");
  assert.equal(
    surface.threadTarget?.("partner-chat:7001:group:42", "1793649600.00000000000000001001"),
    "partner-chat:7001:group:42:1001",
  );
  assert.throws(() => surface.threadTarget?.("partner-chat:7001:group:42", "not-a-message"), /can't reply under/);
});

test("a chat with any member the deployment does not vouch for is neither mirrored nor answered", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    const withGuest = event({ body: "!post hi", mentions: true, eventId: "ev-guest", messageId: "1040" });
    withGuest.chat.members.push({ id: "7", email: "founder@startup.dev", name: "Founder" });
    assert.equal((await deliver(withGuest)).status, 200);
    await new Promise((r) => setTimeout(r, 1_500));
    assert.deepEqual(
      await built.surfaceCache.readMessages(CONTAINER, { surface: "partner-chat", noFallback: true }),
      [],
    );
    assert.equal(partnerChat.received.length, 0);
    assert.equal(await built.runs.latestForThread(CONTAINER), null);
    const unlisted = event({ body: "!post hi", mentions: true, eventId: "ev-unlisted", messageId: "1041" });
    unlisted.message.user = { id: "8", email: "ada@example.com", name: "Not A Member" };
    assert.equal((await deliver(unlisted)).status, 200);
    assert.deepEqual(
      await built.surfaceCache.readMessages(CONTAINER, { surface: "partner-chat", noFallback: true }),
      [],
    );
  } finally {
    await partnerChat.close();
  }
});

test("partner-chat config requires the url and secret together and validates prompt hints", () => {
  assert.throws(() => loadConfig({ PARTNER_CHAT_URL: "https://chat.example" }), /must be set together/);
  assert.throws(
    () =>
      loadConfig({
        PARTNER_CHAT_URL: "https://chat.example",
        PARTNER_CHAT_SECRET: "s",
        PARTNER_CHAT_PROMPT_HINTS: '{"tone":1}',
      }),
    /PARTNER_CHAT_PROMPT_HINTS/,
  );
  assert.deepEqual(
    loadConfig({
      PARTNER_CHAT_URL: "https://chat.example",
      PARTNER_CHAT_SECRET: "s",
      PARTNER_CHAT_LABEL: "Acme Chat",
      PARTNER_CHAT_PROMPT_HINTS: '{"linkSyntax":"plain urls"}',
    }).partnerChat,
    { url: "https://chat.example", secret: "s", label: "Acme Chat", promptHints: { linkSyntax: "plain urls" } },
  );
});

test("a direct reply streams into one placeholder that is edited in place until the run settles", async () => {
  const deliveries = createDeliveryStore();
  let listener: ((e: RunStreamEvent) => void) | undefined;
  let unsubscribed = false;
  let run = {
    id: "run-9",
    sessionId: CONTAINER,
    status: "running",
    deliveryState: null,
    request: {
      surface: "partner-chat",
      surfaceTools: true,
      deliveryTarget: `${CONTAINER}:1002`,
      actor: { id: "ada@example.com", type: "internal" },
      origin: { kind: "human" },
      conversation: { kind: "group", threadRef: CONTAINER },
    },
    result: { status: "ok" },
  } as unknown as Run;
  const live = createPartnerChatLiveReply({
    app: {
      subscribeRun: (_id, l) => {
        listener = l;
        return () => (unsubscribed = true);
      },
    },
    runs: { get: async () => run },
    deliveries,
    intervalMs: 20,
  });
  const destination = { type: "partner-chat", target: `${CONTAINER}:1002` };
  live.follow("run-9", destination);
  const sent = async () =>
    (await deliveries.pending("partner-chat")).map((d) => [d.idempotencyKey, d.destination.editRef, d.text]);
  listener!({ runId: "run-9", kind: "delta", offset: 0, text: "Checking the ", startOffset: 0 });
  listener!({ runId: "run-9", kind: "delta", offset: 13, text: "launch list", startOffset: 0 });
  await settle(async () => (await sent()).length === 1);
  assert.deepEqual(await sent(), [["ack:run-9", undefined, "Checking the launch list"]]);
  listener!({ runId: "run-9", kind: "delta", offset: 24, text: " now.", startOffset: 0 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await sent()).length, 1);
  run = { ...run, deliveryState: { editRef: "77" } };
  await settle(async () => (await sent()).length === 2);
  assert.deepEqual((await sent())[1], ["stream:run-9:1", "77", "Checking the launch list now."]);
  run = { ...run, status: "done" };
  listener!({ runId: "run-9", kind: "delta", offset: 29, text: " Done.", startOffset: 0 });
  await settle(async () => unsubscribed);
  assert.deepEqual((await sent())[2], ["stream:run-9:settled", "77", "✓"]);
  assert.equal((await sent()).length, 3);
});

test("a quiet direct turn gets a placeholder after two seconds, unless the agent already posted", async () => {
  for (const posted of [false, true]) {
    const deliveries = createDeliveryStore();
    const destination = { type: "partner-chat", target: `${CONTAINER}:1002` };
    if (posted)
      await deliveries.enqueue({
        destination,
        text: "answer",
        idempotencyKey: `post:run-q:partner-chat:${CONTAINER}:1002:0`,
      });
    const live = createPartnerChatLiveReply({
      app: { subscribeRun: () => () => {} },
      runs: { get: async () => ({ status: "running", deliveryState: null }) as unknown as Run },
      deliveries,
      intervalMs: 20,
    });
    live.follow("run-q", destination);
    await new Promise((r) => setTimeout(r, 2_300));
    assert.deepEqual(
      (await deliveries.pending("partner-chat"))
        .map((d) => [d.idempotencyKey, d.text])
        .filter(([k]) => k === "ack:run-q"),
      posted ? [] : [["ack:run-q", "…"]],
      String(posted),
    );
  }
});

test("a streamed edit is dropped once the run's final reply or a deliberate post has taken the placeholder", async () => {
  const partnerChat = await fakePartnerChat();
  const deliveries = createDeliveryStore();
  let editRef = "77";
  const outbound = createPartnerChatDeliveries({
    url: partnerChat.url,
    secret: SECRET,
    deliveries,
    app: { setRunDeliveryState: async () => true, ingestSurfaceEvents: async () => ({ upserted: 0 }) },
    runs: { get: async () => ({ deliveryState: { editRef } }) as unknown as Run },
    surfaceCache: { readMessages: async () => [] },
  });
  try {
    const edit = (key: string) =>
      deliveries.enqueue({
        destination: { type: "partner-chat", target: CONTAINER, editRef: "77" },
        text: key,
        idempotencyKey: key,
      });
    await edit("stream:run-9:1");
    await outbound.drain();
    editRef = "";
    await edit("stream:run-9:2");
    await outbound.drain();
    editRef = "77";
    await deliveries.enqueue({
      destination: { type: "partner-chat", target: CONTAINER },
      text: "x",
      idempotencyKey: "run:run-9",
    });
    await edit("stream:run-9:3");
    await outbound.drain();
    assert.deepEqual(
      partnerChat.received.map((r) => [r.path, r.body.body]),
      [
        ["/qm_surface/messages/77/update", "stream:run-9:1"],
        ["/qm_surface/messages", "x"],
      ],
    );
    assert.equal((await deliveries.pending("partner-chat")).length, 0);
  } finally {
    await partnerChat.close();
  }
});
