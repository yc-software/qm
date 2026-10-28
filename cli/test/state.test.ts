import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { withDeploymentLock } from "../src/state.ts";

function lockPath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "qm-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "nested", "up.lock");
}

function hurryLockClock(t: TestContext): void {
  let now = Date.now();
  t.mock.method(Date, "now", () => (now += 1_000));
}

const acquire = (path: string) => withDeploymentLock(path, async () => readdirSync(path));

test("the deployment lock creates its directory, runs the operation, and releases", async (t) => {
  const path = lockPath(t);
  const [owner, ...others] = await acquire(path);
  assert.match(owner!, /^owner-/);
  assert.deepEqual(others, []);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(path, "..")), true);
});

test("the deployment lock is released when the operation throws", async (t) => {
  const path = lockPath(t);
  await assert.rejects(
    withDeploymentLock(path, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(existsSync(path), false);
});

for (const pid of [undefined, "invalid", "0"]) {
  test(`the deployment lock recovers an old lock with PID ${pid ?? "missing"}`, async (t) => {
    const path = lockPath(t);
    mkdirSync(path, { recursive: true });
    if (pid !== undefined) writeFileSync(join(path, "pid"), pid);
    const expired = new Date(Date.now() - 10_000);
    utimesSync(path, expired, expired);
    assert.equal((await acquire(path)).length, 1);
    assert.equal(existsSync(path), false);
  });
}

test("the deployment lock waits for an owner without a PID and reclaims it once it is stale", async (t) => {
  const path = lockPath(t);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "owner-unknown"), "not a pid");
  let waited = 0;
  const now = Date.now;
  t.mock.method(Date, "now", () => now() + 1_000 * waited++);
  assert.equal((await acquire(path)).length, 1);
  assert.ok(waited > 5);
  assert.equal(existsSync(path), false);
});

test("the deployment lock keeps waiting when an owner disappears during the probe", async (t) => {
  const path = lockPath(t);
  mkdirSync(path, { recursive: true });
  symlinkSync(join(path, "missing"), join(path, "owner-releasing"));
  hurryLockClock(t);
  await assert.rejects(acquire(path), /Another qm operation holds/);
  assert.deepEqual(readdirSync(path), ["owner-releasing"]);
});

test("the deployment lock keeps a lock whose owner cannot be probed", async (t) => {
  const path = lockPath(t);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "pid"), String(process.pid));
  t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
  });
  hurryLockClock(t);
  await assert.rejects(acquire(path), /Another qm operation holds/);
  assert.equal(readFileSync(join(path, "pid"), "utf8"), String(process.pid));
});

test("the deployment lock stale recovery preserves a replacement owner", async (t) => {
  const path = lockPath(t);
  mkdirSync(path, { recursive: true });
  hurryLockClock(t);
  const stalePid = process.pid + 1;
  writeFileSync(join(path, "pid"), String(stalePid));
  const replacement = `owner-${randomUUID()}`;
  const kill = process.kill;
  t.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => {
    if (pid !== stalePid) return kill(pid, signal);
    rmSync(path, { recursive: true });
    mkdirSync(path);
    writeFileSync(join(path, replacement), String(process.pid));
    throw Object.assign(new Error("No such process"), { code: "ESRCH" });
  });
  await assert.rejects(acquire(path), /Another qm operation holds/);
  assert.deepEqual(readdirSync(path), [replacement]);
  assert.equal(readFileSync(join(path, replacement), "utf8"), String(process.pid));
});

test("the deployment lock waits for a holder that releases normally", { timeout: 10_000 }, async (t) => {
  const path = lockPath(t);
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { withDeploymentLock } from ${JSON.stringify(new URL("../src/state.ts", import.meta.url).href)};
await withDeploymentLock(${JSON.stringify(path)}, async () => {
  process.send("locked");
  await new Promise((resolve) => setTimeout(resolve, 400));
});`,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const [message] = await once(child, "message");
  assert.equal(message, "locked");
  assert.match(readdirSync(path)[0]!, /^owner-/);
  assert.equal((await acquire(path)).length, 1);
  assert.equal(existsSync(path), false);
  assert.deepEqual(await exited, [0, null]);
});
