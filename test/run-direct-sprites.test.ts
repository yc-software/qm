import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { test } from "node:test";
import { join } from "node:path";
import {
  createSpritesSandbox,
  DIRECT_HELPER_EXECUTABLE,
  DIRECT_HELPER_SCRIPT,
} from "../src/sandbox/sprites-sandbox.ts";
import { DIRECT_RUNTIME_PATH } from "../src/sandbox/scoped-exec.ts";
import type { WorkspaceStore } from "../src/workspace/workspace-store.ts";

function framedResponse(stdout: string, code = 0, split = false): Response {
  const envelope = Buffer.from(
    JSON.stringify({
      stdoutB64: Buffer.from(stdout).toString("base64"),
      stderrB64: "",
      code,
      timedOut: false,
      outputLimitExceeded: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  );
  const first = Buffer.concat([Buffer.from([1]), envelope]);
  const second = Buffer.from([3, code]);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (split) {
        controller.enqueue(first.subarray(0, 2));
        controller.enqueue(Buffer.concat([first.subarray(2), second]));
      } else {
        controller.enqueue(first);
        controller.enqueue(second);
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

test("Sprites direct POST keeps executable args and secrets in structured stdin", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const sandbox = createSpritesSandbox({} as WorkspaceStore, {
    token: "test-token",
    baseUrl: "https://sprites.example",
    client: {
      getSprite: async () => ({}),
      createSprite: async () => ({}),
      deleteSprite: async () => {},
    },
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return framedResponse("ok");
    },
  });
  const result = await sandbox.runDirect!(
    { id: "sprite", rootDir: "/workspace" },
    {
      argv: ["/usr/bin/printf", "literal ; && $(echo no)"],
      executablePath: "/usr/bin/printf",
      allowedEnvKeys: ["STATIC_SECRET"],
    },
    {
      env: { STATIC_SECRET: "secret-value" },
      dynamicEnv: { AGENT_API_TOKEN: "cap-value" },
      stdin: "stdin-value",
      stdoutMaxBytes: 7,
      stderrMaxBytes: 8,
      timeoutMs: 100,
    },
  );
  assert.equal(result.stdout, "ok");
  const parsedUrl = new URL(seenUrl);
  assert.equal(parsedUrl.protocol, "https:");
  const directArgs = parsedUrl.searchParams.getAll("cmd");
  assert.deepEqual(directArgs.slice(0, 2), [DIRECT_HELPER_EXECUTABLE, "-c"]);
  assert.match(directArgs[2] ?? "", /^import sys;sys\.argv\.append\("[0-9a-f-]{36}"\);/);
  assert.equal(parsedUrl.searchParams.get("path"), DIRECT_HELPER_EXECUTABLE);
  assert.equal(parsedUrl.searchParams.get("stdin"), "true");
  assert.equal(parsedUrl.searchParams.has("tty"), false);
  assert.equal(parsedUrl.searchParams.get("max_run_after_disconnect"), "0s");
  assert.equal(seenUrl.includes("secret-value"), false);
  assert.equal(seenUrl.includes("STATIC_SECRET"), false);
  assert.equal(seenUrl.includes("literal%20%3B%20%26%26"), false);
  assert.equal(seenUrl.includes("env="), false);
  assert.ok(seenInit);
  assert.equal(seenInit.method, "POST");
  assert.equal((seenInit.headers as Record<string, string>)["authorization"], "Bearer test-token");
  assert.equal((seenInit.headers as Record<string, string>)["content-type"], "application/octet-stream");
  assert.equal(seenInit.signal instanceof AbortSignal, true);
  const request = JSON.parse(Buffer.from(seenInit.body as Uint8Array).toString("utf8")) as {
    argv: string[];
    env: Record<string, string>;
    dynamicEnvKeys: string[];
    allowedEnvKeys: string[];
    stdinB64: string;
  };
  assert.deepEqual(request.argv, ["/usr/bin/printf", "literal ; && $(echo no)"]);
  assert.deepEqual(request.env, {
    PATH: DIRECT_RUNTIME_PATH,
    STATIC_SECRET: "secret-value",
    AGENT_API_TOKEN: "cap-value",
  });
  assert.deepEqual(request.dynamicEnvKeys, ["AGENT_API_TOKEN"]);
  assert.deepEqual(request.allowedEnvKeys, ["STATIC_SECRET"]);
  assert.equal(Buffer.from(request.stdinB64, "base64").toString(), "stdin-value");
});

test("Sprites direct parser handles split and coalesced HTTP frames", async () => {
  const sandbox = createSpritesSandbox({} as WorkspaceStore, {
    token: "test-token",
    client: {
      getSprite: async () => ({}),
      createSprite: async () => ({}),
      deleteSprite: async () => {},
    },
    fetchImpl: async () => framedResponse("split-safe", 0, true),
  });
  const result = await sandbox.runDirect!(
    { id: "sprite", rootDir: "/workspace" },
    { argv: ["/usr/bin/printf"], executablePath: "/usr/bin/printf" },
  );
  assert.equal(result.stdout, "split-safe");
});

test("Sprites direct POST combines caller abort with authenticated fetch", async () => {
  let seenSignal: AbortSignal | undefined;
  let directKillUid = "";
  let killUrl = "";
  let calls = 0;
  const sandbox = createSpritesSandbox({} as WorkspaceStore, {
    token: "test-token",
    client: {
      getSprite: async () => ({}),
      createSprite: async () => {},
      deleteSprite: async () => {},
    },
    fetchImpl: async (url, init) => {
      calls++;
      if (calls === 2) {
        assert.equal(init?.method, "GET");
        return new Response(
          JSON.stringify({
            sessions: [{ id: 1847, command: `/usr/bin/python3 -c helper ${directKillUid}`, is_active: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (calls === 3) {
        killUrl = String(url);
        assert.equal(init?.method, "POST");
        return new Response('{"type":"signal"}\n{"type":"complete","exit_code":130}\n', { status: 200 });
      }
      seenSignal = init?.signal ?? undefined;
      directKillUid = new URL(String(url)).searchParams.getAll("cmd")[2]?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0] ?? "";
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const request = sandbox.runDirect!(
    { id: "sprite", rootDir: "/workspace" },
    { argv: ["/usr/bin/printf"], executablePath: "/usr/bin/printf" },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(request);
  assert.equal(seenSignal?.aborted, true);
  assert.equal(calls, 3);
  const cleanup = new URL(killUrl);
  assert.equal(cleanup.pathname, "/v1/sprites/sprite/exec/1847/kill");
  assert.equal(cleanup.searchParams.get("signal"), "SIGTERM");
  assert.equal(cleanup.searchParams.get("timeout"), "10s");
});

for (const [label, killBody] of [
  ["error event", '{"type":"error","message":"session may still be active"}\n'],
  [
    "timeout escalation",
    '{"type":"signal"}\n{"type":"timeout"}\n{"type":"killed"}\n{"type":"complete","exit_code":137}\n',
  ],
  ["missing completion", '{"type":"signal"}\n{"type":"exited","exit_code":130}\n'],
] as const) {
  test(`Sprites direct cancellation fails closed on kill ${label}`, async () => {
    let calls = 0;
    let directKillUid = "";
    const sandbox = createSpritesSandbox({} as WorkspaceStore, {
      token: "test-token",
      client: {
        getSprite: async () => ({}),
        createSprite: async () => ({}),
        deleteSprite: async () => {},
      },
      fetchImpl: async (url, init) => {
        calls++;
        if (calls === 1) {
          directKillUid =
            new URL(String(url)).searchParams.getAll("cmd")[2]?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0] ?? "";
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        }
        if (calls === 2) {
          return new Response(
            JSON.stringify([{ id: "session-1", command: `helper ${directKillUid}`, is_active: true }]),
            { status: 200 },
          );
        }
        return new Response(killBody, { status: 200 });
      },
    });
    const controller = new AbortController();
    const request = sandbox.runDirect!(
      { id: "sprite", rootDir: "/workspace" },
      { argv: ["/usr/bin/printf"], executablePath: "/usr/bin/printf" },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(request, /sprites direct cancellation cleanup failed/);
    assert.equal(calls, 3);
  });
}

test("Sprites direct protocol failure terminates the identified remote session", async () => {
  let calls = 0;
  let directKillUid = "";
  const sandbox = createSpritesSandbox({} as WorkspaceStore, {
    token: "test-token",
    client: {
      getSprite: async () => ({}),
      createSprite: async () => ({}),
      deleteSprite: async () => {},
    },
    fetchImpl: async (url) => {
      calls++;
      if (calls === 1) {
        directKillUid =
          new URL(String(url)).searchParams.getAll("cmd")[2]?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0] ?? "";
        return new Response(new Uint8Array([1, ...Buffer.from("unterminated")]));
      }
      if (calls === 2) {
        return new Response(
          JSON.stringify([{ id: "session-2", command: `helper ${directKillUid}`, is_active: true }]),
          { status: 200 },
        );
      }
      return new Response('[{"type":"signal"},{"type":"complete","exit_code":130}]', { status: 200 });
    },
  });
  await assert.rejects(
    sandbox.runDirect!(
      { id: "sprite", rootDir: "/workspace" },
      { argv: ["/usr/bin/printf"], executablePath: "/usr/bin/printf" },
    ),
    /sprites direct execution returned no exit frame/,
  );
  assert.equal(calls, 3);
});

test("Sprites direct cancellation fails closed when the remote session cannot be identified", async () => {
  let calls = 0;
  const sandbox = createSpritesSandbox({} as WorkspaceStore, {
    token: "test-token",
    client: {
      getSprite: async () => ({}),
      createSprite: async () => ({}),
      deleteSprite: async () => {},
    },
    fetchImpl: async (_url, init) => {
      calls++;
      if (calls === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response("not-json", { status: 200 });
    },
  });
  const controller = new AbortController();
  const request = sandbox.runDirect!(
    { id: "sprite", rootDir: "/workspace" },
    { argv: ["/usr/bin/printf"], executablePath: "/usr/bin/printf" },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(request, /sprites direct cancellation cleanup failed/);
  assert.equal(calls, 2);
});

test("Sprites direct rejects an already-aborted caller without starting a remote session", async () => {
  let calls = 0;
  const sandbox = createSpritesSandbox({} as WorkspaceStore, {
    token: "test-token",
    client: {
      getSprite: async () => ({}),
      createSprite: async () => ({}),
      deleteSprite: async () => {},
    },
    fetchImpl: async () => {
      calls++;
      return framedResponse("unexpected");
    },
  });
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled before dispatch"));
  await assert.rejects(
    sandbox.runDirect!(
      { id: "sprite", rootDir: "/workspace" },
      { argv: ["/usr/bin/printf"], executablePath: "/usr/bin/printf" },
      { signal: controller.signal },
    ),
    /caller cancelled before dispatch/,
  );
  assert.equal(calls, 0);
});

test("Sprites provision fails closed when the fixed helper runtime is unavailable", async () => {
  let prepScript = "";
  const stderr = Buffer.from("direct helper runtime unavailable");
  const envelope = Buffer.from(`127 0 ${stderr.length}\n${stderr.toString("base64")}\n`);
  const sandbox = createSpritesSandbox({} as WorkspaceStore, {
    token: "test-token",
    client: {
      getSprite: async () => {
        throw new Error("missing");
      },
      createSprite: async () => ({}),
      deleteSprite: async () => {},
    },
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      prepScript = url.searchParams.getAll("cmd").at(-1) ?? "";
      return new Response(Buffer.concat([Buffer.from([1]), envelope, Buffer.from([3, 0])]), { status: 200 });
    },
  });
  await assert.rejects(sandbox.provision([]), /sprites provision prep failed: direct helper runtime unavailable/);
  assert.match(prepScript, new RegExp(DIRECT_HELPER_EXECUTABLE.replaceAll("/", "\\/")));
  assert.match(prepScript, / -c /);
});

test("Sprites helper executes a bounded structured request with exact child env", async () => {
  const executablePath = process.execPath;
  const rootDir = process.cwd();
  const child = spawn(DIRECT_HELPER_EXECUTABLE, ["-c", DIRECT_HELPER_SCRIPT, randomUUID()], {
    env: { HELPER_AMBIENT: "should-not-reach-target" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stdin.end(
    JSON.stringify({
      argv: [
        executablePath,
        "-e",
        "process.stdout.write(JSON.stringify({args:process.argv.slice(1),stdin:require('node:fs').readFileSync(0,'utf8'),cwd:process.cwd(),env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key==='VISIBLE'||key==='AGENT_API_TOKEN'||key==='HELPER_AMBIENT'))}))",
        "literal ; && $(echo no)",
      ],
      rootDir,
      cwd: rootDir,
      env: { VISIBLE: "yes", AGENT_API_TOKEN: "cap" },
      allowedEnvKeys: ["VISIBLE"],
      dynamicEnvKeys: ["AGENT_API_TOKEN"],
      stdinB64: Buffer.from("input $VAR").toString("base64"),
      timeoutMs: 1000,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
    }),
  );
  await once(child, "close");
  const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
    stdoutB64?: string;
    code?: number;
    error?: string;
  };
  assert.equal(envelope.error, undefined);
  assert.equal(envelope.code, 0);
  assert.deepEqual(JSON.parse(Buffer.from(envelope.stdoutB64!, "base64").toString("utf8")), {
    args: ["literal ; && $(echo no)"],
    stdin: "input $VAR",
    cwd: rootDir,
    env: { VISIBLE: "yes", AGENT_API_TOKEN: "cap" },
  });
});

test("Sprites helper enforces timeout and output limits", async () => {
  const runHelper = async (request: Record<string, unknown>) => {
    const child = spawn(DIRECT_HELPER_EXECUTABLE, ["-c", DIRECT_HELPER_SCRIPT, randomUUID()], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stdin.end(JSON.stringify(request));
    await once(child, "close");
    return JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
      stdoutB64: string;
      code: number;
      timedOut: boolean;
      outputLimitExceeded: boolean;
      stdoutTruncated: boolean;
    };
  };
  const base = {
    rootDir: process.cwd(),
    cwd: process.cwd(),
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
    allowedEnvKeys: [],
    dynamicEnvKeys: [],
    stderrMaxBytes: 1024,
  };
  const timed = await runHelper({
    ...base,
    argv: [process.execPath, "-e", "setTimeout(()=>{},5000)"],
    timeoutMs: 20,
    stdoutMaxBytes: 1024,
  });
  assert.equal(timed.code, 124);
  assert.equal(timed.timedOut, true);
  const limited = await runHelper({
    ...base,
    argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(4096))"],
    timeoutMs: 1000,
    stdoutMaxBytes: 32,
  });
  assert.equal(limited.code, 122);
  assert.equal(limited.outputLimitExceeded, true);
  assert.equal(limited.stdoutTruncated, true);
  assert.equal(Buffer.from(limited.stdoutB64, "base64").length, 32);
});

test("Sprites helper handles remote SIGTERM by terminating the supervised command", async () => {
  const ready = join(process.cwd(), ".direct-helper-cancel-ready");
  const marker = join(process.cwd(), ".direct-helper-cancel-marker");
  rmSync(ready, { force: true });
  rmSync(marker, { force: true });
  const command = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'unexpected'),500);setTimeout(()=>{},2000)`;
  const child = spawn(DIRECT_HELPER_EXECUTABLE, ["-c", DIRECT_HELPER_SCRIPT, randomUUID()], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stdin.end(
    JSON.stringify({
      argv: [process.execPath, "-e", command],
      rootDir: process.cwd(),
      cwd: process.cwd(),
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      allowedEnvKeys: [],
      dynamicEnvKeys: [],
      timeoutMs: 5000,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
    }),
  );
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(ready), true);
    child.kill("SIGTERM");
    await once(child, "close");
    const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { code?: number };
    assert.equal(envelope.code, 130);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(existsSync(marker), false);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(ready, { force: true });
    rmSync(marker, { force: true });
  }
});

test("Sprites helper handles SIGTERM while structured stdin remains open", async () => {
  const child = spawn(DIRECT_HELPER_EXECUTABLE, ["-c", DIRECT_HELPER_SCRIPT, randomUUID()], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stdin.write('{"argv":');
  try {
    // The Python interpreter must finish installing its SIGTERM handler before
    // the test delivers the signal; stdin deliberately remains incomplete.
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill("SIGTERM");
    const closed = await Promise.race([
      once(child, "close").then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(closed, true);
    const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { error?: string };
    assert.equal(envelope.error, "direct helper cancelled");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("Sprites helper rejects an invalid remote cancellation identity before execution", async () => {
  const child = spawn(DIRECT_HELPER_EXECUTABLE, ["-c", DIRECT_HELPER_SCRIPT, "not-a-valid-identity"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stdin.end("{}");
  const [code] = (await once(child, "close")) as [number, NodeJS.Signals | null];
  assert.notEqual(code, 0);
  assert.equal(Buffer.concat(stdout).length, 0);
});

test("Sprites helper keeps descendant supervision until the process group is terminated", async () => {
  const marker = join(process.cwd(), ".direct-helper-descendant-marker");
  rmSync(marker, { force: true });
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected'),300);setTimeout(()=>{},1000)`;
  const leader = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']})`;
  const child = spawn(DIRECT_HELPER_EXECUTABLE, ["-c", DIRECT_HELPER_SCRIPT, randomUUID()], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stdin.end(
    JSON.stringify({
      argv: [process.execPath, "-e", leader],
      rootDir: process.cwd(),
      cwd: process.cwd(),
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      allowedEnvKeys: [],
      dynamicEnvKeys: [],
      timeoutMs: 50,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
    }),
  );
  await once(child, "close");
  const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { code: number; timedOut: boolean };
  assert.equal(envelope.code, 124);
  assert.equal(envelope.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(existsSync(marker), false);
  rmSync(marker, { force: true });
});

test("Sprites helper serializes process reaping with process-group termination", () => {
  assert.match(
    DIRECT_HELPER_SCRIPT,
    /with child_lock:\n\s+if child\.returncode is None:\n\s+try:\n\s+os\.killpg\(child\.pid, signal\.SIGKILL\)/,
  );
  assert.match(DIRECT_HELPER_SCRIPT, /with child_lock:\n\s+child_finished = child\.poll\(\) is not None/);
  assert.match(DIRECT_HELPER_SCRIPT, /with child_lock:\n\s+child\.wait\(\)/);
});

test(
  "Sprites helper terminates detached descendants that escape the child process group",
  { skip: process.platform !== "linux" },
  async () => {
    const marker = join(process.cwd(), ".direct-helper-detached-marker");
    const pidFile = join(process.cwd(), ".direct-helper-detached-pid");
    rmSync(marker, { force: true });
    rmSync(pidFile, { force: true });
    const detached = `setTimeout(()=>{if(process.env.SYNTHETIC_CREDENTIAL==='present')require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')},300);setTimeout(()=>{},1000)`;
    const leader = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(detached)}],{detached:true,stdio:'ignore',env:process.env});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref()`;
    const child = spawn(DIRECT_HELPER_EXECUTABLE, ["-c", DIRECT_HELPER_SCRIPT, randomUUID()], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stdin.end(
      JSON.stringify({
        argv: [process.execPath, "-e", leader],
        rootDir: process.cwd(),
        cwd: process.cwd(),
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          SYNTHETIC_CREDENTIAL: "present",
        },
        allowedEnvKeys: ["SYNTHETIC_CREDENTIAL"],
        dynamicEnvKeys: [],
        timeoutMs: 1000,
        stdoutMaxBytes: 1024,
        stderrMaxBytes: 1024,
      }),
    );
    await once(child, "close");
    const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { code: number; timedOut: boolean };
    assert.equal(envelope.code, 0);
    assert.equal(envelope.timedOut, false);
    const detachedPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    assert.throws(() => process.kill(detachedPid, 0), { code: "ESRCH" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(existsSync(marker), false);
    rmSync(marker, { force: true });
    rmSync(pidFile, { force: true });
  },
);

test("Sprites helper rejects malformed environment key arrays with a structured error", async () => {
  const child = spawn(DIRECT_HELPER_EXECUTABLE, ["-c", DIRECT_HELPER_SCRIPT, randomUUID()], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stdin.end(
    JSON.stringify({
      argv: [process.execPath],
      rootDir: process.cwd(),
      cwd: process.cwd(),
      env: {},
      allowedEnvKeys: [],
      dynamicEnvKeys: [{}],
      timeoutMs: 100,
      stdoutMaxBytes: 10,
      stderrMaxBytes: 10,
    }),
  );
  await once(child, "close");
  const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { error?: string };
  assert.equal(envelope.error, "invalid dynamic env keys");
});

test("Sprites helper does not expose spawn error details", async () => {
  const child = spawn(DIRECT_HELPER_EXECUTABLE, ["-c", DIRECT_HELPER_SCRIPT, randomUUID()], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  const marker = "secret-argv-marker";
  const executablePath = join(process.cwd(), `.direct-helper-${marker}`);
  writeFileSync(executablePath, `#!/not/installed/${marker}\n`);
  chmodSync(executablePath, 0o755);
  try {
    child.stdin.end(
      JSON.stringify({
        argv: [executablePath],
        rootDir: process.cwd(),
        cwd: process.cwd(),
        env: {},
        dynamicEnvKeys: [],
        timeoutMs: 100,
        stdoutMaxBytes: 10,
        stderrMaxBytes: 10,
      }),
    );
    await once(child, "close");
    const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { error?: string };
    assert.equal(envelope.error, "direct helper could not start executable");
    assert.equal(JSON.stringify(envelope).includes(marker), false);
  } finally {
    rmSync(executablePath, { force: true });
  }
});
