import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore, type AclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore, type DirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createCanReadScope, createCanWriteScope } from "../src/resolution/scope-membership.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "deploy-createdin-secret".repeat(3);
const CH = "CBUILT";
const CH_OTHER = "CSHARED";

async function fixture() {
  const deployStore = createDeployStore({ git: { repoRoot: mkdtempSync(join(tmpdir(), "createdin-repo-")) } });
  const acl: AclStore = createAclStore();
  const directory: DirectoryStore = createDirectoryStore();
  const sessions = createMemorySessionStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 19997 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "createdin-deploy-")),
    canReadScope: createCanReadScope({ directory }),
    canWriteScope: createCanWriteScope({ directory }),
  });
  const app = createApp({
    deploy,
    acl,
    directory,
    sessions,
    identity: createIdentityService(),
  } as unknown as Parameters<typeof createApp>[0]);
  const server: Server = createServer(app, { signingSecret: SECRET });
  server.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    app,
    deploy,
    acl,
    directory,
    sessions,
    base,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const capFor = (actorId: string) =>
  mintCapabilityToken(
    {
      actorId,
      scopeId: scopeId("personal", actorId),
      aud: CONTROL_PLANE_AUD,
      liveActor: true,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET,
  );

const gitPerm = async (base: string, id: string, actor: string): Promise<{ status: number; permission?: string }> => {
  const r = await fetch(`${base}/v1/deployments/${encodeURIComponent(id)}/git-url`, {
    headers: { "x-agent-capability": await capFor(actor) },
  });
  if (r.status !== 200) return { status: r.status };
  return { status: 200, permission: ((await r.json()) as { permission: string }).permission };
};

const gitUrl = async (base: string, id: string, actor: string): Promise<string> => {
  const r = await fetch(`${base}/v1/deployments/${encodeURIComponent(id)}/git-url`, {
    headers: { "x-agent-capability": await capFor(actor) },
  });
  if (r.status !== 200) assert.fail(`git URL failed (${r.status}): ${await r.text()}`);
  return ((await r.json()) as { url: string }).url;
};

async function pushStatus(url: string): Promise<number> {
  const parsed = new URL(url);
  const authorization = `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")}`;
  parsed.username = "";
  parsed.password = "";
  parsed.pathname += "/git-receive-pack";
  return (
    await fetch(parsed, {
      method: "POST",
      headers: { authorization, "content-type": "application/x-git-receive-pack-request" },
      body: Buffer.alloc(0),
    })
  ).status;
}

async function setup() {
  const f = await fixture();
  await f.directory.replaceChannels(
    [
      { channelId: CH, name: "built", isPrivate: true },
      { channelId: CH_OTHER, name: "shared", isPrivate: true },
    ],
    [
      { channelId: CH, principalId: "U1" },
      { channelId: CH, principalId: "U2" },
      { channelId: CH_OTHER, principalId: "U2" },
      { channelId: CH_OTHER, principalId: "U3" },
    ],
  );
  const d = await f.app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    files: [{ path: "server.js", data: "console.log('v1')" }],
    name: "channel-app",
    createdInScope: scopeId("channel", CH),
  });
  return { f, d };
}

test("principalGitPermission: a member of the channel the app was created in gets write", async () => {
  const { f, d } = await setup();
  try {
    assert.equal((await gitPerm(f.base, d.id, "U1")).permission, "write");
    assert.equal((await gitPerm(f.base, d.id, "U2")).permission, "write");
  } finally {
    await f.close();
  }
});

test("principalGitPermission: a member of a channel it was only SHARED into gets at most read", async () => {
  const { f, d } = await setup();
  try {
    await f.acl.grant({
      ownerScopeId: scopeId("personal", "U1"),
      ref: `deployment:${d.id}`,
      granteeScopeId: scopeId("channel", CH_OTHER),
      permission: "read",
      grantedBy: "U1",
    });
    assert.equal((await gitPerm(f.base, d.id, "U3")).permission, "read");

    assert.notEqual((await gitPerm(f.base, d.id, "U3")).permission, "write");
  } finally {
    await f.close();
  }
});

test("principalGitPermission: an unrelated principal is denied (no access)", async () => {
  const { f, d } = await setup();
  try {
    assert.equal((await gitPerm(f.base, d.id, "U9")).status, 403);
  } finally {
    await f.close();
  }
});

test("principalGitPermission: org-owned deployment is not manageable by membership (read only)", async () => {
  const f = await fixture();
  try {
    const d = await f.app.deploy({
      ownerScopeId: scopeId("org", "default-org"),
      createdBy: "U1",
      entrypoint: "node server.js",
      files: [{ path: "server.js", data: "console.log('v1')" }],
    });
    assert.equal((await gitPerm(f.base, d.id, "U7")).permission, "read");
  } finally {
    await f.close();
  }
});

test("an explicit public-channel write grant retains write permission", async () => {
  const f = await fixture();
  try {
    const publicScope = scopeId("channel", "CPUBLIC");
    await f.directory.replaceChannels([{ channelId: "CPUBLIC", name: "public", isPrivate: false }], []);
    const session = await f.sessions.getOrCreateByThread("public-history", "channel", publicScope);
    await f.sessions.addParticipant(session.id, "U2");
    const d = await f.app.deploy({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "node server.js",
      files: [{ path: "server.js", data: "console.log('v1')" }],
    });
    await f.acl.grant({
      ownerScopeId: d.ownerScopeId,
      ref: `deployment:${d.id}`,
      granteeScopeId: publicScope,
      permission: "write",
      grantedBy: "U1",
    });
    assert.equal((await gitPerm(f.base, d.id, "U2")).permission, "write");
  } finally {
    await f.close();
  }
});

