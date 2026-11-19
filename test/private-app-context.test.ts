import { createArtifactDisclosure } from "../src/memory/artifact-disclosure.ts";
import { createCurrentScopeMembers, createIsCurrentSharedScopeMember } from "../src/resolution/scope-membership.ts";
import { createServer as createHttpServer } from "node:http";
import { mintCapabilityToken, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createServer } from "../src/api/server.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { verifyDeployGitAccess, mintDeployGitAccess } from "../src/deploy/access-token.ts";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { testMap } from "./support/test-database.ts";
import { testTenant } from "./support/test-tenant.ts";
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
import { testDeployBackings } from "./support/test-database.ts";

async function fixture(
  options: { port?: number; logs?: () => Promise<string>; liveEdit?: true; sharingPosture?: "open" | "isolated" } = {},
) {
  const ownerScopeId = scopeId("personal", "alice");
  const backings = testDeployBackings();
  const databaseUrl = backings.databaseUrl;
  const lock = createPostgresAdvisoryLock(backings.pg);
  const sessions = createPostgresSessionStore(databaseUrl);
  const session = await sessions.getOrCreateByThread("private-app", "dm", ownerScopeId);
  const deployStore = createDeployStore(backings);
  const acl = createAclStore(createPostgresGrantStore(databaseUrl));
  let applied = 0;
  const directory = createPostgresDirectoryStore(databaseUrl);
  const identity = createIdentityService(testMap(), { externalMembers: testMap() });
  const deps = {
    discloseApp: createArtifactDisclosure({
      classify: identity.classify,
      orgScopeId: "org:test",
      config: { resolveSharingPostureDurable: async () => options.sharingPosture ?? "isolated" },
      currentScopeMembers: createCurrentScopeMembers({ directory, identity }, true),
      isCurrentSharedScopeMember: createIsCurrentSharedScopeMember({ directory, identity }),
    }),
    ...singleProcessDeps(),
    advisoryLock: lock,
    sessions,
    deployStore,
    acl,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => {
        applied++;
        return { host: "127.0.0.1", port: options.port ?? 5000 };
      },
      destroy: async () => {},
      ...(options.liveEdit ? { liveEdit: async () => true } : {}),
      ...(options.logs ? { logs: options.logs } : {}),
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "private-app-")),
  };
  const service = () => createDeployService(deps);
  const app = createApp({
    deploy: service(),
    auditLog: deps.auditLog,
    acl,
    sessions,
    directory,
    identity,
  } as unknown as Parameters<typeof createApp>[0]);
  return {
    app,
    databaseUrl,
    directory,
    lock,
    ownerScopeId,
    sessions,
    session,
    deployStore,
    service,
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
  const app = await f.service().deployOrUpdate({ ...f.input, name: "private-app", context: f.context() });
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
  await f
    .service()
    .deployOrUpdate({ ...f.input, name: "private-renamed", renameFrom: "private-app", context: f.context() });
  await f.service().deployOrUpdate({ ...f.input, name: "private-renamed", rollbackTo: 1, context: f.context() });
  assert.equal((await f.service().getApp(app.id))!.personalOnly, true);
  assert.equal(f.applied(), 4);
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
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "ordinary",
    sources: [f.ownerScopeId],
    sourceUnknown: false,
  });
  const app = await service.deployOrUpdate({ ...f.input, name: "callback-app", context: f.context() });
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

test("an owner's shared conversation cannot list, fetch, log or clone their private app", async () => {
  const f = await fixture();
  await f.sessions.markPersonalOnly(f.session.id, f.ownerScopeId);
  const d = await f.service().deploy({ ...f.input, context: f.context() });
  const session = await f.sessions.getOrCreateByThread("shared-app-reader", "channel", "channel:team");
  const caller = { actorId: "alice", scopeId: session.scopeId, sessionId: session.id };
  assert.deepEqual(await f.app.listAppsForViewer(testTenant, caller), []);
  assert.equal(await f.app.appGitPermissionFor(d.id, caller), null);
  assert.equal(
    await f.app.appGitUrlFor(d.id, caller, { secret: "private-app-secret", baseUrl: "http://core.test" }),
    null,
  );
  assert.equal((await f.app.reachApp(d.id, caller)).status, "denied");
  assert.equal((await f.app.reachApp(d.id, caller, { bypassAcl: true })).status, "denied");
  assert.equal((await f.app.appLogsFor(d.id, caller, { tailLines: 10 })).status, "denied");
  const files = createAppFiles({
    deploy: f.service(),
    app: d.id,
    actorId: "alice",
    actingScopeId: session.scopeId,
    context: () => caller,
  });
  assert.equal(await files.sourceReader(), undefined);
  await assert.rejects(files.source(["server.js"]), /write access/);
  assert.notEqual((await f.sessions.get(session.id))!.personalOnly, true);
});

