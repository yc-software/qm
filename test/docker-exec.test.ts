import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnDockerExec } from "../src/sandbox/docker-exec.ts";

test("docker execution reports a bounded timeout when the daemon command hangs", async () => {
  const dockerExec = spawnDockerExec(process.execPath);
  const result = await dockerExec(["-e", "setTimeout(() => {}, 60_000)"], 20);
  assert.equal(result.code, -1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /docker command timed out after 20ms \(SIGKILL\)/);
});

test("docker execution preserves daemon stderr on ordinary failures", async () => {
  const dockerExec = spawnDockerExec(process.execPath);
  const result = await dockerExec(["-e", "process.stderr.write('daemon failed\\n'); process.exit(7)"], 1_000);
  assert.equal(result.code, 7);
  assert.equal(result.stderr, "daemon failed\n");
});
