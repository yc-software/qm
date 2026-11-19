import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { skillSharingRevision } from "../src/skills/skill-store.ts";
import { createControlService } from "../src/api/control-service.ts";
import { testTenant } from "./support/test-tenant.ts";

async function fixture(admin = false) {
  const config = testConfig(admin ? { adminGrants: "alice:org_admin" } : {});
  const built = buildApp(config);
  const session = await built.sessions.getOrCreateByThread("private-skill-release", "dm", "personal:alice");
  const provenance = { sensitivity: "ordinary" as const, sources: [session.scopeId], sourceUnknown: false };
  await built.sessions.recordContextProvenance(session.id, session.scopeId, { ...provenance, personalOnly: true });
  const created = await built.skills.create({
    scopeId: session.scopeId,
    createdBy: "alice",
    personalOnly: true,
    sourceProvenance: provenance,
    manifest: {
      name: "private-procedure",
      description: "Selected procedure",
      body: "Use this selected procedure.",
      requiredCapabilities: [],
      files: [{ path: "references/checklist.txt", content: "Selected appendix" }],
    },
  });
  await built.skills.review(created.id, "alice", []);
  const skill = await built.skills.publish(created.id);
  const claims = {
    privateRead: true,
    actorId: "alice",
    scopeId: session.scopeId,
    sessionId: session.id,
    threadRef: session.threadRef,
    liveActor: true,
    exp: Date.now() + 60_000,
  };
  const request = { type: "skill" as const, id: skill.id, scope: "personal:bob" };
  const grant = {
    ownerScopeId: session.scopeId,
    ref: `skill:${skill.id}`,
    granteeScopeId: "personal:bob",
    permission: "read" as const,
    grantedBy: "alice",
  };
  return {
    built,
    session,
    skill,
    claims,
    request,
    grant,
    control: createControlService(built.app, built.scheduler),
    databaseUrl: config.databaseUrl!,
    orgScope: `org:${config.orgId}`,
  };
}

test("selected private skill release preserves manifest, signature and review state", async () => {
  const f = await fixture();
  const preflight = await f.control.shareArtifact(f.request, f.claims);
  assert.equal(preflight.ok, false);
  if (preflight.ok) assert.fail("approval required");
  assert.equal(preflight.privateRelease?.revision, skillSharingRevision(f.skill));
  const released = await f.control.shareArtifact(
    { ...f.request, privateRevision: preflight.privateRelease!.revision },
    f.claims,
  );
  assert.equal(released.ok, true, JSON.stringify(released));
  const saved = (await f.built.skills.get(f.skill.id))!;
  assert.equal(saved.personalOnly, undefined);
  for (const key of [
    "id",
    "scopeId",
    "manifest",
    "signature",
    "version",
    "status",
    "approvals",
    "grantedCapabilities",
  ] as const)
    assert.deepEqual(saved[key], f.skill[key]);
  assert.equal(f.built.skills.verify(saved), true);
  assert.deepEqual(await f.built.acl.grantsFor(testTenant, f.session.scopeId, f.grant.ref), [f.grant]);
  assert.ok(
    (await f.built.app.listVisibleSkills("bob", false, "personal:bob")).some((row) => row.skill?.id === f.skill.id),
  );
  assert.equal((await f.built.sessions.get(f.session.id))!.personalOnly, true);
});

test("private skill release rolls back its grant and privacy together", async () => {
  const f = await fixture();
  const write = await f.built.acl.preparePrivateGrant(testTenant, f.grant, "alice");
  await assert.rejects(
    f.built.skills.releasePrivate(
      f.skill.id,
      skillSharingRevision(f.skill),
      f.skill.sourceProvenance!,
      async (transaction) => {
        await write(transaction);
        throw new Error("injected skill release failure");
      },
    ),
    /injected skill release failure/,
  );
  assert.equal((await f.built.skills.get(f.skill.id))!.personalOnly, true);
  assert.deepEqual(await f.built.acl.grantsFor(testTenant, f.session.scopeId, f.grant.ref), []);
});