test("reading a private app in another personal conversation persists its privacy and provenance", async () => {
  const f = await fixture();
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "restricted",
    sources: ["group:restricted"],
    sourceUnknown: true,
    personalOnly: true,
  });
  const d = await f.service().deploy({ ...f.input, context: f.context() });
  const session = await f.sessions.getOrCreateByThread("personal-app-reader", "dm", f.ownerScopeId);
  const caller = { actorId: "alice", scopeId: f.ownerScopeId, sessionId: session.id };
  assert.deepEqual(
    (await f.app.listAppsForViewer(testTenant, caller)).map((app) => app.id),
    [d.id],
  );
  const persisted = (await f.sessions.get(session.id))!;
  assert.equal(persisted.personalOnly, true);
  assert.ok(persisted.sourceProvenance?.sources.includes("group:restricted"));
  assert.equal(persisted.sourceProvenance?.sourceUnknown, true);
  assert.equal(persisted.sourceProvenance?.sensitivity, "restricted");
  const files = createAppFiles({
    deploy: f.service(),
    app: d.id,
    actorId: "alice",
    actingScopeId: f.ownerScopeId,
    context: () => caller,
  });
  assert.equal(Buffer.from((await files.source(["server.js"])).files[0]!.data).toString(), "original");
  assert.equal((await f.app.reachApp(d.id, { actorId: "bob" })).status, "denied");
});

