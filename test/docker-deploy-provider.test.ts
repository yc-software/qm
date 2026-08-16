import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";

function deployment(): Deployment {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    currentVersion: 1,
    status: "failed",
    endpoint: null,
    versions: [],
  };
}

function fakeDocker(stderr: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "fake-docker-")), "docker");
  writeFileSync(path, `#!/bin/sh\nprintf '%s' '${stderr}' >&2\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
}

test("destroy rejects a Docker failure so cleanup remains retryable", async () => {
  const provider = createDockerDeployProvider({ docker: fakeDocker("daemon unavailable") });
  await assert.rejects(provider.destroy(deployment()), /deploy destroy failed: daemon unavailable/);
});

test("destroy treats an already-missing Docker container as clean", async () => {
  const provider = createDockerDeployProvider({
    docker: fakeDocker("Error response from daemon: No such container: agent-deploy-550e8400-e29"),
  });
  await provider.destroy(deployment());
});
