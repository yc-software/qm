import http from "node:http";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.AGENT_PORT || 8080);
const MAX_BUFFER = 256 * 1024 * 1024;
const START_MS = Date.now();
const MAX_DIRECT_INPUT = 16 * 1024 * 1024;
const MAX_DIRECT_OUTPUT = 64 * 1024 * 1024;
const DEFAULT_DIRECT_OUTPUT = 4 * 1024 * 1024;
const DIRECT_RUNTIME_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DIRECT_DYNAMIC_ENV_KEYS = new Set([
  "AGENT_API_URL",
  "AGENT_API_TOKEN",
  "AGENT_OAUTH_CONSENT_TOKEN",
  "AGENT_CREDENTIAL_TOKEN",
  "AGENT_OUTBOX",
]);

function readBody(req, cap = MAX_BUFFER) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length });
  res.end(body);
}

async function handleExec(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const cmd = body.cmd;
  if (typeof cmd !== "string") return send(res, 400, { error: "missing cmd" });
  const timeoutMs = Math.max(1, Number(body.timeoutSec || 60)) * 1000;
  execFile(
    "/bin/sh",
    ["-c", cmd],
    { timeout: timeoutMs, maxBuffer: MAX_BUFFER, killSignal: "SIGKILL" },
    (err, stdout, stderr) => {
      const timedOut = !!(err && err.killed && err.signal === "SIGKILL");
      let code = 0;
      if (timedOut) code = 124;
      else if (err) code = typeof err.code === "number" ? err.code : 1;
      send(res, 200, { stdout: String(stdout), stderr: String(stderr), code, timedOut });
    },
  );
}

function directPath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value !== "/" &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value
      .split("/")
      .slice(1)
      .every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function confinedPath(rootDir, requested) {
  if (!directPath(rootDir) || !directPath(requested)) return null;
  const root = path.posix.normalize(rootDir);
  const candidate = path.posix.normalize(requested);
  const relative = path.posix.relative(root, candidate);
  if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) return null;
  return candidate;
}

function boundedDirectNumber(value, fallback, cap) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > cap) return null;
  return result;
}