test("Git credentials recheck a conversation's audience after a previously ordinary app becomes private", async () => {
  const f = await fixture();
  const d = await f.service().deploy({ ...f.input, name: "git-context" });
  const shared = await f.sessions.getOrCreateByThread("shared-git-origin", "channel", "channel:team");
  const context = { actorId: "alice", scopeId: shared.scopeId, sessionId: shared.id };
  const secret = "git-private-context-test-secret-0123456789";
  const link = await f.app.appGitUrlFor(d.id, context, { secret, baseUrl: "http://core.test" });
  assert.ok(link);
  const files = createAppFiles({
    deploy: f.service(),
    app: d.id,
    actorId: "alice",
    actingScopeId: shared.scopeId,
    context: () => context,
  });
  const capturedReader = await files.sourceReader();
  assert.ok(capturedReader);
  const token = decodeURIComponent(new URL(link.url).password);
  const access = await verifyDeployGitAccess(secret, token);
  assert.deepEqual(access?.context, { scopeId: shared.scopeId, sessionId: shared.id });
  const server = createServer(f.app, {
    signingSecret: secret,
    replayDedupe: createPostgresReplayDedupe(f.databaseUrl),
  });
  server.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (token: string, service = "git-upload-pack") =>
    fetch(`${base}/v1/apps/${d.id}/git/info/refs?service=${service}`, {
      headers: { authorization: "Basic " + Buffer.from("app:" + token).toString("base64") },
    });
  try {
    assert.equal((await request(token)).status, 200);
    await f.sessions.markPersonalOnly(f.session.id, f.ownerScopeId);
    await f.service().redeploy(d.id, {
      ...f.input,
      context: f.context(),
      files: [{ path: "server.js", data: "private Git content" }],
    });
    assert.equal((await request(token)).status, 403);
    const updated = (await f.service().getApp(d.id))!;
    const privateCommit = updated.versions.find((version) => version.version === updated.currentVersion)!.commit;
    await assert.rejects(capturedReader.source(["server.js"], privateCommit), /source access is no longer available/);
    const unbound = await mintDeployGitAccess(secret, {
      deploymentId: d.id,
      principalId: "alice",
      permission: "read",
      exp: Date.now() + 60_000,
    });
    assert.equal((await request(unbound)).status, 403);
    const own = await f.app.appGitUrlFor(d.id, f.context(), { secret, baseUrl: base });
    assert.ok(own);
    assert.equal((await request(decodeURIComponent(new URL(own.url).password))).status, 200);
    assert.equal((await f.sessions.get(shared.id))!.personalOnly, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a Git push cannot use stale personal context to change an app already shared with another user", async () => {
  const f = await fixture();
  const service = f.service();
  const d = await service.deploy({ ...f.input });
  await service.shareApp(d.id, "personal:bob", "read", { createdBy: "alice" }, { notify: false });
  const context = f.context();
  await f.sessions.markPersonalOnly(f.session.id, f.ownerScopeId);
  let accepted = false;
  await assert.rejects(
    f.app.runAppGitPush(d.id, context, async () => {
      accepted = true;
      return { result: "pushed", ok: true };
    }),
    /cannot update a shared app/,
  );
  assert.equal(accepted, false);
  assert.equal(Buffer.from((await service.source(d.id, ["server.js"]))!.files[0]!.data).toString(), "original");
});

test("a failed source-edit callback inherits the private app before any source is returned", async () => {
  const f = await fixture();
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "restricted",
    sources: ["group:restricted"],
    sourceUnknown: true,
    personalOnly: true,
  });
  const d = await f.service().deploy({ ...f.input, context: f.context() });
  const reader = await f.sessions.getOrCreateByThread("edit-private-source", "dm", f.ownerScopeId);
  await assert.rejects(
    f.service().editSource(d.id, { actorId: "alice", scopeId: f.ownerScopeId, sessionId: reader.id }, async (read) => {
      assert.equal(Buffer.from((await read(["server.js"])).files[0]!.data).toString(), "original");
      const context = (await f.sessions.get(reader.id))!;
      assert.equal(context.personalOnly, true);
      assert.equal(context.sourceProvenance?.sensitivity, "restricted");
      assert.ok(context.sourceProvenance?.sources.includes("group:restricted"));
      throw new Error("edit preparation failed");
    }),
    /edit preparation failed/,
  );
  assert.equal((await f.sessions.get(reader.id))!.personalOnly, true);
  assert.equal((await f.service().getApp(d.id))!.currentVersion, 1);
});

test("log retrieval excludes a concurrent private redeploy until its authorized response is captured", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let output = "ordinary log";
  const f = await fixture({
    logs: async () => {
      entered.resolve();
      await release.promise;
      return output;
    },
  });
  const service = f.service();
  const d = await service.deploy(f.input);
  const reader = await f.sessions.getOrCreateByThread("shared-log-reader", "channel", "channel:team");
  const reading = f.app.appLogsFor(
    d.id,
    { actorId: "alice", scopeId: reader.scopeId, sessionId: reader.id },
    { tailLines: 10 },
  );
  await entered.promise;
  await f.sessions.markPersonalOnly(f.session.id, f.ownerScopeId);
  try {
    await f.lock.tryWithLock(`deploy:${d.id}`, async () => {
      await service.redeploy(d.id, { ...f.input, context: f.context() });
      output = "private log";
    });
  } finally {
    release.resolve();
  }
  assert.deepEqual(await reading, { status: "ok", logs: "ordinary log" });
  await service.redeploy(d.id, { ...f.input, context: f.context() });
  assert.equal(
    (
      await f.app.appLogsFor(
        d.id,
        { actorId: "alice", scopeId: reader.scopeId, sessionId: reader.id },
        { tailLines: 10 },
      )
    ).status,
    "denied",
  );
});

