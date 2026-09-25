import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { createFeatureFlagStore } from "../src/feature-flags.ts";
import { createSlackSessionStatus, type SlackSessionStatusState } from "../src/slack/session-status.ts";
import { createSlackCoreClient, type SlackCoreClientDeps } from "../src/api/slack-core-client.ts";
import { createTurnStream } from "../src/runs/turn-stream.ts";
import type { Run } from "../src/runs/run-store.ts";

function fixture() {
  let at = 1_000;
  const store = createMemoryMap<SlackSessionStatusState>();
  const flags = createFeatureFlagStore(createMemoryMap());
  const records = new Map<string, Run>();
  const runs = { get: async (id: string) => records.get(id) ?? null };
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    apiCall: async (method: string, args: Record<string, unknown>) => {
      assert.equal(method, "agents.sessions.setStatus");
      calls.push(args);
    },
  };
  const manager = () => createSlackSessionStatus(store, createNoopLeaderLease(), runs, flags, () => at);
  const status = manager();
  const add = (id: string) => {
    const run = {
      id,
      status: "running",
      leaseExpiresAt: Number.MAX_SAFE_INTEGER,
      request: { conversation: { kind: "channel", channelRef: "C1", threadRef: "ch:C1:1.0" }, actor: { id: "U1" } },
    } as Run;
    records.set(id, run);
    return run;
  };
  const enable = () => flags.setEnabled("slack_loading_indicator", "channel:C1", true, "admin");
  const start = (id: string, account = "T1:B1", thread: string | undefined = "1.0") =>
    status.start(client, account, id, "C1", thread);
  const reconcile = () => status.reconcile(client, "T1:B1");
  return {
    store,
    flags,
    records,
    runs,
    calls,
    client,
    manager,
    status,
    add,
    enable,
    start,
    reconcile,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("native status is off by default and never creates a thread for a top-level DM", async () => {
  const f = fixture();
  f.add("r1");
  await f.start("r1");
  await f.enable();
  await f.status.start(f.client, "T1:B1", "r1", "D1");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.store.entries(), []);
});

test("enabled work starts processing and terminal success, failure and stop return to active", async () => {
  for (const terminal of ["done", "failed"] as const) {
    const f = fixture();
    await f.enable();
    const run = f.add("r1");
    await f.start("r1");
    assert.deepEqual(f.calls, [{ channel_id: "C1", thread_ts: "1.0", status: "processing" }]);
    run.status = terminal;
    run.result = { status: "ok", stopped: true };
    await f.reconcile();
    assert.equal(f.calls.at(-1)?.status, "active");
    assert.deepEqual(await f.store.entries(), []);
  }
});

test("steering the same run is idempotent and older completion cannot clear a newer run", async () => {
  const f = fixture();
  await f.enable();
  const old = f.add("old");
  f.add("new");
  await f.start("old");
  await f.start("old");
  await f.start("new");
  old.status = "done";
  await f.reconcile();
  await f.start("old");
  assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.store.all())[0]?.runIds, ["new"]);
});

test("slow processing and active requests serialize with newer work in the same thread", async () => {
  const f = fixture();
  await f.enable();
  const old = f.add("old");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = f.client.apiCall;
  f.client.apiCall = async (method, args) => {
    await call(method, args);
    await blocked;
  };
  const first = f.start("old");
  while (!f.calls.length) await new Promise((resolve) => setImmediate(resolve));
  old.status = "done";
  const cleanup = f.reconcile();
  release();
  await Promise.all([first, cleanup]);
  assert.equal(f.calls.at(-1)?.status, "active");
  f.add("new");
  await f.start("new");
  assert.equal(f.calls.at(-1)?.status, "processing");
});

test("status intent survives restart, refreshes at thirty minutes and does not refresh expired leases", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start("r1");
  const restarted = f.manager();
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.calls.length, 1);
  f.advance(30 * 60_000);
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.calls.length, 2);
  run.leaseExpiresAt = 0;
  f.advance(30 * 60_000);
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.calls.length, 2);
  run.status = "failed";
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.calls.at(-1)?.status, "active");
});

test("network errors preserve cleanup intent without rejecting, permanent errors stop repeat calls", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  const call = f.client.apiCall;
  f.client.apiCall = async () => {
    throw new Error("timeout");
  };
  await f.start("r1");
  assert.equal((await f.store.all()).length, 1);
  f.client.apiCall = call;
  await f.reconcile();
  run.status = "failed";
  f.client.apiCall = async () => {
    throw new Error("rate limited");
  };
  await f.reconcile();
  assert.equal((await f.store.all()).length, 1);
  f.client.apiCall = call;
  await f.manager().reconcile(f.client, "T1:B1");
  assert.deepEqual(await f.store.all(), []);
  f.add("r2");
  let attempts = 0;
  f.client.apiCall = async () => {
    attempts++;
    throw Object.assign(new Error("unsupported"), { data: { error: "feature_disabled" } });
  };
  await f.start("r2");
  await f.reconcile();
  await f.start("r2");
  assert.equal(attempts, 1);
});

test("disabled mid-run clears existing status and each account reconciles only its own rows", async () => {
  const f = fixture();
  await f.enable();
  f.add("r1");
  await f.start("r1", "T1:B1");
  await f.start("r1", "T2:B2");
  await f.flags.setEnabled("slack_loading_indicator", "channel:C1", false, "admin");
  await f.reconcile();
  assert.equal(f.calls.filter((args) => args.status === "active").length, 1);
  assert.deepEqual(
    (await f.store.all()).map((row) => row.account),
    ["T2:B2"],
  );
});

