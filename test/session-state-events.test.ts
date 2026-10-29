import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import type { TurnRequest } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testConfig } from "./support/test-config.ts";
import type { SessionStateEvent } from "../src/runs/session-state-bus.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-state-"));
  return buildApp(testConfig({ dataDir, orgId: "acme" }));
}

const actor = { externalId: "U1", orgId: "acme" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

const BLOCKED_CMD = ["git", "push", `--${"force"}`, "origin", "main"].join(" ");

function record(bus: { subscribe(cb: (e: SessionStateEvent) => void): () => void }): SessionStateEvent[] {
  const got: SessionStateEvent[] = [];
  bus.subscribe((e) => got.push(e));
  return got;
}

function parseFrame(data: string): SessionStateEvent | null {
  try {
    return JSON.parse(data) as SessionStateEvent;
  } catch {
    return null;
  }
}

function statesFor(events: SessionStateEvent[], threadRef: string): string[] {
  return events.filter((e) => e.threadRef === threadRef && e.state !== "metadata").map((e) => e.state);
}

async function settledStates(events: SessionStateEvent[], threadRef: string, count: number): Promise<string[]> {
  await waitFor(() => statesFor(events, threadRef).length >= count);
  return statesFor(events, threadRef);
}

test("a plain turn emits working then idle", async () => {
  const built = freshApp();
  const got = record(built.sessionStateBus);
  await built.app.turn(dm("hello", "web:U1:plain"));
  assert.deepEqual(await settledStates(got, "web:U1:plain", 2), ["working", "idle"]);
});

test("a turn parking a blocking command emits working then awaiting_approval", async () => {
  const built = freshApp();
  const got = record(built.sessionStateBus);
  const r = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, "web:U1:park"));
  assert.equal(r.status, "pending_approval");
  assert.deepEqual(await settledStates(got, "web:U1:park", 2), ["working", "awaiting_approval"]);
});

test("resolving the approval emits working, then idle once the resumed turn settles", async () => {
  const built = freshApp();
  const parked = record(built.sessionStateBus);
  const paused = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, "web:U1:resolve"));
  const requestId = paused.pendingApprovals?.[0]?.requestId;
  assert.ok(requestId);
  await settledStates(parked, "web:U1:resolve", 2);
  const got = record(built.sessionStateBus);
  await built.app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "web:U1:resolve" },
    text: "",
    approval: { requestId: requestId!, approved: false },
  });
  assert.deepEqual(await settledStates(got, "web:U1:resolve", 2), ["working", "idle"]);
});

test("a COLLECTED (non-blocking) approval settles idle — push and snapshot agree", async () => {
  const built = freshApp();
  const got = record(built.sessionStateBus);
  const r = await built.app.turn(dm(`!collect-approval ${BLOCKED_CMD}`, "web:U1:collected"));
  assert.equal(r.status, "ok");
  assert.equal(r.pendingApprovals?.length, 1);
  assert.deepEqual(await settledStates(got, "web:U1:collected", 2), ["working", "idle"]);
  const row = (await built.app.listSessions("U1")).find((s) => s.id === r.sessionId);
  assert.ok(!row?.awaitingInput, "snapshot agrees: a non-blocking offer is not awaiting input");
});

test("the settle event derives from the durable approvals store, exactly what listSessions reads", async () => {
  const built = freshApp();
  const got = record(built.sessionStateBus);
  const r = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, "web:U1:agree"));
  assert.equal(r.status, "pending_approval");
  const states = await settledStates(got, "web:U1:agree", 2);
  assert.equal(states[states.length - 1], "awaiting_approval");
  const row = (await built.app.listSessions("U1")).find((s) => s.id === r.sessionId);
  assert.equal(row?.awaitingInput, true, "snapshot agrees with the pushed state");
});

test("the events carry the session UUID and a timestamp", async () => {
  const built = freshApp();
  const got = record(built.sessionStateBus);
  const r = await built.app.turn(dm("hello", "web:U1:meta"));
  await settledStates(got, "web:U1:meta", 2);
  const settle = got.find((e) => e.threadRef === "web:U1:meta" && e.state === "idle");
  assert.ok(settle);
  assert.equal(settle!.sessionId, r.sessionId);
  assert.ok(typeof settle!.at === "number" && settle!.at > 0);
});