test("manifest changes invalidate private skill approval while use telemetry does not", async () => {
  const f = await fixture();
  const revision = skillSharingRevision(f.skill);
  await f.built.skills.recordUse(f.skill.id);
  assert.equal(skillSharingRevision((await f.built.skills.get(f.skill.id))!), revision);
  await f.built.skills.update(f.skill.id, {
    ...f.skill.manifest,
    files: [{ path: "references/checklist.txt", content: "Changed appendix" }],
  });
  const refused = await f.control.shareArtifact({ ...f.request, privateRevision: revision }, f.claims);
  assert.equal(refused.ok, false);
  assert.deepEqual(await f.built.acl.grantsFor(testTenant, f.session.scopeId, f.grant.ref), []);
  assert.equal((await f.built.skills.get(f.skill.id))!.personalOnly, true);
});

test("a private edit waiting on the name lock cannot modify a skill after release", async () => {
  const f = await fixture();
  const lock = f.built.skills.withNameLock;
  let entered!: () => void;
  let proceed!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  f.built.skills.withNameLock = async (scope, name, fn) => {
    entered();
    await resume;
    return lock(scope, name, fn);
  };
  const editing = f.built.app.updateOwnedSkill(
    f.skill.id,
    "alice",
    { body: "New private material" },
    { personalOnly: true, contextScopeId: f.session.scopeId, liveActor: true },
  );
  await waiting;
  try {
    const released = await f.control.shareArtifact(
      { ...f.request, privateRevision: skillSharingRevision(f.skill) },
      f.claims,
    );
    assert.equal(released.ok, true, JSON.stringify(released));
  } finally {
    proceed();
    f.built.skills.withNameLock = lock;
  }
  assert.equal(await editing, "private_context");
  assert.deepEqual((await f.built.skills.get(f.skill.id))!.manifest, f.skill.manifest);
});

test("private skill release works without a spare query-pool connection", async () => {
  const f = await fixture();
  const { createPgPool } = await import("../src/persistence/pg-pool.ts");
  const db = createPgPool(f.databaseUrl);
  const pool = await db.pool();
  const held = [];
  try {
    for (let n = 1; n < pool.options.max!; n++) held.push(await pool.connect());
    await f.built.app.grant(testTenant, f.grant, { privateRevision: skillSharingRevision(f.skill), context: f.claims });
  } finally {
    for (const client of held) client.release();
    await db.close();
  }
  assert.equal((await f.built.skills.get(f.skill.id))!.personalOnly, undefined);
});

test("a non-admin private skill approval cannot bypass organization promotion authority", async () => {
  const f = await fixture();
  const result = await f.control.shareArtifact(
    { ...f.request, scope: "org:acme", privateRevision: skillSharingRevision(f.skill) },
    f.claims,
  );
  assert.equal(result.ok, false);
  assert.equal((await f.built.skills.get(f.skill.id))!.personalOnly, true);
  assert.deepEqual(await f.built.acl.grantsFor(testTenant, f.session.scopeId, f.grant.ref), []);
});

