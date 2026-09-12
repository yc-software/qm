import { test, before } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../src/types.ts";
import { PROVISIONING_LEASE_MS } from "../src/coordination/types.ts";
import { createMemoryMessageBoardStore } from "../src/coordination/memory-message-board-store.ts";
import { createPostgresMessageBoardStore } from "../src/coordination/postgres-message-board-store.ts";
import { createMemorySwarmStore } from "../src/coordination/memory-swarm-store.ts";
import { createPostgresSwarmStore } from "../src/coordination/postgres-swarm-store.ts";
import type { MessageBoardStore } from "../src/coordination/message-board.ts";
import type { SwarmStore } from "../src/coordination/swarm-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the coordination store-parity tests";
const ORG = "parity-org";
const SCOPE = scopeId("personal", "alice");

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS peer_messages, peer_deliveries, swarms, swarm_members, swarm_reservations");
  const tracked = await p.query<{ present: boolean }>(
    "SELECT to_regclass('qm_schema_migrations') IS NOT NULL AS present",
  );
  if (tracked.rows[0]?.present) {
    await p.query("DELETE FROM qm_schema_migrations WHERE id IN ($1, $2)", [
      "coordination/board/0001",
      "coordination/swarms/0001",
    ]);
  }
  await p.end();
});

function boardTwins(): Array<[string, () => MessageBoardStore]> {
  return [
    ["memory", createMemoryMessageBoardStore],
    ["postgres", () => createPostgresMessageBoardStore(URL!)],
  ];
}

function swarmTwins(): Array<[string, () => SwarmStore]> {
  return [
    ["memory", createMemorySwarmStore],
    ["postgres", () => createPostgresSwarmStore(URL!)],
  ];
}

let run = 0;
const suffix = () => `${process.pid}-${++run}`;

test("board twins agree on publish, cursor paging, claim, retire, park and consumption", { skip }, async () => {
  for (const [name, make] of boardTwins()) {
    const board = make();
    const tag = `${name}-${suffix()}`;
    const first = await board.publish({
      id: `m1-${tag}`,
      orgId: `${ORG}-${tag}`,
      senderSessionId: "s-a",
      senderRunId: null,
      text: "one",
      audienceExpr: '.[] | select(.role == "worker")',
      resolvedRecipientIds: ["s-b", "s-c"],
      replyTo: null,
      createdAt: 1_000,
    });
    assert.equal(typeof first.seq, "number", `${name}: seq is a number, not a bigint string`);
    assert.deepEqual(first.resolvedRecipientIds, ["s-b", "s-c"]);
    assert.equal((await board.deliveries(first.id)).length, 2, `${name}: recipients are frozen with the message`);

    const empty = await board.publish({
      id: `m2-${tag}`,
      orgId: `${ORG}-${tag}`,
      senderSessionId: "s-a",
      senderRunId: null,
      text: "two",
      audienceExpr: null,
      resolvedRecipientIds: [],
      replyTo: first.id,
      createdAt: 1_001,
    });
    assert.deepEqual(await board.deliveries(empty.id), [], `${name}: an empty audience writes no delivery row`);
    assert.equal(empty.replyTo, first.id);
    assert.equal(await board.get("another-org", first.id), null, `${name}: reads are org-scoped`);

    const page = await board.list(`${ORG}-${tag}`, { limit: 1 });
    assert.deepEqual(
      page.messages.map((m) => m.text),
      ["one"],
    );
    assert.equal(page.nextCursor, first.seq);
    const rest = await board.list(`${ORG}-${tag}`, { limit: 1, afterSeq: page.nextCursor! });
    assert.deepEqual(
      rest.messages.map((m) => m.text),
      ["two"],
      `${name}: the cursor neither repeats nor skips`,
    );

    const claimed = await board.claimDue({ now: 2_000, leaseMs: 60_000, limit: 10 });
    assert.equal(claimed.length, 2, `${name}: only due, undispatched rows are claimed`);
    assert.deepEqual(
      claimed.map((row) => row.attempts),
      [1, 1],
    );
    assert.deepEqual(
      await board.claimDue({ now: 2_001, leaseMs: 60_000, limit: 10 }),
      [],
      `${name}: a claimed row is leased out of the next scan`,
    );

    await board.retire(first.id, "s-b", {
      runId: "run-1",
      dispatchedAt: 2_100,
      consumedAt: null,
      lastStatus: "queued",
    });
    await board.park(first.id, "s-c", { nextAttemptAt: null, lastStatus: "refused", lastReason: "no such thread" });
    const rows = await board.deliveries(first.id);
    const delivered = rows.find((row) => row.recipientSessionId === "s-b")!;
    const parked = rows.find((row) => row.recipientSessionId === "s-c")!;
    assert.deepEqual(
      [delivered.runId, delivered.dispatchedAt, delivered.consumedAt, delivered.nextAttemptAt],
      ["run-1", 2_100, null, null],
      `${name}: publication, delivery and consumption are independently set`,
    );
    assert.deepEqual(
      [parked.dispatchedAt, parked.nextAttemptAt, parked.lastReason],
      [null, null, "no such thread"],
      `${name}: a terminal park is a null next attempt on an undispatched row`,
    );

    assert.deepEqual(
      (await board.awaitingConsumption(10)).map((row) => row.recipientSessionId),
      ["s-b"],
    );
    await board.markConsumed(first.id, "s-b", 2_200);
    assert.deepEqual(await board.awaitingConsumption(10), [], `${name}: a consumed row leaves the scan`);
    await board.close?.();
  }
});