test("an agent preview withholds content when the app becomes private while the response is in flight", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const upstream = createHttpServer(async (_req, res) => {
    entered.resolve();
    await release.promise;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("private preview content");
  });
  await new Promise<void>((resolve) => upstream.listen(0, resolve));
  const f = await fixture({ port: (upstream.address() as AddressInfo).port });
  const d = await f.service().deploy({ ...f.input, name: "preview-alias" });
  await f.directory.replaceChannels(
    [{ channelId: "team", name: "team", isPrivate: true }],
    [{ channelId: "team", principalId: "alice" }],
  );
  const reader = await f.sessions.getOrCreateByThread("preview-shared-reader", "channel", "channel:team");
  const secret = "preview-private-context-secret-0123456789";
  const server = createServer(f.app, {
    signingSecret: secret,
    replayDedupe: createPostgresReplayDedupe(f.databaseUrl),
  });
  server.listen(0);
  try {
    const token = await mintCapabilityToken(
      {
        actorId: "alice",
        scopeId: reader.scopeId,
        sessionId: reader.id,
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + 60_000,
      },
      secret,
    );
    const response = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/apps/${d.name}/fetch`, {
      headers: { "x-agent-capability": token },
    });
    await Promise.race([
      entered.promise,
      response.then(async (early) => {
        throw new Error(`Preview did not reach upstream: ${early.status} ${await early.clone().text()}`);
      }),
    ]);
    await f.sessions.markPersonalOnly(f.session.id, f.ownerScopeId);
    await f.service().redeploy(d.id, { ...f.input, context: f.context() });
    await f.service().renameApp(d.id, "private-preview-renamed", f.context());
    await f.service().deploy({ ...f.input, name: "preview-alias" });
    release.resolve();
    const result = await response;
    assert.equal(result.status, 404);
    assert.deepEqual(await result.json(), { error: "not_found" });
    assert.equal((await f.sessions.get(reader.id))!.personalOnly, undefined);
  } finally {
    release.resolve();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("private management responses taint a fresh personal session before a subsequent shared write", async () => {
  const f = await fixture();
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "restricted",
    sources: ["group:restricted"],
    sourceUnknown: true,
    personalOnly: true,
  });
  const d = await f.service().deploy({ ...f.input, context: f.context(), env: { PRIVATE_NOTE: "private metadata" } });
  const shared = await f.service().deploy({ ...f.input, name: "shared-management-target" });
  await f.service().shareApp(shared.id, "personal:bob", "read", { createdBy: "alice" }, { notify: false });
  const reader = await f.sessions.getOrCreateByThread("private-management-reader", "dm", f.ownerScopeId);
  const context = { actorId: "alice", scopeId: f.ownerScopeId, sessionId: reader.id };
  const secret = "management-private-context-secret-0123456789";
  const server = createServer(f.app, {
    signingSecret: secret,
    replayDedupe: createPostgresReplayDedupe(f.databaseUrl),
  });
  server.listen(0);
  try {
    const token = await mintCapabilityToken({ ...context, aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 }, secret);
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/apps/${d.id}/name`, {
      method: "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      body: JSON.stringify({ name: "private-managed" }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(
      ((await response.json()) as { app: { versions: Array<{ env: { PRIVATE_NOTE: string } }> } }).app.versions[0]!.env
        .PRIVATE_NOTE,
      "private metadata",
    );
    const persisted = (await f.sessions.get(reader.id))!;
    assert.equal(persisted.personalOnly, true);
    assert.equal(persisted.sourceProvenance?.sensitivity, "restricted");
    assert.ok(persisted.sourceProvenance?.sources.includes("group:restricted"));
    await assert.rejects(f.service().redeploy(shared.id, { ...f.input, context }), /cannot update a shared app/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("selected private app sharing preserves the app and private conversation while granting only the approved audience", async () => {
  const f = await fixture();
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "ordinary",
    sources: [f.ownerScopeId],
    sourceUnknown: false,
    personalOnly: true,
  });
  const original = await f.service().deployOrUpdate({ ...f.input, context: f.context() });
  const { createControlService } = await import("../src/api/control-service.ts");
  const control = createControlService(f.app, {} as Parameters<typeof createControlService>[1]);
  const claims = { ...f.context(), threadRef: f.session.threadRef, liveActor: true, exp: Date.now() + 60_000 };
  const request = { type: "deploy" as const, id: original.id, scope: "personal:bob", notify: false };
  const preflight = await control.shareArtifact(request, claims);
  assert.equal(preflight.ok, false);
  if (preflight.ok) assert.fail("private sharing must first request approval");
  assert.deepEqual(preflight.privateRelease, {
    id: original.id,
    revision: (await f.app.getArtifactHome("deploy", original.id))!.privateRevision,
    scope: "personal:bob",
  });
  assert.deepEqual(await f.service().appGrantees(original.id), []);
  const result = await control.shareArtifact(
    { ...request, privateRevision: preflight.privateRelease!.revision },
    claims,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const saved = (await f.service().getApp(original.id))!;
  assert.equal(saved.personalOnly, undefined);
  assert.equal(saved.id, original.id);
  assert.deepEqual(saved.versions, original.versions);
  assert.deepEqual(saved.endpoint, original.endpoint);
  assert.equal(f.applied(), 1);
  assert.deepEqual(await f.service().appGrantees(original.id), [{ scope: "personal:bob", permission: "read" }]);
  assert.equal((await f.sessions.get(f.session.id))!.personalOnly, true);
  assert.deepEqual(saved.sourceProvenance, {
    sensitivity: "ordinary",
    sources: [],
    sourceUnknown: false,
  });
});

test("private app release refuses stale revisions, shared conversation and restricted sources without granting access", async () => {
  const f = await fixture();
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "restricted",
    sources: ["group:restricted"],
    sourceUnknown: false,
    personalOnly: true,
  });
  const original = await f.service().deployOrUpdate({ ...f.input, context: f.context() });
  const { createControlService } = await import("../src/api/control-service.ts");
  const control = createControlService(f.app, {} as Parameters<typeof createControlService>[1]);
  const claims = { ...f.context(), threadRef: f.session.threadRef, liveActor: true, exp: Date.now() + 60_000 };
  const revision = (await f.app.getArtifactHome("deploy", original.id))!.privateRevision!;
  const request = {
    type: "deploy" as const,
    id: original.id,
    scope: "personal:bob",
    privateRevision: revision,
    notify: false,
  };
  const refused = await control.shareArtifact(request, claims);
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.message : "", /source restrictions/);
  const shared = await f.sessions.getOrCreateByThread("release-shared", "channel", "channel:other");
  assert.equal(
    (
      await control.shareArtifact(
        { ...request, privateRevision: undefined },
        {
          ...claims,
          scopeId: shared.scopeId,
          sessionId: shared.id,
        },
      )
    ).ok,
    false,
  );
  await f.service().setAppDisplayName(original.id, "Changed after approval", f.context());
  const stale = await control.shareArtifact(request, claims);
  assert.equal(stale.ok, false);
  assert.match(!stale.ok ? stale.message : "", /changed/);
  assert.deepEqual(await f.service().appGrantees(original.id), []);
  assert.equal((await f.service().getApp(original.id))!.personalOnly, true);
});

