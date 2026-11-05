import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createTranscriptSource } from "../src/sessions/transcript-source.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { withWebTranscriptDeliveries } from "../src/delivery/web-transcript-delivery.ts";
import { forModelContext, forSearchView } from "../src/agent/context-compaction.ts";
import { scopeId } from "../src/types.ts";
import { sleep } from "../src/util/async.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { holdThread, testRuns } from "./support/live-run.ts";

const scope = scopeId("personal", "alice");
const databaseUrl = process.env.DATABASE_URL;

const history = async (sessions: SessionStore, sessionId: string) => sessions.getItems(sessionId);

for (const backend of ["memory", "postgres"] as const) {
  test(
    `${backend}: Slack receipts render once across pages and stay out of model context`,
    {
      skip: backend === "postgres" && !databaseUrl ? "requires DATABASE_URL" : false,
    },
    async () => {
      const sessions: SessionStore =
        backend === "memory" ? createPostgresSessionStore(testDatabaseUrl()) : createPostgresSessionStore(databaseUrl!);
      const session = await sessions.getOrCreateByThread(`dm:${randomUUID()}`, "dm", scope, undefined, "slack");
      await sessions.addParticipant(session.id, "alice");
      const writer = { sessionId: session.id };
      const receipt = await sessions.append(writer, {
        kind: "UserMessage",
        text: "Receipt text",
        externalId: "100.123",
        body: { slackReplyReceipt: true, deliveryKey: "sent-1" },
      });
      const middle = await sessions.append(writer, { kind: "AgentMessage", text: "Intervening reply" });
      const source = createTranscriptSource(sessions);
      assert.deepEqual(
        (await source.forViewer(session.id, "alice")).items.map((e) => e.seq),
        [receipt.seq, middle.seq],
      );
      assert.deepEqual(
        forModelContext(await history(sessions, session.id)).map((e) => e.seq),
        [middle.seq],
      );
      assert.deepEqual(
        forSearchView(await history(sessions, session.id)).map((e) => e.seq),
        [middle.seq],
      );
      await sessions.removeParticipant(session.id, "alice");
      await sessions.addParticipant(session.id, "bob");
      const event = await sessions.append(writer, { kind: "UserMessage", text: "Receipt text", externalId: "100.123" });
      const page = await source.forRender(session.id, { limit: 1 });
      assert.deepEqual(
        page.items.map((e) => e.seq),
        [event.seq],
      );
      assert.equal(page.earlier, 1);
      const previous = await source.forRender(session.id, { limit: 1, beforeSeq: event.seq });
      assert.deepEqual(
        previous.items.map((e) => e.seq),
        [middle.seq],
      );
      assert.equal(previous.earlier, 0);
      assert.deepEqual((await source.forViewer(session.id, "alice")).items, []);
      assert.deepEqual(
        forModelContext(await history(sessions, session.id)).map((e) => e.seq),
        [middle.seq, event.seq],
      );
      assert.deepEqual(
        (await source.forViewer(session.id, "bob")).items.map((e) => e.seq),
        [middle.seq, event.seq],
      );
    },
  );

  test(
    `${backend}: receipt retries remain pending and deduplicate beyond the transcript tail`,
    {
      skip: backend === "postgres" && !databaseUrl ? "requires DATABASE_URL" : false,
    },
    async () => {
      const sessions: SessionStore =
        backend === "memory" ? createPostgresSessionStore(testDatabaseUrl()) : createPostgresSessionStore(databaseUrl!);
      const inner =
        backend === "memory"
          ? createDeliveryStore({ maxAgeMs: 1 })
          : createPostgresDeliveryStore(databaseUrl!, { maxAgeMs: 1 });
      const thread = `dm:${randomUUID()}`;
      const session = await sessions.getOrCreateByThread(thread, "dm", scope, undefined, "slack");
      const runs = testRuns();
      const finishTurn = await holdThread(runs, thread);
      const deliveries = withWebTranscriptDeliveries(inner, sessions, runs);
      const row = await deliveries.enqueue({
        destination: {
          type: "web",
          target: thread,
          audienceScopeId: scope,
          webTranscript: { kind: "slack_reply", sessionId: session.id, ts: "200.123", name: "Alice" },
        },
        text: "Durable receipt",
        idempotencyKey: `receipt:${randomUUID()}`,
      });
      row.createdAt = Date.now() - 7 * 60 * 60_000;
      await sleep(10);
      assert.deepEqual(await deliveries.claimPending("web", 1), []);
      assert.equal((await inner.get(row.id))?.expiredAt, undefined);
      assert.equal((await sessions.getItems(session.id)).length, 0);
      await finishTurn();
      await sleep(10);
      assert.equal((await deliveries.claimPending("web", 1)).length, 1);
      await sessions.appendMany(
        { sessionId: session.id },
        Array.from({ length: 210 }, (_, i) => ({ kind: "AgentMessage" as const, text: `Reply ${i}` })),
      );
      const restarted = withWebTranscriptDeliveries(inner, sessions, runs);
      await restarted.pending("web");
      const items = (await createTranscriptSource(sessions).forRender(session.id)).items;
      assert.equal(items.filter((e) => e.body.slackReplyReceipt).length, 1);
      await inner.ack(row.id, Date.now());
    },
  );
}