test("swarm twins agree on reservation, replay, settlement and stop", { skip }, async () => {
  for (const [name, make] of swarmTwins()) {
    const swarms = make();
    const tag = `${name}-${suffix()}`;
    const swarmId = `swarm-${tag}`;
    const swarm = await swarms.createSwarm({
      id: swarmId,
      scopeId: SCOPE,
      rootSessionId: `root-${tag}`,
      sessionLimit: 4,
      maxChildrenPerParent: 2,
      maxDepth: 2,
      createdAt: 1_000,
    });
    assert.equal(swarm.sessionsUsed, 1, `${name}: the pool is descendant-inclusive and counts the root`);
    assert.equal((await swarms.getMember(swarmId, `root-${tag}`))!.depth, 0);

    const reserved = await swarms.reserve({
      swarmId,
      requestId: "req-1",
      parentSessionId: `root-${tag}`,
      n: 2,
      createdAt: 1_001,
    });
    assert.ok(reserved.ok);
    assert.equal(reserved.replay, false);
    assert.deepEqual(reserved.reservation.slots, [null, null]);
    assert.equal(reserved.reservation.leaseExpiresAt, 1_001 + PROVISIONING_LEASE_MS);
    assert.equal((await swarms.getSwarm(swarmId))!.sessionsUsed, 3);
    assert.equal((await swarms.getMember(swarmId, `root-${tag}`))!.childrenUsed, 2);

    const concurrent = await swarms.reserve({
      swarmId,
      requestId: "req-1",
      parentSessionId: `root-${tag}`,
      n: 2,
      createdAt: 1_002,
    });
    assert.equal(concurrent.ok, false, `${name}: a duplicate submit cannot provision the same reservation twice`);
    assert.equal(concurrent.ok === false && concurrent.reason, "provisioning_in_progress");
    assert.equal((await swarms.getSwarm(swarmId))!.sessionsUsed, 3);

    const replayed = await swarms.reserve({
      swarmId,
      requestId: "req-1",
      parentSessionId: `root-${tag}`,
      n: 2,
      createdAt: 1_002 + PROVISIONING_LEASE_MS,
    });
    assert.ok(replayed.ok);
    assert.equal(replayed.replay, true, `${name}: a replayed requestId never charges the pool twice`);
    assert.equal((await swarms.getSwarm(swarmId))!.sessionsUsed, 3);

    const breadth = await swarms.reserve({
      swarmId,
      requestId: "req-2",
      parentSessionId: `root-${tag}`,
      n: 1,
      createdAt: 1_003,
    });
    assert.equal(breadth.ok, false);
    assert.equal(breadth.ok === false && breadth.reason, "breadth_exceeded");
    assert.equal((await swarms.getSwarm(swarmId))!.sessionsUsed, 3, `${name}: a refusal moves no counter`);

    await swarms.appendChild({
      swarmId,
      requestId: "req-1",
      childSessionId: `kid-a-${tag}`,
      parentSessionId: `root-${tag}`,
      slot: 0,
      depth: 1,
      createdAt: 1_004,
    });
    await swarms.appendChild({
      swarmId,
      requestId: "req-1",
      childSessionId: `kid-b-${tag}`,
      parentSessionId: `root-${tag}`,
      slot: 1,
      depth: 1,
      createdAt: 1_005,
    });
    assert.deepEqual((await swarms.getReservation(swarmId, "req-1"))!.slots, [`kid-a-${tag}`, `kid-b-${tag}`]);

    await swarms.settleFailure(swarmId, "req-1", [`kid-a-${tag}`]);
    const kept = await swarms.getReservation(swarmId, "req-1");
    assert.deepEqual(kept!.slots, [null, `kid-b-${tag}`], `${name}: a survivor keeps the slot of the brief it took`);
    assert.equal(kept!.n, 2, `${name}: a live reservation stays charged its full n`);
    assert.equal(kept!.leaseExpiresAt, 0, `${name}: a settled failure hands the reservation back for a resume`);
    assert.equal((await swarms.getSwarm(swarmId))!.sessionsUsed, 3);
    assert.equal(await swarms.getMember(swarmId, `kid-a-${tag}`), null);

    const resumed = await swarms.reserve({
      swarmId,
      requestId: "req-1",
      parentSessionId: `root-${tag}`,
      n: 2,
      createdAt: 1_006,
    });
    assert.ok(resumed.ok);
    assert.equal(resumed.replay, true, `${name}: a settled failure resumes without recharging the pool`);
    assert.equal((await swarms.getSwarm(swarmId))!.sessionsUsed, 3);

    await swarms.settleFailure(swarmId, "req-1", [`kid-b-${tag}`]);
    assert.equal(await swarms.getReservation(swarmId, "req-1"), null, `${name}: an emptied reservation is released`);
    assert.equal((await swarms.getSwarm(swarmId))!.sessionsUsed, 1);
    assert.equal((await swarms.getMember(swarmId, `root-${tag}`))!.childrenUsed, 0);

    const other = await swarms.createSwarm({
      id: `swarm-other-${tag}`,
      scopeId: SCOPE,
      rootSessionId: `root-other-${tag}`,
      sessionLimit: 4,
      maxChildrenPerParent: 2,
      maxDepth: 2,
      createdAt: 1_006,
    });
    const shared = await swarms.reserve({
      swarmId: other.id,
      requestId: "req-1",
      parentSessionId: `root-other-${tag}`,
      n: 1,
      createdAt: 1_007,
    });
    assert.ok(shared.ok);
    assert.equal(shared.replay, false, `${name}: the reservation key is (swarm, request), never the request alone`);

    await swarms.markStopped(swarmId, [`root-${tag}`], 2_000, false);
    assert.equal((await swarms.getMember(swarmId, `root-${tag}`))!.stoppedAt, 2_000);
    assert.equal((await swarms.getSwarm(swarmId))!.stoppedAt, null, `${name}: member stop is not swarm stop`);
    const afterStop = await swarms.reserve({
      swarmId,
      requestId: "req-3",
      parentSessionId: `root-${tag}`,
      n: 1,
      createdAt: 2_001,
    });
    assert.equal(afterStop.ok === false && afterStop.reason, "parent_stopped");

    await swarms.markStopped(swarmId, [`root-${tag}`], 3_000, true);
    assert.equal((await swarms.getMember(swarmId, `root-${tag}`))!.stoppedAt, 2_000, `${name}: stop is idempotent`);
    assert.equal((await swarms.getSwarm(swarmId))!.stoppedAt, 3_000);
    assert.equal((await swarms.members(swarmId)).length, 1, `${name}: stop deletes no durable row`);
    await swarms.close?.();
  }
});
