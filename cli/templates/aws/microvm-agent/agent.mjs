import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.AGENT_PORT || 8080);
const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_ATTEST_EXECUTABLE = 1024 * 1024;
const START_MS = Date.now();

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

export function readAttestedExecutable(binary, root = "/usr/local/bin") {
  if (typeof binary !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(binary)) {
    throw new Error("invalid binary");
  }
  const canonicalRoot = fs.realpathSync(root);
  const target = path.join(root, binary);
  const canonicalTarget = path.join(canonicalRoot, binary);
  const before = fs.lstatSync(target);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > MAX_ATTEST_EXECUTABLE ||
    (before.mode & 0o111) === 0
  ) {
    throw new Error("invalid executable");
  }
  if (fs.realpathSync(target) !== canonicalTarget) throw new Error("invalid executable path");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_ATTEST_EXECUTABLE || (opened.mode & 0o111) === 0) {
      throw new Error("invalid executable");
    }
    const bytes = Buffer.allocUnsafe(MAX_ATTEST_EXECUTABLE + 1);
    let length = 0;
    for (;;) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > MAX_ATTEST_EXECUTABLE) throw new Error("executable too large");
    }
    return { bytes: bytes.subarray(0, length), mode: opened.mode & 0o777 };
  } finally {
    fs.closeSync(fd);
  }
}

async function handleAttestExecutable(req, res) {
  const body = JSON.parse((await readBody(req, 1024)).toString("utf8") || "{}");
  try {
    const { bytes, mode } = readAttestedExecutable(body.binary);
    return send(res, 200, { b64: bytes.toString("base64"), size: bytes.length, mode });
  } catch (error) {
    return send(res, 409, { error: error instanceof Error ? error.message : "attestation failed" });
  }
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
    if (req.method === "POST" && route === "/write") return handleWrite(req, res);
    if (req.method === "POST" && route === "/read") return handleRead(req, res);
    if (req.method === "POST" && route === "/attest-executable") return handleAttestExecutable(req, res);
    return send(res, 404, { error: "not found", route });
  })().catch((e) => send(res, 500, { error: String((e && e.message) || e) }));
});

if (import.meta.main) {
  server.listen(PORT, "0.0.0.0", () => console.log(`[microvm-agent] exec daemon listening on ${PORT}`));
}
