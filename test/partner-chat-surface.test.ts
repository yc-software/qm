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
import { createSurfaceRegistry } from "../src/surfaces/registry.ts";
import { createPartnerChatLiveReply } from "../src/surfaces/partner-chat/live-reply.ts";
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

async function fakePartnerChat(status = 200, rejectEdits: string[] = []) {
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
      if (edited && rejectEdits.includes(edited)) {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "too old" }));
        return;
      }
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
  const close = async () => {
    await built.runtime.stop();
    await partnerChat.close();
  };
  return { built, partnerChat: { ...partnerChat, close }, deliver };
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
    const session = await built.sessions.getByThread(`${CONTAINER}:1002`);
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

const R1 = "00000000-0000-4000-8000-000000000001";

function fakeRuns(initial: Record<string, { status?: string; target?: string; editRef?: string }>) {
  const runs = new Map(Object.entries(initial));
  const slots: Array<[string, unknown]> = [];
  return {
    slots,
    runs: {
      get: async (id: string) => {
        const r = runs.get(id);
        if (!r) return null;
        return {
          id,
          status: r.status ?? "running",
          request: { deliveryTarget: r.target ?? CONTAINER },
          deliveryState: r.editRef === undefined ? null : { editRef: r.editRef },
        } as unknown as Run;
      },
    },
    setRunDeliveryState: async (id: string, state: { editRef?: string }) => {
      slots.push([id, state]);
      runs.set(id, { ...runs.get(id), ...(state.editRef !== undefined ? { editRef: state.editRef } : {}) });
      return true;
    },
  };
}

test("partner-chat deliveries are signed, idempotent by key, and an acknowledged run is finished in place", async () => {
  const partnerChat = await fakePartnerChat();
  const deliveries = createDeliveryStore();
  const fake = fakeRuns({ [R1]: {} });
  const mirrored: IngestEvent[] = [];
  const outbound = createPartnerChatDeliveries({
    url: `${partnerChat.url}/`,
    secret: SECRET,
    deliveries,
    app: {
      setRunDeliveryState: fake.setRunDeliveryState,
      ingestSurfaceEvents: async (events) => (mirrored.push(...events), { upserted: events.length }),
    },
    serialize: (fn) => fn(),
    runs: fake.runs,
    surfaceCache: {
      readMessages: async (_container, opts) =>
        mirrored
          .filter((m) => !opts?.tsSuffix || m.ts.endsWith(opts.tsSuffix))
          .map((m) => ({
            container: m.container,
            ts: m.ts,
            text: m.text ?? "",
            createdAt: m.createdAt ?? 0,
            ...(m.sub ? { sub: m.sub } : {}),
          })),
    },
  });
  try {
    const surface = createPartnerChatSurface({ deliveries, surfaceCache: { readMessages: async () => [] } });
    await surface.post(
      { surface: "partner-chat", account: "7001", kind: "group", container: "88", thread: "1009" },
      { text: "scheduled hello", provenance: PROVENANCE },
      "cron:fire-1",
    );
    await deliveries.enqueue({
      destination: { type: "partner-chat", target: CONTAINER },
      text: "Looking into it",
      idempotencyKey: `ack:${R1}`,
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
        ["/qm_surface/messages", { client_message_id: `ack:${R1}`, chat_id: "88", body: "Looking into it" }, true],
      ],
    );
    assert.deepEqual(fake.slots, [[R1, { editRef: "43" }]]);
    await deliveries.enqueue({
      destination: {
        type: "partner-chat",
        target: CONTAINER,
        editRef: "43",
        editNote: "Edited after a reply check: em dash",
      },
      text: "Here is the full answer",
      idempotencyKey: `post:${R1}:partner-chat:${CONTAINER}:0`,
    });
    await deliveries.enqueue({
      destination: { type: "partner-chat", target: CONTAINER, editRef: "1793649600.00000000000000001021" },
      text: "edited by ref",
      idempotencyKey: `post:${R1}:partner-chat:${CONTAINER}:1`,
    });
    await outbound.drain();
    assert.deepEqual(
      partnerChat.received.slice(2).map((r) => [r.path, r.body]),
      [
        ["/qm_surface/messages/43/update", { body: "Here is the full answer\n\nEdited after a reply check: em dash" }],
        ["/qm_surface/messages/1021/update", { body: "edited by ref" }],
      ],
    );
    assert.deepEqual(fake.slots, [
      [R1, { editRef: "43" }],
      [R1, { editRef: "" }],
    ]);
    assert.deepEqual(
      mirrored.map((m) => [m.ts.split(".")[1]!.replace(/^0+/, ""), m.sub, m.text, m.self, Boolean(m.editedAt)]),
      [
        ["42", "1009", "scheduled hello", true, false],
        ["43", null, "Looking into it", true, false],
        ["43", null, "Here is the full answer\n\nEdited after a reply check: em dash", true, true],
      ],
    );
    assert.equal((await deliveries.pending("partner-chat")).length, 0);
  } finally {
    await partnerChat.close();
  }
});

