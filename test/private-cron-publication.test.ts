import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createControlService } from "../src/api/control-service.ts";
import { cronSharingRevision } from "../src/cron/cron-store.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import { principalDestination } from "../src/reach/reach.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { settle } from "./support/settle.ts";

async function fixture(overrides: Parameters<typeof buildApp>[1] = {}, message?: string) {
  const config = testConfig();
  const built = buildApp(config, overrides);
  await built.app.upsertDirectory([
    { principalId: "alice", displayName: "Alice", type: "internal" },
    { principalId: "bob", displayName: "Bob", type: "internal" },
  ]);
  const project = await built.projects.create({ name: "Publication audience", ownerId: "alice" });
  await built.projects.addMember(project.id, "alice", "bob");
  const target = projectScopeId(project.id);
  const session = await built.sessions.getOrCreateByThread("private-cron-publication", "dm", "personal:alice");
  await built.sessions.recordContextProvenance(session.id, session.scopeId, {
    sources: [session.scopeId],
    sensitivity: "ordinary",
    sourceUnknown: false,
    personalOnly: true,
  });
  const claims = {
    actorId: "alice",
    scopeId: session.scopeId,
    sessionId: session.id,
    threadRef: session.threadRef,
    liveActor: true,
    exp: Date.now() + 60_000,
  };
  const cron = await built.app.createCron({
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: session.scopeId,
    context: claims,
    schedule: { everyMs: 3_600_000 },
    ...(message === undefined ? { action: "Return the synthetic shared report." } : { message }),
    destination: principalDestination("alice", "alice"),
    sessionRef: session.threadRef,
    enabled: false,
  });
  return {
    databaseUrl: config.databaseUrl!,
    projectId: project.id,
    orgScope: `org:${config.orgId}`,
    built,
    session,
    claims,
    cron,
    target,
    control: createControlService(built.app, built.scheduler),
  };
}

test("publishing a private schedule creates a separate shared configuration and preserves private history", async () => {
  const f = await fixture();
  await f.built.crons.setFireNote(f.cron.id, { text: "Private historical note", at: Date.now() });
  await f.built.crons.recordFire(f.cron.id, {
    fireKey: "private-fire",
    threadRef: "private-fire-thread",
    firedAt: 1,
    status: "ok",
    reply: "Private old result",
  });
  const selected = (await f.built.crons.get(f.cron.id))!;
  assert.equal(cronSharingRevision(selected), cronSharingRevision(f.cron));
  const request = { type: "cron" as const, id: selected.id, scope: f.target };
  const preflight = await f.control.shareArtifact(request, f.claims);
  assert.equal(preflight.ok, false);
  if (preflight.ok) assert.fail("approval required");
  assert.equal(preflight.privateRelease?.revision, cronSharingRevision(selected));
  const result = await f.control.shareArtifact(
    { ...request, privateRevision: preflight.privateRelease!.revision },
    f.claims,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.id, selected.id);
  const shared = (await f.built.crons.get(result.id))!;
  assert.equal(shared.ownerScopeId, f.target);
  assert.equal(shared.owner, selected.owner);
  assert.equal(shared.createdBy, selected.createdBy);
  assert.equal(shared.action, selected.action);
  assert.deepEqual(shared.schedule, selected.schedule);
  assert.equal(shared.enabled, false);
  for (const field of [
    "personalOnly",
    "sessionRef",
    "lastFireNote",
    "lastFiredAt",
    "lastAttemptAt",
    "deferUntil",
  ] as const)
    assert.equal(shared[field], undefined, field);
  assert.equal(shared.destination?.type, "web");
  assert.equal(shared.destination?.audienceScopeId, f.target);
  assert.notEqual(shared.destination?.target, selected.destination?.target);
  assert.equal((await f.built.crons.listFires(shared.id)).total, 0);
  assert.equal((await f.built.crons.listFires(selected.id)).runs[0]!.reply, "Private old result");
  const original = (await f.built.crons.get(selected.id))!;
  assert.equal(original.personalOnly, true);
  assert.equal(original.lastFireNote?.text, "Private historical note");
  assert.equal(original.enabled, false);
  const reader = await f.built.sessions.getOrCreateByThread("publication-reader", "group", f.target);
  const bob = {
    actorId: "bob",
    scopeId: f.target,
    sessionId: reader.id,
    threadRef: reader.threadRef,
    liveActor: true,
    exp: Date.now() + 60_000,
  };
  assert.equal((await f.control.getCron(shared.id, bob)).ok, true);
  assert.equal((await f.control.getCron(selected.id, bob)).ok, false);
  assert.equal((await f.control.getCronRuns(selected.id, {}, bob)).ok, false);
  assert.equal((await f.built.sessions.get(f.session.id))!.personalOnly, true);
  await assert.rejects(f.built.app.updateCron(shared.id, { action: "New private content" }, f.claims), /Private/);
  const repeated = await f.built.crons.publishPrivate(
    selected.id,
    cronSharingRevision(selected),
    f.target,
    shared.sourceProvenance!,
  );
  assert.equal(repeated.id, shared.id);
  assert.equal((await f.built.crons.list()).length, 2);
});

