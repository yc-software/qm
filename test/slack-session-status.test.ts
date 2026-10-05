import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { createFeatureFlagStore } from "../src/feature-flags.ts";
import { createSlackSessionStatus, type SlackSessionStatusState } from "../src/slack/session-status.ts";
import { createSlackCoreClient, type SlackCoreClientDeps } from "../src/api/slack-core-client.ts";
import { createTurnStream } from "../src/runs/turn-stream.ts";
import type { ProcessRecord } from "../src/processes/process-registry.ts";
import type { Session, Monitor } from "../src/types.ts";
import { isTerminal, type Run } from "../src/runs/run-store.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let at = 1_000;
  const store = createMemoryMap<SlackSessionStatusState>();
  const flags = createFeatureFlagStore(createMemoryMap());
  const records = new Map<string, Run>();
  const jobs: ProcessRecord[] = [];
  const watches: Monitor[] = [];
  const runs = {
    get: async (id: string) => records.get(id) ?? null,
    inFlightForThread: async (threadRef: string) =>
      [...records.values()].filter((run) => run.sessionId === threadRef && !isTerminal(run.status)),
  };
  const cards: Array<{ method: string; args: Record<string, unknown> }> = [];
  const client = {
    apiCall: async (method: string, args: Record<string, unknown>) => {
      assert.ok(["chat.postMessage", "chat.update"].includes(method));
      cards.push({ method, args });
      return { ts: method === "chat.update" ? String(args.ts) : `card.${cards.length}` };
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
        getByThread: async (threadRef) => (threadRef === "ch:C1:1.0" ? ({ id: "canonical-uuid" } as Session) : null),
      },
    });
  const status = manager();
  const add = (id: string) => {
    const run = {
      id,
      sessionId: "ch:C1:1.0",
      createdAt: at,
      status: "running",
      leaseExpiresAt: Number.MAX_SAFE_INTEGER,
      deliveryState: { replying: true },
      request: { conversation: { kind: "channel", channelRef: "C1", threadRef: "ch:C1:1.0" }, actor: { id: "U1" } },
    } as Run;
    records.set(id, run);
    return run;
  };
  const background = (sessionRef = "ch:C1:1.0") => {
    const job: ProcessRecord = {
      sandboxId: "sandbox-test",
      processId: "p1",
      scopeId: "channel:C1",
      kind: "background",
      command: "secret-command",
      startedAt: at,
      expiresAt: at + 3_600_000,
      status: "running",
      sessionRef,
    };
    jobs.push(job);
    return job;
  };
  const watch = (threadRef = "ch:C1:1.0") => {
    const monitor = {
      id: "m1",
      ownerScopeId: "channel:C1",
      processId: "p1",
      command: "secret-command",
      instructions: "secret-instructions",
      enabled: true,
      expiresAt: at + 3_600_000,
      threadRef,
    } as Monitor;
    watches.push(monitor);
    return monitor;
  };
  return {
    store,
    flags,
    records,
    runs,
    cards,
    client,
    manager,
    status,
    add,
    background,
    watch,
    enable: () => flags.setEnabled("slack_loading_indicator", "channel:C1", true, "admin"),
    start: (id: string, account = "T1:B1") => status.start(client, account, id, "C1", "1.0"),
    reconcile: () => status.reconcile(client, "T1:B1"),
    card: () => cards.at(-1)!.args.blocks as Array<Record<string, unknown>>,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("cards require opt-in, a reply thread and non-private engagement", async () => {
  const f = fixture();
  const run = f.add("r1");
  await f.start(run.id);
  await f.enable();
  await f.status.start(f.client, "T1:B1", run.id, "D1");
  run.deliveryState = null;
  await f.start(run.id);
  run.deliveryState = { replying: true };
  run.request.privateSessionMessage = true;
  await f.start(run.id);
  assert.deepEqual(f.cards, []);
  assert.deepEqual(await f.store.all(), []);
});

test("concurrent starts share one card, terminal runs cannot clear active work, and later work gets a fresh card", async () => {
  const f = fixture();
  await f.enable();
  const old = f.add("old");
  const next = f.add("next");
  await Promise.all([f.start(old.id), f.start(next.id), f.start(old.id)]);
  assert.equal(f.cards.length, 1);
  old.status = "done";
  await f.reconcile();
  await f.start(old.id);
  assert.equal(f.cards.length, 1);
  next.status = "failed";
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "No active work");
  assert.equal(f.card()[0]?.status, "complete");
  assert.deepEqual(await f.store.all(), []);
  const oldCard = f.card()[0]?.task_id;
  f.add("later");
  await f.start("later");
  assert.equal(f.cards.at(-1)?.method, "chat.postMessage");
  assert.notEqual(f.card()[0]?.task_id, oldCard);
});

test("restart preserves card identity and pending or expired-lease work is waiting, not working", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  const restarted = f.manager();
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.cards.length, 1);
  run.leaseExpiresAt = 0;
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.card()[0]?.title, "Waiting to resume");
  run.status = "pending";
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.cards.length, 2);
  run.status = "running";
  run.leaseExpiresAt = Number.MAX_SAFE_INTEGER;
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.card()[0]?.title, "Working");
  assert.ok(f.cards.slice(1).every((call) => call.args.ts === "card.1"));
});

