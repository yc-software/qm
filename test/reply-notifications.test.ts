import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { withWebTranscriptDeliveries } from "../src/delivery/web-transcript-delivery.ts";
import {
  fitReplyNotice,
  watchReplyNotices,
  type AddressedReplyNotice,
  type ReplyNotice,
} from "../src/notifications/reply-notifications.ts";
import { createWebPush, type VapidKeyRecord, type WebPushSubscriptionRecord } from "../src/notifications/web-push.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import type { SessionStateBus, SessionStateEvent } from "../src/runs/session-state-bus.ts";
import { createMemoryEventBus } from "../src/util/event-bus.ts";
import type { ScopeId } from "../src/types.ts";
import { testRuns } from "./support/live-run.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { personalScope } from "../src/types.ts";

const SCOPE = personalScope("alice@example.com") as ScopeId;

async function cronReplyInto(viewers: { alice?: number; bob?: number }, thread = randomUUID()) {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const bus: SessionStateBus = createMemoryEventBus<SessionStateEvent>("test");
  const deliveries = withWebTranscriptDeliveries(createDeliveryStore(), sessions, testRuns(), bus);
  const threadRef = `web:alice@example.com:${thread}`;
  const session = await sessions.getOrCreateByThread(threadRef, "dm", SCOPE, undefined, "web");
  await sessions.addParticipant(session.id, "alice@example.com", "Standups");
  await sessions.addParticipant(session.id, "bob@example.com");
  for (const [who, readAt] of Object.entries(viewers))
    await sessions.updateParticipantView(session.id, `${who}@example.com`, { readAt });
  const sent: Array<{ to: string; notice: ReplyNotice }> = [];
  const shown: SessionStateEvent[] = [];
  bus.subscribe((event) => void (event.state === "notify" && shown.push(event)));
  const send = async (notices: readonly AddressedReplyNotice[]) =>
    void sent.push(...notices.map(({ principalId: to, notice }) => ({ to, notice })));
  const notifiable = async () => ["Alice@example.com"];
  for (let instance = 0; instance < 2; instance++)
    watchReplyNotices({ bus, sessions, notifiable, publicUrl: "https://qm.example", send });
  const reply = async (text: string) => {
    await deliveries.enqueue({
      destination: { type: "web", target: threadRef, audienceScopeId: SCOPE },
      text,
      idempotencyKey: randomUUID(),
      provenance: {
        trigger: "cron",
        surface: "cron",
        fireKey: `agent:main:cron:c1:${randomUUID()}`,
        sourceScopeId: SCOPE,
        sourceThreadRef: "agent:main:cron:c1",
      },
    });
    await deliveries.pending("web");
    await new Promise((resolve) => setTimeout(resolve, 200));
  };
  return { session, sent, shown, reply };
}

test("a reply landing in a web chat notifies each unread participant with notifications on once, across instances", async () => {
  const { session, sent, shown, reply } = await cronReplyInto({});
  await reply("Standup in 10 minutes");
  const notice = {
    sessionId: session.id,
    title: "Standups",
    body: "Standup in 10 minutes",
    url: `https://qm.example/s/${session.id}`,
  };
  assert.deepEqual(sent, [{ to: "alice@example.com", notice }]);
  assert.deepEqual(
    shown.map(({ participants, notice: n }) => ({ participants, n })),
    [{ participants: ["alice@example.com"], n: notice }],
  );
  await reply("Standup now");
  assert.deepEqual(
    sent.map(({ to, notice: n }) => [to, n.body]),
    [
      ["alice@example.com", "Standup in 10 minutes"],
      ["alice@example.com", "Standup now"],
    ],
  );
});

test("a reply already read, or in an app's edit chat, does not notify", async () => {
  const read = await cronReplyInto({ alice: Date.now() + 60_000 });
  await read.reply("seen");
  const appEdit = await cronReplyInto({}, `app-edit:${randomUUID()}`);
  await appEdit.reply("published");
  assert.deepEqual([...read.sent, ...appEdit.sent], []);
});

test("long replies are cut to fit one Web Push record", () => {
  const notice = fitReplyNotice({ sessionId: "s", title: "t", body: "é".repeat(5000) });
  assert.ok(Buffer.byteLength(JSON.stringify(notice)) <= 3993);
  assert.ok(notice.body.endsWith("…") && notice.body.length > 1900);
});

test("web push posts an encrypted VAPID request and forgets subscriptions the push service has dropped", async () => {
  const maps = createPostgresMapFactory(testDatabaseUrl());
  const subscriptions = maps.map<WebPushSubscriptionRecord>(`web_push_subscriptions`, ["principalId"]);
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const statuses = [201, 410];
  const push = createWebPush({
    subscriptions,
    vapid: maps.map<VapidKeyRecord>("web_push_vapid"),
    key: deriveConnectorKey("test-secret", "web-push"),
    subject: "https://qm.example",
    fetch: async (url, init) => {
      requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)) });
      return new Response(null, { status: statuses.shift() });
    },
  });
  const endpoint = `https://push.example/${randomUUID()}`;
  await push.subscribe("carol@example.com", {
    endpoint,
    p256dh: createECDH("prime256v1").generateKeys("base64url"),
    auth: randomBytes(16).toString("base64url"),
  });
  const notice = { sessionId: "s1", title: "Hi", body: "there" };
  await push.send([{ principalId: "carol@example.com", notice }]);
  assert.equal(requests[0]!.url, endpoint);
  assert.equal(requests[0]!.headers["content-encoding"], "aes128gcm");
  assert.ok(requests[0]!.headers.authorization!.startsWith(`vapid t=`));
  assert.ok(requests[0]!.headers.authorization!.endsWith(`k=${await push.publicKey()}`));
  assert.equal((await subscriptions.all()).filter((s) => s.endpoint === endpoint).length, 1);
  await push.send([{ principalId: "carol@example.com", notice }]);
  assert.equal((await subscriptions.all()).filter((s) => s.endpoint === endpoint).length, 0);
});