async function listen(built: ReturnType<typeof freshApp>): Promise<SessionStateEvent[]> {
  const got: SessionStateEvent[] = [];
  built.app.subscribeSessionStates((e) => got.push(e));
  for (let attempt = 0; attempt < 100 && !got.some((e) => e.threadRef === "web:U1:probe"); attempt++) {
    built.sessionStateBus.emit({ threadRef: "web:U1:probe", state: "idle", at: 1 });
    await waitFor(() => got.some((e) => e.threadRef === "web:U1:probe"), 100);
  }
  return got;
}

async function received(got: SessionStateEvent[], at: number): Promise<SessionStateEvent | undefined> {
  await waitFor(() => got.some((e) => e.at === at));
  return got.find((e) => e.at === at);
}

test("a shed-participants event is rehydrated from the session store before subscribers see it", async () => {
  const built = freshApp();
  const thread = "web:U1:shed";
  const turned = await built.app.turn(dm("hello", thread));
  const got = await listen(built);
  built.sessionStateBus.emit({
    threadRef: thread,
    sessionId: turned.sessionId!,
    state: "working",
    at: 7,
    participantsShed: true,
  });
  const event = await received(got, 7);
  assert.ok(event, "the flagged event reached the subscriber");
  assert.deepEqual(event.participants, ["U1"], "the routing field is rebuilt from durable session membership");
  assert.equal(event.participantsShed, undefined, "the internal shed flag never leaves the app");
  assert.equal(event.state, "working");
});

test("a shed event still reaches subscribers when the participant lookup fails", async () => {
  const built = freshApp();
  const thread = "web:U1:shed-fail";
  await built.app.turn(dm("hello", thread));
  built.sessions.participantsOf = async () => {
    throw new Error("db down");
  };
  const got = await listen(built);
  built.sessionStateBus.emit({ threadRef: thread, state: "working", at: 8, participantsShed: true });
  const event = await received(got, 8);
  assert.ok(event, "the transition is not dropped with the lookup");
  assert.equal(event.participants, undefined);
  assert.equal(event.participantsShed, undefined);
});

test("a shed event for an unknown thread still reaches subscribers, just without participants", async () => {
  const built = freshApp();
  const got = await listen(built);
  built.sessionStateBus.emit({ threadRef: "web:U1:ghost", state: "idle", at: 9, participantsShed: true });
  const event = await received(got, 9);
  assert.ok(event);
  assert.equal(event.participants, undefined);
  assert.equal(event.participantsShed, undefined);
});

test("GET /v1/session-state/events streams transitions as SSE frames", async () => {
  const built = freshApp();
  built.runtime.start();
  const core = createInsecureTestServer(built.app, { webhookReceiver: built.webhookReceiver });
  core.listen(0);
  const base = `http://localhost:${(core.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/v1/session-state/events`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    await built.app.turn(dm(`!run ${BLOCKED_CMD}`, "web:U1:sse"));

    const reader = res.body!.getReader();
    let buf = "";
    const frames: SessionStateEvent[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      for (const frame of buf.split("\n\n")) {
        const data = frame
          .split("\n")
          .find((l) => l.startsWith("data: "))
          ?.slice("data: ".length);
        if (!data) continue;
        const ev = parseFrame(data);
        if (ev && ev.threadRef === "web:U1:sse" && ev.state !== "metadata" && !frames.some((f) => f.state === ev.state))
          frames.push(ev);
      }
      if (frames.some((f) => f.state === "awaiting_approval")) break;
    }
    await reader.cancel().catch(() => {});
    assert.deepEqual(
      frames.map((f) => f.state),
      ["working", "awaiting_approval"],
    );
  } finally {
    await new Promise<void>((r) => core.close(() => r()));
    await built.runtime.stop();
  }
});

