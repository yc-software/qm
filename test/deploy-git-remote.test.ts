import { execFile } from "node:child_process";
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
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import type { DeployGitArchive } from "../src/deploy/deploy-git-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

const execFileP = promisify(execFile);
const SECRET = "deploy-git-remote-secret".repeat(3);

async function fixture(): Promise<{
  base: string;
  close: () => Promise<void>;
  deployment: Deployment;
}> {
  const deployments = createMemoryMap<Deployment>();
  const archiveStore = createMemoryMap<DeployGitArchive>();
  const writerStore = createDeployStore({
    deployments,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-git-remote-writer-")), archiveStore },
  });
  const deployment = await writerStore.create({
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
  await writerStore.setAppliedVersion(deployment.id, 1);
  const readerStore = createDeployStore({
    deployments,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-git-remote-reader-")), archiveStore },
  });
  const app = {
    listDeployments: async () => [deployment],
    deploymentGitRepoPath: async (id: string) => (id === deployment.id ? await readerStore.repoUrl(id) : null),
  } as unknown as App;
  const server: Server = createServer(app, { signingSecret: SECRET });
  server.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, deployment, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function authedGitUrl(
  base: string,
  deploymentId: string,
  permission: "read" | "write" = "read",
): Promise<string> {
  const token = await mintDeployGitAccess(SECRET, { deploymentId, permission, exp: Date.now() + 60_000 });
  const url = new URL(`/v1/deployments/${encodeURIComponent(deploymentId)}/git`, base);
  url.username = "deployment";
  url.password = token;
  return url.toString();
}

test("deployment git remote serves the current ref to a real git client", async () => {
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

test("deployment git remote rejects unauthenticated fetches when core auth is configured", async () => {
  const f = await fixture();
  try {
    const res = await fetch(
      `${f.base}/v1/deployments/${encodeURIComponent(f.deployment.id)}/git/info/refs?service=git-upload-pack`,
    );
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /deployment git/);
  } finally {
    await f.close();
  }
});