test("a live private edit invalidates the selected sharing revision without publishing a new version", async () => {
  const f = await fixture({ liveEdit: true });
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "ordinary",
    sources: [f.ownerScopeId],
    sourceUnknown: false,
    personalOnly: true,
  });
  const app = await f.service().deployOrUpdate({ ...f.input, context: f.context() });
  const selected = (await f.app.getArtifactHome("deploy", app.id))!;
  const edit = await f.service().editSource(app.id, f.context(), async () => ({
    files: [{ path: "server.js", data: "changed private source" }],
    deletedPaths: [],
  }));
  assert.ok(edit.liveEdit);
  assert.equal((await f.service().getApp(app.id))!.currentVersion, app.currentVersion);
  const current = (await f.app.getArtifactHome("deploy", app.id))!;
  assert.notEqual(current.privateRevision, selected.privateRevision);
  await assert.rejects(
    f.service().releasePrivateApp(
      {
        ownerScopeId: f.ownerScopeId,
        ref: selected.grantRef,
        granteeScopeId: "personal:bob",
        permission: "read",
        grantedBy: "alice",
      },
      selected.privateRevision!,
      f.context(),
    ),
    /changed after approval/,
  );
  assert.deepEqual(await f.service().appGrantees(app.id), []);
  assert.equal((await f.service().getApp(app.id))!.personalOnly, true);
});