test("canManage: a member acting in the creation channel's context may rename", async () => {
  const { f, d } = await setup();
  try {
    const renamed = await f.deploy.deployOrUpdate({
      ownerScopeId: scopeId("personal", "U2"),
      createdBy: "U2",
      renameFrom: d.name ?? d.id,
      name: "renamed-by-teammate",
      createdInScope: scopeId("channel", CH),
    });
    assert.equal(renamed.name, "renamed-by-teammate");
  } finally {
    await f.close();
  }
});

test("canManage: acting in a different (shared-into) channel does NOT confer manage", async () => {
  const { f, d } = await setup();
  try {
    await f.acl.grant({
      ownerScopeId: scopeId("personal", "U1"),
      ref: `deployment:${d.id}`,
      granteeScopeId: scopeId("channel", CH_OTHER),
      permission: "read",
      grantedBy: "U1",
    });
    await assert.rejects(
      f.deploy.deployOrUpdate({
        ownerScopeId: scopeId("personal", "U3"),
        createdBy: "U3",
        renameFrom: d.name ?? d.id,
        name: "renamed-by-outsider",
        createdInScope: scopeId("channel", CH_OTHER),
      }),
      /not authorized to manage/i,
    );
  } finally {
    await f.close();
  }
});

test("canManage: a channel write grant follows a member into their DM", async () => {
  const { f, d } = await setup();
  try {
    await f.acl.grant({
      ownerScopeId: d.ownerScopeId,
      ref: `deployment:${d.id}`,
      granteeScopeId: scopeId("channel", CH_OTHER),
      permission: "write",
      grantedBy: "U1",
    });
    assert.equal(await f.deploy.canManageDeployment(d.id, "U3", scopeId("personal", "U3")), true);
  } finally {
    await f.close();
  }
});

test("an org write grant gives active org members git write and manage authority", async () => {
  const { f, d } = await setup();
  try {
    await f.acl.grant({
      ownerScopeId: d.ownerScopeId,
      ref: `deployment:${d.id}`,
      granteeScopeId: scopeId("org", "default-org"),
      permission: "write",
      grantedBy: "U1",
    });
    assert.deepEqual(await gitPerm(f.base, d.id, "U9"), { status: 200, permission: "write" });
    assert.equal(await f.deploy.canManageDeployment(d.id, "U9", scopeId("personal", "U9")), true);
  } finally {
    await f.close();
  }
});

test("removed channel members keep stale-session read reach but lose write and manage authority", async () => {
  const { f, d } = await setup();
  try {
    const session = await f.sessions.getOrCreateByThread("stale-channel-session", "channel", scopeId("channel", CH));
    await f.sessions.addParticipant(session.id, "U2");
    const beforeRemovalUrl = await gitUrl(f.base, d.id, "U2");
    await f.directory.replaceChannels(
      [
        { channelId: CH, name: "built", isPrivate: true },
        { channelId: CH_OTHER, name: "shared", isPrivate: true },
      ],
      [
        { channelId: CH, principalId: "U1" },
        { channelId: CH_OTHER, principalId: "U3" },
      ],
    );

    assert.equal((await gitPerm(f.base, d.id, "U2")).status, 403);
    assert.equal(await pushStatus(beforeRemovalUrl), 403, "a write URL minted before removal is revoked at push time");
    assert.equal(await f.deploy.canManageDeployment(d.id, "U2", scopeId("personal", "U2")), false);

    await f.acl.grant({
      ownerScopeId: d.ownerScopeId,
      ref: `deployment:${d.id}`,
      granteeScopeId: scopeId("channel", CH),
      permission: "write",
      grantedBy: "U1",
    });
    assert.equal((await gitPerm(f.base, d.id, "U2")).status, 403);
    assert.equal(await f.deploy.canManageDeployment(d.id, "U2", scopeId("personal", "U2")), false);
  } finally {
    await f.close();
  }
});

test("canManage: the creator may still rename", async () => {
  const { f, d } = await setup();
  try {
    const renamed = await f.deploy.deployOrUpdate({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      renameFrom: d.name ?? d.id,
      name: "renamed-by-creator",
      createdInScope: scopeId("channel", CH),
    });
    assert.equal(renamed.name, "renamed-by-creator");
  } finally {
    await f.close();
  }
});

test("authority follows the person: a creation-channel member manages the app from their DM (web routes + share); a non-member may not", async () => {
  const { f, d } = await setup();
  try {
    const rename = await fetch(`${f.base}/v1/deployments/${d.id}/name`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await capFor("U2") },
      body: JSON.stringify({ name: "renamed-from-dm" }),
    });
    assert.equal(rename.status, 200, await rename.text());

    await assert.rejects(
      f.deploy.shareDeployment(d.id, scopeId("personal", "U3"), "read", { createdBy: "U2" }),
      /only the owner/,
    );

    const denied = await fetch(`${f.base}/v1/deployments/${d.id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await capFor("U3") },
      body: "{}",
    });
    assert.equal(denied.status, 403);
    await assert.rejects(
      f.deploy.shareDeployment(d.id, scopeId("org", "default-org"), "read", { createdBy: "U3" }),
      /only the owner/,
    );
  } finally {
    await f.close();
  }
});
