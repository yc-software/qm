import assert from "node:assert/strict";
import { test } from "node:test";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { createSessionWork } from "../src/sessions/session-work.ts";
import { createSlackSessionStatus, type SlackSessionStatusState } from "../src/slack/session-status.ts";
import type { ProcessRecord } from "../src/processes/process-registry.ts";
import type { Session } from "../src/types.ts";
import type { Monitor } from "../src/triggers/types.ts";
import { isTerminal, type Run } from "../src/runs/run-store.ts";
import { testMap } from "./support/test-database.ts";

function fixture() {
  let at = 1_000;
  const store = testMap<SlackSessionStatusState>();
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
  const manager = (rows = store, publicWebUrl = "https://qm.example.test/web-ui/") =>
    createSlackSessionStatus(rows, createNoopLeaderLease(), runs, () => at, {
      work,
      publicWebUrl,
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
    start: async (id: string, account = "T1:B1") => {
      await status.start(client, account, id, "C1", "1.0");
      at += 30_000;
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

const WEB = "https://qm.example.test/web-ui/s/canonical-uuid";

test("cards require a reply thread and non-private engagement", async () => {
  const f = fixture();
  const run = f.add("r1");
  run.status = "done";
  f.background();
  await f.status.start(f.client, "T1:B1", run.id, "D1");
  run.deliveryState = null;
  await f.start(run.id);
  run.deliveryState = { replying: true };
  run.request.privateSessionMessage = true;
  await f.start(run.id);
  assert.deepEqual(f.cards, []);
  assert.deepEqual(await f.store.all(), []);
});

test("in-turn running work defers to thinking stream; waiting work posts a plan card and clears when idle", async () => {
  const f = fixture();
  const run = f.add("r1");
  await f.start(run.id);
  assert.deepEqual(f.cards, []);
  const job = f.background();
  job.purpose = "Waiting on CI";
  run.status = "done";
  await f.reconcile();
  assert.equal(f.cards.length, 1);
  assert.equal(f.card()[0]?.type, "plan");
  assert.equal(f.card()[0]?.title, "Waiting on CI");
  assert.equal((f.card()[1] as { elements?: Array<{ text?: string }> })?.elements?.[0]?.text, `<${WEB}|Open in QM>`);
  job.status = "exited";
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
  assert.deepEqual(await f.store.all(), []);
});

test("concurrent starts share one waiting card, terminal runs cannot clear active work, and later work gets a fresh card", async () => {
  const f = fixture();
  const old = f.add("old");
  old.status = "done";
  const next = f.add("next");
  next.status = "done";
  const job = f.background();
  await Promise.all([f.start(old.id), f.start(next.id), f.start(old.id)]);
  const posts = () => f.cards.filter((call) => call.method === "chat.postMessage").length;
  assert.equal(posts(), 1);
  await f.reconcile();
  await f.start(old.id);
  assert.equal(posts(), 1);
  job.status = "exited";
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
  assert.deepEqual(await f.store.all(), []);
  const oldCard = f.card()[0]?.block_id;
  const later = f.add("later");
  later.status = "done";
  f.background();
  await f.start(later.id);
  assert.equal(f.cards.at(-1)?.method, "chat.postMessage");
  assert.notEqual(f.card()[0]?.block_id, oldCard);
});

test("restart preserves card identity and pending or expired-lease work is waiting, not working", async () => {
  const f = fixture();
  const run = f.add("r1");
  run.leaseExpiresAt = 0;
  await f.start(run.id);
  const restarted = f.manager();
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.cards.length, 1);
  assert.equal(f.card()[0]?.title, "Queued");
  run.status = "pending";
  await restarted.reconcile(f.client, "T1:B1");
  assert.equal(f.cards.length, 1);
  run.status = "running";
  run.leaseExpiresAt = Number.MAX_SAFE_INTEGER;
  await restarted.reconcile(f.client, "T1:B1");
  assert.deepEqual(f.deleted, ["card.1"]);
});

test("background lifecycle survives restart, links to the web conversation, and vanishes at the end", async () => {
  const f = fixture();
  const run = f.add("r1");
  const job = f.background();
  run.status = "done";
  await f.start(run.id);
  assert.equal(f.card()[0]?.type, "plan");
  assert.equal(f.card()[0]?.title, "Background job");
  const monitor = f.watch();
  await f.manager().reconcile(f.client, "T1:B1");
  assert.equal(f.card()[0]?.title, "Watching for updates");
  job.status = "exited";
  monitor.enabled = false;
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
  assert.deepEqual(await f.store.all(), []);
  assert.equal(f.cards.filter((call) => call.method === "chat.postMessage").length, 1);
  assert.ok(!JSON.stringify(f.cards).includes("secret-"));
});

test("waiting card holds while a reply is still in the delivery outbox and vanishes once landed", async () => {
  const f = fixture();
  const run = f.add("r1");
  const job = f.background();
  job.purpose = "Waiting on CI";
  run.status = "done";
  await f.start(run.id);
  assert.equal(f.card()[0]?.title, "Waiting on CI");
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

test("work that ends without waiting work posts nothing", async () => {
  const f = fixture();
  const quick = f.add("quick");
  quick.sessionId = "ch:C1:2.0";
  await f.status.start(f.client, "T1:B1", quick.id, "C1", "2.0");
  quick.status = "done";
  await f.reconcile();
  assert.ok(f.cards.every((call) => call.args.thread_ts !== "2.0"));
  assert.ok((await f.store.all()).every((row) => row.threadTs !== "2.0"));
});

test("running subagents keep one plan waiting card titled with their latest step", async () => {
  const f = fixture();
  const run = f.add("r1");
  const child = f.subagent("c1", "Slack status card personality");
  f.purposes.set(child.id, "Reading Slack docs");
  f.subagent("c2", "Elsewhere", "channel:other");
  run.status = "done";
  await f.start(run.id);
  assert.equal(f.card()[0]?.type, "plan");
  assert.equal(f.card()[0]?.title, "Still working: reading Slack docs");
  f.purposes.set(child.id, "PR checks for the card");
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "Still working: PR checks for the card");
  child.status = "done";
  const job = f.background("sub:c1");
  job.purpose = "Waiting on CI";
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "Still working: waiting on CI");
  const watch = f.watch("sub:c1");
  watch.purpose = "Watching the deploy";
  job.status = "exited";
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "Still working: watching the deploy");
  watch.enabled = false;
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
});

test("a finished subagent whose result has not reached the parent yet keeps the waiting card active", async () => {
  const f = fixture();
  const run = f.add("r1");
  const child = f.subagent("c1", "Worker");
  child.status = "done";
  f.unreturned.add(child.id);
  run.status = "done";
  await f.start(run.id);
  assert.equal(f.card()[0]?.title, "Still working: wrapping up");
  f.unreturned.delete(child.id);
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
});

test("a busy grandchild's step titles the waiting card", async () => {
  const f = fixture();
  const run = f.add("r1");
  const child = f.subagent("c1", "Coordinator");
  child.status = "done";
  const grandchild = f.subagent("g1", "Worker", "channel:C1", "c1");
  f.purposes.set(grandchild.id, "Running the test suite");
  run.status = "done";
  await f.start(run.id);
  assert.equal(f.card()[0]?.title, "Still working: running the test suite");
});

test("an unchanged live waiting card costs no store writes or Slack calls per sweep", async () => {
  const f = fixture();
  const run = f.add("r1");
  const job = f.background();
  job.purpose = "Waiting on CI";
  run.status = "done";
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
  job.purpose = "Finishing build";
  await f.reconcile();
  assert.equal(f.card()[0]?.title, "Finishing build");
});

test("unrelated, expired, disabled and private work never keeps a card active", async () => {
  const f = fixture();
  const run = f.add("r1");
  const job = f.background();
  run.status = "done";
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
  job.status = "exited";
  await f.reconcile();
  assert.deepEqual(f.deleted, ["card.1"]);
});