test("a failed private release cannot expose a later edit to a stranded earlier grantee", async () => {
  const f = await fixture();
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "ordinary",
    sources: [f.ownerScopeId],
    sourceUnknown: false,
    personalOnly: true,
  });
  const app = await f.service().deployOrUpdate({ ...f.input, context: f.context() });
  const releaseContext = f.deployStore.releaseContext;
  f.deployStore.releaseContext = async () => {
    throw new Error("injected release write failure");
  };
  const selected = (await f.app.getArtifactHome("deploy", app.id))!;
  const grant = {
    ownerScopeId: f.ownerScopeId,
    ref: selected.grantRef,
    granteeScopeId: "personal:bob",
    permission: "read" as const,
    grantedBy: "alice",
  };
  await assert.rejects(
    f.service().releasePrivateApp(grant, selected.privateRevision!, f.context()),
    /injected release write failure/,
  );
  f.deployStore.releaseContext = releaseContext;
  await f.service().editSource(app.id, "alice", async () => ({
    files: [{ path: "server.js", data: "later private edit" }],
    deletedPaths: [],
  }));
  const latest = (await f.app.getArtifactHome("deploy", app.id))!;
  await assert.rejects(
    f.service().releasePrivateApp({ ...grant, granteeScopeId: "personal:carol" }, latest.privateRevision!, f.context()),
    /pending grants/,
  );
  assert.equal((await f.service().getApp(app.id))!.personalOnly, true);
  assert.deepEqual(await f.service().appGrantees(app.id), [{ scope: "personal:bob", permission: "read" }]);
  const denied = await f.app.reachApp(app.id, "bob");
  assert.equal(denied.status, "denied");
});

test("released app source restrictions still constrain later grants, public access and ownership transfer", async () => {
  const f = await fixture();
  await f.directory.replace([
    { principalId: "alice", displayName: "Alice", type: "internal" },
    { principalId: "bob", displayName: "Bob", type: "internal" },
    { principalId: "carol", displayName: "Carol", type: "internal" },
  ]);
  await f.directory.upsertGroup("restricted", ["alice", "bob"], "web");
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "restricted",
    sources: ["group:restricted"],
    sourceUnknown: false,
    personalOnly: true,
  });
  const app = await f.service().deployOrUpdate({ ...f.input, context: f.context() });
  const home = (await f.app.getArtifactHome("deploy", app.id))!;
  const grant = {
    ownerScopeId: f.ownerScopeId,
    ref: home.grantRef,
    granteeScopeId: "group:restricted",
    permission: "read" as const,
    grantedBy: "alice",
  };
  await f.service().releasePrivateApp(grant, home.privateRevision!, f.context());
  await assert.rejects(
    f.service().shareApp(app.id, "personal:carol", "read", { createdBy: "alice" }, { notify: false }),
    /source restrictions/,
  );
  await assert.rejects(
    f.service().grantAppAccess({ ...grant, granteeScopeId: "personal:carol" }),
    /source restrictions/,
  );
  await assert.rejects(
    f.service().setAppPublic(app.id, true, { createdBy: "alice", personAtKeyboard: true }),
    /source restrictions/,
  );
  await assert.rejects(
    f.service().transferAppOwner(app.id, "personal:carol", { callerId: "alice" }),
    /source restrictions/,
  );
  assert.deepEqual(await f.service().appGrantees(app.id), [{ scope: "group:restricted", permission: "read" }]);
  assert.deepEqual((await f.service().getApp(app.id))!.sourceProvenance, {
    sensitivity: "restricted",
    sources: ["group:restricted"],
    sourceUnknown: false,
  });
});

