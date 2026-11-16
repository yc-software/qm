import "./support/auto-fake-sprites.ts";
import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { createWebEvents } from "../src/api/routes/web-events.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import type { SessionStateEvent } from "../src/runs/session-state-bus.ts";
import type { OwnedLedgerEvent } from "../src/loops/ledger-events.ts";
import type { Delivery } from "../src/types.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp, stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserImpersonationCookie, browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

const config = testConfig({ signingSecret: "web-events-signing-secret-0123456789abc" });
const built = stopAtEnd(buildApp(config));
const events = createWebEvents(built.app, built);
events.start();
after(() => events.stop());

async function serve(deps: Partial<ServerDeps> = {}, t?: TestContext): Promise<string> {
  const server = createServer(built.app, {
    ...serverDeps(config, built),
    ...browserSessionDeps,
    web: { events, me: { suggestedActivities: [] }, shell: { release: async () => undefined } as never },
    ...deps,
  } as ServerDeps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };
  if (t) t.after(close);
  else after(close);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const base = await serve();

interface Frame {
  event: string;
  data: unknown;
}

function parse(text: string): Frame[] {
  return text
    .split("\n\n")
    .map((block) => block.split("\n"))
    .filter((lines) => lines.some((line) => line.startsWith("event: ")))
    .map((lines) => ({
      event: lines.find((line) => line.startsWith("event: "))!.slice("event: ".length),
      data: JSON.parse(lines.find((line) => line.startsWith("data: "))!.slice("data: ".length)),
    }));
}

async function listen(cookie: string, t: TestContext) {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/deliveries/events`, {
    headers: { cookie, "accept-encoding": "gzip" },
    signal: abort.signal,
  });
  let text = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      text += decoder.decode(value, { stream: true });
    }
  })();
  t.after(() => abort.abort());
  return { response, raw: () => text, frames: () => parse(text) };
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const seen = (stream: { frames(): Frame[] }, event: string, match: (data: Record<string, unknown>) => boolean) => () =>
  stream.frames().find((f) => f.event === event && match(f.data as Record<string, unknown>));

test("the live-update stream answers with the relay's SSE headers and only to a signed-in person", async (t) => {
  const stream = await listen(browserSessionCookie("alice"), t);
  assert.equal(stream.response.status, 200);
  assert.equal(stream.response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(stream.response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(stream.response.headers.get("x-accel-buffering"), "no");
  assert.equal(stream.response.headers.get("content-encoding"), null);
  await until(() => (stream.raw().startsWith(": open\n\n") ? true : undefined), "the open comment");
  assert.equal((await fetch(`${base}/api/deliveries/events`)).status, 401);
  const unhosted = await serve({ web: undefined }, t);
  const response = await fetch(`${unhosted}/api/deliveries/events`, {
    headers: { cookie: browserSessionCookie("alice") },
  });
  assert.equal(response.status, 404);
});

test("a person sees their own deliveries, session states and inbox items and nobody else's", async (t) => {
  const alice = await listen(browserSessionCookie("alice"), t);
  const bob = await listen(browserSessionCookie("bob"), t);
  await until(() => (alice.raw() && bob.raw() ? true : undefined), "both streams to open");

  const mine = await built.deliveries.enqueue({
    destination: { type: "web", target: "web:alice:t1" },
    text: "",
    idempotencyKey: `alice-${Date.now()}`,
  });
  await until(
    seen(alice, "delivery", (d) => d.threadRef === "web:alice:t1"),
    "alice's delivery",
  );
  let acked = false;
  await until(() => {
    void built.deliveries.get(mine.id).then((d) => (acked = Boolean(d?.deliveredAt)));
    return acked || undefined;
  }, "the ack");

  built.sessionStateBus.emit({ threadRef: "web:alice:t1", state: "working", at: 1 });
  built.sessionStateBus.emit({ threadRef: "ch:C1:1.0", state: "idle", participants: ["alice"], at: 2 });
  const state = await until(
    seen(alice, "session_state", (d) => d.threadRef === "ch:C1:1.0"),
    "the shared state",
  );
  assert.deepEqual(state.data, { threadRef: "ch:C1:1.0", state: "idle", at: 2 });
  await until(
    seen(alice, "session_state", (d) => d.threadRef === "web:alice:t1"),
    "alice's own state",
  );

  const { loop } = await built.loops.store.create({
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: "personal:alice",
    name: "Triage",
    playbook: "triage",
    successCondition: "done",
  });
  await built.loops.items.ingest([{ loopId: loop.id, dedupeKey: "ITEM-1", sourcePayload: { n: 1 } }]);
  const item = await until(
    seen(alice, "inbox_item", (d) => d.loopId === loop.id),
    "alice's inbox item",
  );
  const [ingested] = await built.loops.items.byLoop(loop.id);
  assert.deepEqual(item.data, { loopId: loop.id, itemId: ingested!.id, op: "ingest" });

  built.sessionStateBus.emit({ threadRef: "web:bob:sentinel", state: "working", at: 3 });
  await until(
    seen(bob, "session_state", (d) => d.threadRef === "web:bob:sentinel"),
    "bob's sentinel",
  );
  assert.deepEqual(
    bob.frames().map((f) => f.event),
    ["session_state"],
  );
});

test("an impersonating admin watches the impersonated person's stream, not their own", async (t) => {
  const watching = await listen(
    `${browserSessionCookie("admin-alice")}; ${browserImpersonationCookie("admin-alice", "carol")}`,
    t,
  );
  await until(() => (watching.raw() ? true : undefined), "the stream to open");
  built.sessionStateBus.emit({ threadRef: "web:admin-alice:t", state: "working", at: 4 });
  built.sessionStateBus.emit({ threadRef: "web:carol:t", state: "working", at: 5 });
  await until(
    seen(watching, "session_state", (d) => d.threadRef === "web:carol:t"),
    "carol's state",
  );
  assert.equal(watching.frames().length, 1);
});

interface FakeRes {
  text: string;
  close(): void;
}

function fakeRes(): FakeRes & ServerResponse {
  const closers: Array<() => void> = [];
  const res = {
    text: "",
    writeHead: () => res,
    write: (chunk: string) => {
      res.text += chunk;
      return true;
    },
    on: (event: string, fn: () => void) => {
      if (event === "close") closers.push(fn);
      return res;
    },
    close: () => closers.forEach((fn) => fn()),
  };
  return res as unknown as FakeRes & ServerResponse;
}

function fakeHub(t: TestContext, pending: Delivery[] = []) {
  const acked: string[] = [];
  let state: (event: SessionStateEvent) => void = () => {};
  let stateResync: () => void = () => {};
  let ledger: (event: OwnedLedgerEvent) => void = () => {};
  const owners = new Map<string, string>();
  const managers = new Set<string>();
  let failures = 0;
  const app = {
    pendingDeliveries: async () => {
      if (failures > 0) {
        failures--;
        throw new Error("deliveries unavailable");
      }
      return pending.filter((d) => !acked.includes(d.id));
    },
    ackDelivery: async (id: string) => void acked.push(id),
    subscribeSessionStates: (cb: typeof state, opts?: { onResync?: () => void }) => {
      state = cb;
      stateResync = opts?.onResync ?? (() => {});
      return () => {};
    },
    subscribeLedgerEvents: (cb: typeof ledger) => {
      ledger = cb;
      return () => {};
    },
    membershipControlsScope: async (scope: string) => scope.startsWith("group:"),
    managesScope: async (who: string, scope: string) => scope === "group:core" && managers.has(who),
    samePerson: async (a: string, b: string) => a === b,
  };
  const deps = {
    loops: {
      store: {
        get: async (id: string) => {
          if (id === "broken") throw new Error("db");
          return owners.has(id) ? { id, owner: "alice", ownerScopeId: owners.get(id)! } : null;
        },
      },
    },
    identity: {
      refresh: async () => {},
      classify: (id: string) => ({ id, type: id === "carol" ? "deactivated" : "internal" }),
    },
  } as unknown as Pick<ServerDeps, "loops" | "identity">;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const hub = createWebEvents(app as never, deps);
  hub.start();
  t.after(() => hub.stop());
  return {
    hub,
    acked,
    owners,
    managers,
    fail: (times: number) => (failures = times),
    drain: async () => {
      t.mock.timers.tick(2_500);
      await settled();
    },
    state: (event: SessionStateEvent) => state(event),
    stateResync: () => stateResync(),
    ledger: async (event: OwnedLedgerEvent) => {
      ledger(event);
      await settled();
    },
  };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

const delivery = (id: string, target: string, createdAt: number) =>
  ({ id, createdAt, destination: { type: "web", target } }) as Delivery;

test("a delivery nobody is watching waits a minute, then is acked without a frame", async (t) => {
  const now = Date.now();
  const world = fakeHub(t, [delivery("fresh", "web:bob:t", now), delivery("stale", "web:bob:t", now - 61_000)]);
  const alice = fakeRes();
  world.hub.stream("alice", alice, undefined);
  await world.drain();
  assert.deepEqual(world.acked, ["stale"]);
  assert.doesNotMatch(alice.text, /event: delivery/);
});

test("a failing delivery poll is reported once per outage and its recovery is logged", async (t) => {
  const world = fakeHub(t);
  const lines: string[] = [];
  const record = (...args: unknown[]) => void lines.push(String(args[0]));
  t.mock.method(console, "error", record);
  t.mock.method(console, "log", record);
  const poll = () => lines.filter((line) => line.includes("web delivery poll"));
  world.fail(3);
  for (let i = 0; i < 3; i++) await world.drain();
  assert.equal(poll().length, 1);
  assert.match(poll()[0]!, /^\[failed\] web: web delivery poll.*deliveries unavailable/);
  await world.drain();
  assert.deepEqual(poll().slice(1), ["[web] web delivery poll recovered"]);
});

test("a session state without participants goes to the web thread's owner, and resyncs reach everyone", async (t) => {
  const world = fakeHub(t);
  const alice = fakeRes();
  const bob = fakeRes();
  world.hub.stream("alice", alice, undefined);
  world.hub.stream("bob", bob, undefined);
  world.state({ threadRef: "web:alice:t", state: "idle", at: 2 });
  world.state({ threadRef: "", state: "idle", at: 3 });
  assert.deepEqual(parse(alice.text), [
    { event: "session_state", data: { threadRef: "web:alice:t", state: "idle", at: 2 } },
  ]);
  assert.deepEqual(parse(bob.text), []);
  world.stateResync();
  assert.equal(parse(alice.text).at(-1)?.event, "session_state_resync");
  assert.equal(parse(bob.text).at(-1)?.event, "session_state_resync");
  bob.close();
  world.state({ threadRef: "web:bob:t", state: "idle", at: 4 });
  assert.equal(parse(bob.text).length, 1);
});

test("inbox items reach exactly the active watchers who can administer the loop, including group scopes and aliases", async (t) => {
  const world = fakeHub(t);
  installPrincipalLinks({ canonical: (key) => (key === "bob-slack" ? "bob" : undefined), aliases: () => [] });
  t.after(() => installPrincipalLinks(null));
  world.owners.set("mine", "personal:alice");
  world.owners.set("team", "group:core");
  world.managers.add("alice").add("bob").add("carol");
  const streams = Object.fromEntries(
    ["alice", "bob-slack", "carol", "mallory"].map((user) => {
      const res = fakeRes();
      world.hub.stream(user, res, undefined);
      return [user, res];
    }),
  );
  const items = (user: string) => parse(streams[user]!.text).filter((f) => f.event === "inbox_item");
  await world.ledger({ loopId: "mine", itemId: "i1", op: "ingest", at: 1, owner: "alice" });
  await world.ledger({ loopId: "team", itemId: "i2", op: "triage", at: 2, owner: "alice" });
  await world.ledger({ loopId: "missing", itemId: "i3", op: "triage", at: 3, owner: "alice" });
  assert.deepEqual(
    items("alice").map((f) => f.data),
    [
      { loopId: "mine", itemId: "i1", op: "ingest" },
      { loopId: "team", itemId: "i2", op: "triage" },
    ],
  );
  assert.deepEqual(
    items("bob-slack").map((f) => f.data),
    [{ loopId: "team", itemId: "i2", op: "triage" }],
  );
  assert.deepEqual(items("carol"), []);
  assert.deepEqual(items("mallory"), []);
  await world.ledger({ loopId: "broken", itemId: "i4", op: "triage", at: 4, owner: "alice" });
  assert.equal(parse(streams.mallory!.text).at(-1)?.event, "inbox_resync");
});
