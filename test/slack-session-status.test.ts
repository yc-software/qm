import assert from "node:assert/strict";
import { test } from "node:test";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { createFeatureFlagStore } from "../src/feature-flags.ts";
import { createSessionWork } from "../src/sessions/session-work.ts";
import { createSlackSessionStatus, type SlackSessionStatusState } from "../src/slack/session-status.ts";
import { createSlackCoreClient, type SlackCoreClientDeps } from "../src/api/slack-core-client.ts";
import { createTurnStream } from "../src/runs/turn-stream.ts";
import type { ProcessRecord } from "../src/processes/process-registry.ts";
import type { Session } from "../src/types.ts";
import type { Monitor } from "../src/triggers/types.ts";
import { isTerminal, type Run } from "../src/runs/run-store.ts";
import { testMap } from "./support/test-database.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let at = 1_000;
  const store = testMap<SlackSessionStatusState>();
  const flags = createFeatureFlagStore(testMap());
  const records = new Map<string, Run>();
  const jobs: ProcessRecord[] = [];
  const watches: Monitor[] = [];
  const children: Session[] = [];
  const purposes = new Map<string, string>();
  const unreturned = new Set<string>();
  const outbox: Array<{ provenance?: { sourceThreadRef: string } }> = [];
  const deleted: string[] = [];
  const runs = {
    get: async (id: string) => records.get(id) ?? null,
    inFlightForThread: async (threadRef: string) =>
      [...records.values()].filter((run) => run.sessionId === threadRef && !isTerminal(run.status)),
    activeForThreads: async (threadRefs: readonly string[]) =>
      new Map(
        [...records.values()]
          .filter((run) => threadRefs.includes(run.sessionId) && !isTerminal(run.status))
          .map((run) => [run.sessionId, run]),
      ),
    pendingReturns: async (_limit?: number, _after?: string, threadRefs: readonly string[] = []) =>
      [...records.values()].filter(
        (run) => unreturned.has(run.id) && isTerminal(run.status) && threadRefs.includes(run.sessionId),
      ),
  };
  const cards: Array<{ method: string; args: Record<string, unknown> }> = [];
  const client = {
    apiCall: async (method: string, args: Record<string, unknown>) => {
      assert.ok(["chat.postMessage", "chat.update", "chat.delete"].includes(method));
      if (method === "chat.delete") {
        deleted.push(String(args.ts));
        return {};
      }
      cards.push({ method, args });
      return { ts: method === "chat.update" ? String(args.ts) : `card.${cards.length}` };
    },
  };
  const work = createSessionWork(
    {
      runs,
      processes: {
        liveByScope: async (scope) =>
          jobs.filter((job) => job.scopeId === scope && job.status === "running" && job.expiresAt > at),
      },
      monitors: { ownedBy: async (scope) => watches.filter((watch) => watch.ownerScopeId === scope) },
      deliveries: {
        pending: async (_type, thread) => outbox.filter((d) => d.provenance?.sourceThreadRef === thread) as never,
      },
      sessions: {
        getByThread: async (threadRef) =>
          threadRef === "ch:C1:1.0" ? ({ id: "canonical-uuid", scopeId: "channel:C1" } as Session) : null,
        childrenOf: async (id) => children.filter((child) => child.parentSessionId === id),
        descendantsOf: async (rootIds) => {
          const found: Array<{ id: string; rootId: string; threadRef: string }> = [];
          const walk = (rootId: string, parentId: string) => {
            for (const child of children.filter((c) => c.parentSessionId === parentId)) {
              found.push({ id: child.id, rootId, threadRef: child.threadRef });
              walk(rootId, child.id);
            }
          };
          for (const rootId of rootIds) walk(rootId, rootId);
          return found;
        },
        latestToolSteps: async (ids) =>
          new Map(
            ids.flatMap((id) => {
              const purpose = purposes.get(id);
              return purpose ? [[id.toLowerCase(), { tool: "execute", at, purpose }]] : [];
            }),
          ),
      },
    },
    () => at,
  );
  const manager = (rows = store) =>
    createSlackSessionStatus(rows, createNoopLeaderLease(), runs, flags, () => at, {
      work,
      publicWebUrl: "https://qm.example.test/web-ui/",
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
  const subagent = (id: string, title: string, scope = "channel:C1", parentSessionId = "canonical-uuid") => {
    const child = { id, title, scopeId: scope, threadRef: `sub:${id}`, parentSessionId } as Session;
    children.push(child);
    const run = add(`${id}-run`);
    run.sessionId = child.threadRef;
    return run;
  };
  return {
    store,
    flags,
    records,
    purposes,
    unreturned,
    outbox,
    deleted,
    work,
    subagent,
    runs,
    cards,
    client,
    manager,
    status,
    add,
    background,
    watch,
    enable: () => flags.setEnabled("slack_loading_indicator", "channel:C1", true, "admin"),
    start: async (id: string, account = "T1:B1", emoji?: string) => {
      await status.start(client, account, id, "C1", "1.0", emoji ? Promise.resolve(emoji) : undefined);
      at += 10_000;
      await status.reconcile(client, account);
    },
    reconcile: () => status.reconcile(client, "T1:B1"),
    card: () => cards.at(-1)!.args.blocks as Array<Record<string, unknown>>,
    now: () => at,
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
  assert.deepEqual(f.deleted, ["card.1"]);
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
  assert.equal(f.card()[0]?.title, "Queued");
  run.status = "pending";
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.cards.length, 2);
  run.status = "running";
  run.leaseExpiresAt = Number.MAX_SAFE_INTEGER;
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.card()[0]?.title, "Thinking it through");
  assert.ok(f.cards.slice(1).every((call) => call.args.ts === "card.1"));
});

