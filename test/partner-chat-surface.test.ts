import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import type { IngestEvent } from "../src/surface-cache/types.ts";
import { partnerChatPrincipal, createPartnerChatSurface } from "../src/surfaces/partner-chat/adapter.ts";
import { PARTNER_CHAT_CLAIM_MS, createPartnerChatClient } from "../src/surfaces/partner-chat/client.ts";
import {
  postPartnerChatMessage,
  setPartnerChatTyping,
  type PartnerChatMessages,
} from "../src/surfaces/partner-chat/messages.ts";
import { partnerChatSender } from "../src/surfaces/partner-chat/outbound.ts";
import { createPartnerChatApprovals } from "../src/surfaces/partner-chat/approvals.ts";
import type { KeychainApprovalView } from "../src/credentials/keychain-approval.ts";
import { setPartnerChatReaction } from "../src/surfaces/partner-chat/reactions.ts";
import { signPartnerChat, signPartnerChatRequest } from "../src/surfaces/partner-chat/protocol.ts";
import { createDeliveryRelay } from "../src/delivery/relay.ts";
import type { DeliveryStore } from "../src/delivery/delivery-store.ts";
import { buildApp } from "./support/build-app.ts";
import { runNowSettled, settle } from "./support/settle.ts";
import { testConfig } from "./support/test-config.ts";
import { loadConfig } from "../src/config.ts";
import { scopeId } from "../src/types.ts";
import { createPartnerChatNotices, partnerChatRunNotice } from "../src/surfaces/partner-chat/notices.ts";
import { runResultDelivery, wireRunResultDeliveries } from "../src/delivery/run-result-delivery.ts";
import type { Run } from "../src/runs/run-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { ownerUrl, TEST_TENANT } from "./support/test-tenant.ts";

const SECRET = "partner-chat-test-secret-0123456789abcdef";
const tenantFor = async () => TEST_TENANT;
const NO_BLOBS = { readBlob: async () => Buffer.alloc(0), readFileArtifact: async () => Buffer.alloc(0) };
const PROVENANCE = { trigger: "cron", surface: "partner-chat", fireKey: "f", sourceScopeId: "s", sourceThreadRef: "t" };

interface Received {
  path: string;
  body: Record<string, unknown>;
  signed: boolean;
}

async function fakePartnerChat(status = 200) {
  const received: Received[] = [];
  const messages = new Map<
    string,
    Record<"chat_id" | "thread_id" | "body", unknown> & { actions?: unknown; to?: unknown }
  >();
  let next = 41;
  const keyed = new Map<string, string>();
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      received.push({
        path: req.url ?? "",
        body,
        signed:
          req.headers["x-agent-app-account"] === "7001" &&
          req.headers.authorization === undefined &&
          req.headers["x-agent-app-signature"] ===
            signPartnerChatRequest(
              SECRET,
              String(req.headers["x-agent-app-request-timestamp"]),
              "7001",
              req.url ?? "",
              raw,
            ) &&
          Math.abs(Date.now() / 1000 - Number(req.headers["x-agent-app-request-timestamp"])) <= 300,
      });
      const key = String(body.client_message_id);
      const target = messages.get(String(body.message_id));
      const change = status === 200 && (req.url ?? "").startsWith("/agent_app/messages/");
      const id = change ? String(body.message_id) : (keyed.get(key) ?? String(++next));
      if (change && target && req.url === "/agent_app/messages/update")
        Object.assign(target, { body: body.body }, body.actions ? { actions: body.actions } : {});
      else if (change && target) messages.delete(id);
      else if (status === 200 && req.url === "/agent_app/messages" && !(body.recipient_user_id && body.thread_id))
        messages.set(keyed.set(key, id).get(key)!, {
          chat_id: body.chat_id,
          thread_id: body.thread_id,
          body: body.body,
          ...(body.actions ? { actions: body.actions } : {}),
          ...(body.recipient_user_id ? { to: body.recipient_user_id } : {}),
        });
      const privateReply = req.url === "/agent_app/messages" && body.recipient_user_id && body.thread_id;
      let code = change && !target ? 404 : status;
      if (privateReply) code = 422;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(code === 200 ? { message_id: id } : { error: change ? "message not found" : "nope" }));
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
    appPost?: boolean;
    protocol?: 2;
  } = {},
) {
  return {
    ...(overrides.protocol ? { protocol: overrides.protocol } : {}),
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
      ...(overrides.appPost ? { app_post: true } : {}),
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
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "partner-chat-surface-")),
    partnerChat: { url: partnerChat.url, secret: SECRET },
    emailAuthDomain: "example.com",
  });
  const owner = createPgPool(ownerUrl(config.databaseUrl!).toString());
  await owner.q(`UPDATE tenants SET settings = '{"partnerChatAccount":"7001"}' WHERE id = $1`, [TEST_TENANT]);
  await owner.close();
  const built = buildApp(config);
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