test("a changed private schedule cannot be published with an earlier approval", async () => {
  const f = await fixture();
  const revision = cronSharingRevision(f.cron);
  await f.built.crons.update(f.cron.id, { action: "Changed task" });
  await assert.rejects(
    f.built.crons.publishPrivate(f.cron.id, revision, f.target, {
      sources: [],
      sensitivity: "ordinary",
      sourceUnknown: false,
    }),
    /changed after approval/,
  );
  assert.equal((await f.built.crons.list()).length, 1);
  assert.equal((await f.built.crons.get(f.cron.id))!.personalOnly, true);
});

test("foreign source restrictions and non-owner contexts refuse schedule publication", async () => {
  const f = await fixture();
  const source = await f.built.projects.create({ name: "Restricted source", ownerId: "alice" });
  await f.built.crons.update(f.cron.id, {
    sourceProvenance: { sources: [projectScopeId(source.id)], sensitivity: "restricted", sourceUnknown: false },
  });
  const selected = (await f.built.crons.get(f.cron.id))!;
  const result = await f.control.shareArtifact(
    { type: "cron", id: selected.id, scope: f.target, privateRevision: cronSharingRevision(selected) },
    f.claims,
  );
  assert.equal(result.ok, false);
  assert.equal((await f.built.crons.list()).length, 1);
  await assert.rejects(
    f.built.app.publishPrivateCron(selected.id, cronSharingRevision(selected), f.target, {
      actorId: "bob",
      scopeId: "personal:bob",
    }),
    /owner/,
  );
});

test("publication retains the current cadence rather than replaying the original interval start", async () => {
  const f = await fixture();
  await f.built.crons.update(f.cron.id, {
    schedule: { everyMs: 3_600_000, firstFireAt: Date.now() - 7_200_000 },
    enabled: true,
  });
  const prior = (await f.built.crons.get(f.cron.id))!;
  await f.built.crons.markFired(prior, Date.now() - 60_000);
  const selected = (await f.built.crons.get(prior.id))!;
  const shared = await f.built.app.publishPrivateCron(selected.id, cronSharingRevision(selected), f.target, f.claims);
  assert.equal(shared.enabled, true);
  assert.equal(shared.nextFireAt, selected.nextFireAt);
  assert.ok(shared.nextFireAt! > Date.now());
  assert.equal((await f.built.crons.get(selected.id))!.enabled, false);
});