for (const late of [false, true])
  test(`restricted source ${late ? "acquired while waiting" : "present before editing"} cannot reach existing skill readers`, async () => {
    const f = await fixture();
    assert.equal(
      (await f.control.shareArtifact({ ...f.request, privateRevision: skillSharingRevision(f.skill) }, f.claims)).ok,
      true,
    );
    const before = (await f.built.skills.get(f.skill.id))!;
    const session = await f.built.sessions.getOrCreateByThread("restricted-skill-editor", "dm", f.session.scopeId);
    const project = await f.built.projects.create({ name: "Restricted source", ownerId: "alice" });
    const { projectScopeId } = await import("../src/projects/project-store.ts");
    const restrict = () =>
      f.built.sessions.recordContextProvenance(session.id, session.scopeId, {
        sensitivity: "restricted",
        sources: [projectScopeId(project.id)],
        sourceUnknown: false,
      });
    const lock = f.built.skills.withNameLock;
    let entered!: () => void;
    let proceed!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    if (late)
      f.built.skills.withNameLock = async (scope, name, fn) => {
        entered();
        await resume;
        return lock(scope, name, fn);
      };
    else await restrict();
    const editing = f.built.app.updateOwnedSkill(
      f.skill.id,
      "alice",
      { body: "Restricted new material" },
      {
        liveActor: true,
        contextScopeId: session.scopeId,
        context: { actorId: "alice", scopeId: session.scopeId, sessionId: session.id },
      },
    );
    if (late) {
      await waiting;
      await restrict();
      proceed();
      f.built.skills.withNameLock = lock;
    }
    await assert.rejects(editing, /source restrictions/);
    const saved = (await f.built.skills.get(f.skill.id))!;
    assert.deepEqual(saved.manifest, before.manifest);
    assert.equal(saved.version, before.version);
    assert.deepEqual(saved.sourceProvenance, before.sourceProvenance);
  });

