import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore, type AclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { mintDeployGitAccess, verifyDeployGitAccess } from "../src/deploy/access-token.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";

const execFileP = promisify(execFile);
const SECRET = "deploy-git-rw-secret".repeat(3);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@t",
};

function fixture(urls: { apiBaseUrl?: string; publicUrl?: string } = {}) {
  const deployStore = createDeployStore({ git: { repoRoot: mkdtempSync(join(tmpdir(), "git-rw-repo-")) } });
  const acl: AclStore = createAclStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 19998 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "git-rw-deploy-")),
  });
  const identity = createIdentityService();
  const app = createApp({
    deploy,
    acl,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity,
  } as unknown as Parameters<typeof createApp>[0]);
  const server: Server = createServer(app, { signingSecret: SECRET, identity, ...urls });
  server.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { app, deploy, acl, identity, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function gitUrl(base: string, deploymentId: string, permission: "read" | "write"): Promise<string> {
  const token = await mintDeployGitAccess(SECRET, {
    deploymentId,
    permission,
    principalId: "U1",
    exp: Date.now() + 60_000,
  });
  const url = new URL(`/v1/deployments/${encodeURIComponent(deploymentId)}/git`, base);
  url.username = "deployment";
  url.password = token;
  return url.toString();
}

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

const capFor = (actorId: string, scope?: string) =>
  mintCapabilityToken(
    {
      actorId,
      scopeId: scope ?? scopeId("personal", actorId),
      aud: CONTROL_PLANE_AUD,
      liveActor: true,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET,
  );

test("a read token can clone but cannot push (403 on receive-pack)", async () => {
  const f = fixture();
  try {
    const d = await f.app.deploy({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "node server.js",
      files: [{ path: "server.js", data: "console.log('v1')" }],
    });
    const work = mkdtempSync(join(tmpdir(), "git-rw-clone-"));
    await execFileP("git", ["clone", "--quiet", await gitUrl(f.base, d.id, "read"), work], { env: GIT_ENV });

    await writeFile(join(work, "server.js"), "console.log('v2')");
    await execFileP("git", ["add", "-A"], { cwd: work, env: GIT_ENV });
    await execFileP("git", ["commit", "-q", "-m", "v2"], { cwd: work, env: GIT_ENV });
    await execFileP("git", ["remote", "set-url", "origin", await gitUrl(f.base, d.id, "read")], {
      cwd: work,
      env: GIT_ENV,
    });
    await assert.rejects(
      execFileP("git", ["push", "origin", "HEAD:current"], { cwd: work, env: GIT_ENV }),
      /403|read-only|forbidden/i,
    );

    const after = await f.deploy.listDeployments();
    assert.equal(after[0]!.versions.length, 1);
  } finally {
    await f.close();
  }
});

test("a write token can push, and the push registers a new immutable version", async () => {
  const f = fixture();
  try {
    const d = await f.app.deploy({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "node server.js",
      files: [{ path: "server.js", data: "console.log('v1')" }],
    });
    const work = mkdtempSync(join(tmpdir(), "git-rw-push-"));
    await execFileP("git", ["clone", "--quiet", await gitUrl(f.base, d.id, "write"), work], { env: GIT_ENV });

    await mkdir(join(work, "sub"), { recursive: true });
    await writeFile(join(work, "server.js"), "console.log('v2')");
    await writeFile(join(work, "sub/new.txt"), "added");
    await execFileP("git", ["add", "-A"], { cwd: work, env: GIT_ENV });
    await execFileP("git", ["commit", "-q", "-m", "v2"], { cwd: work, env: GIT_ENV });
    const { stdout: pushedSha } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: work, env: GIT_ENV });
    await execFileP("git", ["push", "origin", "HEAD:current"], { cwd: work, env: GIT_ENV });

    const fresh = (await f.deploy.listDeployments())[0]!;
    assert.equal(fresh.versions.length, 2);
    assert.equal(fresh.currentVersion, 2);
    const v2 = fresh.versions.find((v) => v.version === 2)!;
    assert.equal(v2.commit, pushedSha.trim());
    assert.equal(v2.entrypoint, "node server.js");
  } finally {
    await f.close();
  }
});

test("a write token minted before principal deactivation is revoked at push time", async () => {
  const f = fixture();
  try {
    const d = await f.app.deploy({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "node server.js",
      files: [{ path: "server.js", data: "console.log('v1')" }],
    });
    const url = await gitUrl(f.base, d.id, "write");
    await f.identity.deactivate("U1");
    assert.equal(await pushStatus(url), 403);
  } finally {
    await f.close();
  }
});