function resolvedDm(text: string, thread: string): OrchestratorInput {
  return {
    surface: "test",
    actor: { id: "user:U1", type: "user", orgId: "acme", externalId: "U1" } as unknown as OrchestratorInput["actor"],
    conversation: { kind: "dm", threadRef: thread, audience: [] },
    origin: { kind: "direct" },
    text,
  };
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

test("a terminal run with another run still queued on the thread emits no settle — the LAST live run owns it", async () => {
  const built = freshApp();
  const thread = "web:U1:queued";
  const got = record(built.sessionStateBus);
  await built.app.turn(dm("hello", thread));
  await settledStates(got, thread, 2);
  got.length = 0;
  const { run: a } = await built.runs.enqueue({
    sessionId: thread,
    request: resolvedDm("first", thread),
    maxAttempts: 3,
  });
  const { run: b } = await built.runs.enqueue({
    sessionId: thread,
    request: resolvedDm("second", thread),
    maxAttempts: 3,
  });
  const leasedA = await built.runs.claimById(a.id, "w1", 30_000);
  assert.ok(leasedA);
  await built.runs.complete(a.id, leasedA!.leaseToken!, { status: "ok", reply: "done" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(
    statesFor(got, thread).filter((s) => s !== "working"),
    [],
    "no settle while a run is still queued",
  );
  const leasedB = await built.runs.claimById(b.id, "w1", 30_000);
  assert.ok(leasedB);
  await built.runs.complete(b.id, leasedB!.leaseToken!, { status: "ok", reply: "done" });
  assert.ok(await waitFor(() => statesFor(got, thread).includes("idle")), "the last run's terminal settles idle");
});

test("a FAILED (parked) run still settles from durable truth: leftover blocking approval wins, UUID intact", async () => {
  const built = freshApp();
  const thread = "web:U1:failed";
  const parked = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, thread));
  assert.equal(parked.status, "pending_approval");
  const uuid = parked.sessionId;
  assert.ok(uuid && uuid !== thread);
  const got = record(built.sessionStateBus);
  const { run } = await built.runs.enqueue({ sessionId: thread, request: resolvedDm("boom", thread), maxAttempts: 3 });
  const leased = await built.runs.claimById(run.id, "w1", 30_000);
  assert.ok(leased);
  await built.runs.fail(run.id, leased!.leaseToken!, "kaboom", { retry: false });
  assert.ok(
    await waitFor(() => statesFor(got, thread).some((state) => state !== "working")),
    "terminal emitted a settle",
  );
  const settle = got.find((e) => e.threadRef === thread && e.state !== "working");
  assert.equal(settle?.state, "awaiting_approval", "the undecided blocking approval keeps the session awaiting");
  assert.equal(settle?.sessionId, uuid, "the frame carries the durable session UUID, not the threadRef");
});

test("a settle frame is stamped with the run's durable finishedAt — a later enqueue always out-stamps it", async () => {
  const built = freshApp();
  const thread = "web:U1:stamp";
  const got = record(built.sessionStateBus);
  await built.app.turn(dm("hello", thread));
  await settledStates(got, thread, 2);
  const settle = got.find((e) => e.threadRef === thread && e.state === "idle");
  assert.ok(settle);
  const { run } = await built.runs.enqueue({ sessionId: thread, request: resolvedDm("next", thread), maxAttempts: 3 });
  const leased = await built.runs.claimById(run.id, "w1", 30_000);
  assert.ok(leased);
  await built.runs.complete(run.id, leased!.leaseToken!, { status: "ok", reply: "done" });
  assert.ok(await waitFor(() => statesFor(got, thread).filter((s) => s === "idle").length >= 2));
  const second = [...got].reverse().find((e) => e.threadRef === thread && e.state === "idle");
  const row = await built.runs.get(run.id);
  assert.equal(second!.at, row!.finishedAt, "the settle frame carries the run's durable finishedAt");
});

test("a parent stays working while a subagent runs after its own turn ends — push and snapshot agree", async () => {
  const built = freshApp();
  const parentThread = "web:U1:parent";
  const childThread = "web:U1:parent-child";
  const got = record(built.sessionStateBus);
  const parent = await built.app.turn(dm("hello", parentThread));
  const child = await built.app.turn(dm("hello", childThread));
  assert.ok(
    await waitFor(() => statesFor(got, parentThread).includes("idle") && statesFor(got, childThread).includes("idle")),
    "both greeting turns settle before the delegation starts",
  );
  got.length = 0;
  await built.sessions.setParentSession(child.sessionId!, parent.sessionId!);
  const { run: parentRun } = await built.runs.enqueue({
    sessionId: parentThread,
    request: resolvedDm("delegate", parentThread),
    maxAttempts: 3,
  });
  const { run: childRun } = await built.runs.enqueue({
    sessionId: childThread,
    request: resolvedDm("work", childThread),
    maxAttempts: 3,
  });
  const leasedParent = await built.runs.claimById(parentRun.id, "w1", 30_000);
  await built.runs.complete(parentRun.id, leasedParent!.leaseToken!, { status: "ok", reply: "delegated" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(statesFor(got, parentThread), ["working", "working"], "the subagent keeps its parent working");
  const working = (await built.app.listSessions("U1")).find((s) => s.id === parent.sessionId);
  assert.equal(working?.working, true, "the sidebar snapshot shows the parent working too");

  const leasedChild = await built.runs.claimById(childRun.id, "w1", 30_000);
  await built.runs.complete(childRun.id, leasedChild!.leaseToken!, { status: "ok", reply: "done" });
  assert.ok(
    await waitFor(() => statesFor(got, parentThread).includes("idle")),
    "the last subagent run settles the parent",
  );
  assert.deepEqual(statesFor(got, childThread), ["working", "idle"]);
  const settled = (await built.app.listSessions("U1")).find((s) => s.id === parent.sessionId);
  assert.ok(!settled?.working, "the snapshot settles with the push");
});

test("a parent parked on a blocking approval keeps awaiting while its subagent runs", async () => {
  const built = freshApp();
  const parentThread = "web:U1:parked-parent";
  const childThread = "web:U1:parked-child";
  const child = await built.app.turn(dm("hello", childThread));
  const got = record(built.sessionStateBus);
  const parent = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, parentThread));
  assert.equal(parent.status, "pending_approval");
  await built.sessions.setParentSession(child.sessionId!, parent.sessionId!);
  const { run } = await built.runs.enqueue({
    sessionId: childThread,
    request: resolvedDm("work", childThread),
    maxAttempts: 3,
  });
  const leased = await built.runs.claimById(run.id, "w1", 30_000);
  await built.runs.complete(run.id, leased!.leaseToken!, { status: "ok", reply: "done" });
  assert.ok(await waitFor(() => statesFor(got, childThread).includes("idle")));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(statesFor(got, parentThread), ["working", "awaiting_approval", "awaiting_approval"]);
});

test("a parent whose own turn parks on an approval while its subagent runs settles awaiting at once", async () => {
  const built = freshApp();
  const parentThread = "web:U1:parks-mid-tree";
  const childThread = "web:U1:parks-mid-tree-child";
  const parent = await built.app.turn(dm("hello", parentThread));
  const child = await built.app.turn(dm("hello", childThread));
  await built.sessions.setParentSession(child.sessionId!, parent.sessionId!);
  const { run } = await built.runs.enqueue({
    sessionId: childThread,
    request: resolvedDm("work", childThread),
    maxAttempts: 3,
  });
  const got = record(built.sessionStateBus);
  const parked = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, parentThread));
  assert.equal(parked.status, "pending_approval");
  assert.ok(await waitFor(() => statesFor(got, parentThread).includes("awaiting_approval")));
  const row = (await built.app.listSessions("U1")).find((s) => s.id === parent.sessionId);
  assert.equal(row?.awaitingInput, true);
  assert.ok(!row?.working, "the snapshot ranks the pending approval above subagent work, like the push");
  const leased = await built.runs.claimById(run.id, "w1", 30_000);
  await built.runs.complete(run.id, leased!.leaseToken!, { status: "ok", reply: "done" });
});
