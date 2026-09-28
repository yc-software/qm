import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const source = fileURLToPath(new URL("../src/sandbox/execution-supervisor.py", import.meta.url));
const cases = fileURLToPath(new URL("./execution-supervisor.test.py", import.meta.url));

test("execution supervisor rejects unsafe requests and proxy destinations", async () => {
  const result = await run("python3", [cases], { timeout: 30_000 });
  assert.match(result.stderr, /OK/);
});

test(
  "execution supervisor enforces its boundary on a live Docker kernel",
  { skip: process.env.QM_SUPERVISOR_DOCKER_TEST !== "1", timeout: 300_000 },
  async () => {
    const name = `qm-supervisor-test-${process.pid}-${Date.now()}`;
    try {
      const result = await run(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          name,
          "--cap-add",
          "SYS_ADMIN",
          "--security-opt",
          "seccomp=unconfined",
          "--security-opt",
          "systempaths=unconfined",
          "-v",
          `${source}:/opt/execution-supervisor.py:ro`,
          "-v",
          `${cases}:/opt/execution-supervisor.test.py:ro`,
          "-e",
          "QM_SUPERVISOR_PATH=/opt/execution-supervisor.py",
          "-e",
          "QM_SUPERVISOR_LIVE=1",
          "-e",
          `QM_SUPERVISOR_PUBLIC_NETWORK=${process.env.QM_SUPERVISOR_PUBLIC_NETWORK ?? "0"}`,
          process.env.QM_SUPERVISOR_TEST_IMAGE ?? "debian:bookworm-slim",
          "sh",
          "-c",
          "apt-get update -qq >/tmp/install.log 2>&1 && apt-get install -y -qq python3 bubblewrap libseccomp2 curl ca-certificates util-linux >>/tmp/install.log 2>&1 && python3 /opt/execution-supervisor.test.py -v",
        ],
        { timeout: 290_000, maxBuffer: 4 * 1024 * 1024 },
      );
      assert.match(result.stderr, /OK/);
    } finally {
      await run("docker", ["rm", "-f", name]).catch(() => undefined);
    }
  },
);
