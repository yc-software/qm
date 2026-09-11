import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemoryRunSignalStore, startSignalPoll, type RunSignalStore } from "../src/runs/run-signal-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out");
    await sleep(10);
  }
};

for (const backend of ["memory", "postgres"] as const) {
  const skip = backend === "postgres" && !process.env.DATABASE_URL;
  async function stores(run: (store: RunSignalStore, observer: RunSignalStore, id: string) => Promise<void>) {
    const store =
      backend === "memory" ? createMemoryRunSignalStore() : createPostgresRunSignalStore(process.env.DATABASE_URL!);
    const observer = backend === "memory" ? store : createPostgresRunSignalStore(process.env.DATABASE_URL!);
    try {
      await run(store, observer, randomUUID());
    } finally {
      await store.close?.();
      if (observer !== store) await observer.close?.();
    }
  }
  test(`${backend}: delivery contract: failed handler retains the entire ordered mailbox`, { skip }, async () => {
    await stores(async (store, observer, id) => {
      await store.send(id, { kind: "steer", text: "first" });
      await store.send(id, { kind: "steer", text: "second" });
      const original = await store.pending(id);
      const failed = Promise.withResolvers<void>();
      const keepAlive = setInterval(() => {}, 1000);
      const stop = startSignalPoll(
        store,
        id,
        {
          onSteer: async () => {
            throw new Error("transient handler failure");
          },
          onAbort: async () => {},
        },
        { intervalMs: 5, onError: () => failed.resolve() },
      );
      try {
        await failed.promise;
        await stop();
      } finally {
        clearInterval(keepAlive);
      }
      assert.deepEqual(await observer.pending(id), original);
      const seen: string[] = [];
      const retry = startSignalPoll(
        observer,
        id,
        {
          onSteer: async (text) => {
            seen.push(text);
          },
          onAbort: async () => {},
        },
        { intervalMs: 5 },
      );
      try {
        await until(() => seen.length === 2);
      } finally {
        await retry();
      }
      assert.deepEqual(seen, ["first", "second"]);
      assert.deepEqual(await store.pending(id), []);
    });
  });
  test(
    `${backend}: claims serialize replicas, fence stale acknowledgements, and preserve order`,
    { skip },
    async () => {
      await stores(async (store, observer, id) => {
        await store.openReader(id, "owner");
        await store.send(id, { kind: "steer", text: "first" });
        await store.send(id, { kind: "steer", text: "second" });
        const claims = await Promise.all([
          store.claim(id, { readerToken: "owner" }, 1000),
          observer.claim(id, { readerToken: "owner" }, 1000),
        ]);
        assert.equal(claims.filter(Boolean).length, 1);
        const first = claims.find(Boolean)!;
        assert.equal(first.signal.text, "first");
        await observer.release({ ...first, token: "wrong" });
        assert.equal(await observer.claim(id, { readerToken: "owner" }, 1000), null);
        assert.equal(await observer.ack({ ...first, token: "wrong" }), false);
        await store.release(first);
        const retry = (await observer.claim(id, { readerToken: "owner" }, 1000))!;
        assert.equal(retry.signal.id, first.signal.id);
        assert.notEqual(retry.token, first.token);
        assert.equal(await store.ack(first), false);
        assert.equal(await observer.ack(retry), true);
        assert.equal((await store.claim(id, { readerToken: "owner" }, 1000))?.signal.text, "second");
      });
    },
  );
  test(`${backend}: expired claims recover; replaced readers cannot claim or acknowledge`, { skip }, async () => {
    await stores(async (store, observer, id) => {
      await store.openReader(id, "old");
      await store.send(id, { kind: "steer", text: "message" });
      const old = (await store.claim(id, { readerToken: "old" }, 50))!;
      await assert.rejects(observer.openReader(id, "new"), /still accepting/);
      assert.equal(await store.renew(old, 50), true);
      await sleep(65);
      await observer.openReader(id, "new");
      assert.equal(await store.claim(id, { readerToken: "old" }, 1000), null);
      assert.equal(await store.ack(old), false);
      assert.equal(await store.renew(old, 1000), false);
      await store.closeReader(id, "old");
      assert.equal(await observer.readerClosed(id), false);
      await sleep(65);
      const replacement = (await observer.claim(id, { readerToken: "new" }, 1000))!;
      assert.equal(replacement.signal.id, old.signal.id);
      await store.release(old);
      assert.equal(await observer.ack(replacement), true);
    });
  });
  test(
    `${backend}: abort is level-triggered across reader replacement and terminal transfer retires it`,
    { skip },
    async () => {
      await stores(async (store, observer, id) => {
        await store.send(id, { kind: "abort" });
        await store.openReader(id, "first");
        assert.equal(await store.aborted(id, "first"), true);
        assert.equal(await store.aborted(id, "first"), true);
        await observer.openReader(id, "second");
        assert.equal(await store.aborted(id, "first"), false);
        assert.equal(await observer.aborted(id, "second"), true);
        await observer.closeReader(id, "second");
        await store.claim(id, { terminal: false }, 1000);
        assert.equal((await store.pending(id)).length, 1);
        await store.claim(id, { terminal: true }, 1000);
        assert.deepEqual(await store.pending(id), []);
      });
    },
  );
  test(
    `${backend}: stable admission identity survives concurrency, acknowledgement, closure and pruning`,
    { skip },
    async () => {
      await stores(async (store, observer, id) => {
        const signal = { kind: "steer" as const, text: "message", dedupeKey: id };
        const admissions = await Promise.all([store.send(id, signal), observer.send(id, signal)]);
        assert.deepEqual(admissions.map((admission) => admission.status).sort(), ["duplicate", "sent"]);
        const saved = await observer.getByDedupeKey(id);
        assert.ok(saved);
        const claim = (await store.claim(id, { terminal: true }, 1000))!;
        assert.equal(await store.ack(claim, "queued-run"), true);
        await store.prune(14 * 24 * 60 * 60_000);
        assert.equal((await observer.getByDedupeKey(id))?.deliveryRunId, "queued-run");
        const duplicate = await observer.send(id, signal);
        assert.equal(duplicate.status, "duplicate");
        assert.equal(duplicate.signal.id, saved.id);
        await store.prune(-1);
        assert.equal(await observer.getByDedupeKey(id), null);
      });
    },
  );
  test(`${backend}: a live claim excludes terminal transfer until release`, { skip }, async () => {
    await stores(async (store, observer, id) => {
      await store.openReader(id, "live");
      await store.send(id, { kind: "steer", text: "owned" });
      assert.equal(await observer.claim(id, { terminal: false }, 1000), null);
      const live = (await store.claim(id, { readerToken: "live" }, 1000))!;
      assert.equal(await observer.claim(id, { terminal: true }, 1000), null);
      assert.equal(await store.renew(live, 1000), true);
      await store.release(live);
      await store.closeReader(id, "live");
      const transfer = (await observer.claim(id, { terminal: false }, 1000))!;
      assert.equal(transfer.signal.id, live.signal.id);
      assert.equal((await store.send(id, { kind: "steer", text: "late" })).status, "closed");
      await observer.release(transfer);
      assert.ok((await store.pendingRunIds()).includes(id));
    });
  });
  test(`${backend}: replay ownership survives failed acknowledgement and reader reopening`, { skip }, async () => {
    await stores(async (store, observer, id) => {
      await store.send(id, { kind: "steer", text: "once" });
      await store.openReader(id, "old");
      await store.closeReader(id, "old");
      const transfer = (await store.claim(id, { terminal: false }, 1000))!;
      await store.release(transfer);
      await observer.openReader(id, "new");
      assert.equal(await observer.claim(id, { readerToken: "new" }, 1000), null);
      const recovered = await observer.claim(id, { terminal: false }, 1000);
      assert.equal(recovered?.signal.id, transfer.signal.id);
    });
  });
  test(`${backend}: confirmed acceptance survives bookkeeping and acknowledgement errors`, { skip }, async () => {
    await stores(async (store, observer, id) => {
      let submissions = 0;
      let acknowledgements = 0;
      const ack = store.ack.bind(store);
      store.ack = async (...args) => {
        if (++acknowledgements === 1) throw new Error("lost acknowledgement");
        return ack(...args);
      };
      const done = Promise.withResolvers<void>();
      const stop = startSignalPoll(
        store,
        id,
        {
          onSteer: async (_text, _ts, _id, delivery) => {
            submissions++;
            await delivery.accepted();
            done.resolve();
            throw new Error("tape failed after acceptance");
          },
          onAbort: async () => {},
        },
        { intervalMs: 5 },
      );
      await store.send(id, { kind: "steer", text: "accepted once" });
      try {
        await done.promise;
      } finally {
        await stop();
      }
      assert.equal(submissions, 1);
      assert.equal(acknowledgements, 2);
      assert.deepEqual(await observer.pending(id), []);
      assert.equal(await observer.claim(id, { terminal: true }, 1000), null);
    });
  });

  test(`${backend}: delayed close cannot transfer a replacement reader's new messages`, { skip }, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let transferred = false;
    let finished = false;
    const options = {
      readerFinished: async () => finished,
      onReaderClosed: async (runId: string) => {
        entered.resolve();
        await release.promise;
        transferred ||= !!(await observer.claim(runId, { terminal: false }, 1000));
      },
    };
    const store =
      backend === "memory"
        ? createMemoryRunSignalStore(options)
        : createPostgresRunSignalStore(process.env.DATABASE_URL!, options);
    const observer = backend === "memory" ? store : createPostgresRunSignalStore(process.env.DATABASE_URL!);
    const id = randomUUID();
    try {
      await store.openReader(id, "old");
      const closing = store.closeReader(id, "old");
      await entered.promise;
      await observer.openReader(id, "new");
      await observer.send(id, { kind: "steer", text: "new message" });
      release.resolve();
      await closing;
      assert.equal(transferred, false);
      const live = (await observer.claim(id, { readerToken: "new" }, 1000))!;
      assert.equal(live.signal.text, "new message");
      await observer.ack(live);
      await store.closeReader(id, "old");
      assert.equal(await observer.readerClosed(id), false);
      await store.closeReader(id, "new");
      await store.prune(-1);
      assert.equal(await observer.readerClosed(id), true);
      finished = true;
      await store.prune(-1);
      assert.equal(await observer.readerClosed(id), false);
    } finally {
      release.resolve();
      await store.close?.();
      if (observer !== store) await observer.close?.();
    }
  });

  test(`${backend}: closure racing admission leaves every accepted message owned once`, { skip }, async () => {
    await stores(async (store, observer, id) => {
      await store.openReader(id, "reader");
      const [admission] = await Promise.all([
        store.send(id, { kind: "steer", text: "raced", dedupeKey: id }),
        observer.closeReader(id, "reader"),
      ]);
      const claim = await observer.claim(id, { terminal: false }, 1000);
      assert.equal(!!claim, admission.status !== "closed");
      if (claim) await observer.ack(claim, "queued");
      assert.deepEqual(await store.pending(id), []);
      assert.equal((await store.send(id, { kind: "steer", text: "late" })).status, "closed");
      await store.send(id, { kind: "abort" });
      assert.equal((await store.pending(id))[0]?.kind, "abort");
    });
  });

  test(`${backend}: notifications across replicas deliver immediately with complete metadata`, { skip }, async () => {
    await stores(async (store, observer, id) => {
      let received: { text: string; ts?: string } | undefined;
      const stop = startSignalPoll(
        observer,
        id,
        {
          onSteer: async (text, ts) => {
            received = { text, ts };
          },
          onAbort: async () => {},
        },
        { intervalMs: 10_000 },
      );
      await sleep(100);
      await store.send(id, { kind: "steer", text: "doorbell", ts: "123.456" });
      try {
        await until(() => !!received);
      } finally {
        await stop();
      }
      assert.deepEqual(received, { text: "doorbell", ts: "123.456" });
    });
  });
}