async function handleExecv(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  if (
    !Array.isArray(body.argv) ||
    body.argv.length === 0 ||
    body.argv.length > 4096 ||
    body.argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    return send(res, 400, { error: "missing argv" });
  }
  if (!directPath(body.argv[0])) return send(res, 400, { error: "argv[0] must be a canonical executable path" });
  if (body.executablePath !== undefined && body.executablePath !== body.argv[0]) {
    return send(res, 400, { error: "executablePath must equal argv[0]" });
  }
  const rootDir = body.rootDir;
  if (!directPath(rootDir)) return send(res, 400, { error: "rootDir must be absolute" });
  const cwd = body.cwd === undefined ? rootDir : confinedPath(rootDir, body.cwd);
  if (!cwd) return send(res, 400, { error: "cwd must stay inside rootDir" });
  const suppliedEnv = body.env === undefined ? {} : body.env;
  if (!suppliedEnv || typeof suppliedEnv !== "object" || Array.isArray(suppliedEnv)) {
    return send(res, 400, { error: "env must be an object" });
  }
  const dynamicEnvKeys = body.dynamicEnvKeys === undefined ? [] : body.dynamicEnvKeys;
  if (
    !Array.isArray(dynamicEnvKeys) ||
    dynamicEnvKeys.some((key) => typeof key !== "string" || !DIRECT_DYNAMIC_ENV_KEYS.has(key)) ||
    new Set(dynamicEnvKeys).size !== dynamicEnvKeys.length
  ) {
    return send(res, 400, { error: "invalid dynamic env keys" });
  }
  const allowedEnvKeys = body.allowedEnvKeys === undefined ? [] : body.allowedEnvKeys;
  if (
    !Array.isArray(allowedEnvKeys) ||
    allowedEnvKeys.some(
      (key) =>
        typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key === "PATH" || key.startsWith("AGENT_"),
    ) ||
    new Set(allowedEnvKeys).size !== allowedEnvKeys.length
  ) {
    return send(res, 400, { error: "invalid allowed env keys" });
  }
  for (const [key, value] of Object.entries(suppliedEnv)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      (key === "PATH" && value !== DIRECT_RUNTIME_PATH) ||
      (key !== "PATH" && !dynamicEnvKeys.includes(key) && !allowedEnvKeys.includes(key)) ||
      (key.startsWith("AGENT_") && !dynamicEnvKeys.includes(key)) ||
      (dynamicEnvKeys.includes(key) && !DIRECT_DYNAMIC_ENV_KEYS.has(key)) ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      return send(res, 400, { error: "invalid env" });
    }
  }
  const timeoutMs = boundedDirectNumber(body.timeoutMs, 600000, 24 * 60 * 60 * 1000);
  const stdoutMaxBytes = boundedDirectNumber(body.stdoutMaxBytes, DEFAULT_DIRECT_OUTPUT, MAX_DIRECT_OUTPUT);
  const stderrMaxBytes = boundedDirectNumber(body.stderrMaxBytes, DEFAULT_DIRECT_OUTPUT, MAX_DIRECT_OUTPUT);
  if (timeoutMs === null || stdoutMaxBytes === null || stderrMaxBytes === null) {
    return send(res, 400, { error: "invalid direct execution limits" });
  }
  let stdin;
  if (body.stdinB64 !== undefined) {
    if (typeof body.stdinB64 !== "string") return send(res, 400, { error: "stdinB64 must be a string" });
    stdin = Buffer.from(body.stdinB64, "base64");
    if (stdin.length > MAX_DIRECT_INPUT) return send(res, 400, { error: "stdin exceeds the direct input limit" });
  }
  let rootReal;
  let cwdReal;
  let executableReal;
  try {
    rootReal = fs.realpathSync(rootDir);
    cwdReal = fs.realpathSync(cwd);
    executableReal = fs.realpathSync(body.argv[0]);
    if (cwdReal !== rootReal && !cwdReal.startsWith(`${rootReal}${path.sep}`)) {
      return send(res, 400, { error: "cwd escapes rootDir" });
    }
    if (executableReal !== body.argv[0] || !fs.statSync(executableReal).isFile()) {
      return send(res, 400, { error: "executable must be a canonical installed file" });
    }
  } catch {
    return send(res, 400, { error: "direct path is not available" });
  }
  const child = spawn(body.argv[0], body.argv.slice(1), {
    cwd: cwdReal,
    env: { ...suppliedEnv },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let timedOut = false;
  let outputLimitExceeded = false;
  let finished = false;
  const killTree = () => {
    if (finished || !child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(
    () => {
      if (!finished) {
        timedOut = true;
        killTree();
      }
    },
    Math.max(1, timeoutMs),
  );
  const abort = () => {
    killTree();
  };
  const take = (target, chunk, limit, stream) => {
    const remaining = Math.max(0, limit - target.size);
    if (remaining > 0) target.parts.push(chunk.subarray(0, remaining));
    target.size += chunk.length;
    if (target.size > limit) {
      outputLimitExceeded = true;
      stream.destroy();
      killTree();
    }
  };
  req.once("aborted", abort);
  res.once("close", abort);
  const outState = { parts: stdout, size: 0 };
  const errState = { parts: stderr, size: 0 };
  child.stdout.on("data", (chunk) => take(outState, chunk, stdoutMaxBytes, child.stdout));
  child.stderr.on("data", (chunk) => take(errState, chunk, stderrMaxBytes, child.stderr));
  child.stdin.end(stdin);
  child.once("error", () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    req.removeListener("aborted", abort);
    res.removeListener("close", abort);
    send(res, 200, { stdout: "", stderr: "direct executable could not be started", code: 127, timedOut: false });
  });
  child.once("close", (code, signal) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    req.removeListener("aborted", abort);
    res.removeListener("close", abort);
    let outputCode = code === null ? 1 : code;
    if (outputLimitExceeded) outputCode = 122;
    if (timedOut) outputCode = 124;
    send(res, 200, {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      code: outputCode,
      timedOut,
      stdoutTruncated: outState.size > stdoutMaxBytes,
      stderrTruncated: errState.size > stderrMaxBytes,
      outputLimitExceeded,
      signal: signal ?? undefined,
    });
  });
}

async function handleWrite(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  if (typeof body.path !== "string" || typeof body.b64 !== "string")
    return send(res, 400, { error: "need path + b64" });
  fs.mkdirSync(path.dirname(body.path), { recursive: true });
  fs.writeFileSync(body.path, Buffer.from(body.b64, "base64"));
  send(res, 200, { ok: true });
}

async function handleRead(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  if (typeof body.path !== "string") return send(res, 400, { error: "need path" });
  let buf;
  try {
    buf = fs.readFileSync(body.path);
  } catch {
    return send(res, 404, { error: "not found" });
  }
  send(res, 200, { b64: buf.toString("base64") });
}

const server = http.createServer((req, res) => {
  const route = (req.url || "").split("?")[0];
  (async () => {
    if (route === "/health")
      return send(res, 200, {
        ok: true,
        pid: process.pid,
        startMs: START_MS,
        uptimeSec: Math.round((Date.now() - START_MS) / 1000),
      });
    if (req.method === "POST" && route === "/exec") return handleExec(req, res);
    if (req.method === "POST" && route === "/execv") return handleExecv(req, res);
    if (req.method === "POST" && route === "/write") return handleWrite(req, res);
    if (req.method === "POST" && route === "/read") return handleRead(req, res);
    return send(res, 404, { error: "not found", route });
  })().catch((e) => send(res, 500, { error: String((e && e.message) || e) }));
});

server.listen(PORT, "0.0.0.0", () => console.log(`[microvm-agent] exec daemon listening on ${PORT}`));
