import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
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
  return events.filter((e) => e.threadRef === threadRef).map((e) => e.state);
}

test("a plain turn emits working then idle", async () => {
  const built = freshApp();
  const got = record(built.sessionStateBus);
  await built.app.turn(dm("hello", "web:U1:plain"));
  assert.deepEqual(statesFor(got, "web:U1:plain"), ["working", "idle"]);
});

test("a turn parking a blocking command emits working then awaiting_approval", async () => {
  const built = freshApp();
  const got = record(built.sessionStateBus);
  const r = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, "web:U1:park"));
  assert.equal(r.status, "pending_approval");
  assert.deepEqual(statesFor(got, "web:U1:park"), ["working", "awaiting_approval"]);
});

test("resolving the approval emits working, then idle once the resumed turn settles", async () => {
  const built = freshApp();
  const paused = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, "web:U1:resolve"));
  const requestId = paused.pendingApprovals?.[0]?.requestId;
  assert.ok(requestId);
  const got = record(built.sessionStateBus);
  await built.app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "web:U1:resolve" },
    text: "",
    approval: { requestId: requestId!, approved: false },
  });
  assert.deepEqual(statesFor(got, "web:U1:resolve"), ["working", "idle"]);
});

test("a COLLECTED (non-blocking) approval settles idle — push and snapshot agree", async () => {
  const built = freshApp();
  const got = record(built.sessionStateBus);
  const r = await built.app.turn(dm(`!collect-approval ${BLOCKED_CMD}`, "web:U1:collected"));
  assert.equal(r.status, "ok");
  assert.equal(r.pendingApprovals?.length, 1);
  assert.deepEqual(statesFor(got, "web:U1:collected"), ["working", "idle"]);
  const row = (await built.app.listSessions("U1")).find((s) => s.id === r.sessionId);
  assert.ok(!row?.awaitingInput, "snapshot agrees: a non-blocking offer is not awaiting input");
});

test("the settle event derives from the durable approvals store, exactly what listSessions reads", async () => {
  const built = freshApp();
  const got = record(built.sessionStateBus);
  const r = await built.app.turn(dm(`!run ${BLOCKED_CMD}`, "web:U1:agree"));
  assert.equal(r.status, "pending_approval");
  const states = statesFor(got, "web:U1:agree");
  assert.equal(states[states.length - 1], "awaiting_approval");
  const row = (await built.app.listSessions("U1")).find((s) => s.id === r.sessionId);
  assert.equal(row?.awaitingInput, true, "snapshot agrees with the pushed state");
});

test("the events carry the session UUID and a timestamp", async () => {
  const built = freshApp();
  const got = record(built.sessionStateBus);
  const r = await built.app.turn(dm("hello", "web:U1:meta"));
  const settle = got.find((e) => e.threadRef === "web:U1:meta" && e.state === "idle");
  assert.ok(settle);
  assert.equal(settle!.sessionId, r.sessionId);
  assert.ok(typeof settle!.at === "number" && settle!.at > 0);
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
        if (ev && ev.threadRef === "web:U1:sse" && !frames.some((f) => f.state === ev.state)) frames.push(ev);
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

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
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
  await built.app.turn(dm("hello", thread));
  const got = record(built.sessionStateBus);
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
  assert.ok(await waitFor(() => statesFor(got, thread).length > 0), "terminal emitted a settle");
  const settle = got.find((e) => e.threadRef === thread && e.state !== "working");
  assert.equal(settle?.state, "awaiting_approval", "the undecided blocking approval keeps the session awaiting");
  assert.equal(settle?.sessionId, uuid, "the frame carries the durable session UUID, not the threadRef");
});

test("a settle frame is stamped with the run's durable finishedAt — a later enqueue always out-stamps it", async () => {
  const built = freshApp();
  const thread = "web:U1:stamp";
  const got = record(built.sessionStateBus);
  await built.app.turn(dm("hello", thread));
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
