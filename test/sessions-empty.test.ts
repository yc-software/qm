import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { Principal, TurnRequest } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-empty-"));
  return buildApp(testConfig({ dataDir }));
}

const actor = { externalId: "U1" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

function enqueueRequest(threadRef: string): OrchestratorInput {
  const principal: Principal = { id: "internal:U1", type: "internal" };
  return {
    actor: principal,
    conversation: { kind: "dm", threadRef, audience: [principal] },
    origin: { kind: "direct" },
    text: "hi",
  };
}

async function strandShell(sessions: ReturnType<typeof freshApp>["sessions"], threadRef: string): Promise<string> {
  const s = await sessions.getOrCreateByThread(threadRef, "dm", "personal:U1");
  await sessions.addParticipant(s.id, "U1");
  return s.id;
}

test("listSessions hides a stranded entry-less session", async () => {
  const { app, sessions } = freshApp();

  await app.turn(dm("Just a question", "web:U1:real"));
  const strandedId = await strandShell(sessions, "web:U1:stranded");

  const list = await app.listSessions("U1");
  assert.ok(
    list.find((s) => s.threadRef === "web:U1:real"),
    "the real conversation is listed",
  );
  assert.ok(!list.find((s) => s.id === strandedId), "the entry-less shell is not");

  const raw = await sessions.listByParticipant("U1");
  assert.equal(raw.find((s) => s.id === strandedId)?.hasEntries, false);
});

test("an entry-less session with an in-flight turn stays visible", async () => {
  const { app, sessions, runs } = freshApp();

  const thread = "web:U1:fresh";
  const id = await strandShell(sessions, thread);
  await runs.enqueue({ sessionId: thread, request: enqueueRequest(thread) });

  const row = (await app.listSessions("U1")).find((s) => s.id === id);
  assert.equal(row?.working, true, "a brand-new chat is visible (and working) while its first turn runs");

  const claimed = await runs.claim("w1", 5_000);
  await runs.complete(claimed!.id, claimed!.leaseToken ?? "", { status: "failed", reason: "boom" });

  assert.ok(
    !(await app.listSessions("U1")).find((s) => s.id === id),
    "once the failed turn settles with nothing written, the shell disappears",
  );
});

test("a titled entry-less session stays listed", async () => {
  const { app, sessions } = freshApp();

  const id = await strandShell(sessions, "web:U1:titled");
  await sessions.updateTitle(id, "Planning (fork)");

  assert.ok(
    (await app.listSessions("U1")).find((s) => s.id === id),
    "a title marks the session deliberately created, so it is listed even with no entries",
  );
});

test("a turn refused with 'session busy' does not surface a stranded shell", async () => {
  const { app, sessions } = freshApp();

  const thread = "web:U1:busy-race";
  const shell = await sessions.getOrCreateByThread(thread, "dm", "personal:U1");
  const { lease: held } = await sessions.acquireLease(shell.id);
  assert.ok(held);

  const outcome = await app.turn(dm("hello again", thread));
  assert.equal(outcome.status, "refused");
  assert.match((outcome as { reason?: string }).reason ?? "", /busy/);

  const raw = await sessions.listByParticipant("U1");
  assert.equal(raw.find((s) => s.id === shell.id)?.hasEntries, false, "the shell exists, participant attached");
  assert.ok(!(await app.listSessions("U1")).find((s) => s.id === shell.id), "but it is not listed");
});

test("context cards do not count hidden shells or treat them as shared-scope authority", async () => {
  const { app, sessions } = freshApp();

  await app.turn(dm("real conversation", "web:U1:ctx-real"));
  await strandShell(sessions, "web:U1:ctx-stranded");

  const personal = (await app.listContexts("U1")).find((c) => c.kind === "personal");
  assert.equal(personal?.sessionCount, 1, "the stranded shell is not counted");

  const g = await sessions.getOrCreateByThread("grp:G1", "group", "group:G1");
  await sessions.addParticipant(g.id, "U1");
  const group = (await app.listContexts("U1")).find((c) => c.scopeId === "group:G1");
  assert.equal(group, undefined);
});

test("a session becomes visible once its first entry lands", async () => {
  const { app, sessions } = freshApp();

  const thread = "web:U1:lands";
  const id = await strandShell(sessions, thread);
  assert.ok(!(await app.listSessions("U1")).find((s) => s.id === id));

  const outcome = await app.turn(dm("hello", thread));
  assert.equal(outcome.sessionId, id, "the turn reuses the existing shell");
  assert.ok(
    (await app.listSessions("U1")).find((s) => s.id === id),
    "listed once the transcript exists",
  );
});
