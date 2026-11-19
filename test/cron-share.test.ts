import { withCronAccess } from "../src/cron/cron-store.ts";
import { createKeyedQueue } from "../src/util/async.ts";
import type { Cron } from "../src/triggers/types.ts";
import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testTenant } from "./support/test-tenant.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import { principalDestination } from "../src/reach/reach.ts";

test("a cron shared with a person becomes their paused linked copy until they edit it", async () => {
  const { app } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cron-share-")) }));
  const source = await app.createCron({
    ownerScopeId: "personal:U1",
    owner: "U1",
    createdBy: "U1",
    title: "Weather",
    schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
    action: "weather in SF",
  });

  const { copy } = await app.shareCron(testTenant, source.id, "U2", "U1");
  assert.equal(copy.owner, "U2");
  assert.equal(copy.ownerScopeId, "personal:U2");
  assert.equal(copy.enabled, false);
  assert.equal(copy.destination?.type, "web");
  const notice = (await app.pendingDeliveries("web")).find((d) => d.destination.target === copy.destination?.target);
  assert.match(notice?.text ?? "", new RegExp(`turning cron ${copy.id} on`));
  assert.equal((await app.shareCron(testTenant, source.id, "U2", "U1")).copy.id, copy.id);

  await app.updateCron(source.id, { action: "weather in Oakland" }, { actorId: "U1" });
  assert.equal((await app.getCron(copy.id))?.action, "weather in Oakland");

  await app.updateCron(copy.id, { title: "My weather" }, { actorId: "U2" });
  await app.updateCron(source.id, { action: "weather in Berkeley" }, { actorId: "U1" });
  const forked = await app.getCron(copy.id);
  assert.ok(forked?.forkedAt);
  assert.equal(forked.action, "weather in Oakland");
  const { owned } = await app.listCronsForViewer("U1");
  assert.deepEqual(
    owned.find((c) => c.id === source.id)?.copies?.map((c) => [c.owner, c.status, c.deliversTo]),
    [["U2", "edited", "web"]],
  );
});

test("unsharing a cron detaches each copy and leaves it with its owner", async () => {
  const { app } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cron-unshare-")) }));
  const source = await app.createCron({
    ownerScopeId: "personal:U1",
    owner: "U1",
    createdBy: "U1",
    schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
    action: "weather in SF",
  });
  const paused = (await app.shareCron(testTenant, source.id, "U2", "U1")).copy;
  const accepted = (await app.shareCron(testTenant, source.id, "U3", "U1")).copy;
  await app.updateCron(accepted.id, { enabled: true }, { actorId: "U3" });

  await app.unshareCron(source.id, "U2");
  await app.unshareCron(source.id, "U3");
  assert.equal((await app.getCron(paused.id))?.sharedFrom, undefined);
  assert.equal((await app.getCron(accepted.id))?.enabled, true);
  assert.deepEqual(await app.cronCopies(source.id), []);
});

test("private source edits cannot fan out to linked recipients, and private copies detach before editing", async () => {
  const { app, sessions, crons } = buildApp(testConfig());
  await app.upsertDirectory([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "Bob", type: "internal" },
  ]);
  const source = await app.createCron({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: "personal:U1",
    schedule: { everyMs: 3_600_000 },
    action: "Ordinary source",
  });
  const { copy } = await app.shareCron(testTenant, source.id, "U2", "U1");
  const privateContext = async (owner: string) => {
    const scopeId = `personal:${owner}`;
    const session = await sessions.getOrCreateByThread(`private-linked-${owner}`, "dm", scopeId);
    await sessions.markPersonalOnly(session.id, scopeId);
    return { actorId: owner, scopeId, sessionId: session.id, privateRead: true };
  };
  const alice = await privateContext("U1");
  await assert.rejects(
    app.updateCron(source.id, { action: "PrivateLinkedSourceSpruce7301" }, alice),
    /shared schedule/,
  );
  assert.equal((await crons.get(source.id))!.action, "Ordinary source");
  assert.equal((await crons.get(copy.id))!.action, "Ordinary source");
  const bob = await privateContext("U2");
  await app.updateCron(copy.id, { action: "PrivateLinkedCopySpruce7301" }, bob);
  const personal = (await crons.get(copy.id))!;
  assert.equal(personal.personalOnly, true);
  assert.equal(personal.sharedFrom, undefined);
  assert.ok(personal.forkedAt);
  assert.deepEqual(await app.cronCopies(source.id), []);
  await app.updateCron(source.id, { action: "Later ordinary source" }, { actorId: "U1" });
  assert.equal((await crons.get(copy.id))!.action, "PrivateLinkedCopySpruce7301");
  await assert.rejects(app.shareCron(testTenant, copy.id, "U1", "U2"), /selected publication/);
});

