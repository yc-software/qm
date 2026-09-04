import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.AGENT_PORT || 8080);
const MAX_BUFFER = 256 * 1024 * 1024;
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
    return send(res, 404, { error: "not found", route });
  })().catch((e) => send(res, 500, { error: String((e && e.message) || e) }));
});

server.listen(PORT, "0.0.0.0", () => console.log(`[microvm-agent] exec daemon listening on ${PORT}`));