test("git-url endpoint: write for the owner, read for a read-grantee, 403 for no access", async () => {
  const f = fixture();
  try {
    const d = await f.app.deploy({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "x",
      files: [{ path: "server.js", data: "1" }],
    });
    await f.acl.grant({
      ownerScopeId: scopeId("personal", "U1"),
      ref: `deployment:${d.id}`,
      granteeScopeId: scopeId("personal", "U2"),
      permission: "read",
      grantedBy: "U1",
    });

    const ask = async (actor: string) =>
      fetch(`${f.base}/v1/deployments/${encodeURIComponent(d.id)}/git-url`, {
        headers: { "x-agent-capability": await capFor(actor) },
      });

    const owner = await ask("U1");
    assert.equal(owner.status, 200);
    const ownerBody = (await owner.json()) as { url: string; permission: string };
    assert.equal(ownerBody.permission, "write");
    assert.match(ownerBody.url, new RegExp(`/v1/deployments/${d.id}/git`));
    assert.equal((await verifyDeployGitAccess(SECRET, new URL(ownerBody.url).password))?.principalId, "U1");

    await f.identity.deactivate("U1");
    await assert.rejects(
      execFileP("git", ["ls-remote", ownerBody.url], { env: GIT_ENV }),
      /401|403|Authentication failed/i,
    );

    const reader = await ask("U2");
    assert.equal(reader.status, 200);
    assert.equal(((await reader.json()) as { permission: string }).permission, "read");

    const stranger = await ask("U3");
    assert.equal(stranger.status, 403);

    await f.acl.grant({
      ownerScopeId: scopeId("personal", "U1"),
      ref: `deployment:${d.id}`,
      granteeScopeId: scopeId("personal", "U3"),
      permission: "write",
      grantedBy: "U1",
    });
    const writer = await ask("U3");
    assert.equal(writer.status, 200);
    assert.equal(((await writer.json()) as { permission: string }).permission, "write");

    const anon = await fetch(`${f.base}/v1/deployments/${encodeURIComponent(d.id)}/git-url`);
    assert.equal(anon.status, 401);
  } finally {
    await f.close();
  }
});

test("git-url endpoint returns a clonable API URL when web and API origins differ", async () => {
  let coreBase = "";
  const ingress = createHttpServer((req, res) => {
    const upstream = httpRequest(
      new URL(req.url ?? "/", coreBase),
      { method: req.method, headers: req.headers },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );
    upstream.on("error", (error) => res.destroy(error));
    req.pipe(upstream);
  });
  ingress.listen(0);
  const apiBaseUrl = `http://127.0.0.1:${(ingress.address() as AddressInfo).port}`;
  const f = fixture({ apiBaseUrl, publicUrl: "https://web.example" });
  coreBase = f.base;
  try {
    const deployment = await f.app.deploy({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "x",
      files: [{ path: "server.js", data: "1" }],
    });
    const response = await fetch(`${f.base}/v1/deployments/${encodeURIComponent(deployment.id)}/git-url`, {
      headers: { "x-agent-capability": await capFor("U1") },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { url: string };
    assert.equal(new URL(body.url).origin, apiBaseUrl);
    const work = mkdtempSync(join(tmpdir(), "git-url-clone-"));
    await execFileP("git", ["clone", "--quiet", body.url, work], { env: GIT_ENV });
  } finally {
    await f.close();
    await new Promise<void>((resolve) => ingress.close(() => resolve()));
  }
});

test("git-url endpoint: an org-owned deployment is read for a plain member, write only with a write grant", async () => {
  const f = fixture();
  try {
    const d = await f.app.deploy({
      ownerScopeId: scopeId("org", "default-org"),
      createdBy: "U1",
      entrypoint: "x",
      files: [{ path: "server.js", data: "1" }],
    });
    const ask = async (actor: string) =>
      fetch(`${f.base}/v1/deployments/${encodeURIComponent(d.id)}/git-url`, {
        headers: { "x-agent-capability": await capFor(actor) },
      });

    const member = await ask("U2");
    assert.equal(member.status, 200);
    assert.equal(((await member.json()) as { permission: string }).permission, "read");

    await f.acl.grant({
      ownerScopeId: scopeId("org", "default-org"),
      ref: `deployment:${d.id}`,
      granteeScopeId: scopeId("personal", "U2"),
      permission: "write",
      grantedBy: "U1",
    });
    const promoted = await ask("U2");
    assert.equal(((await promoted.json()) as { permission: string }).permission, "write");
  } finally {
    await f.close();
  }
});
