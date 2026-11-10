import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testConfig } from "./support/test-config.ts";
import { settle } from "./support/settle.ts";
import { configureCommandRules } from "./support/command-rules.ts";
import type { SessionStateEvent } from "../src/runs/session-state-bus.ts";
import { boundTenant, withoutTenant } from "../src/tenants/context.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-state-"));
  return buildApp(testConfig({ dataDir, orgId: "acme" }));
}

async function claimForTest(built: ReturnType<typeof freshApp>, runId: string) {
  const claimed: { run: Awaited<ReturnType<typeof built.runs.claimById>> } = { run: null };
  await settle(async () => (claimed.run = await built.runs.claimById(runId, "w1", 30_000)) !== null);
  return claimed.run;
}

const actor = { externalId: "U1", orgId: "acme" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

const BLOCKED_CMD = ["git", "push", `--${"force"}`, "origin", "main"].join(" ");

async function record(bus: {
  subscribe(cb: (e: SessionStateEvent) => void): () => void;
  emit(e: SessionStateEvent): void;
}): Promise<SessionStateEvent[]> {
  const got: SessionStateEvent[] = [];
  bus.subscribe((e) => got.push(e));
  await heardProbe(bus, got);
  return got;
}

async function heardProbe(bus: { emit(e: SessionStateEvent): void }, got: SessionStateEvent[]): Promise<void> {
  for (let attempt = 0; attempt < 100 && !got.some((e) => e.threadRef === "web:U1:probe"); attempt++) {
    bus.emit({ threadRef: "web:U1:probe", state: "idle", at: 1 });
    await waitFor(() => got.some((e) => e.threadRef === "web:U1:probe"), 100);
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
  const got = await record(built.sessionStateBus);
  await built.app.turn(dm("hello", "web:U1:plain"));
  assert.deepEqual(await settledStates(got, "web:U1:plain", 2), ["working", "idle"]);
});

test("a turn parking a blocking command emits working then awaiting_approval", async () => {
  const built = freshApp();
  await configureCommandRules(built.config, scopeId("org", "acme"));
  const got = await record(built.sessionStateBus);
  const r = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, "web:U1:park"));
  assert.equal(r.status, "pending_approval");
  assert.deepEqual(await settledStates(got, "web:U1:park", 2), ["working", "awaiting_approval"]);
});

test("resolving the approval emits working, then idle once the resumed turn settles", async () => {
  const built = freshApp();
  await configureCommandRules(built.config, scopeId("org", "acme"));
  const parked = await record(built.sessionStateBus);
  const paused = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, "web:U1:resolve"));
  const requestId = paused.pendingApprovals?.[0]?.requestId;
  assert.ok(requestId);
  await settledStates(parked, "web:U1:resolve", 2);
  const got = await record(built.sessionStateBus);
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
  const got = await record(built.sessionStateBus);
  const r = await built.app.turn(dm(`!collect-approval ${BLOCKED_CMD}`, "web:U1:collected"));
  assert.equal(r.status, "ok");
  assert.equal(r.pendingApprovals?.length, 1);
  assert.deepEqual(await settledStates(got, "web:U1:collected", 2), ["working", "idle"]);
  const row = (await built.app.listSessions("U1")).find((s) => s.id === r.sessionId);
  assert.ok(!row?.awaitingInput, "snapshot agrees: a non-blocking offer is not awaiting input");
});

test("the settle event derives from the durable approvals store, exactly what listSessions reads", async () => {
  const built = freshApp();
  await configureCommandRules(built.config, scopeId("org", "acme"));
  const got = await record(built.sessionStateBus);
  const r = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, "web:U1:agree"));
  assert.equal(r.status, "pending_approval");
  const states = await settledStates(got, "web:U1:agree", 2);
  assert.equal(states[states.length - 1], "awaiting_approval");
  const row = (await built.app.listSessions("U1")).find((s) => s.id === r.sessionId);
  assert.equal(row?.awaitingInput, true, "snapshot agrees with the pushed state");
});