test("linked child work waits for the source census and rechecks its root after detachment", async () => {
  const source: Cron = {
    id: "root",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: "personal:U1",
    enabled: false,
    createdAt: 1,
    schedule: { everyMs: 3_600_000 },
  };
  let child: Cron = { ...source, id: "child", sharedFrom: source.id };
  const crons = { get: async (id: string): Promise<Cron | null> => (id === source.id ? source : child) };
  const lock = { withLock: createKeyedQueue() };
  const rootEntered = Promise.withResolvers<void>(),
    rootRelease = Promise.withResolvers<void>();
  const root = withCronAccess(crons, lock, source.id, async () => {
    rootEntered.resolve();
    await rootRelease.promise;
  });
  await rootEntered.promise;
  let childEntered = false;
  const recipient = withCronAccess(crons, lock, child.id, async () => {
    childEntered = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(childEntered, false);
  child = { ...child, forkedAt: Date.now() };
  const forkEntered = Promise.withResolvers<void>(),
    forkRelease = Promise.withResolvers<void>();
  const fork = withCronAccess(crons, lock, child.id, async () => {
    forkEntered.resolve();
    await forkRelease.promise;
  });
  await forkEntered.promise;
  rootRelease.resolve();
  await root;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(childEntered, false);
  forkRelease.resolve();
  await Promise.all([fork, recipient]);
  assert.equal(childEntered, true);
});

for (const exposure of ["destination", "grant"] as const) {
  test(`linked edits authorize a recipient copy's actual ${exposure} before propagating restricted context`, async () => {
    const config = testConfig();
    const built = buildApp(config);
    await built.config.setSharingPosture(`org:${config.orgId}`, "open");
    const { app, projects, sessions, crons } = built;
    await app.upsertDirectory([
      { principalId: "U1", displayName: "Alice", type: "internal" },
      { principalId: "U2", displayName: "Bob", type: "internal" },
      { principalId: "U3", displayName: "Carol", type: "internal" },
    ]);
    const team = await projects.create({ name: "Source team", ownerId: "U1" });
    await projects.addMember(team.id, "U1", "U2");
    const outsider = await projects.create({ name: "Other team", ownerId: "U2" });
    await projects.addMember(outsider.id, "U2", "U1");
    await projects.addMember(outsider.id, "U2", "U3");
    const { projectScopeId } = await import("../src/projects/project-store.ts");
    const sourceScope = projectScopeId(team.id),
      otherScope = projectScopeId(outsider.id);
    const source = await app.createCron({
      owner: "U1",
      createdBy: "U1",
      ownerScopeId: "personal:U1",
      schedule: { everyMs: 3_600_000 },
      action: `Unrestricted source ${exposure}`,
      sourceProvenance: { sources: [], sensitivity: "ordinary", sourceUnknown: false },
    });
    const { copy } = await app.shareCron(testTenant, source.id, "U2", "U1");
    if (exposure === "destination") {
      const target = await sessions.getOrCreateByThread("linked-other-team-result", "group", otherScope);
      await app.setCronDestination(
        copy.id,
        { type: "web", target: target.threadRef, audienceScopeId: otherScope },
        { actorId: "U2" },
      );
    } else {
      const { cronRef, encodeRef } = await import("../src/acl/resource-ref.ts");
      await app.grant(testTenant, {
        ownerScopeId: copy.ownerScopeId,
        ref: encodeRef(cronRef(copy.id)),
        granteeScopeId: otherScope,
        permission: "read",
        grantedBy: "U2",
      });
    }
    const context = await sessions.getOrCreateByThread(`restricted-linked-editor-${exposure}`, "dm", "personal:U1");
    await sessions.recordContextProvenance(context.id, context.scopeId, {
      sources: [sourceScope],
      sensitivity: "restricted",
      sourceUnknown: false,
    });
    const safe = await app.createCron({
      owner: "U1",
      createdBy: "U1",
      ownerScopeId: "personal:U1",
      schedule: { everyMs: 3_600_000 },
      action: `Safe unrestricted source ${exposure}`,
      sourceProvenance: { sources: [], sensitivity: "ordinary", sourceUnknown: false },
    });
    const safeCopy = await app.shareCron(testTenant, safe.id, "U2", "U1");
    await app.updateCron(
      safe.id,
      { action: "Allowed restricted update" },
      { actorId: "U1", scopeId: context.scopeId, sessionId: context.id, privateRead: true },
    );
    assert.equal((await crons.get(safeCopy.copy.id))!.action, "Allowed restricted update");
    await assert.rejects(
      app.updateCron(
        source.id,
        { action: "RestrictedLinkedSpruce7301" },
        { actorId: "U1", scopeId: context.scopeId, sessionId: context.id, privateRead: true },
      ),
    );
    assert.equal((await crons.get(source.id))!.action, `Unrestricted source ${exposure}`);
    assert.equal((await crons.get(copy.id))!.action, `Unrestricted source ${exposure}`);
  });
}

test("shared cron invitations and recipient preparation retain the selected source provenance", async () => {
  const config = testConfig();
  const built = buildApp(config);
  await built.config.setSharingPosture(`org:${config.orgId}`, "open");
  const { app, projects, sessions, deliveries } = built;
  await app.upsertDirectory([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "Bob", type: "internal" },
  ]);
  const project = await projects.create({ name: "Invitation source", ownerId: "U1" });
  await projects.addMember(project.id, "U1", "U2");
  const { projectScopeId } = await import("../src/projects/project-store.ts");
  const sourceProvenance = {
    sources: [projectScopeId(project.id)],
    sensitivity: "restricted" as const,
    sourceUnknown: false,
  };
  const source = await app.createCron({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: "personal:U1",
    schedule: { everyMs: 3_600_000 },
    action: "Scoped invitation",
    sourceProvenance,
  });
  const { copy } = await app.shareCron(testTenant, source.id, "U2", "U1");
  assert.deepEqual(copy.sourceProvenance, sourceProvenance);
  const invitation = (await deliveries.pending("principal")).find(
    (delivery) => delivery.idempotencyKey === `cron-shared:${copy.id}`,
  )!;
  assert.deepEqual(invitation.provenance?.contextProvenance, sourceProvenance);
  await app.preparePrincipalDelivery(invitation.id, "dm:invitation-recipient");
  assert.ok(
    (await sessions.getByThread("dm:invitation-recipient"))!.sourceProvenance?.sources.includes(
      sourceProvenance.sources[0]!,
    ),
  );
  assert.equal((await deliveries.get(invitation.id))!.deliveredAt, null);
});

test("a copy of a project cron keeps its persona and project, and the persona's owner lends it to the recipient", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cron-share-origin-")) }));
  const { app } = built;
  for (const who of ["U1", "U2"]) await built.featureFlags.setEnabled("personas", `personal:${who}`, true, "admin");
  const project = (await app.createProject("U1", "Launch"))!;
  const persona = await app.personas!.create("U1", { name: "Ada" });
  assert.equal(persona.status, "ok");
  const personaId = (persona as { value: { id: string } }).value.id;
  const { session } = (await app.spawnSession("U1", { scopeId: projectScopeId(project.id), title: "Launch" }))!;
  await built.sessions.setPersona(session.id, personaId);
  const source = await app.createCron({
    ownerScopeId: projectScopeId(project.id),
    owner: "U1",
    createdBy: "U1",
    sessionRef: session.threadRef,
    destination: principalDestination("U1", "U1"),
    schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
    action: "launch status",
  });

  const { copy, note } = await app.shareCron(testTenant, source.id, "U2", "U1");
  assert.match(note ?? "", /posts as the persona Ada: they now have read access/);
  assert.equal(await app.personas!.role("U2", personaId), "read");
  assert.deepEqual(await app.cronOrigin(copy), { personaId, project: { id: project.id, name: "Launch" } });
});