test("core only signals engagement after committing to a reply, never for quiet ambient turns", async () => {
  for (const replying of [false, true]) {
    const stream = createTurnStream();
    let polls = 0;
    let engaged = 0;
    const core = createSlackCoreClient({
      runs: {
        onTerminal() {},
        get: async () => {
          polls++;
          if (polls === 2 && replying) stream.begin("r1");
          return { id: "r1", status: polls < 3 ? "running" : "done" };
        },
      },
      turnStream: stream,
      tasks: { list: async () => [] },
      app: { getRun: async () => ({ result: { status: "silent" } }) },
      agentRequests: createMemoryMap(),
    } as unknown as SlackCoreClientDeps);
    const result = await core.waitRun("r1", {
      onEngaged: () => {
        engaged++;
      },
    });
    assert.equal(result?.status, "silent");
    assert.equal(engaged, replying ? 1 : 0);
    stream.end("r1");
  }
});

for (const lateStatus of ["processing", "active"] as const) {
  test(`late ${lateStatus} after lease loss preserves repair intent without overwriting a new owner`, async () => {
    const f = fixture();
    await f.enable();
    const old = f.add("old");
    let lose!: () => void;
    const lost = new Promise<void>((resolve) => {
      lose = resolve;
    });
    const first = createSlackSessionStatus(f.store, { hold: async (_key, fn) => fn(lost) }, f.runs, f.flags);
    const second = f.manager();
    if (lateStatus === "active") {
      await first.start(f.client, "T1:B1", "old", "C1", "1.0");
      old.status = "done";
    }
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = {
      apiCall: async (method: string, args: Record<string, unknown>) => {
        started();
        await blocked;
        await f.client.apiCall(method, args);
      },
    };
    const inflight =
      lateStatus === "active" ? first.reconcile(delayed, "T1:B1") : first.start(delayed, "T1:B1", "old", "C1", "1.0");
    await begun;
    lose();
    if (lateStatus === "processing") {
      old.status = "done";
      await second.reconcile(f.client, "T1:B1");
    } else {
      f.add("new");
      await second.start(f.client, "T1:B1", "new", "C1", "1.0");
    }
    release();
    await inflight;
    assert.equal(f.calls.at(-1)?.status, lateStatus);
    assert.equal((await f.store.all())[0]?.refreshedAt, 0);
    await second.reconcile(f.client, "T1:B1");
    assert.equal(f.calls.at(-1)?.status, lateStatus === "processing" ? "active" : "processing");
    if (lateStatus === "active") assert.deepEqual((await f.store.all())[0]?.runIds, ["new"]);
    else assert.deepEqual(await f.store.all(), []);
  });
}

test("remote worker engagement is observed without a local turn stream", async () => {
  const stream = createTurnStream();
  let polls = 0;
  let engaged = 0;
  const core = createSlackCoreClient({
    runs: {
      onTerminal() {},
      get: async () => ({
        status: ++polls === 1 ? "running" : "done",
        deliveryState: { replying: true, editRef: "1.2" },
      }),
    },
    turnStream: stream,
    tasks: { list: async () => [] },
    app: { getRun: async () => ({ result: { status: "ok", reply: "done" } }) },
    agentRequests: createMemoryMap(),
  } as unknown as SlackCoreClientDeps);
  await core.waitRun("remote", {
    onEngaged: () => {
      engaged++;
    },
  });
  assert.equal(stream.replying("remote"), false);
  assert.equal(engaged, 1);
});

test("unavailable thread retires only its own row, not other threads on the account", async () => {
  const f = fixture();
  await f.enable();
  f.add("r1");
  const call = f.client.apiCall;
  f.client.apiCall = async (method, args) => {
    if (args.thread_ts === "1.0") throw Object.assign(new Error("missing"), { data: { error: "channel_not_found" } });
    await call(method, args);
  };
  await f.start("r1");
  assert.deepEqual(await f.store.all(), []);
  await f.start("r1", "T1:B1", "2.0");
  assert.equal(f.calls.at(-1)?.status, "processing");
  assert.equal((await f.store.all())[0]?.threadTs, "2.0");
});

test("revoked token after lease loss cannot delete a newer replica's valid status", async () => {
  const f = fixture();
  await f.enable();
  const old = f.add("old");
  let lose!: () => void;
  const lost = new Promise<void>((resolve) => {
    lose = resolve;
  });
  const first = createSlackSessionStatus(f.store, { hold: async (_key, fn) => fn(lost) }, f.runs, f.flags);
  let release!: () => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const revoked = {
    apiCall: async () => {
      started();
      await blocked;
      throw Object.assign(new Error("revoked"), { data: { error: "token_revoked" } });
    },
  };
  const inflight = first.start(revoked, "T1:B1", "old", "C1", "1.0");
  await begun;
  lose();
  old.status = "done";
  f.add("new");
  await f.start("new");
  release();
  await inflight;
  assert.deepEqual((await f.store.all())[0]?.runIds, ["new"]);
  await first.reconcile(revoked, "T1:B1");
  assert.deepEqual((await f.store.all())[0]?.runIds, ["new"]);
  await f.reconcile();
  assert.equal(f.calls.at(-1)?.status, "processing");
});
