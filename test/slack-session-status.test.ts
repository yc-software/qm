import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { createFeatureFlagStore } from "../src/feature-flags.ts";
import { createSlackSessionStatus, type SlackSessionStatusState } from "../src/slack/session-status.ts";
import { createSlackCoreClient, type SlackCoreClientDeps } from "../src/api/slack-core-client.ts";
import { createTurnStream } from "../src/runs/turn-stream.ts";
import type { ProcessRecord } from "../src/processes/process-registry.ts";
import type { Session } from "../src/types.ts";
import type { Monitor } from "../src/types.ts";
import type { Run } from "../src/runs/run-store.ts";

function fixture() {
  let at = 1_000;
  const store = createMemoryMap<SlackSessionStatusState>();
  const flags = createFeatureFlagStore(createMemoryMap());
  const records = new Map<string, Run>();
  const jobs: ProcessRecord[] = [];
  const watches: Monitor[] = [];
  const runs = {
    get: async (id: string) => records.get(id) ?? null,
    inFlightForThread: async (sessionId: string) =>
      [...records.values()].filter((run) => run.sessionId === sessionId && ["pending", "running"].includes(run.status)),
    latestForThread: async (threadRef: string, opts?: { statusUpdatesOnly?: boolean }) =>
      [...records.values()]
        .filter(
          (run) =>
            run.sessionId === threadRef &&
            !run.request.privateSessionMessage &&
            (!opts?.statusUpdatesOnly ||
              run.deliveryState?.replying === true ||
              (run.request.surface === "monitor" &&
                (run.status === "failed" ||
                  (run.status === "done" && ["failed", "refused"].includes(run.result?.status ?? ""))))),
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
  };
  const calls: Array<Record<string, unknown>> = [];
  const cards: Array<{ method: string; args: Record<string, unknown> }> = [];
  const client = {
    apiCall: async (method: string, args: Record<string, unknown>) => {
      if (method === "agents.sessions.setStatus") calls.push(args);
      else cards.push({ method, args });
      return { ts: "card.1" };
    },
  };
  const manager = () =>
    createSlackSessionStatus(store, createNoopLeaderLease(), runs, flags, () => at, {
      processes: {
        liveByScope: async (scope) =>
          jobs.filter((job) => job.scopeId === scope && job.status === "running" && job.expiresAt > at),
      },
      monitors: { enabled: async () => watches.filter((watch) => watch.enabled) },
      publicWebUrl: "https://qm.example.test/web-ui/",
      sessions: {
        getByThread: async (threadRef) => (threadRef === "session-1" ? ({ id: "canonical-uuid" } as Session) : null),
      },
    });
  const status = manager();
  const add = (id: string) => {
    const run = {
      id,
      sessionId: "session-1",
      createdAt: at,
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
    jobs,
    watches,
    flags,
    records,
    runs,
    calls,
    cards,
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
    if (method === "agents.sessions.setStatus") await blocked;
    return { ts: "card.1" };
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
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.at(-1)?.status, "active");
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
  f.client.apiCall = async (method, args) => {
    if (method !== "agents.sessions.setStatus") return call(method, args);
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
        if (method === "agents.sessions.setStatus") {
          started();
          await blocked;
        }
        return f.client.apiCall(method, args);
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
    return call(method, args);
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
    apiCall: async (method: string, args: Record<string, unknown>) => {
      if (method !== "agents.sessions.setStatus") return f.client.apiCall(method, args);
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

function background(f: ReturnType<typeof fixture>, sessionRef = "ch:C1:1.0") {
  const job: ProcessRecord = {
    processId: "p1",
    scopeId: "channel:C1",
    kind: "background",
    command: "secret-command-never-rendered",
    startedAt: 1_000,
    expiresAt: 3_600_000,
    status: "running",
    sessionRef,
  };
  f.jobs.push(job);
  return job;
}

function watch(f: ReturnType<typeof fixture>, threadRef = "ch:C1:1.0") {
  const monitor = {
    id: "m1",
    ownerScopeId: "channel:C1",
    processId: "p1",
    command: "secret-monitor-command",
    instructions: "secret-instructions",
    enabled: true,
    expiresAt: 3_600_000,
    threadRef,
  } as Monitor;
  f.watches.push(monitor);
  return monitor;
}

function card(f: ReturnType<typeof fixture>) {
  return f.cards.at(-1)!.args.blocks as Array<Record<string, unknown>>;
}

test("one card persists through background waiting, restart, monitor wake, and terminal outcome", async () => {
  const f = fixture();
  await f.enable();
  const initial = f.add("initial");
  await f.start(initial.id);
  assert.equal(card(f)[0]?.title, "Working");
  const job = background(f);
  initial.status = "done";
  await f.reconcile();
  assert.equal(card(f)[0]?.title, "Waiting on recorded background jobs");
  assert.equal(f.calls.at(-1)?.status, "active");
  const monitor = watch(f);
  await f.manager().reconcile(f.client, "T1:B1");
  assert.equal(card(f)[0]?.title, "Watching background work");
  f.advance(300_001);
  await f.reconcile();
  assert.deepEqual(card(f)[1], {
    type: "context",
    elements: [{ type: "mrkdwn", text: "<https://qm.example.test/web-ui/s/canonical-uuid|Follow via QM Web>" }],
  });
  const resumed = f.add("resumed");
  resumed.deliveryState = { replying: true };
  await f.reconcile();
  assert.equal(card(f)[0]?.title, "Working");
  assert.equal(card(f).length, 2);
  assert.equal((await f.store.all())[0]?.startedAt, 1_000);
  resumed.status = "failed";
  job.status = "exited";
  monitor.enabled = false;
  await f.reconcile();
  assert.equal(card(f)[0]?.title, "Failed");
  assert.equal(card(f)[0]?.status, "error");
  assert.equal(card(f).length, 2);
  assert.equal(f.cards.filter((call) => call.method === "chat.postMessage").length, 1);
  assert.ok(f.cards.filter((call) => call.method === "chat.update").every((call) => call.args.ts === "card.1"));
  assert.ok(!JSON.stringify(f.cards).includes("secret-"));
  assert.deepEqual(await f.store.all(), []);
});

test("background work and monitor counts are exact-conversation only and exclude expired or disabled activity", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  background(f, "ch:C1:other");
  background(f).kind = "dev-server";
  background(f).expiresAt = 999;
  watch(f, "ch:C1:other");
  watch(f).ownerScopeId = "channel:other";
  watch(f).enabled = false;
  watch(f).expiresAt = 999;
  const quiet = f.add("quiet");
  quiet.deliveryState = null;
  const privateRun = f.add("private");
  privateRun.deliveryState = { replying: true };
  privateRun.request = { ...privateRun.request, privateSessionMessage: true };
  run.status = "done";
  await f.reconcile();
  assert.equal(card(f)[0]?.title, "Finished");
  assert.equal(card(f)[0]?.status, "complete");
});

test("a short failed monitor wake between sweeps supplies the final outcome", async () => {
  const f = fixture();
  await f.enable();
  const initial = f.add("initial");
  await f.start(initial.id);
  initial.status = "done";
  background(f);
  await f.reconcile();
  f.advance(100);
  const wake = f.add("wake");
  wake.deliveryState = { replying: true };
  wake.status = "failed";
  f.advance(100);
  f.add("quiet-after-wake").status = "done";
  f.jobs.length = 0;
  await f.reconcile();
  assert.equal(card(f)[0]?.title, "Failed");
});

test("five-minute link is absent at threshold, appended on completion, and never posts another message", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  f.advance(300_000);
  await f.reconcile();
  assert.equal(card(f).length, 1);
  f.advance(1);
  run.status = "done";
  await f.reconcile();
  assert.equal(card(f).length, 2);
  assert.equal(f.cards.filter((call) => call.method === "chat.postMessage").length, 1);
});

test("opt-out settles waiting cards without cancelling background work", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  run.status = "done";
  const job = background(f);
  watch(f);
  await f.reconcile();
  await f.flags.setEnabled("slack_loading_indicator", "channel:C1", false, "admin");
  await f.reconcile();
  assert.equal(card(f)[0]?.title, "Status updates disabled");
  assert.equal(card(f)[0]?.status, "complete");
  assert.equal(job.status, "running");
  assert.deepEqual(await f.store.all(), []);
});

test("card API failure does not prevent native status and retries update the same card", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  const call = f.client.apiCall;
  f.client.apiCall = async (method, args) => {
    if (method === "chat.update") throw new Error("timeout");
    return call(method, args);
  };
  run.status = "done";
  await f.reconcile();
  assert.equal(f.calls.at(-1)?.status, "active");
  assert.equal((await f.store.all()).length, 1);
  f.client.apiCall = call;
  await f.reconcile();
  assert.equal(card(f)[0]?.title, "Finished");
  assert.equal(f.cards.filter((call) => call.method === "chat.postMessage").length, 1);
});

test("a delayed initial insert after lease loss cannot replace a newer card", async () => {
  const f = fixture();
  await f.enable();
  const old = f.add("old");
  let lose!: () => void;
  const lost = new Promise<void>((resolve) => {
    lose = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const begun = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = createSlackSessionStatus(
    {
      ...f.store,
      putIfAbsent: async (id, value) => {
        entered();
        await blocked;
        return f.store.putIfAbsent(id, value);
      },
    },
    { hold: async (_key, fn) => fn(lost) },
    f.runs,
    f.flags,
  );
  const pending = first.start(f.client, "T1:B1", old.id, "C1", "1.0");
  await begun;
  lose();
  old.status = "done";
  f.advance(1);
  f.add("new");
  await f.start("new");
  const newer = (await f.store.all())[0]!;
  release();
  await pending;
  await f.reconcile();
  assert.equal((await f.store.all())[0]?.cardId, newer.cardId);
  assert.equal((await f.store.all())[0]?.cardTs, newer.cardTs);
  assert.equal(f.cards.filter((call) => call.method === "chat.postMessage").length, 1);
});

test("late card receipt after lease loss retains its timestamp for reconciliation", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  let lose!: () => void;
  const lost = new Promise<void>((resolve) => {
    lose = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const begun = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const delayed = {
    apiCall: async (method: string, args: Record<string, unknown>) => {
      const result = await f.client.apiCall(method, args);
      if (method === "chat.postMessage") {
        entered();
        await blocked;
      }
      return result;
    },
  };
  const first = createSlackSessionStatus(f.store, { hold: async (_key, fn) => fn(lost) }, f.runs, f.flags);
  const pending = first.start(delayed, "T1:B1", run.id, "C1", "1.0");
  await begun;
  lose();
  release();
  await pending;
  run.status = "done";
  await f.reconcile();
  assert.equal(f.cards.filter((call) => call.method === "chat.postMessage").length, 1);
  assert.equal(card(f)[0]?.title, "Finished");
});

for (const outcome of ["failed", "refused"] as const) {
  test(`a monitor ${outcome} before engagement is reported without a processing spinner`, async () => {
    const f = fixture();
    await f.enable();
    const initial = f.add("initial");
    await f.start(initial.id);
    initial.status = "done";
    background(f);
    await f.reconcile();
    f.advance(100);
    const wake = f.add("wake");
    wake.request = { ...wake.request, surface: "monitor" };
    wake.status = "done";
    wake.result = { status: outcome };
    f.advance(100);
    f.add("quiet-after-wake").status = "done";
    f.jobs.length = 0;
    await f.reconcile();
    assert.equal(card(f)[0]?.title, outcome === "failed" ? "Failed" : "Could not proceed");
    assert.notEqual(card(f)[0]?.status, "in_progress");
    assert.equal(f.calls.filter((call) => call.status === "processing").length, 1);
  });
}