test("an org admin can approve a known personal skill without transferring its ownership", async () => {
  const f = await fixture(true);
  const result = await f.control.shareArtifact(
    { ...f.request, scope: f.orgScope, privateRevision: skillSharingRevision(f.skill) },
    f.claims,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const saved = (await f.built.skills.get(f.skill.id))!;
  assert.equal(saved.scopeId, f.skill.scopeId);
  assert.equal(saved.personalOnly, undefined);
  assert.deepEqual(saved.manifest, f.skill.manifest);
  assert.deepEqual(
    (await f.built.acl.grantsFor(testTenant, f.skill.scopeId, f.grant.ref)).map((g) => g.granteeScopeId),
    [f.orgScope],
  );
});

test("released skill restrictions survive moves, org promotion and shared copies", async () => {
  const f = await fixture(true);
  const { projectScopeId } = await import("../src/projects/project-store.ts");
  const source = await f.built.projects.create({ name: "Restricted skill source", ownerId: "alice" });
  const target = await f.built.projects.create({ name: "Other audience", ownerId: "alice" });
  const sourceScope = projectScopeId(source.id),
    targetScope = projectScopeId(target.id);
  await f.built.skills.update(f.skill.id, f.skill.manifest, {
    sensitivity: "restricted",
    sources: [sourceScope],
    sourceUnknown: false,
  });
  const selected = (await f.built.skills.get(f.skill.id))!;
  assert.equal(
    (
      await f.control.shareArtifact(
        { ...f.request, scope: sourceScope, privateRevision: skillSharingRevision(selected) },
        f.claims,
      )
    ).ok,
    true,
  );
  await assert.rejects(f.built.app.moveArtifactHome("skill", selected.id, targetScope, "alice"), /source restrictions/);
  await assert.rejects(
    f.built.app.promoteSkill(selected.id, f.orgScope, "alice", true),
    /source restrictions|audience could not be verified/,
  );
  await assert.rejects(
    f.built.app.createOwnedSkill({
      principalId: "alice",
      homeScope: targetScope,
      name: "foreign-copy",
      description: "Copy",
      body: selected.manifest.body,
      sourceProvenance: (await f.built.skills.get(selected.id))!.sourceProvenance,
    }),
    /source restrictions/,
  );
  assert.equal((await f.built.skills.get(selected.id))!.scopeId, f.skill.scopeId);
  assert.equal((await f.built.skills.list()).length, 1);
});

for (const operation of ["move", "promote"] as const)
  test(`a skill change after ${operation} policy validation cannot bypass the selected source snapshot`, async () => {
    const f = await fixture(true);
    assert.equal(
      (await f.control.shareArtifact({ ...f.request, privateRevision: skillSharingRevision(f.skill) }, f.claims)).ok,
      true,
    );
    const { projectScopeId } = await import("../src/projects/project-store.ts");
    const target = await f.built.projects.create({ name: "Snapshot target", ownerId: "alice" });
    let entered!: () => void, proceed!: () => void;
    const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      resume = new Promise<void>((resolve) => {
        proceed = resolve;
      });
    const original = f.built.skills[operation];
    f.built.skills[operation] = async (id, scope, revision) => {
      entered();
      await resume;
      return original(id, scope, revision);
    };
    const publishing =
      operation === "move"
        ? f.built.app.moveArtifactHome("skill", f.skill.id, projectScopeId(target.id), "alice")
        : f.built.app.promoteSkill(f.skill.id, f.orgScope, "alice", true);
    await waiting;
    await f.built.skills.update(f.skill.id, { ...f.skill.manifest, body: "Changed after policy validation" });
    proceed();
    f.built.skills[operation] = original;
    await assert.rejects(publishing, /changed before/);
    assert.equal((await f.built.skills.get(f.skill.id))!.scopeId, f.skill.scopeId);
    assert.equal((await f.built.skills.list()).length, 1);
  });

test("a tampered private skill cannot be shared even with its current metadata revision", async () => {
  const f = await fixture();
  await f.built.skills.restore({ ...f.skill, manifest: { ...f.skill.manifest, body: "Tampered without a signature" } });
  const selected = (await f.built.skills.get(f.skill.id))!;
  const result = await f.control.shareArtifact(
    { ...f.request, privateRevision: skillSharingRevision(selected) },
    f.claims,
  );
  assert.equal(result.ok, false);
  assert.equal((await f.built.skills.get(selected.id))!.personalOnly, true);
  assert.deepEqual(await f.built.acl.grantsFor(testTenant, f.session.scopeId, f.grant.ref), []);
});

for (const operation of ["grant", "replace"] as const)
  test(`a concurrent skill ${operation} cannot add an unvalidated reader to an edit`, async () => {
    const f = await fixture();
    assert.equal(
      (await f.control.shareArtifact({ ...f.request, privateRevision: skillSharingRevision(f.skill) }, f.claims)).ok,
      true,
    );
    await f.built.acl.revoke(testTenant, f.skill.scopeId, f.grant.ref, "personal:bob", "alice");
    const session = await f.built.sessions.getOrCreateByThread("reader-race-editor", "dm", f.session.scopeId);
    const source = await f.built.projects.create({ name: "Reader race source", ownerId: "alice" });
    const { projectScopeId } = await import("../src/projects/project-store.ts");
    await f.built.sessions.recordContextProvenance(session.id, session.scopeId, {
      sensitivity: "restricted",
      sources: [projectScopeId(source.id)],
      sourceUnknown: false,
    });
    let editingReady!: () => void, continueEdit!: () => void, grantWaiting!: () => void;
    const paused = new Promise<void>((resolve) => {
        editingReady = resolve;
      }),
      resume = new Promise<void>((resolve) => {
        continueEdit = resolve;
      }),
      waiting = new Promise<void>((resolve) => {
        grantWaiting = resolve;
      });
    const update = f.built.skills.update,
      lock = f.built.skills.withNameLock;
    f.built.skills.update = async (...args) => {
      editingReady();
      await resume;
      return update(...args);
    };
    const editing = f.built.app
      .updateOwnedSkill(
        f.skill.id,
        "alice",
        { body: "Restricted after audience check" },
        {
          liveActor: true,
          contextScopeId: session.scopeId,
          context: { actorId: "alice", scopeId: session.scopeId, sessionId: session.id },
        },
      )
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
    await paused;
    f.built.skills.withNameLock = async (scope, name, fn) => {
      grantWaiting();
      return lock(scope, name, fn);
    };
    const granting = (
      operation === "grant"
        ? f.built.acl.grant(testTenant, f.grant)
        : f.built.acl.replaceGrantsIfCurrent(testTenant, f.skill.scopeId, f.grant.ref, [], [f.grant], "alice")
    ).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    try {
      await Promise.race([waiting, granting]);
    } finally {
      continueEdit();
      f.built.skills.update = update;
      f.built.skills.withNameLock = lock;
    }
    await Promise.all([editing, granting]);
    const saved = (await f.built.skills.get(f.skill.id))!;
    const readers = await f.built.acl.grantsFor(testTenant, f.skill.scopeId, f.grant.ref);
    assert.equal(
      saved.manifest.body === "Restricted after audience check" &&
        readers.some((g) => g.granteeScopeId === "personal:bob"),
      false,
    );
  });

test("a move after edit validation cannot change the edit's publication scope", async () => {
  const f = await fixture();
  assert.equal(
    (await f.control.shareArtifact({ ...f.request, privateRevision: skillSharingRevision(f.skill) }, f.claims)).ok,
    true,
  );
  await f.built.acl.revoke(testTenant, f.skill.scopeId, f.grant.ref, "personal:bob", "alice");
  const session = await f.built.sessions.getOrCreateByThread("move-race-editor", "dm", f.session.scopeId);
  const source = await f.built.projects.create({ name: "Edit source", ownerId: "alice" }),
    target = await f.built.projects.create({ name: "New publication scope", ownerId: "alice" });
  const { projectScopeId } = await import("../src/projects/project-store.ts");
  await f.built.sessions.recordContextProvenance(session.id, session.scopeId, {
    sensitivity: "restricted",
    sources: [projectScopeId(source.id)],
    sourceUnknown: false,
  });
  let entered!: () => void, proceed!: () => void;
  const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    resume = new Promise<void>((resolve) => {
      proceed = resolve;
    });
  const update = f.built.skills.update;
  f.built.skills.update = async (...args) => {
    entered();
    await resume;
    return update(...args);
  };
  const editing = f.built.app.updateOwnedSkill(
    f.skill.id,
    "alice",
    { body: "Restricted pending edit" },
    {
      liveActor: true,
      contextScopeId: session.scopeId,
      context: { actorId: "alice", scopeId: session.scopeId, sessionId: session.id },
    },
  );
  await waiting;
  try {
    await assert.rejects(
      f.built.app.moveArtifactHome("skill", f.skill.id, projectScopeId(target.id), "alice"),
      /being changed/,
    );
  } finally {
    proceed();
    f.built.skills.update = update;
  }
  await editing;
  const saved = (await f.built.skills.get(f.skill.id))!;
  assert.equal(saved.scopeId, f.skill.scopeId);
  assert.equal(saved.manifest.body, "Restricted pending edit");
});

test("moving a skill back cannot reactivate readers excluded from its new sources", async () => {
  const f = await fixture();
  assert.equal(
    (await f.control.shareArtifact({ ...f.request, privateRevision: skillSharingRevision(f.skill) }, f.claims)).ok,
    true,
  );
  const project = await f.built.projects.create({ name: "Restricted working home", ownerId: "alice" });
  const { projectScopeId } = await import("../src/projects/project-store.ts");
  const home = projectScopeId(project.id);
  await f.built.app.moveArtifactHome("skill", f.skill.id, home, "alice");
  const session = await f.built.sessions.getOrCreateByThread("restricted-moved-skill", "dm", home);
  await f.built.sessions.recordContextProvenance(session.id, home, {
    sensitivity: "restricted",
    sources: [home],
    sourceUnknown: false,
  });
  await f.built.app.updateOwnedSkill(
    f.skill.id,
    "alice",
    { body: "Restricted working material" },
    { liveActor: true, contextScopeId: home, context: { actorId: "alice", scopeId: home, sessionId: session.id } },
  );
  await assert.rejects(f.built.app.moveArtifactHome("skill", f.skill.id, f.skill.scopeId, "alice"));
  assert.equal((await f.built.skills.get(f.skill.id))!.scopeId, home);
  assert.equal(
    (await f.built.app.listVisibleSkills("bob", false, "personal:bob")).some((row) => row.skill?.id === f.skill.id),
    false,
  );
});
