import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createDocumentConversations, type DocumentRecord } from "../src/documents/conversations.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import { testMap } from "./support/test-database.ts";

const surface = "https://sheets.example.test";

test("document bindings share team conversations, isolate private conversations, and survive service recreation", async () => {
  const built = buildApp(testConfig());
  try {
    const project = await built.projects.create({ name: "Operations", ownerId: "owner" });
    await built.projects.addMember(project.id, "owner", "member");
    const backing = testMap<DocumentRecord>();
    const create = () => createDocumentConversations({ backing, projects: built.projects, sessions: built.sessions });
    const service = create();
    assert.equal(await service.configure(surface, project.id), true);
    const resolve = (principalId: string, mode?: "private" | "shared", documentId = "document-a") =>
      create().resolve({ surface, documentId, principalId, ...(mode ? { mode } : {}) });
    const shared = await Promise.all([resolve("owner"), resolve("member"), resolve("owner")]);
    for (const result of shared) {
      assert.equal(result.status, "ok");
      if (result.status !== "ok") throw new Error("missing document binding");
      assert.deepEqual(result, shared[0]);
      assert.equal(result.conversation.scopeId, projectScopeId(project.id));
    }
    const owner = await resolve("owner", "private");
    const member = await resolve("member", "private");
    assert.equal(owner.status, "ok");
    assert.equal(member.status, "ok");
    if (owner.status !== "ok" || member.status !== "ok") throw new Error("missing private binding");
    assert.equal(owner.conversation.scopeId, "personal:owner");
    assert.equal(member.conversation.scopeId, "personal:member");
    assert.notEqual(owner.conversation.threadRef, member.conversation.threadRef);
    assert.deepEqual(await resolve("owner"), owner);
    const otherTeam = await built.projects.create({ name: "Another team", ownerId: "owner" });
    await service.configure(surface, otherTeam.id);
    const remapped = await resolve("owner");
    assert.equal(remapped.status, "ok");
    if (remapped.status !== "ok") throw new Error("missing private binding after remapping");
    assert.equal(remapped.conversation.mode, "private");
    await service.configure(surface, project.id);
    assert.deepEqual(await resolve("member"), member);
    assert.equal(await built.app.getSessionForViewer(owner.conversation.sessionId, { actorId: "member" }), null);
    assert.deepEqual(await resolve("owner", "shared"), shared[0]);
    const otherDocument = await resolve("owner", undefined, "document-b");
    assert.equal(otherDocument.status, "ok");
    if (otherDocument.status !== "ok" || shared[0]?.status !== "ok") throw new Error("missing shared binding");
    assert.notEqual(otherDocument.conversation.threadRef, shared[0].conversation.threadRef);
    assert.equal(otherDocument.conversation.scopeId, shared[0].conversation.scopeId);
  } finally {
    await built.runtime.stop();
  }
});

test("document resolution refuses unknown surfaces, outsiders, and removed members even with saved private preferences", async () => {
  const built = buildApp(testConfig());
  try {
    const project = await built.projects.create({ name: "Operations", ownerId: "owner" });
    const input = { surface, documentId: "document-a", principalId: "member" };
    assert.deepEqual(await built.documentConversations.resolve(input), { status: "unconfigured" });
    await built.documentConversations.configure(surface, project.id);
    assert.deepEqual(await built.documentConversations.resolve(input), { status: "forbidden" });
    await built.projects.addMember(project.id, "owner", "member");
    assert.equal((await built.documentConversations.resolve({ ...input, mode: "private" })).status, "ok");
    await built.projects.removeMember(project.id, "owner", "member");
    assert.deepEqual(await built.documentConversations.resolve(input), { status: "forbidden" });
  } finally {
    await built.runtime.stop();
  }
});