test("close waits for in-flight acceptance and hands only unacknowledged messages to transfer", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const handoff: string[] = [];
  const store = createMemoryRunSignalStore({
    onReaderClosed: async (id) => {
      for (;;) {
        const claim = await store.claim(id, { terminal: false }, 1000);
        if (!claim) return;
        handoff.push(claim.signal.text!);
        await store.ack(claim, "queued");
      }
    },
  });
  const stop = startSignalPoll(store, "close", {
    onSteer: async () => {
      entered.resolve();
      await release.promise;
    },
    onAbort: async () => {},
  });
  await store.send("close", { kind: "steer", text: "first" });
  await entered.promise;
  await store.send("close", { kind: "steer", text: "second" });
  const closing = stop();
  assert.deepEqual(handoff, []);
  release.resolve();
  await closing;
  assert.deepEqual(handoff, ["second"]);
});

test("abort still reaches a handler waiting for steer acceptance", async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const store = createMemoryRunSignalStore();
  const stop = startSignalPoll(
    store,
    "abort",
    {
      onSteer: async () => {
        entered.resolve();
        await aborted.promise;
        throw new Error("aborted before acceptance");
      },
      onAbort: async () => aborted.resolve(),
    },
    { intervalMs: 5 },
  );
  await store.send("abort", { kind: "steer", text: "message" });
  await entered.promise;
  await store.send("abort", { kind: "abort" });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await aborted.promise;
    await stop();
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal((await store.pending("abort")).length, 2);
});

