import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { fileSharingRevision } from "../src/files/file-artifact-store.ts";
import { testTenant } from "./support/test-tenant.ts";

async function fixture(owner = "alice") {
  const config = testConfig();
  const built = buildApp(config);
  const session = await built.sessions.getOrCreateByThread("private-file-release", "dm", `personal:${owner}`);
  await built.sessions.recordContextProvenance(session.id, session.scopeId, {
    sensitivity: "ordinary",
    sources: [session.scopeId],
    sourceUnknown: false,
    personalOnly: true,
  });
  const { artifact } = await built.files.put({
    id: "selected-file",
    ownerScopeId: session.scopeId,
    createdBy: owner,
    name: "selected.txt",
    path: "selected.txt",
    mimetype: "text/plain",
    direction: "out",
    data: Buffer.from("Selected private bytes"),
    contextSessionIds: [session.id],
  });
  const grant = {
    ownerScopeId: session.scopeId,
    ref: artifact.id,
    granteeScopeId: "personal:bob",
    permission: "read" as const,
    grantedBy: owner,
  };
  return { built, artifact, grant, session, databaseUrl: config.databaseUrl! };
}

test("private file release commits the selected bytes and grant together", async () => {
  const { built, artifact, grant, session } = await fixture();
  const writeGrant = await built.acl.preparePrivateGrant(testTenant, grant, "alice");
  const published = await built.files.releasePrivate(
    artifact.id,
    fileSharingRevision(artifact),
    { ...artifact.sourceProvenance!, sources: [] },
    writeGrant,
  );
  assert.equal(published.personalOnly, undefined);
  assert.equal(published.blobKey, artifact.blobKey);
  assert.equal(published.sha256, artifact.sha256);
  assert.deepEqual(await built.acl.grantsFor(testTenant, artifact.ownerScopeId, artifact.id), [grant]);
  const opened = (await built.files.open(artifact.id))!;
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "Selected private bytes");
  assert.equal((await built.sessions.get(session.id))!.personalOnly, true);
});

test("a failed private file release rolls its grant back and remains private", async () => {
  const { built, artifact, grant } = await fixture();
  const writeGrant = await built.acl.preparePrivateGrant(testTenant, grant, "alice");
  await assert.rejects(
    built.files.releasePrivate(
      artifact.id,
      fileSharingRevision(artifact),
      artifact.sourceProvenance!,
      async (transaction) => {
        await writeGrant(transaction);
        throw new Error("injected failure after grant write");
      },
    ),
    /injected failure/,
  );
  assert.equal((await built.files.get(artifact.id))!.personalOnly, true);
  assert.deepEqual(await built.acl.grantsFor(testTenant, artifact.ownerScopeId, artifact.id), []);
});

test("a stale private file selection cannot write a grant", async () => {
  const { built, artifact } = await fixture();
  let committed = false;
  await built.files.setEnabled(artifact.id, false);
  await assert.rejects(
    built.files.releasePrivate(artifact.id, fileSharingRevision(artifact), artifact.sourceProvenance!, async () => {
      committed = true;
    }),
    /changed after approval/,
  );
  assert.equal(committed, false);
  assert.equal((await built.files.get(artifact.id, { includeDisabled: true }))!.personalOnly, true);
});