function onBothProtocols(name: string, run: (version: { protocol?: 2 }) => Promise<void>) {
  test(name, () => run({}));
  test(`${name}, on protocol 2 as well`, () => run({ protocol: 2 }));
}

const MENTIONED = "an @-mention starts a turn whose reply lands in the chat once, even when the event is redelivered";
onBothProtocols(MENTIONED, async (version) => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    const mention = event({ body: "!post on it", mentions: true, eventId: "ev-m", messageId: "1002", ...version });
    assert.equal((await deliver(mention)).status, 200);
    assert.equal((await deliver(mention)).status, 200);
    await settle(async () => partnerChat.shown().some((m) => m.body === "on it"));
    await new Promise((r) => setTimeout(r, 1_000));
    assert.deepEqual(
      partnerChat.shown().map((m) => [m.chat_id, m.thread_id, m.body]),
      [["88", "1002", "on it"]],
    );
    assert.ok(partnerChat.received.every((r) => r.signed));
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
    assert.deepEqual(
      await Promise.all(
        ["ada@example.com", "grace@example.com", "eve@example.com"].map((p) =>
          built.directory.groupMember(CONTAINER, p),
        ),
      ),
      [true, true, false],
    );
    assert.ok(await built.sessions.getByThread(`partner-chat:${CONTAINER}:ambient:1793649600.00000000000000001003`));
  } finally {
    await partnerChat.close();
  }
});

const FOLLOWED =
  "a thread the agent already posted in is followed without a mention, and an aside between people gets no reply";