test("document HTTP routes enforce signed identity and admin configuration rather than client identity claims", async () => {
  const { createServer } = await import("../src/api/server.ts");
  const { serverDeps } = await import("../src/wiring.ts");
  const { signedRequestHeaders } = await import("../plugins/chassis/src/source-auth-sign.ts");
  const { mintPortalIdentity } = await import("../src/auth/portal-identity.ts");
  const config = testConfig({
    signingSecret: "document-source-secret-long-enough-for-ingress",
    portalIdentitySecret: "document-identity-secret-distinct-from-source",
  });
  const built = buildApp(config);
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const request = async (path: string, principal: string, body: unknown, method = "POST", impersonator?: string) => {
    const target = `${path}?nonce=${crypto.randomUUID()}`;
    const raw = JSON.stringify(body);
    return fetch(`http://127.0.0.1:${port}${target}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...signedRequestHeaders(config.signingSecret!, method, target, raw),
        "x-portal-identity": await mintPortalIdentity(
          { p: principal, ...(impersonator ? { imp: impersonator } : {}), exp: Date.now() + 60_000 },
          config.portalIdentitySecret!,
        ),
      },
      body: raw,
    });
  };
  try {
    const project = await built.projects.create({ name: "Operations", ownerId: "owner" });
    const settings = { surface, projectId: project.id };
    assert.equal((await request("/v1/admin/documents/surface", "owner", settings, "PUT")).status, 403);
    assert.equal(
      (await request("/v1/admin/documents/surface", "admin-alice", settings, "PUT", "admin-bob")).status,
      403,
    );
    assert.equal((await request("/v1/admin/documents/surface", "admin-alice", settings, "PUT")).status, 200);
    const input = { surface, documentId: "document-a", mode: "private", principalId: "owner" };
    assert.equal((await request("/v1/web/documents/resolve", "member", input)).status, 403);
    const resolved = await request("/v1/web/documents/resolve", "owner", { ...input, principalId: "member" });
    assert.equal(resolved.status, 200);
    const result = (await resolved.json()) as { conversation: { scopeId: string } };
    assert.equal(result.conversation.scopeId, "personal:owner");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});

test("adopting an existing document preserves its audience and thread while new documents use the configured team", async () => {
  const built = buildApp(testConfig());
  try {
    const original = await built.projects.create({ name: "Existing document", ownerId: "owner" });
    const team = await built.projects.create({ name: "Team", ownerId: "owner" });
    await built.projects.addMember(team.id, "owner", "member");
    await built.documentConversations.configure(surface, team.id);
    const old = await built.sessions.getOrCreateByThread(
      "web:owner:existing-document",
      "group",
      projectScopeId(original.id),
    );
    const previous = { scopeId: old.scopeId, threadRef: old.threadRef };
    const input = { surface, documentId: "existing", principalId: "owner", previous };
    assert.deepEqual(await built.documentConversations.resolve({ ...input, principalId: "member" }), {
      status: "forbidden",
    });
    const adopted = await built.documentConversations.resolve(input);
    assert.equal(adopted.status, "ok");
    if (adopted.status !== "ok") throw new Error("missing adopted binding");
    assert.equal(adopted.conversation.sessionId, old.id);
    assert.equal(adopted.conversation.scopeId, old.scopeId);
    const originalKnowledge = await built.documentConversations.knowledgeForSession(old.id, "owner");
    const separate = await built.documentConversations.resolve({ ...input, documentId: "independent-copy" });
    assert.equal(separate.status, "ok");
    if (separate.status !== "ok") throw new Error("missing separate conversation");
    assert.notEqual(separate.conversation.sessionId, old.id);
    assert.deepEqual(await built.documentConversations.knowledgeForSession(old.id, "owner"), originalKnowledge);
    assert.notEqual(
      (await built.documentConversations.knowledgeForSession(separate.conversation.sessionId, "owner"))?.documentKey,
      originalKnowledge?.documentKey,
    );
    assert.deepEqual(
      await built.documentConversations.resolve({ surface, documentId: "existing", principalId: "member" }),
      { status: "forbidden" },
    );
    const fresh = await built.documentConversations.resolve({ surface, documentId: "fresh", principalId: "member" });
    assert.equal(fresh.status, "ok");
    if (fresh.status !== "ok") throw new Error("missing fresh binding");
    assert.equal(fresh.conversation.scopeId, projectScopeId(team.id));
    const personal = await built.sessions.getOrCreateByThread("web:owner:personal", "dm", "personal:owner");
    assert.deepEqual(
      await built.documentConversations.resolve({
        ...input,
        documentId: "forged",
        previous: { scopeId: old.scopeId, threadRef: personal.threadRef },
      }),
      { status: "forbidden" },
    );
  } finally {
    await built.runtime.stop();
  }
});