test("native file sharing preflight binds the selected file and preserves private history", async () => {
  const { built, artifact, session } = await fixture();
  const { createControlService } = await import("../src/api/control-service.ts");
  const control = createControlService(built.app, built.scheduler);
  const claims = {
    privateRead: true,
    actorId: "alice",
    scopeId: session.scopeId,
    sessionId: session.id,
    threadRef: session.threadRef,
    liveActor: true,
    exp: Date.now() + 60_000,
  };
  const request = { type: "file" as const, id: artifact.id, scope: "personal:bob" };
  const preflight = await control.shareArtifact(request, claims);
  assert.equal(preflight.ok, false);
  if (preflight.ok) assert.fail("private output requires approval");
  assert.deepEqual(preflight.privateRelease, {
    id: artifact.id,
    scope: "personal:bob",
    revision: fileSharingRevision(artifact),
  });
  assert.deepEqual(await built.acl.grantsFor(testTenant, session.scopeId, artifact.id), []);
  assert.equal(await built.app.openFileForViewer(testTenant, artifact.id, "bob", false), null);
  const other = await built.sessions.getOrCreateByThread("private-file-shared-reader", "channel", "channel:other");
  for (const caller of [
    { ...claims, scopeId: other.scopeId, sessionId: other.id, personalOnly: undefined },
    { ...claims, liveActor: false },
    { ...claims, actorId: "bob" },
  ]) {
    const refused = await control.shareArtifact({ ...request, privateRevision: fileSharingRevision(artifact) }, caller);
    assert.equal(refused.ok, false);
  }
  assert.deepEqual(await built.acl.grantsFor(testTenant, session.scopeId, artifact.id), []);
  assert.notEqual((await built.sessions.get(other.id))!.personalOnly, true);
  assert.equal(
    await built.app.openFileForViewer(testTenant, artifact.id, "alice", false, {
      actorId: "alice",
      scopeId: other.scopeId,
      sessionId: other.id,
    }),
    null,
  );
  const result = await control.shareArtifact(
    { ...request, privateRevision: preflight.privateRelease!.revision },
    claims,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const opened = await built.app.openFileForViewer(testTenant, artifact.id, "bob", false);
  assert.ok(opened);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "Selected private bytes");
  assert.equal((await built.sessions.get(session.id))!.personalOnly, true);
});

test("released file foreign-source restrictions also gate raw grants and grant replacement", async () => {
  const { built, session } = await fixture();
  await built.app.upsertDirectory([
    { principalId: "alice", displayName: "Alice", type: "internal" },
    { principalId: "bob", displayName: "Bob", type: "internal" },
    { principalId: "carol", displayName: "Carol", type: "internal" },
  ]);
  const project = await built.projects.create({ name: "Source team", ownerId: "alice" });
  await built.projects.addMember(project.id, "alice", "bob");
  const { projectScopeId } = await import("../src/projects/project-store.ts");
  const scope = projectScopeId(project.id);
  await built.sessions.recordContextProvenance(session.id, session.scopeId, {
    sensitivity: "restricted",
    sources: [scope],
    sourceUnknown: false,
    personalOnly: true,
  });
  const { artifact } = await built.files.put({
    id: "foreign-source-file",
    ownerScopeId: session.scopeId,
    createdBy: "alice",
    name: "restricted.txt",
    path: "restricted.txt",
    mimetype: "text/plain",
    direction: "out",
    data: Buffer.from("Restricted output"),
    contextSessionIds: [session.id],
  });
  const grant = {
    ownerScopeId: session.scopeId,
    ref: artifact.id,
    granteeScopeId: scope,
    permission: "read" as const,
    grantedBy: "alice",
  };
  await built.app.grant(testTenant, grant, {
    privateRevision: fileSharingRevision(artifact),
    context: { privateRead: true, actorId: "alice", scopeId: session.scopeId, sessionId: session.id },
  });
  const outsider = { ...grant, granteeScopeId: "personal:carol" };
  const { createControlService } = await import("../src/api/control-service.ts");
  const refused = await createControlService(built.app, built.scheduler).shareArtifact(
    { type: "file", id: artifact.id, scope: "personal:carol" },
    {
      actorId: "alice",
      scopeId: session.scopeId,
      sessionId: session.id,
      threadRef: session.threadRef,
      liveActor: true,
      exp: Date.now() + 60_000,
    },
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "forbidden");
  await assert.rejects(built.acl.grant(testTenant, outsider), /source restrictions/);
  await assert.rejects(
    built.acl.replaceGrantsIfCurrent(testTenant, session.scopeId, artifact.id, [grant], [grant, outsider], "alice"),
    /source restrictions/,
  );
  assert.deepEqual(await built.acl.grantsFor(testTenant, session.scopeId, artifact.id), [grant]);
  assert.deepEqual((await built.files.get(artifact.id))!.sourceProvenance, {
    sensitivity: "restricted",
    sources: [scope],
    sourceUnknown: false,
  });
});