test("background lifecycle survives restart, links to the web conversation from the start, and vanishes at the end", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  assert.deepEqual(f.card()[1], {
    type: "context",
    elements: [{ type: "mrkdwn", text: "<https://qm.example.test/web-ui/s/canonical-uuid|Follow via QM Web>" }],
  });
  const job = f.background();
  run.status = "done";
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "Background job");
  const monitor = f.watch();
  await f.manager().reconcile(f.client, "T1:B1");
  assert.equal(f.card()[0]?.title, "Watching for updates");
  f.advance(290_000);
  const wake = f.add("wake");
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "Thinking it through");
  assert.equal((await f.store.all())[0]?.startedAt, 1_000);
  wake.status = "done";
  job.status = "exited";
  monitor.enabled = false;
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
  assert.deepEqual(await f.store.all(), []);
  assert.equal(f.cards.filter((call) => call.method === "chat.postMessage").length, 1);
  assert.ok(!JSON.stringify(f.cards).includes("secret-"));
});

const line = (block: Record<string, unknown> | undefined) =>
  (block?.details as { elements: Array<{ elements: unknown[] }> } | undefined)?.elements[0]?.elements;

test("the card shows the latest step with the ack emoji and vanishes once the reply has landed", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.status.start(f.client, "T1:B1", run.id, "C1", "1.0", Promise.resolve("gear"));
  assert.deepEqual(f.cards, []);
  f.advance(10_000);
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "⚙️ Thinking it through");
  assert.deepEqual(line(f.card()[0]), [{ type: "text", text: "Working on it" }]);
  f.purposes.set("r1", "Reading status implementation");
  f.advance(51_000);
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "⚙️ Reading status implementation");
  assert.deepEqual(line(f.card()[0]), [{ type: "text", text: "Working on it · 1m" }]);
  const posts = f.cards.length;
  await f.reconcile();
  assert.equal(f.cards.length, posts);
  const job = f.background();
  job.purpose = "Waiting on CI";
  run.status = "done";
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "⚙️ Waiting on CI");
  assert.deepEqual(line(f.card()[0]), [{ type: "text", text: "Running in the background · 1m" }]);
  job.status = "exited";
  f.outbox.push({ provenance: { sourceThreadRef: "ch:C1:1.0" } }, { provenance: { sourceThreadRef: "ch:C1:9.0" } });
  const shown = f.cards.length;
  await f.reconcile();
  assert.equal(f.cards.length, shown);
  assert.deepEqual(f.deleted, []);
  f.outbox.splice(0, 1);
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
  assert.deepEqual(await f.store.all(), []);
});

test("custom ack emoji ride in the details, and work that ends before the card is due posts nothing", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id, "T1:B1", "qm-wave");
  assert.equal(f.card()[0]?.title, "Thinking it through");
  assert.deepEqual(line(f.card()[0]), [
    { type: "emoji", name: "qm-wave" },
    { type: "text", text: " Working on it" },
  ]);
  const quick = f.add("quick");
  quick.sessionId = "ch:C1:2.0";
  await f.status.start(f.client, "T1:B1", quick.id, "C1", "2.0");
  quick.status = "done";
  f.advance(10_000);
  await f.reconcile();
  assert.ok(f.cards.every((call) => call.args.thread_ts !== "2.0"));
  assert.ok((await f.store.all()).every((row) => row.threadTs !== "2.0"));
});

