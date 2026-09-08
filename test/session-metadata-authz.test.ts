import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { projectGroupRef, projectScopeId } from "../src/projects/project-store.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-session-authz-"));
  return buildApp(testConfig({ dataDir }));
}

function dm(text: string, thread: string, externalId: string): TurnRequest {
  return { surface: "test", actor: { externalId }, conversation: { kind: "dm", threadRef: thread }, text };
}

test("getSessionForViewer withholds metadata from a non-participant (no session-metadata IDOR)", async () => {
  const { app } = freshApp();

  const outcome = await app.turn(dm("my private question", "web:alice:private", "alice"));
  const sessionId = outcome.sessionId!;
  assert.ok(sessionId);

  const asAlice = await app.getSessionForViewer(sessionId, "alice");
  assert.ok(asAlice, "the owner reads her own session");
  assert.equal(asAlice!.session.id, sessionId);
  assert.equal(asAlice!.session.threadRef, "web:alice:private");

  const asCarol = await app.getSessionForViewer(sessionId, "carol");
  assert.equal(asCarol, null, "a non-participant cannot read the session row");
});

test("the single-session read applies the managed-project check the session list applies", async () => {
  const built = freshApp();
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  const project = await built.projects.create({ name: "Launch Cohort", ownerId: "owner" });
  const groupRef = projectGroupRef(project.id);

  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  const outcome = await built.app.turn({
    surface: "web",
    actor: { externalId: "member" },
    conversation: { kind: "group", channelRef: groupRef, threadRef: "web:member:project" },
    text: "!run git push --force origin main",
  });
  assert.equal(outcome.status, "pending_approval", "the member's own turn parks on an approval only they can read");
  const sessionId = outcome.sessionId!;
  assert.ok(sessionId);

  assert.ok(await built.sessions.getForParticipant(sessionId, "member"), "the member is a participant of the row");
  assert.ok(await built.app.getSessionForViewer(sessionId, "member"), "a project member reads the session");
  assert.ok(
    (await built.app.listSessionApprovals(sessionId, "member")).length,
    "and reads the pending approval while membership stands",
  );
  assert.ok(
    (await built.app.listSessions("member")).some((session) => session.id === sessionId),
    "the list agrees while membership stands",
  );

  assert.ok((await built.app.searchSessions("member", "push")).some((hit) => hit.sessionId === sessionId));
  assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");
  assert.deepEqual(await built.app.searchSessions("member", "push"), []);
  assert.ok(
    await built.sessions.getForParticipant(sessionId, "member"),
    "the participant row outlives the project membership, so the project check is what must reject",
  );
  assert.equal(
    await built.app.getSessionForViewer(sessionId, "member"),
    null,
    "a dropped project member cannot read the session one at a time",
  );
  assert.equal(await built.app.getSessionEntryForViewer(sessionId, "member", 1), null, "nor a single entry");
  assert.equal(await built.app.sessionBackground(sessionId, "member"), null, "nor its background work");
  assert.equal(await built.app.updateSession(sessionId, "member", { title: "stolen" }), null, "nor rename it");
  assert.ok(
    !(await built.app.listSessions("member")).some((session) => session.id === sessionId),
    "the list rejects it too, so both paths agree",
  );
});

test("a dropped project member cannot discard or retitle a session they can no longer read", async () => {
  const built = freshApp();
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  const project = await built.projects.create({ name: "Launch Cohort", ownerId: "owner" });
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");

  const spawned = await built.app.spawnSession("owner", { scopeId: projectScopeId(project.id) });
  const sessionId = spawned!.session.id;
  assert.ok(await built.app.getSessionForViewer(sessionId, "member"), "a project member reads the empty shell");

  assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");
  assert.ok(
    await built.sessions.getForParticipant(sessionId, "member"),
    "the participant row outlives the project membership",
  );
  assert.equal(await built.app.regenerateTitle(sessionId, "member"), null, "no retitling a session they cannot read");
  assert.equal(await built.app.discardSession(sessionId, "member"), false, "no discarding it either");
  assert.ok(await built.sessions.get(sessionId), "the session survives the refused discard");
  assert.equal(await built.app.discardSession(sessionId, "owner"), true, "the owner can still discard it");
});
