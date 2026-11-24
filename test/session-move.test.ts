import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { createServer } from "../src/api/server.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import { isUserItem } from "../src/sessions/items.ts";
import { createGoalRecord } from "../src/agent/goal.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

async function setup() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-move-")) }));
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
    { principalId: "outsider", displayName: "Outsider", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Launch");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  const personal = async (principal: string, thread: string, text: string) => {
    const result = await built.app.turn({
      surface: "web",
      actor: { externalId: principal },
      conversation: { kind: "dm", threadRef: thread },
      text,
    });
    return result.sessionId!;
  };
  const subagent = async (parentId: string, thread: string) => {
    const child = await built.sessions.getOrCreateByThread(thread, "dm", "personal:owner", undefined, "web");
    await built.sessions.addParticipant(child.id, "owner");
    await built.sessions.setParentSession(child.id, parentId);
    return child;
  };
  return { built, project, scope: projectScopeId(project.id), personal, subagent };
}

async function soloProject(built: Awaited<ReturnType<typeof setup>>["built"]) {
  const project = await built.app.createProject("owner", "Solo");
  assert.ok(project);
  return projectScopeId(project.id);
}

test("moving a chat where nobody new can read it re-homes the same chat without asking", async () => {
  const { built, personal } = await setup();
  const scope = await soloProject(built);
  const sid = await personal("owner", "web:owner:move-1", "Plan the launch checklist");
  await built.app.updateSession(sid, { actorId: "owner" }, { title: "Launch checklist", pinned: true });

  assert.deepEqual(await built.app.moveSession(tenant, sid, "owner", scope, { preview: true }), {
    moved: false,
    preview: true,
    gains: [],
  });
  const out = await built.app.moveSession(tenant, sid, "owner", scope);
  assert.ok(out.moved);
  assert.equal(out.session.id, sid, "the chat keeps its id and link");
  assert.equal(out.session.scopeId, scope);
  assert.equal(out.session.type, "group");
  assert.equal(out.session.channelName, "Solo");
  assert.equal(out.session.title, "Launch checklist");
  assert.equal(out.session.pinned, true);
  assert.equal(out.session.archived, undefined);
  assert.equal((await built.sessions.listByScope("personal:owner")).length, 0, "nothing is left behind");
  const audits = (await built.auditLog.events(tenant)).filter((e) => e.action === "session.move");
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.resource, sid);
  assert.equal(audits[0]!.scopeLabel, scope);
});

test("broadening a chat's readers needs the user to confirm exactly who gains access", async () => {
  const { built, project, scope, personal } = await setup();
  const sid = await personal("owner", "web:owner:move-confirm", "Private launch notes");
  const member = { principalId: "member", displayName: "Member" };
  assert.deepEqual(await built.app.moveSession(tenant, sid, "owner", scope, { preview: true }), {
    moved: false,
    preview: true,
    gains: [member],
  });
  assert.deepEqual(await built.app.moveSession(tenant, sid, "owner", scope), {
    moved: false,
    reason: "confirm_audience",
    gains: [member],
  });
  assert.equal(await built.app.getSessionForViewer(sid, { actorId: "member" }), null);

  assert.equal((await built.app.addProjectMember(project.id, "owner", "outsider")).status, "ok");
  const late = await built.app.moveSession(tenant, sid, "owner", scope, { audience: ["member"] });
  assert.deepEqual(
    late,
    { moved: false, reason: "confirm_audience", gains: [member, { principalId: "outsider", displayName: "Outsider" }] },
    "someone who joined after the confirmation was shown is not let in",
  );
  assert.equal((await built.sessions.get(sid))!.scopeId, "personal:owner");

  const out = await built.app.moveSession(tenant, sid, "owner", scope, { audience: ["member", "outsider"] });
  assert.ok(out.moved);
  const view = await built.app.getSessionForViewer(sid, { actorId: "member" });
  assert.ok(view?.items.filter(isUserItem).some((item) => item.text?.includes("Private launch notes")));
  assert.deepEqual(
    (await built.sessions.participantsOf(sid)).sort(),
    ["member", "outsider", "owner"],
    "the chat's readers are now the project's members",
  );
});