test("reader registration retries after transient failure", async () => {
  const store = createMemoryRunSignalStore();
  const open = store.openReader.bind(store);
  let attempts = 0;
  store.openReader = async (...args) => {
    if (++attempts === 1) throw new Error("offline");
    await open(...args);
  };
  let accepted = false;
  const stop = startSignalPoll(
    store,
    "retry",
    {
      onAbort: async () => {
        accepted = true;
      },
      onSteer: async () => {},
    },
    { intervalMs: 5 },
  );
  await store.send("retry", { kind: "abort" });
  try {
    await until(() => accepted);
  } finally {
    await stop();
  }
  assert.equal(attempts, 2);
});

test("stopping before registration resolves still closes the reader", async () => {
  const store = createMemoryRunSignalStore();
  const opened = Promise.withResolvers<void>();
  const open = store.openReader.bind(store);
  store.openReader = async (...args) => {
    await opened.promise;
    await open(...args);
  };
  const stop = startSignalPoll(store, "delayed-registration", { onSteer: async () => {}, onAbort: async () => {} });
  const stopping = stop();
  opened.resolve();
  await stopping;
  assert.equal(await store.readerClosed("delayed-registration"), true);
});

test("a failed abort retries and remains level-triggered across reader handoff", async () => {
  const store = createMemoryRunSignalStore();
  let attempts = 0;
  const stop = startSignalPoll(
    store,
    "abort-retry",
    {
      onSteer: async () => {},
      onAbort: async () => {
        if (++attempts === 1) throw new Error("retry");
      },
    },
    { intervalMs: 5 },
  );
  await store.send("abort-retry", { kind: "abort" });
  try {
    await until(() => attempts >= 2);
  } finally {
    await stop();
  }
  await store.openReader("abort-retry", "replacement");
  assert.equal(await store.aborted("abort-retry", "replacement"), true);
});

