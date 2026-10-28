import "../../support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createInsecureTestServer } from "../../../src/api/server.ts";
import { projectRoutes } from "../../../src/api/routes/projects.ts";
import { createAclStore } from "../../../src/acl/acl-store.ts";
import { createDeployService } from "../../../src/deploy/deploy-service.ts";
import { createDeployStore } from "../../../src/deploy/deploy-store.ts";
import { projectGroupRef, projectScopeId } from "../../../src/projects/project-store.ts";
import { buildApp } from "../../support/build-app.ts";
import { isReply } from "../../../src/sessions/items.ts";
import { testConfig } from "../../support/test-config.ts";
import { singleProcessDeps } from "../../support/single-process.ts";
import { testDeployBackings, testDatabaseUrl } from "../../support/test-database.ts";
import { createPostgresGrantStore } from "../../../src/acl/postgres-grant-store.ts";
import { listen } from "../../support/project-routes.ts";
import { settledRun } from "../../support/turns.ts";
import { mockPrompts } from "../../support/mock-harness/turn.ts";

type Built = ReturnType<typeof buildApp>;
type ProjectSession = Awaited<ReturnType<Built["sessions"]["listByScope"]>>[number];
type DeployService = ReturnType<typeof createDeployService>;

interface ProjectScenario {
  built: Built;
  base: string;
  project: { id: string };
  scope: string;
  groupRef: string;
  turn: (actor: string, threadRef: string, text?: string) => ReturnType<Built["app"]["turn"]>;
  first: ProjectSession;
}

const send = (base: string, method: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function openProjectScenario(t: TestContext): Promise<ProjectScenario> {
  assert.ok(projectRoutes.every((route) => route.auth === "either"));
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app, {});
  const base = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
    { principalId: "outsider", displayName: "Outsider", type: "internal" },
    { principalId: "roster-helper", displayName: "Roster Helper", type: "internal" },
  ]);

  const create = await send(base, "POST", `/v1/projects`, { principalId: "owner", name: "Launch Cohort" });
  assert.equal(create.status, 201);
  const project = (
    (await create.json()) as {
      project: { id: string; scopeId: string; members: Array<{ principalId: string; displayName: string }> };
    }
  ).project;
  const scope = projectScopeId(project.id);
  const groupRef = projectGroupRef(project.id);
  assert.equal(project.scopeId, scope);
  assert.deepEqual(project.members, [{ principalId: "owner", displayName: "Owner" }]);

  const projectContext = (await built.app.listContexts("owner")).find((context) => context.scopeId === scope);
  assert.equal(projectContext?.sessionCount, 0);
  assert.equal(projectContext?.project?.id, project.id);
  assert.deepEqual(projectContext?.project?.members, [{ principalId: "owner", displayName: "Owner" }]);
  assert.ok(await built.app.listScopeResources("owner", scope));

  const turn = (actor: string, threadRef: string, text = "hello project") =>
    built.app.turn({
      origin: { kind: "direct" },
      surface: "web",
      actor: { externalId: actor },
      conversation: {
        kind: "group",
        channelRef: groupRef,
        channelName: "forged name",
        threadRef,
        audience: [{ externalId: "outsider" }],
        publishMembers: [{ externalId: "outsider" }],
      },
      text,
    });

  assert.equal((await turn("owner", "web:owner:first", "secret-before-join")).status, "ok");
  assert.equal((await built.runs.list())[0]?.request.scopeVersion, await built.projects.version(groupRef));
  const [first] = (await built.sessions.listByScope(scope)).toReversed();
  assert.ok(first);
  assert.equal(first.channelName, "Launch Cohort");
  assert.ok(!(await built.sessions.listByParticipant("outsider")).some((session) => session.id === first.id));
  return { built, base, project, scope, groupRef, turn, first };
}

