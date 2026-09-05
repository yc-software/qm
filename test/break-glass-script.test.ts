import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

/**
 * Async, not spawnSync: the fake core below runs in this process, and a
 * synchronous spawn blocks the event loop so the connection is never accepted.
 */
function run(
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
    child.stdin.end(input);
  });
}
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "break-glass.ts");

/** A core that accepts any signed break-glass call and reports the password it received. */
async function fakeCore(): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push((JSON.parse(raw) as { password: string }).password);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const env = (url: string) => ({
  ...process.env,
  CORE_API_URL: url,
  CORE_SIGNING_SECRET: "a".repeat(48),
  QM_BREAK_GLASS_SECRET: "b".repeat(48),
});

// A piped password used to leave the process on an unsettled top-level await:
// rl.question() never settles on a non-interactive stdin, so the documented
// "keep it out of the shell history" form died without setting anything.
test("the password can be piped in, which is what the runbook tells an operator to do", async () => {
  const core = await fakeCore();
  try {
    const r = await run([script, "rescue@example.invalid"], "piped-password-123\n", env(core.url));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(core.seen, ["piped-password-123"], "the trailing newline is not part of the password");
  } finally {
    await core.close();
  }
});

test("an empty pipe is refused rather than sending an empty password", async () => {
  const core = await fakeCore();
  try {
    const r = await run([script, "rescue@example.invalid"], "", env(core.url));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no password was supplied on stdin/);
    assert.deepEqual(core.seen, []);
  } finally {
    await core.close();
  }
});

test("a short password is refused before core is called", async () => {
  const core = await fakeCore();
  try {
    const r = await run([script, "rescue@example.invalid"], "short\n", env(core.url));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /at least 8 characters/);
    assert.deepEqual(core.seen, []);
  } finally {
    await core.close();
  }
});
