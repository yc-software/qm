import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { partnerChatPrincipal, createPartnerChatSurface } from "../src/surfaces/partner-chat/adapter.ts";
import { createPartnerChatDeliveries } from "../src/surfaces/partner-chat/outbound.ts";
import { signPartnerChat } from "../src/surfaces/partner-chat/protocol.ts";
import { buildApp } from "./support/build-app.ts";
import { runNowSettled, settle } from "./support/settle.ts";
import { testConfig } from "./support/test-config.ts";
import { loadConfig } from "../src/config.ts";
import { scopeId } from "../src/types.ts";

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
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { message_id: String(++next) } : { error: "nope" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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
    await settle(async () => partnerChat.received.length > 0);
    await new Promise((r) => setTimeout(r, 1_000));
    assert.equal(partnerChat.received.length, 1);
    const [post] = partnerChat.received;
    assert.equal(post!.path, "/qm_surface/messages");
    assert.equal(post!.signature, signPartnerChat(SECRET, post!.timestamp, post!.raw));
    assert.equal(post!.body.chat_id, "88");
    assert.equal(post!.body.body, "on it");
    assert.match(String(post!.body.client_message_id), /^post:/);
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
    await deliver(event({ bot: true, body: "earlier answer", eventId: "ev-self", messageId: "1010", thread: "1009" }));
    await deliver(event({ body: "!post following up", eventId: "ev-thread", messageId: "1011", thread: "1009" }));
    await settle(async () => partnerChat.received.length > 0);
    assert.equal(partnerChat.received[0]!.body.thread_id, "1009");
    assert.equal(partnerChat.received[0]!.body.body, "following up");
    assert.ok(await built.sessions.getByThread(`${CONTAINER}:1009`));
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
  const outbound = createPartnerChatDeliveries({
    url: `${partnerChat.url}/`,
    secret: SECRET,
    deliveries,
    app: { setRunDeliveryState: async (runId, state) => (editRefs.push([runId, state]), true) },
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
      app: { setRunDeliveryState: async () => true },
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
