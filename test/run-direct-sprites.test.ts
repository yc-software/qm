import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.deepEqual(parsedUrl.searchParams.getAll("cmd").slice(0, 2), [DIRECT_HELPER_EXECUTABLE, "-e"]);
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
  const sandbox = createSpritesSandbox({} as WorkspaceStore, {
    token: "test-token",
    client: {
      getSprite: async () => ({}),
      createSprite: async () => {},
      deleteSprite: async () => {},
    },
    fetchImpl: async (_url, init) => {
      seenSignal = init?.signal ?? undefined;
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
});

test("Sprites helper path follows the image's copied Node runtime", () => {
  const dockerfile = readFileSync("fly/Dockerfile", "utf8");
  assert.match(dockerfile, /COPY --from=node-runtime \/usr\/local\/ \/usr\/local\//);
  assert.equal(DIRECT_HELPER_EXECUTABLE, "/usr/local/bin/node");
});

test("Sprites helper executes a bounded structured request with exact child env", async () => {
  const executablePath = process.execPath;
  const rootDir = process.cwd();
  const child = spawn(executablePath, ["-e", DIRECT_HELPER_SCRIPT], {
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

test("Sprites helper does not expose spawn error details", async () => {
  const child = spawn(process.execPath, ["-e", DIRECT_HELPER_SCRIPT], { stdio: ["pipe", "pipe", "ignore"] });
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
