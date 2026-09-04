import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-fork-"));
  return buildApp(testConfig({ dataDir }));
}

const actor = { externalId: "U1" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

test("forking copies the transcript into a fresh independent web session", async () => {
  const { app } = freshApp();
  await app.turn(dm("First question about deploys", "web:U1:f1"));
  const r2 = await app.turn(dm("Second question about rollbacks", "web:U1:f1"));
  const sid = r2.sessionId!;
  const source = (await app.getSession(sid))!;

  const fork = await app.forkSession(sid, "U1");
  assert.ok(fork, "participant can fork");
  assert.notEqual(fork.session.id, sid);
  assert.ok(fork.session.threadRef.startsWith("web:U1:"), "fork lives on a fresh web thread");
  assert.notEqual(fork.session.threadRef, source.session.threadRef);
  assert.equal(fork.session.scopeId, source.session.scopeId);
  assert.deepEqual(
    fork.entries.map((e) => [e.type, e.payload]),
    source.entries.map((e) => [e.type, e.payload]),
  );
  assert.deepEqual(fork.session.forkedFrom, { sessionId: sid, title: source.session.title ?? null });
  assert.equal(fork.session.forkBoundarySeq, fork.entries.at(-1)?.seq);

  const mine = await app.listSessions("U1");
  assert.ok(mine.some((s) => s.id === fork.session.id));
});

test("upToSeq truncates the copy at the cut point", async () => {
  const { app } = freshApp();
  await app.turn(dm("Keep this turn", "web:U1:f2"));
  const r2 = await app.turn(dm("Drop this turn", "web:U1:f2"));
  const sid = r2.sessionId!;
  const entries = (await app.getSession(sid))!.entries;
  const secondUser = entries.filter((e) => e.type === "user")[1]!;

  const fork = await app.forkSession(sid, "U1", { upToSeq: secondUser.seq - 1 });
  assert.ok(fork);
  assert.ok(fork.entries.length > 0, "the first turn is kept");
  const copiedTexts = fork.entries
    .filter((e) => e.type === "user")
    .map((e) => (e.payload as { text?: string }).text ?? "");
  assert.ok(copiedTexts.some((t) => t.includes("Keep this turn")));
  assert.ok(!copiedTexts.some((t) => t.includes("Drop this turn")));
  assert.equal(fork.session.forkBoundarySeq, fork.entries.at(-1)?.seq);
});

test("a single-entry fork (boundary seq 0) still records provenance", async () => {
  const { app } = freshApp();
  const r = await app.turn(dm("Only the opening message survives the cut", "web:U1:seq0"));
  const sid = r.sessionId!;
  const first = (await app.getSession(sid))!.entries[0]!;
  const fork = await app.forkSession(sid, "U1", { upToSeq: first.seq });
  assert.ok(fork);
  assert.equal(fork.entries.length, 1);
  assert.equal(fork.entries[0]!.seq, 0, "entry seqs are 0-based");
  assert.deepEqual(fork.session.forkedFrom, {
    sessionId: sid,
    title: (await app.getSession(sid))!.session.title ?? null,
  });
  assert.equal(fork.session.forkBoundarySeq, 0);
});

test("an empty fork has no provenance", async () => {
  const { app } = freshApp();
  const r = await app.turn(dm("Nothing before zero", "web:U1:empty"));
  const fork = await app.forkSession(r.sessionId!, "U1", { upToSeq: -1 });
  assert.ok(fork);
  assert.equal(fork.entries.length, 0);
  assert.equal(fork.session.forkedFrom, undefined);
  assert.equal(fork.session.forkBoundarySeq, undefined);
});

test("the fork inherits a marked title and the original keeps its own history", async () => {
  const { app } = freshApp();
  const r = await app.turn(dm("Plan the database migration", "web:U1:f3"));
  const sid = r.sessionId!;
  await app.updateSession(sid, "U1", { title: "Migration plan" });

  const fork = (await app.forkSession(sid, "U1"))!;
  const before = (await app.getSession(sid))!.entries.length;
  await app.turn(dm("A follow-up only in the fork", fork.session.threadRef));
  assert.equal((await app.getSession(sid))!.entries.length, before, "turns on the fork do not touch the source");
  const forkTitle = (await app.getSession(fork.session.id))!.session.title;
  assert.equal(forkTitle, "Chat: Plan the database migration (fork)");
});

test("a stranger cannot fork someone else's conversation", async () => {
  const { app } = freshApp();
  const r = await app.turn(dm("Private planning", "web:U1:f4"));
  assert.equal(await app.forkSession(r.sessionId!, "intruder"), null);
  assert.equal(await app.forkSession("does-not-exist", "U1"), null);
});
