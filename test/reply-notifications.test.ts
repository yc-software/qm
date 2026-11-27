import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { withWebTranscriptDeliveries } from "../src/delivery/web-transcript-delivery.ts";
import { fitReplyNotice, watchReplyNotices } from "../src/notifications/reply-notifications.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import type { SessionStateBus, SessionStateEvent } from "../src/runs/session-state-bus.ts";
import { encodeWirePayload } from "../src/runs/postgres-session-state-bus.ts";
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
  const shown: SessionStateEvent[] = [];
  bus.subscribe((event) => void (event.state === "notify" && shown.push(event)));
  const notifiable = async () => ["Alice@example.com"];
  for (let instance = 0; instance < 2; instance++) watchReplyNotices({ bus, sessions, notifiable });
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
  return { session, shown, reply };
}

test("a reply landing in a web chat notifies each unread participant with notifications on once, across instances", async () => {
  const { session, shown, reply } = await cronReplyInto({});
  await reply("Standup in 10 minutes");
  assert.deepEqual(
    shown.map(({ participants, notice }) => ({ participants, notice })),
    [
      {
        participants: ["alice@example.com"],
        notice: { sessionId: session.id, title: "Standups", body: "Standup in 10 minutes" },
      },
    ],
  );
  await reply("Standup now");
  assert.deepEqual(
    shown.map(({ participants, notice }) => [participants, notice?.body]),
    [
      [["alice@example.com"], "Standup in 10 minutes"],
      [["alice@example.com"], "Standup now"],
    ],
  );
});

test("a reply already read, or in an app's edit chat, does not notify", async () => {
  const read = await cronReplyInto({ alice: Date.now() + 60_000 });
  await read.reply("seen");
  const appEdit = await cronReplyInto({}, `app-edit:${randomUUID()}`);
  await appEdit.reply("published");
  assert.deepEqual([...read.shown, ...appEdit.shown], []);
});

test("long replies are cut to fit one session-state event on the Postgres bus", () => {
  const notice = fitReplyNotice({ sessionId: "s", title: "t", body: "é".repeat(5000) });
  const event = {
    threadRef: `web:alice@example.com:${randomUUID()}`,
    sessionId: randomUUID(),
    participants: ["alice@example.com"],
  };
  assert.ok(encodeWirePayload({ ...event, state: "notify", notice, at: Date.now() }));
  assert.ok(notice.body.endsWith("…") && notice.body.length > 3000);
});
