import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStateBus, type SessionStateEvent } from "../src/runs/session-state-bus.ts";
import { createPostgresSessionStateBus } from "../src/runs/postgres-session-state-bus.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";

const PG = process.env.DATABASE_URL;
const pgSkip = PG ? false : "set DATABASE_URL to run the Postgres session-state bus test";

test("memory bus: subscribers receive emitted events", () => {
  const bus = createMemorySessionStateBus();
  const got: SessionStateEvent[] = [];
  const off = bus.subscribe((e) => got.push(e));
  bus.emit({ threadRef: "web:u:a", sessionId: "s1", state: "working", at: 111 });
  bus.emit({ threadRef: "web:u:a", sessionId: "s1", state: "awaiting_approval", at: 222 });
  assert.deepEqual(
    got.map((e) => e.state),
    ["working", "awaiting_approval"],
  );
  off();
  bus.emit({ threadRef: "web:u:a", sessionId: "s1", state: "idle", at: 333 });
  assert.equal(got.length, 2, "an unsubscribed listener hears nothing");
});

test("memory bus: a throwing subscriber does not break the others", () => {
  const bus = createMemorySessionStateBus();
  const got: string[] = [];
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe((e) => got.push(e.state));
  bus.emit({ threadRef: "web:u:b", state: "working", at: 1 });
  assert.deepEqual(got, ["working"]);
});

test("[postgres] events cross bus instances (pg_notify)", { skip: pgSkip }, async () => {
  const a = createPostgresSessionStateBus(PG!);
  const b = createPostgresSessionStateBus(PG!);
  try {
    const got: SessionStateEvent[] = [];
    const ready = new Promise<void>((resolve) => {
      b.subscribe((e) => {
        if (e.threadRef === "web:u:xbus") {
          got.push(e);
          resolve();
        }
      });
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      a.emit({ threadRef: "web:u:xbus", sessionId: "s9", state: "awaiting_approval", at: 42 });
      const landed = await Promise.race([
        ready.then(() => true),
        new Promise((r) => setTimeout(r, 250)).then(() => false),
      ]);
      if (landed) break;
      if (Date.now() > deadline) assert.fail("event never crossed instances");
    }
    assert.equal(got[0]?.state, "awaiting_approval");
    assert.equal(got[0]?.sessionId, "s9");
    assert.equal(got[0]?.at, 42);
  } finally {
    await a.close?.();
    await b.close?.();
  }
});

test("encodeWirePayload measures UTF-8 bytes and sheds participants before dropping the event", async () => {
  const { encodeWirePayload } = await import("../src/runs/postgres-session-state-bus.ts");
  const small = { threadRef: "web:U1:t", state: "idle" as const, at: 1, participants: ["a", "b"] };
  assert.equal(encodeWirePayload(small), JSON.stringify(small), "a small event ships whole");

  const wide = {
    threadRef: "web:U1:wide",
    state: "working" as const,
    at: 2,
    participants: Array.from({ length: 40 }, () => "\u{1F980}".repeat(20)),
  };
  const encodedWide = encodeWirePayload(wide, 2_000);
  assert.ok(encodedWide !== null, "the transition still ships");
  const decodedWide = JSON.parse(encodedWide!) as SessionStateEvent;
  assert.equal(decodedWide.participants, undefined, "the oversized participant list is shed, not the event");
  assert.equal(decodedWide.participantsShed, true, "a shed event says so, so consumers can rehydrate the routing");
  assert.ok(Buffer.byteLength(encodedWide!, "utf8") <= 2_000);

  const pathological = { threadRef: "x".repeat(9_000), state: "idle" as const, at: 3 };
  assert.equal(encodeWirePayload(pathological), null, "an event that cannot fit even bare is dropped");
});

test("[postgres] a re-established LISTEN connection announces a resync to subscribers", { skip: pgSkip }, async () => {
  const bus = createPostgresSessionStateBus(PG!);
  const admin = createPgPool(PG!, []);
  try {
    const listenerPids = async (): Promise<Set<number>> => {
      const rows = await admin.q("SELECT pid FROM pg_stat_activity WHERE query = 'LISTEN session_state'");
      return new Set(rows.map((r) => Number(r.pid)));
    };
    const until = async <T>(probe: () => Promise<T | null> | T | null, what: string): Promise<T> => {
      const deadline = Date.now() + 8_000;
      for (;;) {
        const hit = await probe();
        if (hit !== null) return hit;
        if (Date.now() > deadline) assert.fail(what);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const newListener = async (known: Set<number>): Promise<number | null> => {
      for (const pid of await listenerPids()) if (!known.has(pid)) return pid;
      return null;
    };
    const foreign = await listenerPids();
    let resyncs = 0;
    const got: SessionStateEvent[] = [];
    bus.subscribe((e) => got.push(e), { onResync: () => resyncs++ });
    const first = await until(() => newListener(foreign), "the bus never started listening");
    await until(
      () => (resyncs === 1 ? true : null),
      "the first LISTEN announces a resync so nothing emitted before it is trusted",
    );
    await admin.query("SELECT pg_terminate_backend($1)", [first]);
    await until(
      () => newListener(new Set([...foreign, first])),
      "the bus never re-listened after its backend was killed",
    );
    await until(() => (resyncs === 2 ? true : null), "the re-LISTEN did not announce a resync");
    bus.emit({ threadRef: "web:u:after", state: "idle", at: 1 });
    await until(
      () => (got.some((e) => e.threadRef === "web:u:after") ? true : null),
      "events do not flow after the reconnect",
    );
  } finally {
    await bus.close?.();
    await admin.close();
  }
});
