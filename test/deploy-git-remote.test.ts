import { execFile } from "node:child_process";
import { TEST_TENANT } from "./support/test-tenant.ts";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { mintDeployGitAccess } from "../src/deploy/access-token.ts";
import { createDeployStore, type PublishedApp } from "../src/deploy/deploy-store.ts";
import type { DeployGitArchive } from "../src/deploy/deploy-git-store.ts";
import { scopeId } from "../src/types.ts";
import { testMap, testDeployBackings, testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";

const execFileP = promisify(execFile);
const SECRET = "deploy-git-remote-secret".repeat(3);

async function fixture(): Promise<{
  base: string;
  close: () => Promise<void>;
  deployment: PublishedApp;
}> {
  const backing = testDeployBackings();
  const archiveStore = testMap<DeployGitArchive>();
  const writerStore = createDeployStore({
    ...backing,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-git-remote-writer-")), archiveStore },
  });
  const publishedApp = await writerStore.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/unused",
    files: [
      { path: "server.js", data: "console.log('hello')" },
      { path: "data.json", data: '{"n":1}' },
    ],
    name: "git-remote",
  });
  await writerStore.setAppliedVersion(publishedApp.id, 1);
  const readerStore = createDeployStore({
    ...backing,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-git-remote-reader-")), archiveStore },
  });
  const app = {
    tenantFor: async () => TEST_TENANT,
    listApps: async () => [publishedApp],
    appGitRepoPath: async (id: string) => (id === publishedApp.id ? await readerStore.repoUrl(id) : null),
  } as unknown as App;
  const server: Server = createServer(app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
  });
  server.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, deployment: publishedApp, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function authedGitUrl(base: string, appId: string, permission: "read" | "write" = "read"): Promise<string> {
  const token = await mintDeployGitAccess(SECRET, { deploymentId: appId, permission, exp: Date.now() + 60_000 });
  const url = new URL(`/v1/apps/${encodeURIComponent(appId)}/git`, base);
  url.username = "deployment";
  url.password = token;
  return url.toString();
}

test("app git remote serves the current ref to a real git client", async () => {
  const f = await fixture();
  try {
    const v = f.deployment.versions[0]!;
    const { stdout } = await execFileP("git", [
      "ls-remote",
      await authedGitUrl(f.base, f.deployment.id),
      "refs/heads/current",
    ]);
    assert.equal(stdout.trim(), `${v.commit}\trefs/heads/current`);
  } finally {
    await f.close();
  }
});

test("app git remote rejects unauthenticated fetches when core auth is configured", async () => {
  const f = await fixture();
  try {
    const res = await fetch(
      `${f.base}/v1/apps/${encodeURIComponent(f.deployment.id)}/git/info/refs?service=git-upload-pack`,
    );
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /app git/);
  } finally {
    await f.close();
  }
});