test("private file release finishes with only one query-pool connection available", async () => {
  const { built, artifact, grant, session, databaseUrl } = await fixture();
  const { createPgPool } = await import("../src/persistence/pg-pool.ts");
  const db = createPgPool(databaseUrl);
  const pool = await db.pool();
  const held = [];
  try {
    for (let n = 1; n < pool.options.max!; n++) held.push(await pool.connect());
    await built.app.grant(testTenant, grant, {
      privateRevision: fileSharingRevision(artifact),
      context: { privateRead: true, actorId: "alice", scopeId: session.scopeId, sessionId: session.id },
    });
  } finally {
    for (const client of held) client.release();
    await db.close();
  }
  assert.equal((await built.files.get(artifact.id))!.personalOnly, undefined);
  assert.deepEqual(await built.acl.grantsFor(testTenant, artifact.ownerScopeId, artifact.id), [grant]);
});

test("a private file release cannot activate grants added after authorization", async () => {
  const { built, artifact, grant, databaseUrl } = await fixture();
  const writeGrant = await built.acl.preparePrivateGrant(testTenant, grant, "alice");
  const { createPostgresGrantStore } = await import("../src/acl/postgres-grant-store.ts");
  const outsider = { ...grant, granteeScopeId: "personal:carol" };
  await createPostgresGrantStore(databaseUrl).put(testTenant, outsider);
  await assert.rejects(
    built.files.releasePrivate(artifact.id, fileSharingRevision(artifact), artifact.sourceProvenance!, writeGrant),
    /access changed after approval/,
  );
  assert.equal((await built.files.get(artifact.id))!.personalOnly, true);
  assert.deepEqual(await built.acl.grantsFor(testTenant, artifact.ownerScopeId, artifact.id), [outsider]);
  await assert.rejects(built.acl.preparePrivateGrant(testTenant, grant, "alice"), /already has grants/);
});

test("sharing a private output with its owner cannot remove the private boundary", async () => {
  const { built, artifact, grant, session } = await fixture();
  const { createControlService } = await import("../src/api/control-service.ts");
  const result = await createControlService(built.app, built.scheduler).shareArtifact(
    { type: "file", id: artifact.id, scope: artifact.ownerScopeId },
    {
      actorId: "alice",
      scopeId: session.scopeId,
      sessionId: session.id,
      threadRef: session.threadRef,
      liveActor: true,
      exp: Date.now() + 60_000,
    },
  );
  assert.equal(result.ok, false);
  await assert.rejects(
    built.acl.preparePrivateGrant(testTenant, { ...grant, granteeScopeId: artifact.ownerScopeId }, "alice"),
    /already personal/,
  );
  assert.equal((await built.files.get(artifact.id))!.personalOnly, true);
  assert.deepEqual(await built.acl.grantsFor(testTenant, artifact.ownerScopeId, artifact.id), []);
});

test("an equivalent personal email scope is also a self-share", async () => {
  const actorId = "alice@example.test";
  const { built, artifact, grant, session } = await fixture(actorId);
  const scope = "personal:ALICE@EXAMPLE.TEST";
  const { createControlService } = await import("../src/api/control-service.ts");
  const result = await createControlService(built.app, built.scheduler).shareArtifact(
    { type: "file", id: artifact.id, scope },
    {
      actorId,
      scopeId: session.scopeId,
      sessionId: session.id,
      threadRef: session.threadRef,
      liveActor: true,
      exp: Date.now() + 60_000,
    },
  );
  assert.equal(result.ok, false);
  await assert.rejects(
    built.acl.preparePrivateGrant(testTenant, { ...grant, granteeScopeId: scope }, actorId),
    /already personal/,
  );
  assert.equal((await built.files.get(artifact.id))!.personalOnly, true);
});