test("private release respects a foreign source's sharing posture even for an entitled recipient", async () => {
  for (const sharingPosture of ["isolated", "open"] as const) {
    const f = await fixture({ sharingPosture });
    await f.directory.replace([
      { principalId: "alice", displayName: "Alice", type: "internal" },
      { principalId: "bob", displayName: "Bob", type: "internal" },
    ]);
    await f.directory.upsertGroup("foreign", ["alice", "bob"], "web");
    await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
      sensitivity: "restricted",
      sources: ["group:foreign"],
      sourceUnknown: false,
      personalOnly: true,
    });
    const app = await f.service().deployOrUpdate({ ...f.input, context: f.context() });
    const home = (await f.app.getArtifactHome("deploy", app.id))!;
    const release = () =>
      f.service().releasePrivateApp(
        {
          ownerScopeId: f.ownerScopeId,
          ref: home.grantRef,
          granteeScopeId: "personal:bob",
          permission: "read",
          grantedBy: "alice",
        },
        home.privateRevision!,
        f.context(),
      );
    if (sharingPosture === "isolated") {
      await assert.rejects(release(), /source restrictions/);
      assert.equal((await f.service().getApp(app.id))!.personalOnly, true);
      assert.deepEqual(await f.service().appGrantees(app.id), []);
    } else {
      await release();
      assert.equal((await f.service().getApp(app.id))!.personalOnly, undefined);
      assert.deepEqual(await f.service().appGrantees(app.id), [{ scope: "personal:bob", permission: "read" }]);
    }
  }
});

test("new restricted context cannot update an app already released to an unentitled recipient", async () => {
  const f = await fixture();
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "ordinary",
    sources: [f.ownerScopeId],
    sourceUnknown: false,
    personalOnly: true,
  });
  const app = await f.service().deployOrUpdate({ ...f.input, context: f.context() });
  const home = (await f.app.getArtifactHome("deploy", app.id))!;
  await f.service().releasePrivateApp(
    {
      ownerScopeId: f.ownerScopeId,
      ref: home.grantRef,
      granteeScopeId: "personal:bob",
      permission: "read",
      grantedBy: "alice",
    },
    home.privateRevision!,
    f.context(),
  );
  const before = (await f.service().getApp(app.id))!;
  const session = await f.sessions.getOrCreateByThread("restricted-edit", "dm", f.ownerScopeId);
  await f.sessions.recordContextProvenance(session.id, f.ownerScopeId, {
    sensitivity: "restricted",
    sources: ["group:restricted"],
    sourceUnknown: false,
  });
  let edited = false;
  await assert.rejects(
    f.service().editSource(app.id, { actorId: "alice", scopeId: f.ownerScopeId, sessionId: session.id }, async () => {
      edited = true;
      return { files: [{ path: "server.js", data: "restricted content" }], deletedPaths: [] };
    }),
    /source restrictions/,
  );
  assert.equal(edited, false);
  const after = (await f.service().getApp(app.id))!;
  assert.deepEqual(after.versions, before.versions);
  assert.deepEqual(after.sourceProvenance, before.sourceProvenance);
  assert.equal(f.applied(), 1);
});

test("creation refuses an automatic audience before granting or running restricted content", async () => {
  const f = await fixture();
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "restricted",
    sources: ["group:restricted"],
    sourceUnknown: false,
  });
  await assert.rejects(
    f.service().deployOrUpdate({ ...f.input, createdInScope: "channel:elsewhere", context: f.context() }),
    /audience could not be verified|source restrictions/,
  );
  assert.deepEqual(await f.service().listApps(), []);
  assert.equal(f.applied(), 0);
  const { allGrants } = await import("./support/acl-grants.ts");
  assert.deepEqual(await allGrants(f.databaseUrl), []);
});

test("a private app cannot be released through a grant to its owner", async () => {
  const f = await fixture();
  await f.sessions.recordContextProvenance(f.session.id, f.ownerScopeId, {
    sensitivity: "ordinary",
    sources: [f.ownerScopeId],
    sourceUnknown: false,
    personalOnly: true,
  });
  const app = await f.service().deployOrUpdate({ ...f.input, context: f.context() });
  const home = (await f.app.getArtifactHome("deploy", app.id))!;
  await assert.rejects(
    f.service().releasePrivateApp(
      {
        ownerScopeId: f.ownerScopeId,
        ref: home.grantRef,
        granteeScopeId: f.ownerScopeId,
        permission: "read",
        grantedBy: "alice",
      },
      home.privateRevision!,
      f.context(),
    ),
    /already personal/,
  );
  assert.equal((await f.service().getApp(app.id))!.personalOnly, true);
  assert.deepEqual(await f.service().appGrantees(app.id), []);
});
