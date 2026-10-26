import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createTranscriptSource } from "../src/sessions/transcript-source.ts";
import { appendToTranscript } from "../src/surfaces/outbound.ts";
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
        kind: "UserMessage",
        text: "Receipt text",
        externalId: "100.123",
        body: { slackReplyReceipt: true, deliveryKey: "sent-1" },
      });
      const middle = await sessions.append(lease, {
        kind: "AgentMessage",
        text: "Intervening reply",
      });
      const source = createTranscriptSource(sessions);
      assert.deepEqual(
        (await source.forViewer(session.id, "alice")).items.map((e) => e.seq),
        [receipt.seq, middle.seq],
      );
      assert.deepEqual(
        forModelContext(await sessions.getItems(session.id)).map((e) => e.seq),
        [middle.seq],
      );
      assert.deepEqual(
        forSearchView(await sessions.getItems(session.id)).map((e) => e.seq),
        [middle.seq],
      );
      await sessions.removeParticipant(session.id, "alice");
      await sessions.addParticipant(session.id, "bob");
      const event = await sessions.append(lease, {
        kind: "UserMessage",
        text: "Receipt text",
        externalId: "100.123",
      });
      await sessions.releaseLease(lease);
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
      assert.deepEqual(
        (await source.forViewer(session.id, "alice")).items.map((e) => e.seq),
        [receipt.seq, middle.seq],
      );
      assert.deepEqual(
        forModelContext(await sessions.getItems(session.id)).map((e) => e.seq),
        [middle.seq, event.seq],
      );
      assert.deepEqual(
        (await source.forViewer(session.id, "bob")).items.map((e) => e.seq),
        [event.seq],
      );
    },
  );

  test(
    `${backend}: a receipt waits for a busy session and deduplicates beyond the transcript tail`,
    {
      skip: backend === "postgres" && !databaseUrl ? "requires DATABASE_URL" : false,
    },
    async () => {
      const sessions: SessionStore =
        backend === "memory" ? createMemorySessionStore() : createPostgresSessionStore(databaseUrl!);
      const thread = `dm:${randomUUID()}`;
      const session = await sessions.getOrCreateByThread(thread, "dm", scope, undefined, "slack");
      const key = `receipt:${randomUUID()}`;
      const record = () =>
        appendToTranscript(
          { sessions },
          session,
          {
            kind: "UserMessage",
            text: "Durable receipt",
            externalId: "200.123",
            body: { name: "Alice", slackReplyReceipt: true, deliveryKey: key },
          },
          key,
          () => sessions.hasDeliveryEntry(session.id, key, "200.123"),
        );
      const { lease } = await sessions.acquireLease(session.id, "turn");
      assert.ok(lease);
      const pending = record();
      await sleep(50);
      assert.equal((await sessions.getItems(session.id)).length, 0, "nothing lands while a turn holds the session");
      await sessions.releaseLease(lease);
      await pending;
      const next = await sessions.acquireLease(session.id, "turn");
      assert.ok(next.lease);
      await sessions.appendMany(
        next.lease,
        Array.from({ length: 210 }, (_, i) => ({ kind: "AgentMessage" as const, text: `Reply ${i}` })),
      );
      await sessions.releaseLease(next.lease);
      await record();
      const items = (await createTranscriptSource(sessions).forRender(session.id)).items;
      assert.equal(items.filter((e) => e.body.slackReplyReceipt).length, 1);
    },
  );
}
