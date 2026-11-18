import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createAppFiles } from "../src/tools/app-files.ts";
import { scopeId } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testDeployBackings, testDatabaseUrl } from "./support/test-database.ts";

async function fixture() {
  const ownerScopeId = scopeId("personal", "alice");
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread("private-app", "dm", ownerScopeId);
  const deployStore = createDeployStore(testDeployBackings());
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  let applied = 0;
  const deps = {
    ...singleProcessDeps(),
    sessions,
    deployStore,
    acl,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => {
        applied++;
        return { host: "127.0.0.1", port: 5000 };
      },
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "private-app-")),
  };
  return {
    ownerScopeId,
    sessions,
    session,
    deployStore,
    service: () => createDeployService(deps),
    context: () => ({ actorId: "alice", scopeId: ownerScopeId, sessionId: session.id }),
    input: {
      ownerScopeId,
      createdBy: "alice",
      entrypoint: "node server.js",
      files: [{ path: "server.js", data: "original" }],
    },
    applied: () => applied,
  };
}

test("private app creation persists provenance and cannot widen its audience", async () => {
  const f = await fixture();
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "restricted",
    sources: ["group:restricted"],
    sourceUnknown: true,
    personalOnly: true,
  });
  const app = await f.service().deployOrUpdate({ ...f.input, context: f.context() });
  const recovered = (await f.service().getApp(app.id))!;
  assert.equal(recovered.personalOnly, true);
  assert.deepEqual(recovered.sourceProvenance, {
    sensitivity: "restricted",
    sources: ["group:restricted"],
    sourceUnknown: true,
  });
  assert.deepEqual(await f.service().appGrantees(app.id), []);
  assert.equal(recovered.public, undefined);
  await assert.rejects(f.service().shareApp(app.id, "personal:bob", "read", { createdBy: "alice" }), /explicitly/);
  await assert.rejects(
    f.service().setAppPublic(app.id, true, { createdBy: "alice", personAtKeyboard: true }),
    /explicitly/,
  );
  await assert.rejects(f.service().transferAppOwner(app.id, "personal:bob", { callerId: "alice" }), /explicitly/);
  await assert.rejects(
    f.service().deploy({ ...f.input, ownerScopeId: "group:team", context: f.context() }),
    /personal scope/,
  );
  await assert.rejects(
    f.service().deploy({ ...f.input, createdInScope: "channel:team", context: f.context() }),
    /personal scope/,
  );
  await f
    .service()
    .redeploy(app.id, { ...f.input, context: f.context(), files: [{ path: "server.js", data: "personal revision" }] });
  assert.equal((await f.service().getApp(app.id))!.personalOnly, true);
  assert.equal(
    Buffer.from((await f.service().source(app.id, ["server.js"]))!.files[0]!.data).toString(),
    "personal revision",
  );
  assert.equal(f.applied(), 2);
});

test("a late private read cannot overwrite an app already shared with another person", async () => {
  const f = await fixture();
  const service = f.service();
  const app = await service.deployOrUpdate({ ...f.input, name: "shared-app" });
  await service.shareApp(app.id, "personal:bob", "read", { createdBy: "alice" }, { notify: false });
  const context = f.context();
  const files = createAppFiles({
    deploy: service,
    app: app.id,
    actorId: "alice",
    actingScopeId: f.ownerScopeId,
    context: () => context,
  });
  await f.sessions.markPersonalOnly(f.session.id, f.ownerScopeId);
  await assert.rejects(
    service.deployOrUpdate({
      ...f.input,
      name: "shared-app",
      context,
      files: [{ path: "server.js", data: "private content" }],
    }),
    /cannot update a shared app/,
  );
  await assert.rejects(
    files.save(async () => ({ files: [{ path: "server.js", data: "private source edit" }], deletedPaths: [] })),
    /cannot update a shared app/,
  );
  const source = await service.source(app.id, ["server.js"]);
  assert.equal(Buffer.from(source!.files[0]!.data).toString(), "original");
  assert.equal((await service.getApp(app.id))!.currentVersion, 1);
  assert.equal(f.applied(), 1);
});

test("revoking an automatic grant does not remove the app's implicit creation-scope audience", async () => {
  const f = await fixture();
  const service = f.service();
  const app = await service.deploy({ ...f.input, createdInScope: "channel:team" });
  await service.shareApp(app.id, "channel:team", null, { createdBy: "alice" }, { notify: false });
  assert.deepEqual(await service.appGrantees(app.id), []);
  await f.sessions.markPersonalOnly(f.session.id, f.ownerScopeId);
  await assert.rejects(service.redeploy(app.id, { ...f.input, context: f.context() }), /cannot update a shared app/);
  assert.equal(f.applied(), 1);
});

test("source edits recheck privacy after preparation and private publish cannot roll back a shared app", async () => {
  const f = await fixture();
  const service = f.service();
  const app = await service.deployOrUpdate({ ...f.input, name: "callback-app" });
  await service.shareApp(app.id, "personal:bob", "read", { createdBy: "alice" }, { notify: false });
  await assert.rejects(
    createAppFiles({
      deploy: service,
      app: app.id,
      actorId: "alice",
      actingScopeId: f.ownerScopeId,
      context: f.context,
    }).save(async () => {
      await f.sessions.markPersonalOnly(f.session.id, f.ownerScopeId);
      return { files: [{ path: "server.js", data: "late private" }], deletedPaths: [] };
    }),
    /cannot update a shared app/,
  );
  await assert.rejects(
    service.deployOrUpdate({ ...f.input, name: "callback-app", rollbackTo: 1, context: f.context() }),
    /cannot update a shared app/,
  );
  assert.equal(Buffer.from((await service.source(app.id, ["server.js"]))!.files[0]!.data).toString(), "original");
  assert.equal(f.applied(), 1);
});
