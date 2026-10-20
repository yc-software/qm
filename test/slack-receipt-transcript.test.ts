import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createTranscriptSource } from "../src/sessions/transcript-source.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { withWebTranscriptDeliveries } from "../src/delivery/web-transcript-delivery.ts";
import { forModelContext, forSearchView } from "../src/harness/context-compaction.ts";
import { scopeId } from "../src/types.ts";
import { sleep } from "../src/util/async.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";

const scope = scopeId("personal", "alice");
const databaseUrl = process.env.DATABASE_URL;

for (const backend of ["memory", "postgres"] as const) {
  test(
    `${backend}: Slack receipts render once across pages and stay out of model context`,
    {
      skip: backend === "postgres" && !databaseUrl ? "requires DATABASE_URL" : false,
    },
    async () => {
      const sessions: SessionStore =
        backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(databaseUrl!);
      const session = await sessions.getOrCreateByThread(`dm:${randomUUID()}`, "dm", scope, undefined, "slack");
      await sessions.addParticipant(session.id, "alice");
      const { lease } = await sessions.acquireLease(session.id, "turn");
      assert.ok(lease);
      const receipt = await sessions.append(lease, {
        type: "user",
        scopeLabel: scope,
        payload: { text: "Receipt text", ts: "100.123", slackReplyReceipt: true, deliveryKey: "sent-1" },
      });
      const middle = await sessions.append(lease, {
        type: "assistant",
        scopeLabel: scope,
        payload: { text: "Intervening reply" },
      });
      const source = createTranscriptSource(sessions);
      assert.deepEqual(
        (await source.forViewer(session.id, "alice")).entries.map((e) => e.seq),
        [receipt.seq, middle.seq],
      );
      assert.deepEqual(
        forModelContext(await sessions.getEntries(session.id)).map((e) => e.seq),
        [middle.seq],
      );
      assert.deepEqual(
        forSearchView(await sessions.getEntries(session.id)).map((e) => e.seq),
        [middle.seq],
      );
      await sessions.removeParticipant(session.id, "alice");
      await sessions.addParticipant(session.id, "bob");
      const event = await sessions.append(lease, {
        type: "user",
        scopeLabel: scope,
        payload: { text: "Receipt text", ts: "100.123" },
      });
      await sessions.releaseLease(lease);
      const page = await source.forRender(session.id, { limit: 1 });
      assert.deepEqual(
        page.entries.map((e) => e.seq),
        [event.seq],
      );
      assert.equal(page.earlier, 1);
      const previous = await source.forRender(session.id, { limit: 1, beforeSeq: event.seq });
      assert.deepEqual(
        previous.entries.map((e) => e.seq),
        [middle.seq],
      );
      assert.equal(previous.earlier, 0);
      assert.deepEqual(
        (await source.forViewer(session.id, "alice")).entries.map((e) => e.seq),
        [receipt.seq, middle.seq],
      );
      assert.deepEqual(
        forModelContext(await sessions.getEntries(session.id)).map((e) => e.seq),
        [middle.seq, event.seq],
      );
      assert.deepEqual(
        (await source.forViewer(session.id, "bob")).entries.map((e) => e.seq),
        [event.seq],
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
        backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(databaseUrl!);
      const inner =
        backend === "memory"
          ? createDeliveryStore({ maxAgeMs: 1 })
          : createPostgresDeliveryStore(databaseUrl!, { maxAgeMs: 1 });
      const thread = `dm:${randomUUID()}`;
      const session = await sessions.getOrCreateByThread(thread, "dm", scope, undefined, "slack");
      const { lease } = await sessions.acquireLease(session.id, "turn");
      assert.ok(lease);
      const deliveries = withWebTranscriptDeliveries(inner, sessions);
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
      assert.equal((await sessions.getEntries(session.id)).length, 0);
      await sessions.releaseLease(lease);
      await sleep(10);
      assert.equal((await deliveries.claimPending("web", 1)).length, 1);
      const next = await sessions.acquireLease(session.id, "turn");
      assert.ok(next.lease);
      await sessions.appendMany(
        next.lease,
        Array.from({ length: 210 }, (_, i) => ({
          type: "assistant" as const,
          scopeLabel: scope,
          payload: { text: `Reply ${i}` },
        })),
      );
      await sessions.releaseLease(next.lease);
      const restarted = withWebTranscriptDeliveries(inner, sessions);
      await restarted.pending("web");
      const entries = (await createTranscriptSource(sessions).forRender(session.id)).entries;
      assert.equal(entries.filter((e) => (e.payload as { slackReplyReceipt?: boolean }).slackReplyReceipt).length, 1);
      await inner.ack(row.id, Date.now());
    },
  );
}