async function rosterRoutesGateApprovals({ built, base, project, scope, groupRef, turn, first }: ProjectScenario) {
  const pendingBeforeJoin = await turn("owner", "web:owner:approval", "!run git push --force origin main");
  assert.equal(pendingBeforeJoin.status, "pending_approval");
  const pendingApproval = pendingBeforeJoin.pendingApprovals?.[0];
  assert.ok(pendingApproval);
  const denied = await send(base, "POST", `/v1/projects/${project.id}/members`, {
    principalId: "member",
    memberId: "outsider",
  });
  assert.equal(denied.status, 403);

  await new Promise((resolve) => setTimeout(resolve, 2));
  const added = await send(base, "POST", `/v1/projects/${project.id}/members`, {
    principalId: "owner",
    memberId: "member",
  });
  assert.equal(added.status, 200);
  const memberAdded = await send(base, "POST", `/v1/projects/${project.id}/members`, {
    principalId: "member",
    memberId: "roster-helper",
  });
  assert.equal(memberAdded.status, 200);
  const memberRemoved = await send(base, "DELETE", `/v1/projects/${project.id}/members/roster-helper`, {
    principalId: "owner",
  });
  assert.equal(memberRemoved.status, 200);
  const renameDenied = await send(base, "PATCH", `/v1/projects/${project.id}`, {
    principalId: "member",
    name: "Stolen",
  });
  assert.equal(renameDenied.status, 403);
  const renameEmpty = await send(base, "PATCH", `/v1/projects/${project.id}`, { principalId: "owner", name: "   " });
  assert.equal(renameEmpty.status, 400);
  const renamed = await send(base, "PATCH", `/v1/projects/${project.id}`, {
    principalId: "owner",
    name: "  Launch Renamed ",
  });
  assert.equal(renamed.status, 200);
  assert.equal(((await renamed.json()) as { project: { name: string } }).project.name, "Launch Renamed");
  assert.equal(await built.projects.name(groupRef), "Launch Renamed");

  assert.ok((await built.app.listSessions("member")).some((session) => session.id === first.id));
  assert.equal(
    (await built.sessions.listByParticipant("member")).find((session) => session.id === first.id)?.title,
    (await built.sessions.get(first.id))?.title,
  );
  assert.match(JSON.stringify((await built.app.getSessionForViewer(first.id, "member"))?.items), /secret-before-join/);
  assert.equal(await built.app.managesScope("member", scope), true);
  assert.ok(await built.app.listScopeResources("member", scope));
  assert.deepEqual(await built.app.listSessionApprovals(pendingBeforeJoin.sessionId!, "member"), []);
  const hiddenBlocked = await turn("member", "web:owner:approval", "new work while blocked");
  assert.equal(
    hiddenBlocked.status,
    "ok",
    "a roster change invalidates approvals minted for the previous Project audience",
  );
  const forgedApproval = await built.app.turn({
    origin: { kind: "direct" },
    surface: "web",
    actor: { externalId: "member" },
    conversation: { kind: "group", channelRef: groupRef, threadRef: "web:owner:approval", audience: [] },
    text: "!run git push --force origin main",
    approval: { requestId: pendingApproval.requestId, approved: true },
  });
  assert.equal(forgedApproval.status, "refused");
}

async function sharedDeploymentReachesMembers({ built, scope, turn, first }: ProjectScenario) {
  const deployAcl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 19999 }),
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: deployAcl,
    deployDir: mkdtempSync(join(tmpdir(), "project-deploy-")),
    canReadScope: (principalId, scopeId) => built.app.belongsToScope(principalId, scopeId),
  });
  const deployment = await deploy.deploy({
    ownerScopeId: "personal:owner",
    createdBy: "owner",
    entrypoint: "node server.js",
    files: [{ path: "server.js", data: "console.log('ready')" }],
  });
  await deployAcl.grant({
    ownerScopeId: "personal:owner",
    ref: `deployment:${deployment.id}`,
    granteeScopeId: scope,
    permission: "read",
    grantedBy: "owner",
  });
  assert.equal((await deploy.reachDeployment(deployment.id, "member")).status, "ok");
  assert.equal((await turn("owner", "web:owner:first", "Simulate four-way title outage after joining")).status, "ok");
  assert.ok((await built.app.listSessions("member")).some((session) => session.id === first.id));
  const latestRequest = mockPrompts(first.id).at(-1)!;
  assert.match(JSON.stringify(latestRequest), /secret-before-join/);
  assert.match(JSON.stringify(latestRequest), /after joining/);
  return { deploy, deployment };
}