test("a direct reply holds one placeholder that the reply replaces, or that settles when nothing does", async () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const target = `${CONTAINER}:1002`;
  const partnerChat = await fakePartnerChat(200, ["77"]);
  let serialized = 0;
  const deliveries = createDeliveryStore();
  const fake = fakeRuns({
    [id(2)]: { target },
    [id(3)]: { target, editRef: "" },
    [id(4)]: { target, status: "done" },
    [id(5)]: { target, editRef: "99" },
    [id(6)]: { target, editRef: "" },
    [id(7)]: { target, editRef: "77" },
  });
  const outbound = createPartnerChatDeliveries({
    url: partnerChat.url,
    secret: SECRET,
    deliveries,
    app: { setRunDeliveryState: fake.setRunDeliveryState, ingestSurfaceEvents: async () => ({ upserted: 0 }) },
    runs: fake.runs,
    surfaceCache: { readMessages: async () => [] },
    serialize: async (fn) => {
      serialized += 1;
      return fn();
    },
  });
  const send = (key: string, text: string, editRef?: string) =>
    deliveries.enqueue({
      destination: { type: "partner-chat", target, ...(editRef ? { editRef } : {}) },
      text,
      idempotencyKey: key,
    });
  try {
    await send(`placeholder:${id(2)}`, "…");
    await send(`post:${id(2)}:partner-chat:${target}:0`, "the answer");
    await send(`placeholder:${id(3)}`, "…");
    await send(`placeholder:${id(4)}`, "…");
    await send(`settle:${id(5)}`, "✓");
    await send(`settle:${id(6)}`, "✓");
    await send(`run:${id(7)}`, "final reply", "77");
    await outbound.drain();
    assert.deepEqual(
      partnerChat.received.map((r) => [r.path, r.body.body]),
      [
        ["/qm_surface/messages", "…"],
        ["/qm_surface/messages/42/update", "the answer"],
        ["/qm_surface/messages/99/update", "✓"],
        ["/qm_surface/messages/77/update", "final reply"],
        ["/qm_surface/messages", "final reply"],
      ],
    );
    assert.deepEqual(fake.slots, [
      [id(2), { editRef: "42" }],
      [id(2), { editRef: "" }],
      [id(5), { editRef: "" }],
      [id(7), { editRef: "" }],
    ]);
    assert.ok(serialized > 0);
    assert.equal((await deliveries.pending("partner-chat")).length, 0);
  } finally {
    await partnerChat.close();
  }
});