test("a chat's goal, schedules, watches, webhooks, subagents and their computers come along", async () => {
  const { built, personal, subagent } = await setup();
  const scope = await soloProject(built);
  const sid = await personal("owner", "web:owner:move-attached", "Keep an eye on the launch");
  const thread = (await built.sessions.get(sid))!.threadRef;
  await built.sessions.setGoal({ sessionId: sid }, createGoalRecord({ objective: "ship the launch" }));
  const destination = { type: "web", target: thread, audienceScopeId: "personal:owner" as const };
  const owned = { ownerScopeId: "personal:owner" as const, owner: "owner", createdBy: "owner", destination };
  const cron = await built.crons.create({
    ...owned,
    schedule: { everyMs: 3_600_000 },
    action: "check the launch",
    sessionRef: thread,
    script: { command: "true", sandboxId: "personal-box" },
  });
  const elsewhere = await built.crons.create({
    ...owned,
    destination: { ...destination, target: "web:owner:other" },
    schedule: { everyMs: 3_600_000 },
    action: "unrelated",
  });
  const webhook = await built.app.createWebhook({
    ...owned,
    action: "note the deploy",
    verification: { scheme: "token", secret: "s3cret-token-value" },
  });
  const watch = await built.monitors.create({
    ...owned,
    processId: "p-done",
    command: "bg: tail",
    threadRef: thread,
    expiresAt: Date.now() + 600_000,
  });
  const { loop } = await built.loops.store.create({
    ...owned,
    name: "Launch triage",
    playbook: "Triage launch issues.",
    successCondition: "Issues are triaged.",
  });

  const { id: child, threadRef: childThread } = await subagent(sid, "agent:main:subagent:move-child");
  const actor = { id: "internal:owner", type: "internal" as const, externalId: "owner" };
  await built.sessions.setSpawnMeta(child, {
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: childThread, audience: [actor] },
    isolation: { mode: "sandbox", sandboxId: child },
  });
  const { id: helper, threadRef: helperThread } = await subagent(sid, "agent:main:subagent:move-helper");
  await built.sessions.setSpawnMeta(helper, {
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: helperThread, audience: [actor] },
    isolation: { mode: "shared", sandboxId: "personal-computer" },
  });
  const { id: grand, threadRef: grandThread } = await subagent(sid, "agent:main:subagent:move-grand");
  await built.sessions.setSpawnMeta(grand, {
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: grandThread, audience: [actor] },
    isolation: { mode: "shared", sandboxId: child },
  });

  const out = await built.app.moveSession(tenant, sid, "owner", scope);
  assert.ok(out.moved);
  assert.equal((await built.sessions.goals([sid])).get(sid)?.objective, "ship the launch");

  const movedCron = (await built.crons.get(cron.id))!;
  assert.equal(movedCron.ownerScopeId, scope, "the schedule now runs in the project");
  assert.equal(movedCron.destination?.audienceScopeId, scope);
  assert.equal(movedCron.destination?.target, thread, "and still posts into the same chat");
  assert.deepEqual(movedCron.script, { command: "true" }, "its pinned personal computer stays behind");
  assert.equal((await built.crons.get(elsewhere.id))!.ownerScopeId, "personal:owner");
  assert.equal((await built.app.getWebhook(webhook.id))!.ownerScopeId, scope);
  assert.equal((await built.monitors.get(watch.id))!.ownerScopeId, scope);
  const movedLoop = (await built.loops.store.get(loop.id))!;
  assert.equal(movedLoop.ownerScopeId, "personal:owner", "a loop belongs to its space and stays");
  assert.equal(movedLoop.destination, undefined, "but it no longer posts into the moved chat");

  const movedChild = (await built.sessions.get(child))!;
  assert.equal(movedChild.scopeId, scope);
  assert.equal(movedChild.parentSessionId, sid);
  assert.equal(movedChild.spawnMeta?.conversation.kind, "group");
  assert.equal(movedChild.spawnMeta?.conversation.channelName, "Solo");
  assert.deepEqual(movedChild.spawnMeta?.sessionParticipantIds, ["owner"]);
  assert.equal(movedChild.spawnMeta?.isolation?.mode, "sandbox");
  assert.notEqual(
    movedChild.spawnMeta?.isolation?.sandboxId,
    child,
    "an own-computer subagent gets a fresh computer in the project the next time it runs",
  );
  assert.deepEqual(
    (await built.sessions.get(helper))!.spawnMeta?.isolation,
    { mode: "shared" },
    "a subagent sharing the chat's personal computer follows the chat onto the project's",
  );
  assert.equal(
    (await built.sessions.get(grand))!.spawnMeta?.isolation?.sandboxId,
    movedChild.spawnMeta?.isolation?.sandboxId,
    "one sharing a moved subagent's own computer follows it to the new one",
  );
});