async function approvalsAndTitlesStayPerViewer({ built, project, groupRef, turn, first }: ProjectScenario) {
  const sharedApproval = await turn("owner", "web:owner:shared-approval", "!run git push --force origin main");
  assert.equal(sharedApproval.status, "pending_approval");
  const sharedPending = sharedApproval.pendingApprovals?.[0];
  assert.ok(sharedPending);
  assert.equal((await built.app.listSessionApprovals(sharedApproval.sessionId!, "owner")).length, 1);
  assert.deepEqual(await built.app.listSessionApprovals(sharedApproval.sessionId!, "member"), []);
  const crossMemberApproval = await built.app.turn({
    origin: { kind: "direct" },
    surface: "web",
    actor: { externalId: "member" },
    conversation: { kind: "group", channelRef: groupRef, threadRef: "web:owner:shared-approval", audience: [] },
    text: "!run git push --force origin main",
    approval: { requestId: sharedPending.requestId, approved: true },
  });
  assert.equal(crossMemberApproval.status, "refused");

  const globalTitle = (await built.sessions.get(first.id))?.title ?? null;
  const regenerated = await built.app.regenerateTitle(first.id, "member");
  assert.equal(regenerated?.title, "secret-before-join");
  assert.equal((await built.sessions.get(first.id))?.title ?? null, globalTitle);
  assert.equal(
    (await built.app.listSessions("member")).find((session) => session.id === first.id)?.title,
    regenerated.title,
  );
  assert.equal((await built.app.listSessions("owner")).find((session) => session.id === first.id)?.title, globalTitle);
  assert.equal(await built.app.regenerateTitle(first.id, "outsider"), null);
  assert.ok(await built.app.updateSession(first.id, "owner", { title: "Owner-only project title" }));
  assert.equal((await built.sessions.get(first.id))?.title ?? null, globalTitle);
  assert.equal(
    (await built.app.listSessions("member")).find((session) => session.id === first.id)?.title,
    regenerated.title,
  );
  assert.equal(
    (await built.app.listSessions("owner")).find((session) => session.id === first.id)?.title,
    "Owner-only project title",
  );
  const unchangedAdd = await built.app.addProjectMember(project.id, "owner", "member");
  assert.equal(unchangedAdd.status, "ok");
  assert.equal(unchangedAdd.status === "ok" && unchangedAdd.changed, false);
  assert.equal(
    (await built.sessions.listByParticipant("member")).find((session) => session.id === first.id)?.title,
    regenerated.title,
  );
}