for (const exactText of [false, true])
  test(`published ${exactText ? "exact-text" : "task"} schedule automatically fires to its fresh shared conversation`, async (t) => {
    const calls: { scopeId: string; personalOnly?: true; input: string }[] = [];
    let additionalSource = "";
    const f = await fixture(
      {
        agent: {
          ...createMockAgent(),
          runTurn: async (input) => {
            calls.push({
              scopeId: input.session.scopeId,
              personalOnly: input.session.personalOnly,
              input: input.input,
            });
            await f.built.sessions.recordContextProvenance(input.session.id, input.session.scopeId, {
              sources: [additionalSource],
              sensitivity: "restricted",
              sourceUnknown: false,
            });
            await input.emit({ kind: "AgentMessage", text: "Synthetic shared scheduled result" });
            return { reply: "Synthetic shared scheduled result", modelCalls: 0 };
          },
        },
      },
      exactText ? "Synthetic shared scheduled result" : undefined,
    );
    await f.built.config.setSharingPosture(f.orgScope, "open");
    const retained = await f.built.projects.create({ name: "Retained scheduled source", ownerId: "alice" });
    const additional = await f.built.projects.create({ name: "Source read during execution", ownerId: "alice" });
    await f.built.projects.addMember(retained.id, "alice", "bob");
    await f.built.projects.addMember(additional.id, "alice", "bob");
    additionalSource = projectScopeId(additional.id);
    await f.built.crons.update(f.cron.id, {
      sourceProvenance: { sources: [projectScopeId(retained.id)], sensitivity: "restricted", sourceUnknown: false },
    });
    await (await import("../src/cron/job-queue.ts")).installCronQueue(f.databaseUrl);
    f.built.runtime.start();
    f.built.scheduler.start(60_000);
    await f.built.scheduler.ready();
    t.after(() => f.built.scheduler.stop());
    await f.built.crons.update(f.cron.id, { schedule: { firstFireAt: Date.now() + 4_000 }, enabled: true });
    const selected = (await f.built.crons.get(f.cron.id))!;
    await f.built.crons.setFireNote(selected.id, {
      text: "Private history must not enter the shared task",
      at: Date.now(),
    });
    const notifications: string[] = [];
    const notify = f.built.scheduler.notifyChanged.bind(f.built.scheduler);
    t.mock.method(f.built.scheduler, "notifyChanged", (id: string) => {
      notifications.push(id);
      notify(id);
    });
    const shared = await f.built.app.publishPrivateCron(selected.id, cronSharingRevision(selected), f.target, f.claims);
    assert.deepEqual(notifications, [selected.id, shared.id]);
    let deliveries = await f.built.deliveries.pending("web");
    await settle(async () => {
      deliveries = await f.built.deliveries.pending("web");
      return deliveries.some((d) => d.destination.target === shared.destination!.target);
    });
    const sent = deliveries.filter((d) => d.destination.target === shared.destination!.target);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text, "Synthetic shared scheduled result");
    assert.equal(sent[0]!.destination.audienceScopeId, f.target);
    assert.equal((await f.built.crons.listFires(selected.id)).total, 0);
    const sharedSession = (await f.built.sessions.getByThread(shared.destination!.target))!;
    assert.equal(sharedSession.scopeId, f.target);
    assert.notEqual(sharedSession.personalOnly, true);
    assert.ok(sharedSession.sourceProvenance?.sources.includes(projectScopeId(retained.id)));
    if (!exactText) assert.ok(sharedSession.sourceProvenance?.sources.includes(additionalSource));
    assert.ok(await f.built.app.getSessionForViewer(sharedSession.id, { actorId: "bob" }));
    if (exactText) assert.equal(calls.length, 0);
    else {
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.scopeId, f.target);
      assert.notEqual(calls[0]!.personalOnly, true);
      assert.ok(!calls[0]!.input.includes("Private history must not enter"));
    }
  });

test("workbook-specific published results lose access when Team membership is revoked", async () => {
  const f = await fixture();
  const surface = "https://sheets.example.test";
  await f.built.documentConversations.configure(surface, f.projectId);
  const bound = await f.built.documentConversations.resolve({
    surface,
    documentId: "publication-workbook",
    principalId: "alice",
    mode: "shared",
  });
  assert.equal(bound.status, "ok");
  if (bound.status !== "ok") assert.fail("binding required");
  const knowledge = await f.built.documentConversations.knowledgeForSession(bound.conversation.sessionId, "alice");
  assert.ok(knowledge);
  const shared = await f.built.app.publishPrivateCron(
    f.cron.id,
    cronSharingRevision(f.cron),
    knowledge.documentScopeId,
    f.claims,
  );
  const session = (await f.built.sessions.getByThread(shared.destination!.target))!;
  assert.ok(await f.built.app.getSessionForViewer(session.id, { actorId: "bob" }));
  await f.built.projects.removeMember(f.projectId, "alice", "bob");
  assert.equal(await f.built.app.getSessionForViewer(session.id, { actorId: "bob" }), null);
});

test("a committed publication replays through the control API after pausing an enabled source", async () => {
  const f = await fixture();
  await f.built.crons.setEnabled(f.cron.id, true);
  const selected = (await f.built.crons.get(f.cron.id))!;
  const request = {
    type: "cron" as const,
    id: selected.id,
    scope: f.target,
    privateRevision: cronSharingRevision(selected),
  };
  const first = await f.control.shareArtifact(request, f.claims);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.notEqual(cronSharingRevision((await f.built.crons.get(selected.id))!), request.privateRevision);
  const second = await f.control.shareArtifact(request, f.claims);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second, first);
  assert.equal((await f.built.crons.list()).length, 2);
  assert.equal((await f.built.crons.get(selected.id))!.enabled, false);
});