test("only work that is running right now holds a move back", async () => {
  const { built, personal, subagent } = await setup();
  const scope = await soloProject(built);
  const sid = await personal("owner", "web:owner:move-busy", "Busy work");
  const { threadRef: childThread } = await subagent(sid, "agent:main:subagent:move-busy-child");
  const actor = { id: "internal:owner", type: "internal" as const };
  await built.runs.enqueue({
    sessionId: childThread,
    request: {
      actor,
      conversation: { kind: "dm" as const, threadRef: childThread, audience: [actor] },
      origin: { kind: "direct" as const },
      text: "Keep going",
    },
  });
  assert.deepEqual(await built.app.moveSession(tenant, sid, "owner", scope), { moved: false, reason: "busy" });

  const other = await personal("owner", "web:owner:move-job", "Job work");
  await built.processes!.register({
    processId: "p-move-job",
    scopeId: "personal:owner",
    sandboxId: "personal-box",
    kind: "background",
    command: "bg: npm run build",
    purpose: "Building the site",
    ttlMs: 600_000,
    sessionRef: (await built.sessions.get(other))!.threadRef,
  });
  assert.deepEqual(await built.app.moveSession(tenant, other, "owner", scope), {
    moved: false,
    reason: "job_running",
    job: { purpose: "Building the site" },
  });
  await built.processes!.markStatus("p-move-job", "exited");
  assert.ok(
    (await built.app.moveSession(tenant, other, "owner", scope)).moved,
    "a finished job no longer holds it back",
  );
  assert.equal((await built.sessions.get(sid))!.scopeId, "personal:owner", "refused moves change nothing");
});

test("moves are refused for non-members, strangers, side chats, and non-project targets", async () => {
  const { built, scope, personal } = await setup();
  const outsiders = await personal("outsider", "web:outsider:move", "Not a member here");
  assert.deepEqual(await built.app.moveSession(tenant, outsiders, "outsider", scope), {
    moved: false,
    reason: "forbidden",
  });

  const sid = await personal("owner", "web:owner:move-2", "Some private notes");
  assert.deepEqual(await built.app.moveSession(tenant, sid, "member", scope), { moved: false, reason: "not_found" });
  assert.deepEqual(await built.app.moveSession(tenant, sid, "owner", "personal:owner"), {
    moved: false,
    reason: "same_scope",
  });
  assert.deepEqual(await built.app.moveSession(tenant, sid, "owner", "personal:member"), {
    moved: false,
    reason: "not_project",
  });
  const sideChat = await built.app.forkSession(sid, "owner", {
    sideChat: { entrySeq: 0, quote: "private notes", occurrence: 0 },
  });
  assert.deepEqual(await built.app.moveSession(tenant, sideChat!.session.id, "owner", scope), {
    moved: false,
    reason: "unsupported_source",
  });
});

test("the move route binds the principal to the portal identity and maps refusals to statuses", async () => {
  const { built, scope, personal } = await setup();
  const sid = await personal("owner", "web:owner:move-route", "Route move");
  const outsiders = await personal("outsider", "web:outsider:move-route", "Route refusal");
  const sourceSecret = "session-move-source-secret-for-http-tests";
  const identitySecret = "session-move-identity-secret-for-http-tests";
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: sourceSecret,
    capabilitySecret: "session-move-capability-secret-for-http-tests",
    portalIdentitySecret: identitySecret,
    production: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const move = async (id: string, principal: string, body: Record<string, unknown>) => {
    const path = `/v1/sessions/${id}/move?nonce=${crypto.randomUUID()}`;
    const payload = JSON.stringify({ principalId: principal, ...body });
    return fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedRequestHeaders(sourceSecret, "POST", path, payload),
        "x-portal-identity": await mintSignedPayload({ p: principal, exp: Date.now() + 60_000 }, identitySecret),
      },
      body: payload,
    });
  };
  try {
    assert.equal((await move(sid, "owner", {})).status, 400);
    const refused = await move(outsiders, "outsider", { scopeId: scope });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { message: string }).message, "You're not a member of that project.");
    const preview = await move(sid, "owner", { scopeId: scope, preview: true });
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), { gains: [{ principalId: "member", displayName: "Member" }] });
    const unconfirmed = await move(sid, "owner", { scopeId: scope });
    assert.equal(unconfirmed.status, 409);
    assert.deepEqual(await unconfirmed.json(), {
      error: "confirm_audience",
      gains: [{ principalId: "member", displayName: "Member" }],
      message: "Moving this chat lets Member read it. Confirm to move it.",
    });
    assert.equal((await move(sid, "owner", { scopeId: scope, audience: "member" })).status, 400);
    const ok = await move(sid, "owner", { scopeId: scope, audience: ["member"] });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { session: { scopeId: string } };
    assert.equal(body.session.scopeId, scope);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