test("the events carry the session UUID and a timestamp", async () => {
  const built = freshApp();
  const got = await record(built.sessionStateBus);
  const r = await built.app.turn(dm("hello", "web:U1:meta"));
  await settledStates(got, "web:U1:meta", 2);
  const settle = got.find((e) => e.threadRef === "web:U1:meta" && e.state === "idle");
  assert.ok(settle);
  assert.equal(settle!.sessionId, r.sessionId);
  assert.ok(typeof settle!.at === "number" && settle!.at > 0);
});

async function listen(built: ReturnType<typeof freshApp>): Promise<SessionStateEvent[]> {
  const got: SessionStateEvent[] = [];
  built.app.subscribeSessionStates((e) => void got.push(e));
  await heardProbe(built.sessionStateBus, got);
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
  const got = await record(built.sessionStateBus);
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
  const leasedA = await claimForTest(built, a.id);
  assert.ok(leasedA);
  await built.runs.complete(a.id, leasedA!.leaseToken!, { status: "ok", reply: "done" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(
    statesFor(got, thread).filter((s) => s !== "working"),
    [],
    "no settle while a run is still queued",
  );
  const leasedB = await claimForTest(built, b.id);
  assert.ok(leasedB);
  await built.runs.complete(b.id, leasedB!.leaseToken!, { status: "ok", reply: "done" });
  assert.ok(await waitFor(() => statesFor(got, thread).includes("idle")), "the last run's terminal settles idle");
});

test("a FAILED (parked) run still settles from durable truth: leftover blocking approval wins, UUID intact", async () => {
  const built = freshApp();
  await configureCommandRules(built.config, scopeId("org", "acme"));
  const thread = "web:U1:failed";
  const parked = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, thread));
  assert.equal(parked.status, "pending_approval");
  const uuid = parked.sessionId;
  assert.ok(uuid && uuid !== thread);
  const got = await record(built.sessionStateBus);
  const { run } = await built.runs.enqueue({ sessionId: thread, request: resolvedDm("boom", thread), maxAttempts: 3 });
  const leased = await claimForTest(built, run.id);
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
  const got = await record(built.sessionStateBus);
  await built.app.turn(dm("hello", thread));
  await settledStates(got, thread, 2);
  const settle = got.find((e) => e.threadRef === thread && e.state === "idle");
  assert.ok(settle);
  const { run } = await built.runs.enqueue({ sessionId: thread, request: resolvedDm("next", thread), maxAttempts: 3 });
  const leased = await claimForTest(built, run.id);
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
  const got = await record(built.sessionStateBus);
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
  const leasedParent = await claimForTest(built, parentRun.id);
  await built.runs.complete(parentRun.id, leasedParent!.leaseToken!, { status: "ok", reply: "delegated" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(statesFor(got, parentThread), ["working", "working"], "the subagent keeps its parent working");
  const working = (await built.app.listSessions("U1")).find((s) => s.id === parent.sessionId);
  assert.equal(working?.working, true, "the sidebar snapshot shows the parent working too");

  const leasedChild = await claimForTest(built, childRun.id);
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
  await configureCommandRules(built.config, scopeId("org", "acme"));
  const parentThread = "web:U1:parked-parent";
  const childThread = "web:U1:parked-child";
  const child = await built.app.turn(dm("hello", childThread));
  const got = await record(built.sessionStateBus);
  const parent = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, parentThread));
  assert.equal(parent.status, "pending_approval");
  await built.sessions.setParentSession(child.sessionId!, parent.sessionId!);
  const { run } = await built.runs.enqueue({
    sessionId: childThread,
    request: resolvedDm("work", childThread),
    maxAttempts: 3,
  });
  const leased = await claimForTest(built, run.id);
  await built.runs.complete(run.id, leased!.leaseToken!, { status: "ok", reply: "done" });
  assert.ok(await waitFor(() => statesFor(got, childThread).includes("idle")));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(statesFor(got, parentThread), ["working", "awaiting_approval", "awaiting_approval"]);
});

