import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hostDockerSocket } from "../src/backends/docker.ts";

test("Docker socket group uses the configured host path without platform-specific commands", () => {
  const prior = process.env.DOCKER_HOST;
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-socket-"));
  const path = join(dir, "docker.sock");
  try {
    writeFileSync(path, "");
    process.env.DOCKER_HOST = `unix://${path}`;
    assert.deepEqual(hostDockerSocket(), { path, gid: String(statSync(path).gid) });
    rmSync(path);
    assert.throws(() => hostDockerSocket(), /cannot read the Docker socket/);
    process.env.DOCKER_HOST = "tcp://localhost:2375";
    assert.throws(() => hostDockerSocket(), /requires a Unix Docker socket/);
  } finally {
    if (prior === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