test("a refusal notice edits an open placeholder, is posted in the reply thread when none was posted, and a bare settle without one stays silent", async () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000002${n}`;
  const target = `${CONTAINER}:1002`;
  const partnerChat = await fakePartnerChat();
  const deliveries = createDeliveryStore();
  const fake = fakeRuns({
    [id(1)]: { target, status: "done", editRef: "99" },
    [id(2)]: { target, status: "done" },
    [id(3)]: { target, status: "done" },
    [id(4)]: { target, status: "done", editRef: "" },
  });
  const outbound = createPartnerChatDeliveries({
    url: partnerChat.url,
    secret: SECRET,
    deliveries,
    app: { setRunDeliveryState: fake.setRunDeliveryState, ingestSurfaceEvents: async () => ({ upserted: 0 }) },
    runs: fake.runs,
    surfaceCache: { readMessages: async () => [] },
    serialize: (fn) => fn(),
  });
  const notice = "⚠️ I couldn't finish that turn: budget exceeded ($5.00 of $5); try again later";
  const send = (key: string, text: string) =>
    deliveries.enqueue({ destination: { type: "partner-chat", target }, text, idempotencyKey: key });
  try {
    await send(`notice:${id(1)}`, notice);
    await send(`notice:${id(2)}`, notice);
    await send(`placeholder:${id(2)}`, "…");
    await send(`settle:${id(3)}`, "✓");
    await send(`notice:${id(4)}`, notice);
    await outbound.drain();
    assert.deepEqual(
      partnerChat.received.map((r) => [r.path, r.body.thread_id ?? null, r.body.body]),
      [
        ["/qm_surface/messages/99/update", null, notice],
        ["/qm_surface/messages", "1002", notice],
      ],
    );
    assert.deepEqual(fake.slots, [
      [id(1), { editRef: "" }],
      [id(2), { editRef: "" }],
    ]);
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
      serialize: (fn) => fn(),
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

test("partner-chat principals are internal only when vouched for, otherwise external guests", async () => {
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
  const reply = "1793649600.00000000000000001003";
  const surface = createPartnerChatSurface({
    deliveries: createDeliveryStore(),
    surfaceCache: {
      readMessages: async (container, opts) =>
        container === "partner-chat:7001:group:42" && opts?.timestamps?.[0] === reply
          ? [{ container, ts: reply, sub: "1000", text: "", createdAt: 0 }]
          : [],
    },
  });
  const principal = partnerChatPrincipal({ id: "5", name: "Ada Lovelace" }, false);
  assert.equal(surface.mention({ surface: "partner-chat", account: "7001", id: "5", principal }), "@Ada Lovelace");
  assert.equal(
    await surface.threadTarget?.("partner-chat:7001:group:42", "1793649600.00000000000000001001"),
    "partner-chat:7001:group:42:1001",
  );
  assert.equal(
    await surface.threadTarget?.("partner-chat:7001:group:42:1000", reply),
    "partner-chat:7001:group:42:1000",
  );
  await assert.rejects(
    async () => surface.threadTarget?.("partner-chat:7001:group:42", "not-a-message"),
    /can't reply under/,
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
    assert.deepEqual(await built.runs.list({ threadRef: CONTAINER }), []);
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

test("a followed turn queues its placeholder after the delay, and a finished direct run settles its slot unless a run reply replaces it", async () => {
  const deliveries = createDeliveryStore();
  const surfaces = createSurfaceRegistry({
    surfaces: [createPartnerChatSurface({ deliveries, surfaceCache: { readMessages: async () => [] } })],
  });
  const live = createPartnerChatLiveReply({ deliveries, surfaces, delayMs: 10 });
  const destination = { type: "partner-chat", target: `${CONTAINER}:1002` };
  live.follow(R1, destination);
  await settle(async () => (await deliveries.pending("partner-chat")).length === 1);
  const id = (n: number) => `00000000-0000-4000-8000-00000000001${n}`;
  const run = (n: number, opts: { editRef?: string; kind?: string; result?: Record<string, unknown> }) =>
    ({
      id: id(n),
      sessionId: "s",
      status: "done",
      request: {
        surface: "partner-chat",
        deliveryTarget: destination.target,
        origin: { kind: opts.kind ?? "human" },
        addressed: true,
        surfaceTools: true,
        actor: { externalId: "ada@example.com" },
        conversation: { kind: "group", threadRef: destination.target, channelRef: CONTAINER, audience: [] },
        text: "hi",
      },
      deliveryState: opts.editRef === undefined ? null : { editRef: opts.editRef },
      ...(opts.result ? { result: opts.result } : {}),
    }) as unknown as Run;
  live.settle(run(1, { editRef: "" }));
  live.settle(run(2, { editRef: "42", kind: "ambient" }));
  live.settle(run(3, { editRef: "42", result: { status: "refused", refusalKind: "model_budget", reason: "spent" } }));
  live.settle(run(4, { result: { status: "ok" } }));
  live.settle(
    run(5, {
      editRef: "42",
      result: { status: "refused", reason: "project membership changed; retry from the current project" },
    }),
  );
  live.settle(run(6, { editRef: "42", result: { status: "pending_approval" } }));
  live.unanswered(
    {
      status: "pending_approval",
      reason: "This conversation is waiting for someone else to resolve a pending approval.",
    },
    destination,
    "notice:m7",
  );
  live.unanswered({ status: "refused", reason: "empty message" }, destination, "notice:m8");
  live.unanswered({ status: "silent" }, destination, "notice:m9");
  await settle(async () => (await deliveries.pending("partner-chat")).length === 6);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    (await deliveries.pending("partner-chat")).map((d) => [d.idempotencyKey, d.destination.target, d.text]).sort(),
    [
      [
        `notice:${id(5)}`,
        destination.target,
        "⚠️ I couldn't finish that turn: project membership changed; retry from the current project",
      ],
      [`notice:${id(6)}`, destination.target, "This conversation is waiting on a pending approval."],
      ["notice:m7", destination.target, "This conversation is waiting for someone else to resolve a pending approval."],
      ["notice:m8", destination.target, "⚠️ I couldn't finish that turn: empty message"],
      [`placeholder:${R1}`, destination.target, "…"],
      [`settle:${id(4)}`, destination.target, "✓"],
    ],
  );
});

async function agentSaid(built: Awaited<ReturnType<typeof partnerChatApp>>["built"], thread: string, pattern: RegExp) {
  let said: string | undefined;
  await settle(async () => {
    const session = await built.sessions.getByThread(thread);
    const items = session ? await built.sessions.getItems(session.id) : [];
    said = items
      .map((i) => (i.kind === "AgentMessage" ? (i as { text?: string }).text : undefined))
      .find((t) => t && pattern.test(t));
    return said !== undefined;
  });
  return said!;
}

test("the agent edits its own chat message in place and never reposts it", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    await deliver(event({ body: "!post draft answer", mentions: true, eventId: "ev-e1", messageId: "1060" }));
    await settle(async () => partnerChat.shown().some((m) => m.body === "draft answer"));
    const posted = partnerChat.shown().find((m) => m.body === "draft answer")!;
    let ts: string | undefined;
    await settle(async () => {
      const own = await built.surfaceCache.readMessages(CONTAINER, {
        surface: "partner-chat",
        self: true,
        noFallback: true,
      });
      ts = own.find((m) => m.text === "draft answer")?.ts;
      return ts !== undefined;
    });
    await deliver(
      event({ body: `!edit ${ts} final answer`, mentions: true, eventId: "ev-e2", messageId: "1061", thread: "1060" }),
    );
    await settle(async () => partnerChat.shown().some((m) => m.body === "final answer"));
    assert.ok(partnerChat.received.some((r) => r.path === `/qm_surface/messages/${posted.id}/update`));
    assert.deepEqual(
      partnerChat
        .shown()
        .filter((m) => m.body === "final answer")
        .map((m) => m.id),
      [posted.id],
    );
  } finally {
    await partnerChat.close();
  }
});

test("an explicit edit the chat refuses fails its delivery instead of posting, and an edit of the reply slot closes it", async () => {
  const partnerChat = await fakePartnerChat(200, ["77"]);
  const deliveries = createDeliveryStore();
  const fake = fakeRuns({ [R1]: { target: `${CONTAINER}:1002`, editRef: "78" } });
  const outbound = createPartnerChatDeliveries({
    url: partnerChat.url,
    secret: SECRET,
    deliveries,
    app: { setRunDeliveryState: fake.setRunDeliveryState, ingestSurfaceEvents: async () => ({ upserted: 0 }) },
    runs: fake.runs,
    surfaceCache: { readMessages: async () => [] },
    serialize: (fn) => fn(),
  });
  try {
    const d = await deliveries.enqueue({
      destination: {
        type: "partner-chat",
        target: `${CONTAINER}:1002`,
        edit: { messageTs: "1793649600.00000000000000000077" },
      },
      text: "corrected",
      idempotencyKey: `post:${R1}:partner-chat:${CONTAINER}:1002:1`,
    });
    await outbound.drain();
    assert.deepEqual(
      partnerChat.received.map((r) => r.path),
      ["/qm_surface/messages/77/update"],
    );
    assert.ok((await deliveries.get(d.id))?.failedReason);
    assert.deepEqual(fake.slots, []);
    await deliveries.enqueue({
      destination: {
        type: "partner-chat",
        target: `${CONTAINER}:1002`,
        edit: { messageTs: "1793649600.00000000000000000078" },
      },
      text: "rewritten answer",
      idempotencyKey: `post:${R1}:partner-chat:${CONTAINER}:1002:2`,
    });
    await outbound.drain();
    assert.deepEqual(partnerChat.received.at(-1)?.path, "/qm_surface/messages/78/update");
    assert.deepEqual(fake.slots, [[R1, { editRef: "" }]]);
  } finally {
    await partnerChat.close();
  }
});

test("search inside a partner chat finds the chat's mirrored messages", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    await deliver(event({ body: "the launch moved to friday", eventId: "ev-s1", messageId: "1070" }));
    await deliver(event({ body: "!search launch", mentions: true, eventId: "ev-s2", messageId: "1071" }));
    const said = await agentSaid(built, `${CONTAINER}:1071`, /^search\(/);
    assert.match(said, /^search\(cache\) 2 hit\(s\) first=Ada Lovelace:.* coverage=2026-11-02T20:00:00\.000Z$/);
  } finally {
    await partnerChat.close();
  }
});

test("reading a thread starts with the message the thread hangs off, once, on the page that reaches it", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    await deliver(event({ body: "root question", eventId: "r1", messageId: "1080" }));
    await deliver(event({ body: "elsewhere", eventId: "r2", messageId: "1081" }));
    await deliver(event({ body: "first reply", eventId: "r3", messageId: "1082", thread: "1080" }));
    await deliver(event({ body: "second reply", eventId: "r4", messageId: "1083", thread: "1080" }));
    await deliver(event({ body: "third reply", eventId: "r5", messageId: "1084", thread: "1080" }));
    const read = async (count: number, before?: string) => {
      const request = await built.app.createContextRequest("partner-chat", {
        conversationTarget: `${CONTAINER}:1080`,
        count,
        ...(before ? { before } : {}),
      });
      let result: { messages: Array<{ ts: string; text: string }>; hasMore: boolean; nextBefore?: string } | undefined;
      await settle(async () => {
        const r = await built.app.getContextRequest(request.id);
        result = r?.result as typeof result;
        return r?.status === "done";
      });
      return result!;
    };
    assert.deepEqual(
      (await read(10)).messages.map((m) => m.text),
      ["root question", "first reply", "second reply", "third reply"],
    );
    const first = await read(2);
    assert.deepEqual(
      first.messages.map((m) => m.text),
      ["second reply", "third reply"],
    );
    assert.equal(first.hasMore, true);
    const second = await read(2, first.nextBefore);
    assert.deepEqual(
      second.messages.map((m) => m.text),
      ["root question", "first reply"],
    );
    assert.equal(second.hasMore, false);
    assert.deepEqual((await read(2, second.messages[0]!.ts)).messages, []);
  } finally {
    await partnerChat.close();
  }
});

test("a partner-chat history read returns a long message whole", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    const long = `${"a long design note ".repeat(60)}end`;
    await deliver(event({ body: long, eventId: "l1", messageId: "1096" }));
    const request = await built.app.createContextRequest("partner-chat", { conversationTarget: CONTAINER, count: 5 });
    let result: { messages: Array<{ text: string }> } | undefined;
    await settle(async () => {
      const r = await built.app.getContextRequest(request.id);
      result = r?.result as typeof result;
      return r?.status === "done";
    });
    assert.deepEqual(
      result!.messages.map((m) => m.text),
      [long],
    );
  } finally {
    await partnerChat.close();
  }
});

test("a bot message echoing one of the agent's own posts is dropped, while its edits and deletes apply to the stored post", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    await deliver(event({ body: "!post on the record", mentions: true, eventId: "ev-own", messageId: "1095" }));
    await settle(async () => partnerChat.shown().some((m) => m.body === "on the record"));
    const posted = partnerChat.shown().find((m) => m.body === "on the record")!;
    const rows = () =>
      built.surfaceCache
        .readMessages(CONTAINER, { surface: "partner-chat", noFallback: true })
        .then((all) => all.filter((m) => m.text === "on the record").map((m) => [Boolean(m.self), Boolean(m.bot)]));
    await settle(async () => (await rows()).length === 1);
    const echo = event({ body: "on the record", eventId: "ev-echo", messageId: posted.id, thread: "1095", bot: true });
    assert.deepEqual(await deliver(echo), { status: 200, body: { ok: true, ignored: "own_message" } });
    assert.deepEqual(await rows(), [[true, true]]);
    const own = () =>
      built.surfaceCache
        .readMessages(CONTAINER, { surface: "partner-chat", self: true, includeDeleted: true, noFallback: true })
        .then((all) =>
          all
            .filter((m) => m.ts.endsWith(`.${posted.id.padStart(20, "0")}`))
            .map((m) => [m.text, Boolean(m.bot), Boolean(m.editedAt), Boolean(m.deleted)]),
        );
    const updated = event({
      body: "on the record, revised",
      eventId: "ev-echo-edit",
      messageId: posted.id,
      thread: "1095",
      bot: true,
    });
    updated.type = "message.updated";
    assert.deepEqual(await deliver(updated), { status: 200, body: { ok: true } });
    assert.deepEqual(await own(), [["on the record, revised", true, true, false]]);
    const deleted = event({ body: "", eventId: "ev-echo-delete", messageId: posted.id, thread: "1095", bot: true });
    deleted.type = "message.deleted";
    assert.deepEqual(await deliver(deleted), { status: 200, body: { ok: true } });
    assert.deepEqual(
      (await own()).map((m) => m[3]),
      [true],
    );
    const late = event({
      body: "late revision",
      eventId: "ev-echo-late",
      messageId: posted.id,
      thread: "1095",
      bot: true,
    });
    late.type = "message.updated";
    assert.deepEqual(await deliver(late), { status: 200, body: { ok: true } });
    assert.deepEqual(
      (await own()).map((m) => m[3]),
      [true],
    );
    assert.deepEqual(
      (await built.surfaceCache.readMessages(CONTAINER, { surface: "partner-chat", noFallback: true }))
        .filter((m) => m.ts.endsWith(`.${posted.id.padStart(20, "0")}`))
        .map((m) => m.text),
      [],
    );
  } finally {
    await partnerChat.close();
  }
});

test("another bot's message is mirrored as a bot's, not the agent's, and does not engage its thread", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    assert.deepEqual(await deliver(event({ body: "bot says hi", eventId: "b1", messageId: "1090", bot: true })), {
      status: 200,
      body: { ok: true },
    });
    const rows = await built.surfaceCache.readMessages(CONTAINER, { surface: "partner-chat", noFallback: true });
    assert.deepEqual(
      rows.map((m) => [m.text, Boolean(m.self), Boolean(m.bot)]),
      [["bot says hi", false, true]],
    );
    await deliver(event({ body: "!post answering the bot", eventId: "b2", messageId: "1091", thread: "1090" }));
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(partnerChat.received.length, 0);
    const unlisted = event({ body: "who am i", eventId: "b3", messageId: "1092", bot: true });
    unlisted.message.user = { id: "10", name: "Stranger", bot: true };
    assert.equal((await deliver(unlisted)).body.ignored, "unvouched_participants");
  } finally {
    await partnerChat.close();
  }
});

test("a direct chat is only trusted when its author is its one listed person", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    const shared = event({ body: "!post private hello", eventId: "d1", messageId: "1100" });
    shared.chat.kind = "dm";
    assert.equal((await deliver(shared)).body.ignored, "not_one_to_one");
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(partnerChat.received.length, 0);
    assert.deepEqual(
      await built.surfaceCache.readMessages("partner-chat:7001:dm:88", { surface: "partner-chat", noFallback: true }),
      [],
    );
    const direct = event({ body: "!surfacename", eventId: "d2", messageId: "1101" });
    direct.chat.kind = "dm";
    direct.chat.members = direct.chat.members.filter((m) => m.id !== "6");
    assert.deepEqual(await deliver(direct), { status: 200, body: { ok: true } });
    await settle(async () => partnerChat.shown().some((m) => m.body === "surface:partner-chat"));
  } finally {
    await partnerChat.close();
  }
});

test("a thread under one of the agent's older posts is still recognised as engaged", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    await built.surfaceCache.ingest(
      Array.from({ length: 600 }, (_, i) => ({
        surface: "partner-chat",
        container: CONTAINER,
        ts: `1793649600.${String(2000 + i).padStart(20, "0")}`,
        authorId: "self",
        text: `earlier post ${i}`,
        self: true,
        bot: true,
        handled: true,
      })),
    );
    await deliver(event({ body: "!post back to this", eventId: "o1", messageId: "2700", thread: "2000" }));
    await settle(async () => partnerChat.shown().some((m) => m.body === "back to this"));
    assert.ok(await built.sessions.getByThread(`${CONTAINER}:2000`));
  } finally {
    await partnerChat.close();
  }
});
