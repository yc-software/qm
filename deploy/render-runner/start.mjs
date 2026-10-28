import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { cp, lchown, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request, ServerResponse } from "node:http";
import { connect } from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";
import { startSqliteBackup } from "./sqlite.mjs";

const SHUTDOWN_GRACE_MS = 20_000;
const READINESS_SWEEP_MS = 5_000;
const READINESS_MISSES = 3;
const APP_UID = 10001;
const APP_GID = 10001;

function git(args, cwd, env) {
  return new Promise((resolveGit, rejectGit) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => rejectGit(new Error(`Could not start Git for the app source: ${error.message}`)));
    child.on("exit", (code, signal) =>
      code === 0
        ? resolveGit(Buffer.concat(stdout).toString("utf8"))
        : rejectGit(
            new Error(
              `App source Git command failed (${signal ?? code}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
            ),
          ),
    );
  });
}

export async function prepareRenderApp(manifestPath, appDir, env = process.env) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const url = new URL(manifest.url);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    typeof manifest.token !== "string" ||
    !manifest.token ||
    /[\r\n\0]/.test(manifest.token) ||
    typeof manifest.commit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.commit) ||
    typeof manifest.entrypoint !== "string" ||
    !manifest.entrypoint.trim() ||
    manifest.entrypoint.includes("\0")
  )
    throw new Error("Invalid Render app source manifest");
  const staging = await mkdtemp(join(tmpdir(), "qm-render-source-"));
  const gitEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${manifest.token}`,
    GIT_CONFIG_KEY_1: "http.followRedirects",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
  };
  try {
    await git(["init", "--quiet"], staging, gitEnv);
    await git(["fetch", "--quiet", "--no-tags", "--depth=1", url.toString(), manifest.commit], staging, gitEnv);
    await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], staging, gitEnv);
    if ((await git(["rev-parse", "HEAD"], staging, gitEnv)).trim() !== manifest.commit)
      throw new Error("Render app source does not match the selected commit");
    await rm(join(staging, ".git"), { recursive: true });
    await mkdir(appDir, { recursive: true });
    for (const entry of await readdir(appDir)) await rm(join(appDir, entry), { recursive: true, force: true });
    await cp(staging, appDir, { recursive: true, verbatimSymlinks: true });
    return manifest.entrypoint;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function runRenderApp({
  manifestPath = "/etc/secrets/qm-render-artifact.json",
  appDir = "/app",
  dataDir = "/data",
  env = process.env,
  gatewayPort = 8080,
  appPort = 8081,
  shutdownGraceMs = SHUTDOWN_GRACE_MS,
  readinessSweepMs = READINESS_SWEEP_MS,
} = {}) {
  const gatewayToken = env.QM_RENDER_APP_TOKEN;
  if (typeof gatewayToken !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(gatewayToken))
    throw new Error("Render app requires a private gateway token");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest.readinessNonce !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(manifest.readinessNonce))
    throw new Error("Invalid Render app readiness nonce");
  const privileged = process.getuid?.() === 0;
  if (!privileged && manifestPath.startsWith("/etc/secrets/"))
    throw new Error("Render app runner must start as root to run the app as its own user");
  if (privileged) {
    const secret = await stat(manifestPath);
    if (secret.mode & 0o004 || secret.uid === APP_UID || (secret.mode & 0o040 && secret.gid === APP_GID))
      throw new Error(`Render app runner refuses a manifest the app user can read: ${manifestPath}`);
  }
  const entrypoint = await prepareRenderApp(manifestPath, appDir, env);
  const appEnv = { ...env, ...manifest.runtimeEnv, PORT: String(appPort), DATA_DIR: dataDir };
  delete appEnv.QM_RENDER_APP_TOKEN;
  if (privileged) {
    appEnv.HOME = "/home/app";
    appEnv.USER = "app";
    appEnv.LOGNAME = "app";
    const own = async (dir) => {
      await lchown(dir, APP_UID, APP_GID);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await own(path);
        else await lchown(path, APP_UID, APP_GID);
      }
    };
    await own(appDir);
  }
  for (const key of Object.keys(appEnv))
    if (key.startsWith("GIT_CONFIG_") || key === "GIT_ASKPASS" || key === "SSH_ASKPASS") delete appEnv[key];
  let appReady = false;
  let stopping = false;
  let missed = 0;
  let sweep;
  const listening = (timeoutMs) =>
    new Promise((settle) => {
      const socket = connect({ host: "127.0.0.1", port: appPort });
      const finish = (result) => {
        socket.destroy();
        settle(result);
      };
      socket.setTimeout(timeoutMs, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
  const server = createRenderAppGateway({
    token: gatewayToken,
    readinessNonce: manifest.readinessNonce,
    appPort,
    isReady: () => appReady,
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(gatewayPort, "0.0.0.0", ready);
  });
  let sqliteBackup;
  try {
    sqliteBackup = await startSqliteBackup({
      dataDir,
      env: { ...env, ...manifest.storageEnv },
      ...(privileged ? { uid: APP_UID, gid: APP_GID } : {}),
    });
  } catch (error) {
    await new Promise((done) => server.close(done));
    throw error;
  }
  const child = spawn("bash", ["-c", entrypoint], {
    cwd: appDir,
    env: appEnv,
    stdio: "inherit",
    detached: true,
    ...(privileged ? { uid: APP_UID, gid: APP_GID } : {}),
  });
  let spawnError;
  const completion = new Promise((resolveExit) => {
    child.on("error", (error) => {
      spawnError = error;
      resolveExit(1);
    });
    child.on("exit", (code, signal) => resolveExit(code ?? (signal === "SIGTERM" ? 143 : 1)));
  });
  const forward = (signal) => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
      return false;
    }
  };
  let shutdown;
  let shutdownTimer;
  const stop = (signal) => {
    if (shutdown) return shutdown;
    stopping = true;
    appReady = false;
    clearInterval(sweep);
    forward(signal);
    const deadline = Date.now() + shutdownGraceMs;
    shutdownTimer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      forward("SIGKILL");
    }, shutdownGraceMs);
    shutdown = Promise.all([
      new Promise((done) => server.close(() => done())),
      (async () => {
        while (Date.now() < deadline && forward(0)) await new Promise((done) => setTimeout(done, 50));
      })(),
    ]);
    return shutdown;
  };
  const term = () => {
    void stop("SIGTERM");
  };
  const interrupt = () => {
    void stop("SIGINT");
  };
  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);
  let failure;
  try {
    const deadline = Date.now() + 90_000;
    while (true) {
      sqliteBackup.assertRunning();
      if (spawnError) throw new Error(`Render app could not start: ${spawnError.message}`);
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Render app exited before it was ready (${child.signalCode ?? child.exitCode})`);
      if (await listening(1_000)) break;
      if (Date.now() >= deadline) throw new Error("Render app did not become ready");
      await new Promise((done) => setTimeout(done, 200));
    }
    appReady = !stopping;
    sweep = setInterval(async () => {
      if (stopping) return;
      if (await listening(1_000)) {
        missed = 0;
        appReady = !stopping;
      } else if (++missed >= READINESS_MISSES) appReady = false;
    }, readinessSweepMs);
    sweep.unref();
    return await Promise.race([
      completion,
      sqliteBackup.exited.then((error) => {
        throw error;
      }),
    ]);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await stop("SIGTERM");
    forward("SIGKILL");
    await completion;
    clearTimeout(shutdownTimer);
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
    await sqliteBackup.stop().catch((error) => {
      if (failure)
        throw new AggregateError([failure, error], `${failure.message}; backup shutdown failed: ${error.message}`);
      throw error;
    });
  }
}

export function createRenderAppGateway({ token, readinessNonce, appPort = 8081, isReady = () => true }) {
  const authorized = (req) => {
    const value = req.headers["x-qm-render-app-token"];
    if (typeof value !== "string") return false;
    const [expiresAt, signature = ""] = value.split(".");
    if (!/^[0-9]{1,15}$/.test(expiresAt) || Number(expiresAt) <= Date.now()) return false;
    const expected = createHmac("sha256", token).update(expiresAt).digest("base64url");
    return (
      Buffer.byteLength(signature) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    );
  };
  const options = (req) => {
    const headers = { ...req.headers };
    delete headers["x-qm-render-app-token"];
    return { hostname: "127.0.0.1", port: appPort, method: req.method, path: req.url, headers };
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/__qm_ready") {
      const ready = isReady();
      const headers = { "cache-control": "no-store" };
      if (ready && authorized(req)) headers["x-qm-render-app-ready"] = readinessNonce;
      res.writeHead(ready ? 204 : 503, headers).end();
      return;
    }
    if (!authorized(req)) {
      res.writeHead(403).end();
      return;
    }
    if (!isReady()) {
      res.writeHead(503).end();
      return;
    }
    const upstream = request(options(req), (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on("error", () => {
      if (req.aborted || res.destroyed) return;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    if (!authorized(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!isReady()) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    let upgraded = false;
    let clientClosed = false;
    const upstream = request(options(req));
    upstream.on("error", () => {
      if (clientClosed || socket.destroyed) return;
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    upstream.on("response", (res) => {
      const response = new ServerResponse(req);
      response.assignSocket(socket);
      response.on("finish", () => socket.end());
      response.on("error", () => socket.destroy());
      res.on("aborted", () => socket.destroy());
      response.writeHead(res.statusCode ?? 502, { ...res.headers, connection: "close" });
      res.pipe(response);
    });
    upstream.on("upgrade", (res, connection, upstreamHead) => {
      upgraded = true;
      socket.write(
        `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n${Object.entries(res.headers)
          .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((part) => `${key}: ${part}\r\n`))
          .join("")}\r\n`,
      );
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) connection.write(head);
      socket.on("error", () => connection.destroy());
      socket.on("close", () => connection.end());
      connection.on("error", () => socket.destroy());
      connection.on("close", () => socket.end());
      socket.pipe(connection).pipe(socket);
    });
    socket.on("end", () => {
      clientClosed = true;
      if (!upgraded) {
        upstream.destroy();
        socket.end();
      }
    });
    socket.on("close", () => {
      clientClosed = true;
      upstream.destroy();
    });
    upstream.end();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runRenderApp();
  } catch (error) {
    console.error(`Render app startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
