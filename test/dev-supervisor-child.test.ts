import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Child } from "../scripts/dev/supervisor/children.ts";
import { tcpPortOpen } from "../scripts/dev/lib/proc.ts";
import { sleep } from "../scripts/dev/lib/util.ts";
import type { ChildSpec } from "../scripts/dev/lib/types.ts";

const FAKE = join(import.meta.dirname, "../scripts/dev/test-helpers/fake-child.mjs");

async function freeTcpPort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

function spec(lock: string, port: number, extraArgs: string[] = []): ChildSpec {
  return {
    name: "web",
    cwd: lock,
    argv: ["node", FAKE, `--port=${port}`, ...extraArgs],
    env: { PATH: process.env.PATH ?? "" },
    port,
    readiness: { kind: "log", pattern: `fake-child ready on :${port}` },
    health: { kind: "tcp", port },
    stopGraceMs: 2000,
  };
}

test("child starts, reports ready via log pattern, and stops with the port released", async () => {
  const lock = mkdtempSync(join(tmpdir(), "qm-child-"));
  const port = await freeTcpPort();
  const child = new Child(
    spec(lock, port),
    lock,
    () => {},
    () => {},
  );
  const res = await child.start();
  assert.equal(res.ok, true);
  assert.equal(child.state, "healthy");
  assert.equal(await tcpPortOpen(port), true);
  assert.equal(await child.probeHealth(), true);
  await child.stop();
  assert.equal(child.state, "stopped");
  assert.equal(await tcpPortOpen(port), false);
  rmSync(lock, { recursive: true, force: true });
});

test("a crashed child is auto-restarted with backoff", async () => {
  const lock = mkdtempSync(join(tmpdir(), "qm-child-"));
  const port = await freeTcpPort();
  const crashes: number[] = [];
  const child = new Child(
    spec(lock, port, ["--crashAfter=1500"]),
    lock,
    () => {},
    () => crashes.push(Date.now()),
  );
  assert.equal((await child.start()).ok, true);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && crashes.length === 0) await sleep(100);
  assert.ok(crashes.length >= 1, "child crash was observed");
  while (Date.now() < deadline && child.state !== "healthy") await sleep(100);
  assert.equal(child.state, "healthy");
  assert.ok(child.restarts >= 1);
  await child.stop();
  rmSync(lock, { recursive: true, force: true });
});

test("start frees a squatted port before spawning (the EADDRINUSE fix)", async () => {
  const lock = mkdtempSync(join(tmpdir(), "qm-child-"));
  const port = await freeTcpPort();
  const squatter = new Child(
    spec(lock, port, ["--ignoreTerm"]),
    lock,
    () => {},
    () => {},
  );
  assert.equal((await squatter.start()).ok, true);
  squatter.proc?.removeAllListeners("exit");

  const child = new Child(
    spec(lock, port),
    lock,
    () => {},
    () => {},
  );
  const res = await child.start();
  assert.equal(res.ok, true, res.detail);
  assert.equal(await child.probeHealth(), true);
  await child.stop();
  rmSync(lock, { recursive: true, force: true });
});

test("stop escalates to SIGKILL for a TERM-ignoring child", async () => {
  const lock = mkdtempSync(join(tmpdir(), "qm-child-"));
  const port = await freeTcpPort();
  const child = new Child(
    spec(lock, port, ["--ignoreTerm"]),
    lock,
    () => {},
    () => {},
  );
  assert.equal((await child.start()).ok, true);
  const before = Date.now();
  await child.stop();
  assert.equal(child.state, "stopped");
  assert.equal(await tcpPortOpen(port), false);
  assert.ok(Date.now() - before < 8000);
  rmSync(lock, { recursive: true, force: true });
});
