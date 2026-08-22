import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { DIRECT_RUNTIME_PATH } from "../src/sandbox/scoped-exec.ts";

const agentPath = join(process.cwd(), "aws/microvm-agent/agent.mjs");
const executablePath = realpathSync(process.execPath);
let daemon: ChildProcess;
let endpoint: string;
let rootDir: string;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port allocation failed");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function post(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; value: any }> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();
  return { status: response.status, value: text ? JSON.parse(text) : null };
}

function directBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    argv: [executablePath, "-e", "process.stdout.write('ok')"],
    executablePath,
    rootDir,
    cwd: rootDir,
    env: {},
    allowedEnvKeys: [],
    ...overrides,
  };
}

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), "qm-direct-agent-"));
  mkdirSync(join(rootDir, "sub"));
  const port = await freePort();
  endpoint = `http://127.0.0.1:${port}`;
  daemon = spawn(executablePath, [agentPath], { env: { AGENT_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const response = await fetch(`${endpoint}/health`);
      if (response.ok) return;
    } catch {
      // The daemon may not have bound its loopback port yet.
    }
    if (Date.now() >= deadline) throw new Error("direct execution daemon did not start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

after(async () => {
  daemon.kill("SIGKILL");
  if (daemon.exitCode === null) await once(daemon, "exit").catch(() => undefined);
  rmSync(rootDir, { recursive: true, force: true });
});

test("execv preserves literal argv, stdin, cwd, and excludes ambient environment", async () => {
  const args = [
    ";",
    "&&",
    "||",
    "|",
    ">",
    "<",
    "$VAR",
    "${VAR}",
    "$(echo no)",
    "`echo no`",
    "*",
    "line\nnext",
    "'quoted'",
    '"double"',
  ];
  const script =
    "process.stdout.write(JSON.stringify({args:process.argv.slice(1),stdin:require('node:fs').readFileSync(0,'utf8'),cwd:process.cwd(),only:process.env.DIRECT_ONLY,dynamic:process.env.AGENT_API_TOKEN,ambient:process.env.DIRECT_AMBIENT??null,keys:Object.keys(process.env).filter(key=>!key.startsWith('__CF_')).sort()}))";
  const stdin = "stdin ; && $VAR\n";
  const result = await post(
    "/execv",
    directBody({
      argv: [executablePath, "-e", script, ...args],
      env: { DIRECT_ONLY: "yes", AGENT_API_TOKEN: "cap" },
      allowedEnvKeys: ["DIRECT_ONLY"],
      dynamicEnvKeys: ["AGENT_API_TOKEN"],
      cwd: join(rootDir, "sub"),
      stdinB64: Buffer.from(stdin).toString("base64"),
    }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.value.code, 0);
  assert.deepEqual(JSON.parse(result.value.stdout), {
    args,
    stdin,
    cwd: realpathSync(join(rootDir, "sub")),
    only: "yes",
    dynamic: "cap",
    ambient: null,
    keys: ["AGENT_API_TOKEN", "DIRECT_ONLY"],
  });
});

test("execv starts descriptor scripts through the fixed non-inherited runtime PATH", async () => {
  const scriptPath = join(rootDir, "descriptor-tool");
  writeFileSync(scriptPath, "#!/usr/bin/env node\nprocess.stdout.write(process.env.PATH || 'missing')\n");
  chmodSync(scriptPath, 0o755);
  const executable = realpathSync(scriptPath);
  const result = await post(
    "/execv",
    directBody({ argv: [executable], executablePath: executable, env: { PATH: DIRECT_RUNTIME_PATH } }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.value.code, 0);
  assert.equal(result.value.stdout, DIRECT_RUNTIME_PATH);
});

test("execv rejects reserved and invalid paths and environment", async () => {
  assert.equal((await post("/execv", directBody({ env: { AGENT_SECRET: "x" } }))).status, 400);
  assert.equal((await post("/execv", directBody({ env: { AGENT_API_TOKEN: "x" } }))).status, 400);
  assert.equal((await post("/execv", directBody({ env: { PATH: "/tmp" } }))).status, 400);
  assert.equal((await post("/execv", directBody({ env: { FOO: "x" } }))).status, 400);
  assert.equal((await post("/execv", directBody({ argv: ["relative", "-e", ""] }))).status, 400);
  assert.equal((await post("/execv", directBody({ cwd: join(rootDir, "..") }))).status, 400);
  const outside = mkdtempSync(join(tmpdir(), "qm-direct-outside-"));
  const escape = join(rootDir, "escape");
  const tool = join(rootDir, "tool");
  symlinkSync(outside, escape);
  symlinkSync(executablePath, tool);
  try {
    assert.equal((await post("/execv", directBody({ cwd: escape }))).status, 400);
    assert.equal((await post("/execv", directBody({ argv: [tool, "-e", ""] }))).status, 400);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("execv reports nonzero exit, timeout, and bounded output", async () => {
  const nonzero = await post("/execv", directBody({ argv: [executablePath, "-e", "process.exit(9)"] }));
  assert.equal(nonzero.value.code, 9);
  const timed = await post(
    "/execv",
    directBody({ argv: [executablePath, "-e", "setTimeout(()=>{},5000)"], timeoutMs: 50 }),
  );
  assert.equal(timed.value.code, 124);
  assert.equal(timed.value.timedOut, true);
  const capped = await post(
    "/execv",
    directBody({ argv: [executablePath, "-e", "process.stdout.write('x'.repeat(100))"], stdoutMaxBytes: 7 }),
  );
  assert.equal(capped.value.code, 122);
  assert.equal(capped.value.stdout, "xxxxxxx");
  assert.equal(capped.value.stdoutTruncated, true);
  assert.equal(capped.value.outputLimitExceeded, true);
});

test("execv does not expose spawn error details", async () => {
  const marker = "secret-spawn-error-marker";
  const executable = join(realpathSync(rootDir), "bad-executable");
  writeFileSync(executable, `#!/not/installed/${marker}\n`);
  chmodSync(executable, 0o755);
  const result = await post("/execv", directBody({ argv: [executable], executablePath: executable }));
  assert.equal(result.status, 200);
  assert.equal(result.value.code, 127);
  assert.equal(result.value.stderr, "direct executable could not be started");
  assert.equal(JSON.stringify(result.value).includes(marker), false);
});

test("execv abort closes the request and terminates the child", async () => {
  const controller = new AbortController();
  const request = post(
    "/execv",
    directBody({ argv: [executablePath, "-e", "setTimeout(()=>{},5000)"], timeoutMs: 5000 }),
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(request);
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test("legacy exec route still evaluates the legacy command string", async () => {
  const result = await post("/exec", { cmd: "printf '%s' legacy", timeoutSec: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.value.stdout, "legacy");
  assert.equal(result.value.code, 0);
});