test("a parent whose own turn parks on an approval while its subagent runs settles awaiting at once", async () => {
  const built = freshApp();
  await configureCommandRules(built.config, scopeId("org", "acme"));
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
  const leased = await claimForTest(built, run.id);
  assert.ok(leased);
  const got = await record(built.sessionStateBus);
  const parked = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, parentThread));
  assert.equal(parked.status, "pending_approval");
  assert.ok(await waitFor(() => statesFor(got, parentThread).includes("awaiting_approval")));
  const row = (await built.app.listSessions("U1")).find((s) => s.id === parent.sessionId);
  assert.equal(row?.awaitingInput, true);
  assert.ok(!row?.working, "the snapshot ranks the pending approval above subagent work, like the push");
  await built.runs.complete(run.id, leased!.leaseToken!, { status: "ok", reply: "done" });
});

test("a subagent idle between its own runs is not working while its own subagent runs — only the root is", async () => {
  const built = freshApp();
  const rootThread = "web:U1:tree-root";
  const midThread = "web:U1:tree-mid";
  const leafThread = "web:U1:tree-leaf";
  const got = await record(built.sessionStateBus);
  const root = await built.app.turn(dm("hello", rootThread));
  const mid = await built.app.turn(dm("hello", midThread));
  const leaf = await built.app.turn(dm("hello", leafThread));
  assert.ok(await waitFor(() => [rootThread, midThread, leafThread].every((t) => statesFor(got, t).includes("idle"))));
  got.length = 0;
  await built.sessions.setParentSession(mid.sessionId!, root.sessionId!);
  await built.sessions.setParentSession(leaf.sessionId!, mid.sessionId!);
  const { run: midRun } = await built.runs.enqueue({
    sessionId: midThread,
    request: resolvedDm("delegate", midThread),
    maxAttempts: 3,
  });
  const { run: leafRun } = await built.runs.enqueue({
    sessionId: leafThread,
    request: resolvedDm("work", leafThread),
    maxAttempts: 3,
  });
  assert.deepEqual(statesFor(got, midThread), ["working"], "a descendant's run does not mark the subagent working");
  const leasedMid = await built.runs.claimById(midRun.id, "w1", 30_000);
  await built.runs.complete(midRun.id, leasedMid!.leaseToken!, { status: "ok", reply: "delegated" });
  assert.ok(await waitFor(() => statesFor(got, midThread).includes("idle")), "the subagent settles with its own run");
  assert.ok(!statesFor(got, rootThread).includes("idle"), "the root stays working while the tree runs");

  const rows = await built.app.listSessions("U1");
  const byId = (id: string) => rows.find((s) => s.id === id);
  assert.ok(!byId(mid.sessionId!)?.working, "the snapshot agrees the idle subagent is not working");
  assert.equal(byId(leaf.sessionId!)?.working, true);
  assert.equal(byId(root.sessionId!)?.working, true);
  assert.deepEqual(byId(root.sessionId!)?.subagents, { running: 1, waiting: 0 });

  const leasedLeaf = await built.runs.claimById(leafRun.id, "w1", 30_000);
  await built.runs.complete(leafRun.id, leasedLeaf!.leaseToken!, { status: "ok", reply: "done" });
  assert.ok(await waitFor(() => statesFor(got, rootThread).includes("idle")), "the last run settles the root");
  assert.deepEqual(statesFor(got, midThread), ["working", "idle"]);
});

test("a background subscriber hears each event inside the event's tenant", async () => {
  const built = freshApp();
  const tenant = "7a4f7f0e-3c55-4c3e-9d0b-2f1c8a6e5b11";
  const heard: Array<{ at: number; tenant: string | undefined }> = [];
  const got: SessionStateEvent[] = [];
  withoutTenant(() =>
    built.app.subscribeSessionStates((e) => {
      got.push(e);
      heard.push({ at: e.at, tenant: boundTenant() });
    }),
  );
  await heardProbe(built.sessionStateBus, got);
  built.sessionStateBus.emit({ tenantId: tenant, threadRef: "web:U1:tenanted", state: "working", at: 9 });
  await received(got, 9);
  assert.deepEqual(
    heard.find((h) => h.at === 9),
    { at: 9, tenant },
  );
});