async function forkRacesRosterChange({ built, project, turn, first }: ProjectScenario) {
  const forked = await built.app.forkSession(first.id, "owner");
  assert.ok(forked);
  assert.match(JSON.stringify(forked.items), /secret-before-join/);
  assert.match(JSON.stringify(forked.items), /after joining/);
  assert.equal((await built.sessions.get(forked.session.id))?.title ?? null, null);

  const appendForFork = built.sessions.appendMany.bind(built.sessions);
  let releaseForkCopy!: () => void;
  const forkCopyReleased = new Promise<void>((resolve) => {
    releaseForkCopy = resolve;
  });
  let forkCopyStarted!: () => void;
  const forkCopyStart = new Promise<void>((resolve) => {
    forkCopyStarted = resolve;
  });
  let copyingSessionId: string | undefined;
  built.sessions.appendMany = async (lease, entries) => {
    if (!copyingSessionId && lease.sessionId !== first.id && lease.sessionId !== forked.session.id) {
      copyingSessionId = lease.sessionId;
      forkCopyStarted();
      await forkCopyReleased;
    }
    return appendForFork(lease, entries);
  };
  const racingForkPromise = built.app.forkSession(first.id, "owner");
  await forkCopyStart;
  let addSettled = false;
  const addDuringFork = built.app.addProjectMember(project.id, "owner", "outsider").finally(() => {
    addSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(addSettled, false);
  releaseForkCopy();
  const [racingFork, addedDuringFork] = await Promise.all([racingForkPromise, addDuringFork]);
  built.sessions.appendMany = appendForFork;
  assert.ok(racingFork);
  assert.equal(addedDuringFork.status, "ok");
  assert.equal(racingFork.session.id, copyingSessionId);
  const ownerForkView = await built.app.getSessionForViewer(racingFork.session.id, "owner");
  const memberForkView = await built.app.getSessionForViewer(racingFork.session.id, "member");
  assert.match(JSON.stringify(ownerForkView?.items), /after joining/);
  assert.match(JSON.stringify(memberForkView?.items), /after joining/);
  assert.match(
    JSON.stringify((await built.app.getSessionForViewer(racingFork.session.id, "outsider"))?.items),
    /after joining/,
  );
  assert.equal((await built.app.removeProjectMember(project.id, "owner", "outsider")).status, "ok");
  assert.equal((await turn("owner", racingFork.session.threadRef, "continue the fork")).status, "ok");
  assert.match(JSON.stringify(mockPrompts(racingFork.session.id).at(-1)), /after joining/);
}

async function leaseOrderingAndDeactivation({ built, project, scope, groupRef, turn, first }: ProjectScenario) {
  const participantOrder: string[] = [];
  const acquireLease = built.sessions.acquireLease.bind(built.sessions);
  const addParticipantForOrder = built.sessions.addParticipant.bind(built.sessions);
  built.sessions.acquireLease = async (sessionId, holder) => {
    const attempt = await acquireLease(sessionId, holder);
    participantOrder.push(`lease:${sessionId}`);
    return attempt;
  };
  built.sessions.addParticipant = async (sessionId, principalId, title) => {
    participantOrder.push(`participant:${sessionId}:${principalId}`);
    return addParticipantForOrder(sessionId, principalId, title);
  };
  try {
    assert.equal((await turn("owner", "web:owner:second")).status, "ok");
  } finally {
    built.sessions.acquireLease = acquireLease;
    built.sessions.addParticipant = addParticipantForOrder;
  }
  const leaseIndex = participantOrder.findIndex((event) => event.startsWith("lease:"));
  const participantIndex = participantOrder.findIndex((event) => event.startsWith("participant:"));
  assert.ok(
    leaseIndex >= 0 && participantIndex > leaseIndex,
    "Project participant reconciliation happens only after the lease",
  );
  const projectSessions = await built.sessions.listByScope(scope);
  assert.equal(projectSessions.length, 6);
  for (const session of projectSessions) {
    assert.ok((await built.sessions.listByParticipant("member")).some((candidate) => candidate.id === session.id));
  }
  const background = () =>
    built.app.turn({
      surface: "cron",
      actor: { externalId: "member" },
      conversation: {
        kind: "group",
        channelRef: groupRef,
        threadRef: `cron:${project.id}:fire`,
        audience: [{ externalId: "outsider" }],
      },
      text: "background project work",
      origin: { kind: "automation" },
    });
  assert.equal((await background()).status, "ok");
  const removableApprovalThread = "web:member:approval-to-cancel";
  const removableApproval = await turn("member", removableApprovalThread, "!run git push --force origin main");
  assert.equal(removableApproval.status, "pending_approval");
  const removableApprovalId = removableApproval.pendingApprovals?.[0]?.requestId;
  assert.ok(removableApprovalId);

  await built.identity.deactivate("member");
  assert.deepEqual(await built.app.listProjects("member"), []);
  assert.equal(await built.app.belongsToScope("member", scope), false);
  assert.equal((await turn("member", "web:owner:first")).status, "refused");
  assert.equal((await background()).status, "refused");
  assert.equal((await turn("owner", "web:owner:first", "inactive-gap-secret")).status, "ok");
  await built.identity.reactivate("member");
  assert.equal((await turn("owner", "web:owner:first", "after-reactivation")).status, "ok");
  const reactivatedRequest = mockPrompts(first.id).at(-1)!;
  assert.doesNotMatch(JSON.stringify(reactivatedRequest), /inactive-gap-secret/);
  assert.match(JSON.stringify(reactivatedRequest), /after-reactivation/);
  await built.identity.deactivate("owner");
  assert.deepEqual(await built.app.listProjects("member"), []);
  assert.equal((await turn("member", "web:owner:first")).status, "refused");
  assert.equal((await built.app.addProjectMember(project.id, "owner", "outsider")).status, "forbidden");
  assert.equal((await built.app.addProjectMember(project.id, "member", "outsider")).status, "forbidden");
  await built.identity.reactivate("owner");
  return { projectSessions, removableApprovalThread };
}

async function failedReconcileHeals({ built, project }: ProjectScenario, projectSessions: ProjectSession[]) {
  const addParticipant = built.sessions.addParticipant.bind(built.sessions);
  let failReconcile = true;
  built.sessions.addParticipant = async (sessionId, principalId, title, opts) => {
    if (principalId === "outsider" && failReconcile) {
      failReconcile = false;
      throw new Error("injected participant failure");
    }
    return addParticipant(sessionId, principalId, title, opts);
  };
  await assert.rejects(built.app.addProjectMember(project.id, "owner", "outsider"), /injected participant failure/);
  assert.ok((await built.projects.get(project.id))?.memberIds.includes("outsider"));
  built.sessions.addParticipant = addParticipant;
  const healed = await built.app.addProjectMember(project.id, "owner", "outsider");
  assert.equal(healed.status, "ok");
  assert.equal(healed.status === "ok" && healed.changed, false);
  const outsiderSessions = await built.sessions.listByParticipant("outsider");
  assert.ok(projectSessions.every((session) => outsiderSessions.some((candidate) => candidate.id === session.id)));
  for (const session of outsiderSessions)
    assert.equal(session.title ?? null, (await built.sessions.get(session.id))?.title ?? null);
  assert.equal((await built.app.removeProjectMember(project.id, "owner", "outsider")).status, "ok");
}

async function removalCutsAccessUntilRejoin(
  { built, base, project, scope, groupRef, turn, first }: ProjectScenario,
  deploy: DeployService,
  deployment: Awaited<ReturnType<DeployService["deploy"]>>,
  projectSessions: ProjectSession[],
  removableApprovalThread: string,
) {
  const removed = await send(base, "DELETE", `/v1/projects/${project.id}/members/member`, { principalId: "owner" });
  assert.equal(removed.status, 200);
  assert.equal(await built.app.belongsToScope("member", scope), false);
  assert.equal(await built.app.managesScope("member", scope), false);
  assert.equal((await deploy.reachDeployment(deployment.id, "member")).status, "denied");
  assert.equal(await built.app.listScopeResources("member", scope), null);
  assert.ok(!(await built.app.listSessions("member")).some((session) => session.scopeId === scope));
  assert.equal(await built.app.getSessionForViewer(first.id, "member"), null);
  assert.equal((await turn("member", "web:owner:first")).status, "refused");
  assert.equal(await built.app.pendingApprovalForThread(removableApprovalThread), null);
  const closed = (await built.sessions.listParticipants()).filter(
    (window) => window.principalId === "member" && projectSessions.some((session) => session.id === window.sessionId),
  );
  assert.equal(closed.length, projectSessions.length);
  assert.ok(closed.every((window) => window.validTo !== null));
  const closedAt = Math.max(...closed.map((window) => window.validTo!));

  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  const reopened = (await built.sessions.listParticipants()).filter(
    (window) => window.principalId === "member" && projectSessions.some((session) => session.id === window.sessionId),
  );
  assert.ok(closedAt > 0);
  assert.ok(reopened.every((window) => window.validTo === null && window.validFrom === 0));
  assert.equal((await turn("member", removableApprovalThread, "continue after rejoining")).status, "ok");

  const queued = await built.app.turn({
    origin: { kind: "direct" },
    surface: "web",
    actor: { externalId: "member" },
    conversation: { kind: "group", channelRef: groupRef, threadRef: "web:member:queued-before-removal", audience: [] },
    text: "work that must not cross membership tenures",
    async: true,
  });
  assert.equal(queued.status, "queued");
  assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  built.runtime.start();
  try {
    const finished = await settledRun(built.runs, queued.runId!, 5_000);
    assert.equal(finished.result?.status, "refused");
    assert.match(finished.result?.reason ?? "", /membership changed/);
    assert.equal(await built.sessions.getByThread("web:member:queued-before-removal"), null);
  } finally {
    await built.runtime.stop();
  }
}

test("Project routes use ordinary group sessions with the durable roster as authority", async (t) => {
  const s = await openProjectScenario(t);
  await rosterRoutesGateApprovals(s);
  const { deploy, deployment } = await sharedDeploymentReachesMembers(s);
  await approvalsAndTitlesStayPerViewer(s);
  await forkRacesRosterChange(s);
  const { projectSessions, removableApprovalThread } = await leaseOrderingAndDeactivation(s);
  await failedReconcileHeals(s, projectSessions);
  await removalCutsAccessUntilRejoin(s, deploy, deployment, projectSessions, removableApprovalThread);
});

test("a member added mid-turn sees the thread but never the prior roster's output", async () => {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "late-member", displayName: "Late Member", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Roster race");
  assert.ok(project);

  const originalRecord = built.sessions.recordLlmRequest.bind(built.sessions);
  let resumeTurn!: () => void;
  const turnMayResume = new Promise<void>((resolve) => {
    resumeTurn = resolve;
  });
  let markPaused!: () => void;
  const turnPaused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  let paused = false;
  built.sessions.recordLlmRequest = async (sessionId, record) => {
    const stored = await originalRecord(sessionId, record);
    if (!paused && record.scopeLabel === project.scopeId) {
      paused = true;
      markPaused();
      await turnMayResume;
    }
    return stored;
  };

  const threadRef = "web:owner:roster-race";
  const turn = built.app.turn({
    origin: { kind: "direct" },
    surface: "web",
    actor: { externalId: "owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef,
      audience: [],
    },
    text: "old-roster-prompt",
  });

  try {
    await turnPaused;
    const session = await built.sessions.getByThread(threadRef);
    assert.ok(session);
    assert.match(JSON.stringify(await built.sessions.getItems(session.id)), /old-roster-prompt/);

    const added = await built.app.addProjectMember(project.id, "owner", "late-member");
    assert.equal(added.status, "ok");
    resumeTurn();

    const result = await turn;
    assert.equal(result.status, "refused");
    assert.match(result.reason ?? "", /membership changed/);
    const lateView = await built.app.getSessionForViewer(session.id, "late-member");
    assert.ok(lateView);
    assert.match(JSON.stringify(lateView.items), /old-roster-prompt/);
    assert.equal(lateView.items.some(isReply), false);
    assert.equal((await built.sessions.getItems(session.id)).some(isReply), false);
  } finally {
    resumeTurn();
    built.sessions.recordLlmRequest = originalRecord;
  }
});

test("a member added to a Project inherits the chats that predate them", async () => {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Shared history");
  assert.ok(project);
  const threadRef = "web:owner:pre-join";
  const conversation = { kind: "group" as const, channelRef: projectGroupRef(project.id), threadRef, audience: [] };
  assert.equal(
    (
      await built.app.turn({
        origin: { kind: "direct" },
        surface: "web",
        actor: { externalId: "owner" },
        conversation,
        text: "BEFORE_JOIN_TOPIC",
      })
    ).status,
    "ok",
  );
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);
  await built.sessions.updateTitle(session.id, "Pre-join chat");

  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");

  const listed = await built.app.listSessions("member");
  const row = listed.find((entry) => entry.id === session.id);
  assert.ok(row, "a chat that predates the member must appear in their conversation list");
  assert.equal(row.title, "Pre-join chat", "the joiner sees the chat's real title, not a blanked one");
  const view = await built.app.getSessionForViewer(session.id, "member");
  assert.match(JSON.stringify(view?.items), /BEFORE_JOIN_TOPIC/, "pre-join transcript must be readable");

  assert.equal(
    (
      await built.app.turn({
        origin: { kind: "direct" },
        surface: "web",
        actor: { externalId: "member" },
        conversation,
        text: "hello after joining",
      })
    ).status,
    "ok",
  );
  assert.match(
    JSON.stringify(mockPrompts(session.id).at(-1)!.messages),
    /BEFORE_JOIN_TOPIC/,
    "the agent keeps the project's full history",
  );
});

test("leaving a Project still cuts off everything after the member left", async () => {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Departures");
  assert.ok(project);
  const threadRef = "web:owner:departure";
  const conversation = { kind: "group" as const, channelRef: projectGroupRef(project.id), threadRef, audience: [] };
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  assert.equal(
    (
      await built.app.turn({
        origin: { kind: "direct" },
        surface: "web",
        actor: { externalId: "owner" },
        conversation,
        text: "WHILE_A_MEMBER",
      })
    ).status,
    "ok",
  );
  assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);
  assert.equal(
    (
      await built.app.turn({
        origin: { kind: "direct" },
        surface: "web",
        actor: { externalId: "owner" },
        conversation,
        text: "AFTER_THEY_LEFT",
      })
    ).status,
    "ok",
  );
  assert.equal(await built.app.getSessionForViewer(session.id, "member"), null);
  assert.deepEqual(await built.app.listSessions("member"), []);
});
