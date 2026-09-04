import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresLeaderLease, createNoopLeaderLease } from "../src/persistence/leader-lease.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the leader-lease tests";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("no-op lease: hold runs fn and returns its value (single-instance dev/test path)", async () => {
  const lease = createNoopLeaderLease();
  let ran = 0;
  const out = await lease.hold("any:key", async () => {
    ran++;
    return 42;
  });
  assert.equal(out, 42, "returns fn's result");
  assert.equal(ran, 1, "ran fn exactly once");
});

test("pg lease: while the leader's fn is running, a SECOND instance on the same key is skipped", { skip }, async () => {
  const pg = createPgPool(URL!, []);
  try {
    const leader = createPostgresLeaderLease(pg);
    const other = createPostgresLeaderLease(pg);
    const started = deferred();
    const gate = deferred();
    let bRan = 0;
    const aP = leader.hold("runs:reaper", async () => {
      started.resolve();
      await gate.promise;
      return "A";
    });
    await started.promise;
    const b = await other.hold("runs:reaper", async () => {
      bRan++;
      return "B";
    });
    assert.equal(b, null, "second instance on a held key is skipped");
    assert.equal(bRan, 0, "the non-leader does NOT run fn");
    gate.resolve();
    assert.equal(await aP, "A", "the leader's fn completes and its result is returned");

    const b2 = await other.hold("runs:reaper", async () => "B2");
    assert.equal(b2, "B2", "once the leader's run finishes, the key is free for the next tick");
  } finally {
    await pg.close();
  }
});

test(
  "pg lease: a second in-process hold on the same instance's held key is skipped (no reentrant win)",
  { skip },
  async () => {
    const pg = createPgPool(URL!, []);
    try {
      const lease = createPostgresLeaderLease(pg);
      const started = deferred();
      const gate = deferred();
      const aP = lease.hold("wiring:reaper", async () => {
        started.resolve();
        await gate.promise;
        return "outer";
      });
      await started.promise;
      assert.equal(
        await lease.hold("wiring:reaper", async () => "inner"),
        null,
        "same instance, same key, while held → skipped",
      );
      gate.resolve();
      assert.equal(await aP, "outer");
    } finally {
      await pg.close();
    }
  },
);

test("pg lease: a separate key is independent (each loop has its own leader gate)", { skip }, async () => {
  const pg = createPgPool(URL!, []);
  try {
    const a = createPostgresLeaderLease(pg);
    const b = createPostgresLeaderLease(pg);
    const started = deferred();
    const gate = deferred();
    const aP = a.hold("cron:scheduler:tick", async () => {
      started.resolve();
      await gate.promise;
      return "cron";
    });
    await started.promise;
    assert.equal(
      await b.hold("cron:scheduler:tick", async () => "cron2"),
      null,
      "same key held by another instance → skip",
    );
    assert.equal(await b.hold("other:loop", async () => "free"), "free", "a free key is independently winnable");
    gate.resolve();
    assert.equal(await aP, "cron");
  } finally {
    await pg.close();
  }
});

test("pg lease: fn throwing still releases the lock (and the error propagates)", { skip }, async () => {
  const pg = createPgPool(URL!, []);
  try {
    const a = createPostgresLeaderLease(pg);
    const b = createPostgresLeaderLease(pg);
    await assert.rejects(
      a.hold("throwing:key", async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await b.hold("throwing:key", async () => "after"), "after", "lock released despite fn throwing");
  } finally {
    await pg.close();
  }
});

test(
  "pg lease: a dead holder's lock auto-releases with its connection (no TTL wait), and the holder recovers",
  { skip },
  async () => {
    const holderPool = createPgPool(URL!, []);
    const standbyPool = createPgPool(URL!, []);
    try {
      const holder = createPostgresLeaderLease(holderPool);
      const standby = createPostgresLeaderLease(standbyPool);
      const started = deferred();
      const gate = deferred();
      let sawLost = false;
      const heldP = holder.hold("failover:key", async (lost) => {
        started.resolve();
        void lost.then(() => (sawLost = true));
        await gate.promise;
        return "held";
      });
      await started.promise;
      assert.equal(await standby.hold("failover:key", async () => "blocked"), null, "held key blocks the standby");

      const killed = await standbyPool.q(
        `WITH k AS (SELECT hashtextextended('leader-lease:failover:key', 0) AS v)
       SELECT pg_terminate_backend(l.pid) AS ok
         FROM pg_locks l, k
        WHERE l.locktype = 'advisory' AND l.granted
          AND l.classid::bigint = ((k.v >> 32) & 4294967295) AND l.objid::bigint = (k.v & 4294967295)`,
      );
      assert.equal(killed.length, 1, "found and terminated the holder's lock connection");

      assert.equal(
        await standby.hold("failover:key", async () => "second"),
        "second",
        "dead holder's lock is reclaimable immediately",
      );
      for (let i = 0; i < 100 && !sawLost; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(sawLost, true, "the in-flight fn is signaled that its lock is gone");
      gate.resolve();
      assert.equal(
        await heldP,
        "held",
        "the orphaned fn still runs to completion (split-brain window is on the caller)",
      );
      assert.equal(
        await holder.hold("failover:key", async () => "again"),
        "again",
        "the holder reconnects and can win again",
      );
    } finally {
      await holderPool.close();
      await standbyPool.close();
    }
  },
);