test("known acceptance still acknowledges when renewal fails before storage recovers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const store = createMemoryRunSignalStore();
  const failed = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const ack = store.ack.bind(store);
  let attempts = 0;
  store.ack = async (...args) => {
    if (++attempts === 1) throw new Error("temporary storage outage");
    return ack(...args);
  };
  store.renew = async () => false;
  await store.send("known", { kind: "steer", text: "once" });
  const stop = startSignalPoll(
    store,
    "known",
    {
      onSteer: async (_text, _ts, _id, delivery) => {
        await delivery.accepted();
        delivered.resolve();
      },
      onAbort: async () => {},
    },
    { onError: () => failed.resolve() },
  );
  try {
    await failed.promise;
    t.mock.timers.tick(10_000);
    await delivered.promise;
    assert.deepEqual(await store.pending("known"), []);
    assert.equal(attempts, 2);
  } finally {
    await stop();
  }
});

for (const backend of ["memory", "postgres"]) {
  test(
    `${backend}: renewal errors cancel an unaccepted recipient before handoff`,
    { skip: backend === "postgres" && !process.env.DATABASE_URL },
    async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const store =
        backend === "memory" ? createMemoryRunSignalStore() : createPostgresRunSignalStore(process.env.DATABASE_URL!);
      const id = crypto.randomUUID();
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      let aborted = false;
      store.renew = async () => {
        throw new Error("renewal unavailable");
      };
      await store.send(id, { kind: "steer", text: "not yet accepted" });
      const stop = startSignalPoll(store, id, {
        onSteer: async () => {
          entered.resolve();
          await released.promise;
          throw new Error("cancelled before acceptance");
        },
        onAbort: async () => {
          aborted = true;
          released.resolve();
        },
      });
      try {
        await entered.promise;
        t.mock.timers.tick(10_000);
        await sleep(20);
        assert.equal(aborted, true);
        assert.equal((await store.pending(id)).length, 1);
      } finally {
        released.resolve();
        await stop();
        await store.close?.();
      }
    },
  );
}

test("an unaccepted claim stays owned until recipient cancellation completes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const store = createMemoryRunSignalStore();
  const entered = Promise.withResolvers<void>();
  const releaseHandler = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const aborting = Promise.withResolvers<void>();
  let releases = 0;
  const release = store.release.bind(store);
  store.release = async (...args) => {
    releases++;
    await release(...args);
  };
  store.renew = async () => false;
  await store.send("quiescence", { kind: "steer", text: "not accepted" });
  const stop = startSignalPoll(store, "quiescence", {
    onSteer: async () => {
      entered.resolve();
      await releaseHandler.promise;
      throw new Error("cancelled");
    },
    onAbort: async () => {
      aborting.resolve();
      releaseHandler.resolve();
      await cancelled.promise;
    },
  });
  try {
    await entered.promise;
    t.mock.timers.tick(10_000);
    await aborting.promise;
    await sleep(20);
    assert.equal(releases, 0);
  } finally {
    cancelled.resolve();
    releaseHandler.resolve();
    await stop();
  }
  assert.equal(releases, 1);
});