test("background lifecycle survives restart and gains a canonical link after five minutes including waits", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  const job = f.background();
  run.status = "done";
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "Background work");
  const monitor = f.watch();
  await f.manager().reconcile(f.client, "T1:B1");
  assert.equal(f.card()[0]?.title, "Monitoring");
  f.advance(300_000);
  await f.reconcile();
  assert.equal(f.card().length, 1);
  f.advance(1);
  await f.reconcile();
  assert.deepEqual(f.card()[1], {
    type: "context",
    elements: [{ type: "mrkdwn", text: "<https://qm.example.test/web-ui/s/canonical-uuid|Follow via QM Web>" }],
  });
  const wake = f.add("wake");
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "Working");
  assert.equal((await f.store.all())[0]?.startedAt, 1_000);
  wake.status = "done";
  job.status = "exited";
  monitor.enabled = false;
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "No active work");
  assert.equal(f.card().length, 2);
  assert.equal(f.cards.filter((call) => call.method === "chat.postMessage").length, 1);
  assert.ok(!JSON.stringify(f.cards).includes("secret-"));
});

test("unrelated, expired, disabled, private and nonengaged work never keeps a card active", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  f.background("other-thread");
  f.background().scopeId = "channel:other";
  f.background().kind = "dev-server";
  f.background().expiresAt = 0;
  f.watch("other-thread");
  f.watch().ownerScopeId = "channel:other";
  f.watch().enabled = false;
  f.watch().expiresAt = 0;
  f.add("quiet").deliveryState = null;
  f.add("private").request.privateSessionMessage = true;
  f.add("other").sessionId = "other-thread";
  run.status = "done";
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "No active work");
});

test("opt-out settles only this account's card without cancelling work", async () => {
  const f = fixture();
  await f.enable();
  f.add("r1");
  await f.start("r1");
  await f.start("r1", "T2:B2");
  const job = f.background();
  await f.flags.setEnabled("slack_loading_indicator", "channel:C1", false, "admin");
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "No active work");
  assert.equal(f.card()[0]?.status, "complete");
  assert.equal(job.status, "running");
  assert.deepEqual(
    (await f.store.all()).map((row) => row.account),
    ["T2:B2"],
  );
});

test("transient failures retry the same card after restart; inaccessible threads retire", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  const call = f.client.apiCall;
  f.client.apiCall = async () => {
    throw new Error("timeout");
  };
  run.status = "done";
  await f.reconcile();
  assert.equal((await f.store.all()).length, 1);
  f.client.apiCall = call;
  await f.manager().reconcile(f.client, "T1:B1");
  assert.equal(f.cards.at(-1)?.args.ts, "card.1");
  assert.deepEqual(await f.store.all(), []);
  f.add("new");
  f.client.apiCall = async () => {
    throw Object.assign(new Error("missing"), { data: { error: "channel_not_found" } });
  };
  await f.start("new");
  assert.deepEqual(await f.store.all(), []);
});

test("delayed insert after lease loss cannot replace a newer card", async () => {
  const f = fixture();
  await f.enable();
  const old = f.add("old");
  const lost = deferred(),
    blocked = deferred(),
    begun = deferred();
  const first = createSlackSessionStatus(
    {
      ...f.store,
      putIfAbsent: async (id, value) => {
        begun.resolve();
        await blocked.promise;
        return f.store.putIfAbsent(id, value);
      },
    },
    { hold: async (_key, fn) => fn(lost.promise) },
    f.runs,
    f.flags,
  );
  const pending = first.start(f.client, "T1:B1", old.id, "C1", "1.0");
  await begun.promise;
  lost.resolve();
  old.status = "done";
  f.add("new");
  await f.start("new");
  const newer = (await f.store.all())[0]!;
  blocked.resolve();
  await pending;
  assert.equal((await f.store.all())[0]?.cardId, newer.cardId);
  assert.equal(f.cards.length, 1);
});

for (const method of ["chat.postMessage", "chat.update"]) {
  test(`late ${method} after lease loss retains its receipt and repairs stale content`, async () => {
    const f = fixture();
    await f.enable();
    const run = f.add("r1");
    const lost = deferred(),
      blocked = deferred(),
      begun = deferred();
    const first = createSlackSessionStatus(f.store, { hold: async (_key, fn) => fn(lost.promise) }, f.runs, f.flags);
    if (method === "chat.update") {
      await f.start(run.id);
      run.status = "done";
    }
    const delayed = {
      apiCall: async (called: string, args: Record<string, unknown>) => {
        begun.resolve();
        await blocked.promise;
        return f.client.apiCall(called, args);
      },
    };
    const pending =
      method === "chat.update" ? first.reconcile(delayed, "T1:B1") : first.start(delayed, "T1:B1", run.id, "C1", "1.0");
    await begun.promise;
    lost.resolve();
    if (method === "chat.update") {
      f.add("new");
      await f.start("new");
    } else run.status = "done";
    blocked.resolve();
    await pending;
    await f.reconcile();
    assert.equal(f.cards.filter((call) => call.method === "chat.postMessage").length, 1);
    assert.equal(f.card()[0]?.title, method === "chat.update" ? "Working" : "No active work");
  });
}

test("core engagement is signaled once for local or durable replies, never quiet ambient turns", async () => {
  for (const mode of ["quiet", "local", "remote"]) {
    const stream = createTurnStream();
    let polls = 0,
      engaged = 0;
    const core = createSlackCoreClient({
      runs: {
        onTerminal() {},
        get: async () => {
          if (++polls === 1 && mode === "local") stream.begin("r1");
          return {
            id: "r1",
            status: polls < 3 ? "running" : "done",
            deliveryState: mode === "remote" ? { replying: true } : null,
          };
        },
      },
      turnStream: stream,
      tasks: { list: async () => [] },
      app: { getRun: async () => ({ result: { status: "silent" } }) },
      agentRequests: createMemoryMap(),
    } as unknown as SlackCoreClientDeps);
    await core.waitRun("r1", {
      onReplying: () => {
        engaged++;
      },
    });
    assert.equal(engaged, mode === "quiet" ? 0 : 1);
    stream.end("r1");
  }
});
