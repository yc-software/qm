import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { evaluateAudience } from "../src/coordination/audience.ts";
import { createPeerBoard } from "../src/coordination/board.ts";
import { createPeerIdentity } from "../src/coordination/identity.ts";
import {
  createMemoryCoordinationRepository,
  createPostgresCoordinationRepository,
} from "../src/coordination/repository.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";

test("audiences accept unchanged candidates, deduplicate, and reject forged identities", async () => {
  const candidates = [
    { id: "a", name: "Worker", version: 1, character: { group: "new-feature", role: "worker", _qm: { id: "spoof" } } },
  ];
  assert.deepEqual(await evaluateAudience('.[] | select(.group == "new-feature" and .role == "worker")', candidates), [
    "a",
  ]);
  assert.deepEqual(await evaluateAudience('.[] | select(._qm.character._qm.id == "spoof") | ., .', candidates), ["a"]);
  assert.deepEqual(await evaluateAudience("empty", candidates), []);
  for (const expression of [
    '.[] | ._qm.id = "forged"',
    '.[] | .role = "admin"',
    ".[]._qm.id",
    "null",
    "[.[]]",
    'import "/tmp/secret" as secret; .[]',
    "not valid jq",
  ]) {
    await assert.rejects(evaluateAudience(expression, candidates));
  }
});

test("audience evaluator bounds nonterminating expressions", async () => {
  await assert.rejects(evaluateAudience("repeat(1)", []), { code: "audience_evaluation_failed" });
});

const database = process.env.COORDINATION_TEST_DATABASE_URL;
for (const backend of ["memory", "postgres"] as const) {
  test(
    `message board: ${backend} publication, frozen evidence, replies, and cursors`,
    { skip: backend === "postgres" && !database },
    async (t) => {
      const pool = createPgPool(database ?? "postgres://unused");
      t.after(() => pool.close());
      const repository =
        backend === "memory"
          ? createMemoryCoordinationRepository()
          : createPostgresCoordinationRepository(pool, randomUUID());
      const identity = createPeerIdentity(repository);
      for (const id of ["parent", "worker", "observer"])
        await identity.ensure({ id, scopeId: scopeId("personal", id) });
      await identity.replace("worker", 1, { character: { role: "worker", group: "new-feature" } });
      await identity.replace("parent", 1, { character: { role: "coordinator", group: "new-feature" } });
      const board = createPeerBoard(repository);
      const request = {
        senderId: "parent",
        senderRunId: "run-a",
        idempotencyKey: "task-a",
        text: "Build the feature",
        audience: '.[] | select(.role == "worker")',
      };
      const [message, duplicate] = await Promise.all([board.publish(request), board.publish(request)]);
      assert.deepEqual(message, duplicate);
      assert.deepEqual(message.recipientIds, ["worker"]);
      assert.equal((await board.get(message.id)).deliveries.length, 1);
      await identity.replace("worker", 2, { character: { role: "reviewer" } });
      assert.deepEqual((await board.preview(request.audience)).recipientIds, []);
      assert.deepEqual(
        (await board.get(message.id)).message.candidates.find((peer) => peer.id === "worker")?.character,
        { role: "worker", group: "new-feature" },
      );
      assert.deepEqual(await board.publish({ ...request, senderRunId: "retry-run" }), message);
      await assert.rejects(board.publish({ ...request, text: "Different task" }), { code: "idempotency_conflict" });
      const reply = await board.publish({
        senderId: "observer",
        senderRunId: "run-b",
        idempotencyKey: "reply",
        text: "An outside suggestion",
        audience: "empty",
        replyTo: message.id,
      });
      assert.equal(reply.threadId, message.id);
      assert.deepEqual((await board.get(reply.id)).deliveries, []);
      assert.equal((await board.list({ recipientId: "worker" })).messages.length, 1);
      assert.equal((await board.list({ text: "OUTSIDE" })).messages[0]?.id, reply.id);
      const first = await board.list({ limit: 1 });
      assert.equal(first.hasMore, true);
      assert.equal("candidates" in first.messages[0]!, false);
      assert.equal((await board.get(message.id)).message.candidates.length, 3);
      await identity.replace("parent", 2, { character: { role: "retired" } });
      const originalList = repository.list.bind(repository);
      repository.list = async (kind, filter) => {
        assert.notEqual(kind, "message", "board pagination must not read all message history");
        return originalList(kind, filter);
      };
      assert.deepEqual(
        (await board.list({ senderId: "parent" })).messages.map((row) => row.id),
        [message.id],
      );
      assert.equal((await board.list({ threadId: message.id })).messages.length, 2);
      assert.equal((await board.list({ text: "%" })).messages.length, 0);
      const next = await board.list({ after: first.nextCursor });
      assert.deepEqual(
        next.messages.map((item) => item.id),
        [reply.id],
      );
      assert.equal(next.hasMore, false);
      const before = await repository.events(0, 200);
      await assert.rejects(board.publish({ ...request, idempotencyKey: "bad-reply", replyTo: "missing" }), {
        code: "message_not_found",
      });
      assert.deepEqual(await repository.events(0, 200), before);
    },
  );
}