onBothProtocols(FOLLOWED, async (version) => {
  const { built, partnerChat, deliver: deliverEvent } = await partnerChatApp();
  const deliver = (payload: ReturnType<typeof event>) => deliverEvent({ ...payload, ...version });
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
    await deliver(
      event({ body: "sounds good, see you at lunch", eventId: "ev-aside", messageId: "1015", thread: "1008" }),
    );
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

test("a turn in a partner-chat thread may schedule into the thread or the whole chat, and a whole-chat cron posts at top level", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    await deliver(event({ body: "!post sure", mentions: true, eventId: "ev-c", messageId: "1030" }));
    await settle(async () => partnerChat.received.some((r) => r.body.body === "sure"));
    const [run] = await built.runs.list({ threadRef: `${CONTAINER}:1030` });
    assert.deepEqual(run?.request.deliveryCandidates, [
      { target: `${CONTAINER}:1030`, label: "this thread" },
      { target: CONTAINER, label: "Launch crew (the whole chat)" },
    ]);
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
    const fired = partnerChat.received.find((r) => r.body.body === "standup time")?.body;
    assert.equal(fired?.chat_id, "88");
    assert.equal(fired?.thread_id, undefined);
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

function outboundFor(url: string, deliveries = createDeliveryStore(), mirrored: IngestEvent[] = []) {
  const send = partnerChatSender({
    client: createPartnerChatClient({ url, secret: SECRET }),
    blobs: NO_BLOBS,
    app: {
      tenantFor,
      getApproval: async () => null,
      readSurfaceMessages: async () => [],
      ingestSurfaceEvents: async (events) => (mirrored.push(...events), { upserted: events.length }),
    },
  });
  return { deliveries, mirrored, settled: (until: () => Promise<boolean>) => relayUntil(deliveries, send, until) };
}

async function relayUntil(
  deliveries: DeliveryStore,
  send: ReturnType<typeof partnerChatSender>,
  until: () => Promise<boolean>,
): Promise<void> {
  const relay = createDeliveryRelay(deliveries, { type: "partner-chat", send, claimMs: PARTNER_CHAT_CLAIM_MS });
  withTenant(TEST_TENANT, () => relay.start());
  try {
    await settle(until);
  } finally {
    await relay.stop();
  }
}

test("partner-chat deliveries are signed posts mirrored as the agent's own", async () => {
  const partnerChat = await fakePartnerChat();
  const { deliveries, mirrored, settled } = outboundFor(`${partnerChat.url}/`);
  try {
    const surface = createPartnerChatSurface({ deliveries, surfaceCache: { readMessages: async () => [] } });
    await surface.post(
      { surface: "partner-chat", account: "7001", kind: "group", container: "88", thread: "1009" },
      { text: "scheduled hello", provenance: PROVENANCE },
      "cron:fire-1",
    );
    await deliveries.enqueue({
      destination: { type: "partner-chat", target: CONTAINER },
      text: "Here is the full answer",
      attachments: [{ name: "chart.png", mimeType: "image/png", blob: { kind: "inline", data: "" } }] as never,
      idempotencyKey: "run:00000000-0000-4000-8000-000000000001",
    });
    await settled(async () => (await deliveries.pending("partner-chat")).length === 0);
    assert.deepEqual(
      partnerChat.received.map((r) => [r.path, r.body, r.signed]),
      [
        [
          "/agent_app/messages",
          { client_message_id: "cron:fire-1", chat_id: "88", thread_id: "1009", body: "scheduled hello" },
          true,
        ],
        [
          "/agent_app/messages",
          {
            client_message_id: "run:00000000-0000-4000-8000-000000000001",
            chat_id: "88",
            body: "Here is the full answer",
          },
          true,
        ],
      ],
    );
    assert.deepEqual(
      mirrored.map((m) => [m.ts.split(".")[1]!.replace(/^0+/, ""), m.sub, m.text, m.self]),
      [
        ["42", "1009", "scheduled hello", true],
        ["43", null, "Here is the full answer", true],
      ],
    );
    assert.equal((await deliveries.pending("partner-chat")).length, 0);
  } finally {
    await partnerChat.close();
  }
});

test("partner-chat rejections fail the delivery with the chat's reason while auth and server errors leave it for retry", async () => {
  for (const [status, failedReason] of [
    [404, "partner-chat 404: nope"],
    [401, null],
    [503, null],
  ] as const) {
    const partnerChat = await fakePartnerChat(status);
    const { deliveries, settled } = outboundFor(partnerChat.url);
    try {
      const d = await deliveries.enqueue({
        destination: { type: "partner-chat", target: CONTAINER },
        text: "hi",
        idempotencyKey: `k-${status}`,
      });
      await settled(async () => partnerChat.received.length > 0);
      const after = await deliveries.get(d.id);
      assert.equal(after?.failedReason ?? null, failedReason, String(status));
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

test("partner-chat config requires the url and secret together", () => {
  assert.throws(() => loadConfig({ PARTNER_CHAT_URL: "https://chat.example" }), /must be set together/);
  assert.deepEqual(
    loadConfig({ PARTNER_CHAT_URL: "https://chat.example", PARTNER_CHAT_SECRET: "s", PARTNER_CHAT_LABEL: "Acme Chat" })
      .partnerChat,
    { url: "https://chat.example", secret: "s", label: "Acme Chat" },
  );
});

test("a direct run that ends refused or waiting on an approval, or a message answered without a run, gets one notice in its reply thread", async () => {
  const deliveries = createDeliveryStore();
  const notices = createPartnerChatNotices({ deliveries });
  const destination = { type: "partner-chat", target: `${CONTAINER}:1002` };
  const id = (n: number) => `00000000-0000-4000-8000-00000000001${n}`;
  const run = (n: number, opts: { kind?: string; result?: Record<string, unknown> }) =>
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
      ...(opts.result ? { result: opts.result } : {}),
    }) as unknown as Run;
  const ran = [
    run(1, {}),
    run(2, { kind: "ambient", result: { status: "refused", reason: "spent" } }),
    run(4, { result: { status: "ok", reply: "done" } }),
    run(5, { result: { status: "refused", reason: "project membership changed; retry from the current project" } }),
    run(6, { result: { status: "pending_approval" } }),
    run(7, { result: { status: "pending_approval", reason: "Waiting on approval to run it." } }),
  ];
  for (const r of ran) {
    const d = runResultDelivery(r, undefined, partnerChatRunNotice);
    if (d) await deliveries.enqueue(d);
  }
  notices.unanswered(
    {
      status: "pending_approval",
      reason: "This conversation is waiting for someone else to resolve a pending approval.",
    },
    destination,
    "notice:m7",
  );
  notices.unanswered({ status: "refused", reason: "empty message" }, destination, "notice:m8");
  notices.unanswered({ status: "silent" }, destination, "notice:m9");
  await settle(async () => (await deliveries.pending("partner-chat")).length === 5);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    (await deliveries.pending("partner-chat")).map((d) => [d.idempotencyKey, d.destination.target, d.text]).sort(),
    [
      [
        `run:${id(5)}`,
        destination.target,
        "⚠️ I couldn't finish that turn: project membership changed; retry from the current project",
      ],
      [`run:${id(6)}`, destination.target, "This conversation is waiting on a pending approval."],
      [`run:${id(7)}`, destination.target, "Waiting on approval to run it."],
      ["notice:m7", destination.target, "This conversation is waiting for someone else to resolve a pending approval."],
      ["notice:m8", destination.target, "⚠️ I couldn't finish that turn: empty message"],
    ].sort(),
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

test("an event for a message the agent posted is dropped even before the post is recorded, while its edits and deletes apply to the stored post", async () => {
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
    const early = event({ body: "not yet recorded", eventId: "ev-early", messageId: "1199", bot: true, appPost: true });
    assert.deepEqual(await deliver(early), { status: 200, body: { ok: true, ignored: "own_message" } });
    const earlyEdit = event({
      body: "edited early",
      eventId: "ev-early-edit",
      messageId: "1199",
      bot: true,
      appPost: true,
    });
    earlyEdit.type = "message.updated";
    assert.deepEqual(await deliver(earlyEdit), { status: 200, body: { ok: true, ignored: "own_message" } });
    assert.equal(
      (await built.surfaceCache.readMessages(CONTAINER, { surface: "partner-chat", noFallback: true })).some(
        (m) => m.text === "not yet recorded" || m.text === "edited early",
      ),
      false,
    );
    const echo = event({
      body: "on the record",
      eventId: "ev-echo",
      messageId: posted.id,
      thread: "1095",
      bot: true,
      appPost: true,
    });
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
      appPost: true,
    });
    updated.type = "message.updated";
    assert.deepEqual(await deliver(updated), { status: 200, body: { ok: true } });
    assert.deepEqual(await own(), [["on the record, revised", true, true, false]]);
    const deleted = event({
      body: "",
      eventId: "ev-echo-delete",
      messageId: posted.id,
      thread: "1095",
      bot: true,
      appPost: true,
    });
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
      appPost: true,
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

test("a protocol 2 turn is answered by the turn driver: once in a direct chat, and to the asker alone when a group turn fails", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    const direct = event({ body: "!preamble On it.", eventId: "v2-d", messageId: "1201", protocol: 2 });
    direct.chat.kind = "dm";
    direct.chat.members = direct.chat.members.filter((m) => m.id !== "6");
    assert.equal((await deliver(direct)).status, 200);
    assert.equal((await deliver(direct)).status, 200);
    await deliver(event({ body: "!refuse", mentions: true, eventId: "v2-g", messageId: "1202", protocol: 2 }));
    const react = { body: "!react 1793649600.00000000000000001203 tada", mentions: true };
    await deliver(event({ ...react, eventId: "v1-r", messageId: "1203" }));
    await deliver(event({ ...react, eventId: "v2-r", messageId: "1204", protocol: 2 }));
    const messages = () => partnerChat.received.filter((r) => r.path === "/agent_app/messages");
    const reacted = () => partnerChat.received.filter((r) => r.body.name === "tada").map((r) => r.body.message_id);
    await settle(async () => messages().length >= 3 && reacted().length >= 1);
    await new Promise((r) => setTimeout(r, 1_500));
    const sent = messages();
    const posts = sent.map(({ body }) => [
      body.thread_id,
      body.recipient_user_id,
      String(body.client_message_id).split(":")[0],
      String(body.body).split(" — ")[0],
    ]);
    assert.deepEqual(reacted(), ["1203"]);
    assert.deepEqual(posts.map(String).sort(), [
      ",,run,All clear",
      ",,status,On it.",
      ",5,post,I hit an error and couldn't finish",
      "1203,,post,[not reacted] Reactions aren't supported in this conversation.",
    ]);
    await settle(async () => (await built.deliveries.pending("partner-chat")).length === 0);
    const mirrored = await built.surfaceCache.readMessages(CONTAINER, { surface: "partner-chat", self: true });
    assert.deepEqual(
      mirrored.map((m) => m.sub),
      ["1203"],
    );
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

test("partner-chat event and post signatures follow the agent-app scheme", () => {
  const hmac = (data: string) => createHmac("sha256", SECRET).update(data).digest("hex");
  assert.equal(signPartnerChat(SECRET, "1793649600", "{}"), `v0=${hmac("v0:1793649600:{}")}`);
  assert.equal(
    signPartnerChatRequest(SECRET, "1793649600", "7001", "/agent_app/messages", "{}"),
    `v0=${hmac("v0:1793649600:7001:/agent_app/messages:{}")}`,
  );
});

test("a run-end notice lost before its enqueue is recovered by the run-result sweep, once", async () => {
  const deliveries = createDeliveryStore();
  const ended = {
    id: "00000000-0000-4000-8000-000000000031",
    tenantId: TEST_TENANT,
    sessionId: "s",
    status: "done",
    finishedAt: Date.now() - 120_000,
    request: {
      surface: "partner-chat",
      deliveryTarget: `${CONTAINER}:1002`,
      origin: { kind: "human" },
      addressed: true,
      surfaceTools: true,
      actor: { externalId: "ada@example.com" },
      conversation: { kind: "group", threadRef: `${CONTAINER}:1002`, channelRef: CONTAINER, audience: [] },
      text: "hi",
    },
    result: { status: "pending_approval", reason: "Waiting on approval to run it." },
  } as unknown as Run;
  const recovery = wireRunResultDeliveries(
    {
      onTerminal: () => () => {},
      terminalFinished: async (cursor: { id: string }) => (cursor.id === "" ? [ended] : []),
      inFlightForThread: async () => [],
    } as unknown as Parameters<typeof wireRunResultDeliveries>[0],
    deliveries,
    undefined,
    undefined,
    partnerChatRunNotice,
  );
  assert.equal(await recovery.sweep(), 1);
  assert.equal(await recovery.sweep(), 0);
  assert.deepEqual(
    (await deliveries.pending("partner-chat")).map((d) => [d.idempotencyKey, d.destination.target, d.text]),
    [[`run:${ended.id}`, `${CONTAINER}:1002`, "Waiting on approval to run it."]],
  );
});

test("a retryable failure holds back later posts to the same chat target only", async () => {
  const deliveries = createDeliveryStore();
  const sent: string[] = [];
  const send = partnerChatSender({
    blobs: NO_BLOBS,
    app: {
      tenantFor,
      getApproval: async () => null,
      readSurfaceMessages: async () => [],
      ingestSurfaceEvents: async () => ({ upserted: 0 }),
    },
    client: createPartnerChatClient({
      url: "https://chat.example",
      secret: SECRET,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { chat_id: string; body: string };
        sent.push(body.body);
        return body.chat_id === "88"
          ? new Response(JSON.stringify({ error: "busy" }), { status: 503 })
          : new Response(JSON.stringify({ message_id: String(50 + sent.length) }), { status: 200 });
      },
    }),
  });
  for (const [chat, text] of [
    ["88", "first in 88"],
    ["88", "second in 88"],
    ["99", "only in 99"],
  ] as const)
    await deliveries.enqueue({
      destination: { type: "partner-chat", target: `partner-chat:7001:group:${chat}` },
      text,
      idempotencyKey: text,
    });
  await relayUntil(deliveries, send, async () => sent.length >= 2);
  assert.deepEqual(sent.toSorted(), ["first in 88", "only in 99"]);
  assert.deepEqual(
    (await deliveries.pending("partner-chat")).map((d) => d.text),
    ["first in 88", "second in 88"],
  );
});

interface ShownAction {
  id: string;
  label: string;
  style: string;
}

test("a pending approval arrives as a card with buttons that only the person who asked can settle", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    const ask = { body: "!paused-approval git push", mentions: true, eventId: "ev-ask", messageId: "1002" };
    await deliver(event({ ...ask, protocol: 2 }));
    const card = () => partnerChat.shown().find((m) => String(m.body).includes("git push") && Array.isArray(m.actions));
    await settle(async () => card() !== undefined);
    const posted = card()!;
    const actions = posted.actions as ShownAction[];
    assert.match(String(posted.body), /Approval needed[\s\S]*git push[\s\S]*Flagged as/);
    assert.equal(posted.thread_id, "1002");
    assert.deepEqual(
      actions.map((a) => [a.label, a.style]),
      [
        ["Allow once", "primary"],
        ["Allow session", "default"],
        ["Allow always", "default"],
        ["Deny", "danger"],
      ],
    );
    const click = (eventId: string, user: Record<string, string>) =>
      deliver({
        ...event({ bot: true, appPost: true, messageId: posted.id, thread: "1002", eventId }),
        protocol: 2,
        type: "action.invoked",
        action: { id: actions.at(-1)!.id, user },
      });
    assert.equal(
      (await click("ev-click-1", { id: "77", email: "eve@example.com" })).body.ignored,
      "unvouched_participants",
    );
    await click("ev-click-2", { id: "6", email: "grace@example.com", name: "Grace Hopper" });
    assert.ok(partnerChat.shown().some((m) => m.to === "6" && /Only the person who requested/.test(String(m.body))));
    assert.equal((card()!.actions as ShownAction[]).length, 4);
    await click("ev-click-3", { id: "5", email: "ada@example.com", name: "Ada Lovelace" });
    const settled = partnerChat.shown().find((m) => m.id === posted.id)!;
    assert.deepEqual([settled.body, settled.actions], ["Denied by Ada Lovelace · `git push`", []]);
    await settle(async () => {
      const session = await built.sessions.getByThread(`${CONTAINER}:1002`);
      const items = session ? await built.sessions.getItems(session.id) : [];
      return items.some((i) => /denied this pending operation/.test((i as { text?: string }).text ?? ""));
    });
    await new Promise((r) => setTimeout(r, 1_000));
    assert.ok(!partnerChat.shown().some((m) => /couldn't finish|waiting on a pending approval/.test(String(m.body))));
  } finally {
    await partnerChat.close();
  }
});

test("a credential request is a card its owner decides from the chat, and a decision made elsewhere clears the posted card", async () => {
  const partnerChat = await fakePartnerChat();
  const ask = { id: "ask1", status: "pending", requestedMode: "once", requesterScopeId: "group:g1" };
  const view = () => ({ ask, service: "github", conversation: "Launch crew" }) as unknown as KeychainApprovalView;
  const decided: unknown[] = [];
  const keychainApprovals = {
    card: async () => view(),
    decide: async (...args: unknown[]) => {
      decided.push(args);
      ask.status = "approved";
      return view();
    },
  };
  const client = createPartnerChatClient({ url: partnerChat.url, secret: SECRET });
  const app = {
    tenantFor,
    getApproval: async () => null,
    readSurfaceMessages: async () => [],
    ingestSurfaceEvents: async () => ({ upserted: 1 }),
  };
  const deliveries = createDeliveryStore();
  const send = partnerChatSender({ client, blobs: NO_BLOBS, app, keychainApprovals });
  const destination = { type: "partner-chat", target: `${CONTAINER}:1002`, keychainAskId: "ask1" };
  try {
    await deliveries.enqueue({ destination, text: "notice", idempotencyKey: "ask:ask1:notice" });
    await relayUntil(deliveries, send, async () => partnerChat.shown().length === 1);
    const [card] = partnerChat.shown();
    assert.equal(
      card!.body,
      "🔒 **Approval needed.**\n\nUse your **github** credential in Launch crew (one-time access).",
    );
    const actions = card!.actions as ShownAction[];
    assert.deepEqual(
      actions.map((a) => a.label),
      ["Allow once", "Allow", "Deny"],
    );
    const actor = { externalId: "ada@example.com" };
    await createPartnerChatApprovals({ client, app: app as never, keychainApprovals }).invoke({
      eventId: "ev-1",
      account: "7001",
      kind: "group",
      chat: "88",
      messageId: card!.id,
      actionId: actions[0]!.id,
      userId: "5",
      actor,
    });
    assert.deepEqual(decided, [["ask1", actor, "once"]]);
    const resolved = "**Approved — one-time access.**\n\nUse your **github** credential in Launch crew.";
    assert.deepEqual([partnerChat.shown()[0]!.body, partnerChat.shown()[0]!.actions], [resolved, []]);
    await deliveries.enqueue({ destination, text: "resolved", idempotencyKey: "ask:ask1:resolved" });
    await relayUntil(deliveries, send, async () => partnerChat.received.length === 4);
    assert.deepEqual(
      partnerChat.received.slice(2).map((r) => [r.path, r.body.client_message_id, r.body.body, r.body.actions]),
      [
        ["/agent_app/messages", "ask:ask1:notice", resolved, undefined],
        ["/agent_app/messages/update", undefined, resolved, []],
      ],
    );
  } finally {
    await partnerChat.close();
  }
});

test("a status post becomes the final reply in place, and the agent can revise or delete what it posted", async () => {
  const { built, partnerChat } = await partnerChatApp();
  const deliveries = createDeliveryStore();
  const ops: PartnerChatMessages = {
    client: createPartnerChatClient({ url: partnerChat.url, secret: SECRET }),
    app: built.app,
  };
  const send = partnerChatSender({ ...ops, app: built.app, blobs: NO_BLOBS });
  const thread = { account: "7001", kind: "group" as const, chat: "88", thread: "1009" };
  const status = () =>
    withTenant(TEST_TENANT, () => postPartnerChatMessage(ops, thread, { text: "On it", idempotencyKey: "status:r1" }));
  const deliver = async (destination: Record<string, unknown>, text: string, idempotencyKey: string) => {
    const d = await deliveries.enqueue({
      destination: { type: "partner-chat", target: `${CONTAINER}:1009`, ...destination },
      text,
      idempotencyKey,
    });
    await relayUntil(deliveries, send, async () => (await deliveries.pending("partner-chat")).length === 0);
    return (await deliveries.get(d.id))?.failedReason ?? null;
  };
  const cached = () =>
    built.surfaceCache
      .readMessages(CONTAINER, { surface: "partner-chat", self: true, includeDeleted: true, noFallback: true })
      .then((all) => all.map((m) => [m.ts, m.sub, m.text, Boolean(m.editedAt), Boolean(m.deleted)]));
  try {
    const ref = (await status())!;
    assert.equal(await status(), ref);
    assert.deepEqual(await cached(), [[ref, "1009", "On it", false, false]]);

    assert.equal(await deliver({ editRef: ref }, "Here is the answer", "run:r1"), null);
    assert.deepEqual(partnerChat.shown(), [{ id: "42", chat_id: "88", thread_id: "1009", body: "Here is the answer" }]);
    assert.deepEqual(await cached(), [[ref, "1009", "Here is the answer", true, false]]);

    assert.equal(await deliver({ edit: { messageTs: ref } }, "Here is the answer, revised", "revise"), null);
    assert.equal(await deliver({ edit: { messageTs: ref } }, " ", "blank"), null);
    assert.deepEqual(
      partnerChat.shown().map((m) => m.body),
      ["Here is the answer, revised"],
    );
    assert.equal(
      await deliver({ edit: { messageTs: "1793649600.00000000000000000999" } }, "nothing there", "stray"),
      "partner-chat 404: message not found",
    );

    assert.equal(await deliver({ editRef: "1793649600.00000000000000000999" }, "Posted afresh", "run:r2"), null);
    assert.deepEqual(
      partnerChat.shown().map((m) => [m.id, m.body]),
      [
        ["42", "Here is the answer, revised"],
        ["43", "Posted afresh"],
      ],
    );

    assert.equal(await deliver({ delete: { messageTs: ref } }, "", "remove"), null);
    assert.equal(await deliver({ editRef: (await cached())[1]![0] as string }, "", "run:r3"), null);
    assert.deepEqual(partnerChat.shown(), []);
    assert.deepEqual(
      (await cached()).map((m) => m[4]),
      [true, true],
    );

    await setPartnerChatTyping(ops.client, thread, true);
    await setPartnerChatTyping(ops.client, { account: "7001", chat: "88" }, false);
    assert.deepEqual(
      partnerChat.received.slice(-2).map((r) => [r.path, r.body, r.signed]),
      [
        ["/agent_app/typing", { chat_id: "88", thread_id: "1009", typing: true }, true],
        ["/agent_app/typing", { chat_id: "88", typing: false }, true],
      ],
    );
  } finally {
    await partnerChat.close();
  }
});

test("a react delivery adds the agent's reaction under the chat's own emoji name, and an unknown emoji is refused", async () => {
  const partnerChat = await fakePartnerChat();
  const { deliveries, mirrored, settled } = outboundFor(partnerChat.url);
  try {
    const react = (emoji: string) =>
      deliveries.enqueue({
        destination: {
          type: "partner-chat",
          target: `${CONTAINER}:1009`,
          react: { messageTs: "1793649600.00000000000000001021", emoji },
        },
        text: "",
        idempotencyKey: `react-${emoji}`,
      });
    await react("thumbsup");
    await react("👍🏽");
    const unknown = await react("not_a_real_emoji");
    await settled(async () => (await deliveries.pending("partner-chat")).length === 0);
    await setPartnerChatReaction(
      createPartnerChatClient({ url: partnerChat.url, secret: SECRET }),
      { account: "7001", chat: "88" },
      "1021",
      ":white_check_mark:",
      false,
    );
    assert.deepEqual(
      partnerChat.received.map((r) => [r.path, r.body, r.signed]),
      [
        ["/agent_app/reactions/add", { chat_id: "88", message_id: "1021", name: "+1" }, true],
        ["/agent_app/reactions/add", { chat_id: "88", message_id: "1021", name: "+1", skin_tone: 4 }, true],
        ["/agent_app/reactions/remove", { chat_id: "88", message_id: "1021", name: "white_check_mark" }, true],
      ],
    );
    assert.equal(
      (await deliveries.get(unknown.id))?.failedReason,
      'partner-chat: no emoji is named "not_a_real_emoji"',
    );
    assert.deepEqual(mirrored, []);
  } finally {
    await partnerChat.close();
  }
});

test("a person's reaction to the agent's message starts one turn, while the agent's own and reactions it has no stake in start none", async () => {
  const { built, partnerChat, deliver } = await partnerChatApp();
  try {
    await deliver(event({ body: "!post should the bot deploy", mentions: true, eventId: "ev-ask", messageId: "1002" }));
    await settle(async () => partnerChat.shown().length === 1);
    const asked = partnerChat.shown()[0]!.id;
    const reaction = (eventId: string, reactor: "5" | "6" | "9", on: "agent" | "other") => {
      const base = event({ eventId, body: on === "agent" ? "should the bot deploy" : "is the bot around" });
      return {
        ...base,
        protocol: 2,
        type: "reaction.added",
        ...(on === "agent" ? { thread_id: "1002" } : {}),
        reaction: { name: "white_check_mark", user: base.chat.members.find((m) => m.id === reactor) },
        message:
          on === "agent"
            ? { ...base.message, id: asked, user: { id: "9", name: "QM", bot: true }, app_post: true }
            : { ...base.message, id: "1050" },
      };
    };
    const { protocol: _unversioned, ...unversioned } = reaction("ev-r0", "5", "agent");
    assert.equal((await deliver(unversioned)).status, 400);
    assert.deepEqual((await deliver(reaction("ev-r1", "9", "agent"))).body, { ok: true, ignored: "bot_reaction" });
    assert.deepEqual((await deliver(reaction("ev-r2", "6", "other"))).body, { ok: true, ignored: "no_stake" });
    const approve = reaction("ev-r3", "5", "agent");
    assert.deepEqual((await deliver(approve)).body, { ok: true });
    assert.deepEqual((await deliver(approve)).body, { ok: true });
    const reactionTurns = async () =>
      (await built.runs.list({ threadRef: `${CONTAINER}:1002` }))
        .map((run) => run.request.text)
        .filter((text) => text.startsWith("[Chat reaction]"));
    await settle(async () => (await reactionTurns()).length > 0);
    await new Promise((r) => setTimeout(r, 1_000));
    assert.deepEqual(await reactionTurns(), [
      '[Chat reaction] Ada Lovelace reacted with :white_check_mark: on your message: "should the bot deploy".',
    ]);
  } finally {
    await partnerChat.close();
  }
});