test("running subagents keep the card open as plan rows showing their latest step", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  const child = f.subagent("c1", "Slack status card personality");
  f.purposes.set(child.id, "Reading Slack docs");
  f.subagent("c2", "Elsewhere", "channel:other");
  run.status = "done";
  await f.reconcile();
  const plan = f.card()[0] as { type: string; title: string; tasks: Array<Record<string, unknown>> };
  assert.equal(plan.type, "plan");
  assert.equal(plan.title, "Waiting on subagents");
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0]?.title, "Slack status card personality");
  assert.deepEqual(line(plan.tasks[0]), [{ type: "text", text: "Reading Slack docs" }]);
  child.status = "done";
  const job = f.background("sub:c1");
  job.purpose = "Waiting on CI";
  await f.reconcile();
  assert.equal((f.card()[0] as typeof plan).tasks[0]?.title, "Slack status card personality");
  assert.deepEqual(line((f.card()[0] as typeof plan).tasks[0]), [{ type: "text", text: "Waiting on CI" }]);
  const watch = f.watch("sub:c1");
  watch.purpose = "Watching the deploy";
  await f.reconcile();
  assert.deepEqual(line((f.card()[0] as typeof plan).tasks[0]), [{ type: "text", text: "Watching the deploy" }]);
  job.status = "exited";
  watch.enabled = false;
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
});

test("a turn that hands work to a subagent and finishes before the card starts still gets a card while that work runs", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  run.status = "done";
  const child = f.subagent("c1", "Worker");
  child.status = "done";
  const job = f.background("sub:c1");
  job.purpose = "Waiting on CI";
  await f.start(run.id);
  assert.deepEqual(line((f.card()[0] as { tasks: Array<Record<string, unknown>> }).tasks[0]), [
    { type: "text", text: "Waiting on CI" },
  ]);
  job.status = "exited";
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
  const quick = f.add("quick");
  quick.status = "done";
  await f.start(quick.id);
  assert.deepEqual(await f.store.all(), []);
});

test("a finished subagent whose result has not reached the parent yet keeps the card waiting", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  const child = f.subagent("c1", "Worker");
  child.status = "done";
  f.unreturned.add(child.id);
  run.status = "done";
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "Waiting on subagents");
  assert.equal(f.card()[0]?.status, "in_progress");
  f.unreturned.delete(child.id);
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
});

test("a busy grandchild keeps its subagent row open, and overflow rows are counted rather than dropped", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  const child = f.subagent("c1", "Coordinator");
  child.status = "done";
  const grandchild = f.subagent("g1", "Worker", "channel:C1", "c1");
  f.purposes.set(grandchild.id, "Running the test suite");
  run.status = "done";
  await f.reconcile();
  const plan = f.card()[0] as { title: string; tasks: Array<Record<string, unknown>> };
  assert.deepEqual(
    plan.tasks.map((task) => [task.title, line(task)]),
    [["Coordinator", [{ type: "text", text: "Running the test suite" }]]],
  );
  for (let i = 0; i < 50; i++) f.subagent(`extra${i}`, `Extra ${i}`);
  await f.reconcile();
  const tasks = (f.card()[0] as typeof plan).tasks;
  assert.equal(tasks.length, 50);
  assert.equal(tasks.at(-1)?.title, "2 more subagents");
});

test("an unchanged live card costs no store writes or Slack calls per sweep", async () => {
  const f = fixture();
  await f.enable();
  const run = f.add("r1");
  await f.start(run.id);
  let writes = 0;
  const counted = {
    ...f.store,
    update: (...args: Parameters<typeof f.store.update>) => {
      writes++;
      return f.store.update(...args);
    },
  };
  const status = f.manager(counted);
  const calls = f.cards.length;
  await status.reconcile(f.client, "T1:B1");
  await status.reconcile(f.client, "T1:B1");
  assert.equal(writes, 0);
  assert.equal(f.cards.length, calls);
  f.purposes.set("r1", "Reading files");
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "Reading files");
});

test("unrelated, expired, disabled and private work never keeps a card active", async () => {
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
  f.add("private").request.privateSessionMessage = true;
  f.add("other").sessionId = "other-thread";
  run.status = "done";
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
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
  assert.deepEqual(f.deleted, ["card.1"]);
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
  assert.deepEqual(f.deleted, ["card.1"]);
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
    f.now,
    { work: f.work },
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
    const first = createSlackSessionStatus(
      f.store,
      { hold: async (_key, fn) => fn(lost.promise) },
      f.runs,
      f.flags,
      f.now,
      { work: f.work },
    );
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
    if (method === "chat.postMessage") {
      await first.start(delayed, "T1:B1", run.id, "C1", "1.0");
      f.advance(10_000);
    }
    const pending = first.reconcile(delayed, "T1:B1");
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
    if (method === "chat.update") assert.equal(f.card()[0]?.title, "Thinking it through");
    else assert.deepEqual(f.deleted, ["card.1"]);
  });
}

test("core engagement is signaled once for local or durable replies, never quiet ambient turns", async () => {
  for (const mode of ["quiet", "local", "remote"]) {
    const stream = createTurnStream();
    let polls = 0,
      engaged = 0;
    const core = createSlackCoreClient({
      runs: {
        watchSession: () => ({ changed: async () => {}, close() {} }),
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
      app: { getRun: async () => ({ result: { status: "silent" } }) },
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
