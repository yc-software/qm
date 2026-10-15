#!/usr/bin/env node
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createLockServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync, chmodSync } from "node:fs";
import { request, createServer, setGlobalProxyFromEnv } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBrowserService } from "./browser-service.mjs";
import { formatBrowserError } from "./browser-errors.mjs";
import { ensurePlaywright } from "./playwright-runtime.mjs";
import { parseArgs } from "node:util";
setGlobalProxyFromEnv();
const API = (process.env.BROWSER_USE_API_BASE ?? "https://api.browser-use.com").replace(/\/+$/, "");
const KEY = process.env.BROWSER_USE_API_KEY;
const DIR = process.env.QM_BROWSE_DIR ?? join(tmpdir(), "qm-browse");
const IDLE_MS = Number(process.env.QM_BROWSE_IDLE_MS ?? 15 * 60000);
const MAX_OUTPUT = 10_000;
const PROVIDER_LIFETIME_MINUTES = 60;
const print = (obj) => console.log(JSON.stringify(obj));
function fail(obj, code = 1) {
  print({ ok: false, ...obj });
  process.exit(code);
}
const paths = (session) => ({
  sock: join(DIR, `${session}.sock`),
  state: join(DIR, `${session}.json`),
});
async function api(method, path, body) {
  const init = { method, headers: { "X-Browser-Use-API-Key": KEY ?? "" } };
  if (body) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, { ...init, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
async function preflight() {
  if (!KEY) return { ok: false, reason: "missing_key" };
  let r;
  try {
    r = await api("GET", "/api/v2/billing/account");
  } catch (err) {
    return { ok: false, reason: "unreachable", error: String(err?.cause?.message ?? err?.message ?? err) };
  }
  if (r.status === 401 || r.status === 403)
    return { ok: false, reason: "key_rejected", status: r.status, detail: r.json };
  if (r.status === 402) return { ok: false, reason: "no_credits", status: r.status, detail: r.json };
  if (r.status !== 200) return { ok: false, reason: "api_error", status: r.status, detail: r.json };
  const balanceUsd = r.json?.totalCreditsBalanceUsd;
  if (typeof balanceUsd === "number" && balanceUsd <= 0) return { ok: false, reason: "no_credits", balanceUsd };
  return {
    ok: true,
    balanceUsd,
    activeSessions: r.json?.activeSessionCount,
    sessionLimit: r.json?.concurrentSessionLimit,
  };
}
async function stopBrowser(id) {
  try {
    const r = await api("PATCH", `/api/v4/browsers/${encodeURIComponent(id)}`, { action: "stop" });
    return { stopped: (r.status >= 200 && r.status < 300) || r.status === 404, status: r.status, detail: r.json };
  } catch (err) {
    return { stopped: false, error: String(err?.cause?.message ?? err?.message ?? err) };
  }
}
function call(sock, path, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body ?? {});
    const req = request(
      { socketPath: sock, path, method: "POST", headers: { "content-type": "application/json" }, timeout: timeoutMs },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve({ ok: false, error: text });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`daemon did not answer within ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(data);
  });
}
function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (text += c));
    process.stdin.on("end", () => resolve(text));
  });
}
async function open(session, values) {
  if (process.platform !== "linux") fail({ error: "Browser service requires a Linux sandbox" });
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const key = createHash("sha256")
    .update(join(realpathSync(DIR), session))
    .digest("hex");
  const lock = createLockServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      lock.once("error", reject);
      lock.listen(`\0qm-browse-open-${key}`, resolve);
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    fail({ error: `session "${session}" is opening; wait for that command to finish` });
  }
  try {
    return await openLocked(session, values);
  } finally {
    lock.close();
  }
}
async function openLocked(session, values) {
  const p = paths(session);
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (existsSync(p.sock)) {
    const live = await call(p.sock, "/health", {}, 5000).catch((error) => {
      if (["ECONNREFUSED", "ENOENT"].includes(error.code)) return null;
      fail({
        reason: "daemon_health_unknown",
        error: `Existing browser did not answer; it was not stopped or replaced: ${error.message}`,
      });
    });
    if (live) fail({ error: `session "${session}" is already open; stop it first`, liveUrl: live.liveUrl });
  }
  const pre = await preflight();
  if (!pre.ok) fail(pre, 2);
  if (existsSync(p.state)) {
    const stale = JSON.parse(readFileSync(p.state, "utf8"));
    const s = await stopBrowser(stale.id);
    if (!s.stopped) fail({ reason: "stale_browser_not_stopped", browserId: stale.id, ...s });
    rmSync(p.state, { force: true });
  }
  await ensurePlaywright();
  const country = values.country ?? "us";
  const body = {
    proxyCountryCode: country === "none" ? null : country,
    timeout: PROVIDER_LIFETIME_MINUTES,
    allowResizing: true,
  };
  if (values.profile) body.profileId = values.profile;
  const created = await api("POST", "/api/v4/browsers", body);
  if (created.status !== 200 && created.status !== 201) {
    fail({ reason: "create_failed", status: created.status, detail: created.json }, created.status === 402 ? 2 : 1);
  }
  const ready = await daemon(session, created.json);
  print({ ok: true, session, ...ready });
}
async function daemon(session, created) {
  process.umask(0o077);
  const p = paths(session);
  const { id, cdpUrl, liveUrl, startedAt, timeoutAt } = created;
  const endpoints = [cdpUrl];
  const privateError = (error) => formatBrowserError(error, [...endpoints, KEY]);
  let stopping = null;
  let worker;
  let browser;
  let pendingJs;
  const finishJs = (message) => {
    if (!pendingJs) return;
    clearTimeout(pendingJs.timer);
    const { resolve } = pendingJs;
    pendingJs = null;
    const cause = browser.getError();
    resolve(cause ? { ...message, error: privateError(cause) } : message);
  };
  const shutdown = (why) =>
    (stopping ??= Promise.resolve().then(async () => {
      worker?.kill("SIGKILL");
      try {
        await browser?.close();
      } catch (error) {
        console.error(`browser disconnect failed: ${privateError(error)}`);
      }
      const cause = browser?.getError();
      console.error(`stopping browser ${id}: ${why}${cause ? `: ${privateError(cause)}` : ""}`);
      const s = await stopBrowser(id);
      if (!s.stopped) console.error(`stop failed: ${JSON.stringify(s)}`);
      rmSync(p.sock, { force: true });
      if (s.stopped) rmSync(p.state, { force: true });
      return s;
    }));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(sig).then(() => process.exit(0)));
  try {
    writeFileSync(p.state, JSON.stringify({ id, cdpUrl, liveUrl, startedAt, timeoutAt }), { mode: 0o600 });
    const lifetimeMs = Date.parse(timeoutAt) - Date.parse(startedAt);
    if (!(lifetimeMs > 0 && lifetimeMs <= PROVIDER_LIFETIME_MINUTES * 60_000 && Date.parse(timeoutAt) > Date.now()))
      throw new Error("Provider did not confirm a browser lifetime bounded to 60 minutes");
    browser = await startBrowserService(cdpUrl, { provider: true, browserId: id, api });
    endpoints.push(browser.endpoint);
    browser.on("disconnected", (error) => {
      if (stopping) return;
      finishJs({ error: error ? privateError(error) : "Browser disconnected; browser stopped" });
      shutdown("disconnected").then(() => process.exit(0));
    });
    const listTabs = () =>
      browser.browser
        .contexts()
        .flatMap((context) => context.pages())
        .map((page) => ({
          id: page._guid,
          url: page.url(),
          title: "",
        }));
    if (!listTabs().length) {
      const context = browser.browser.contexts()[0] ?? (await browser.browser.newContext());
      await context.newPage();
    }
    const modulePath = await ensurePlaywright();
    worker = fork(fileURLToPath(new URL("./js-runtime.mjs", import.meta.url)), [browser.endpoint, modulePath], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      execArgv: [...process.execArgv, "--unhandled-rejections=strict"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    let initialized = false;
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const readyTimer = setTimeout(
      () => readyReject(new Error("JavaScript browser client initialization timed out")),
      30_000,
    );
    worker.on("message", (message) => {
      if (message.type === "ready") {
        clearTimeout(readyTimer);
        readyResolve();
      } else if (message.type === "fatal") {
        if (!initialized) return readyReject(new Error(message.error));
        finishJs({ error: message.error });
        shutdown("unhandled asynchronous error").then(() => process.exit(1));
      } else if (message.type === "result" && pendingJs?.id === message.id) {
        finishJs(message);
      }
    });
    worker.on("exit", () => {
      clearTimeout(readyTimer);
      readyReject(new Error("JavaScript browser client exited during initialization"));
      if (stopping || !initialized) return;
      finishJs({ error: "JavaScript process exited; browser stopped" });
      shutdown("JavaScript process exited").then(() => process.exit(1));
    });
    await ready;
    initialized = true;
    let sequence = 0;
    const runJs = (code, timeoutMs = 90_000) =>
      new Promise((resolve) => {
        const id = ++sequence;
        const timer =
          timeoutMs === 0
            ? null
            : setTimeout(() => {
                pendingJs = null;
                resolve({
                  error: `JavaScript exceeded ${timeoutMs / 1000} seconds; browser stopped. Inspect before retrying any action.`,
                });
                worker.kill("SIGKILL");
              }, timeoutMs);
        pendingJs = { id, resolve, timer };
        worker.send({ type: "js", id, code });
      });
    let idle;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => shutdown("idle").then(() => process.exit(0)), IDLE_MS);
    };
    touch();
    const handlers = {
      "/health": async () => ({
        ok: true,
        browserId: id,
        liveUrl,
        tabs: listTabs(),
        capabilities: browser.capabilities,
      }),
      "/js": async ({ code, timeoutMs = 90_000 }) => {
        if (typeof code !== "string" || code.length > 50_000)
          throw new Error("code must be a string under 50,000 characters");
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)
          throw new Error("timeoutMs must be an integer from 0 to 2147483647");
        const { result, output, error } = await runJs(code, timeoutMs);
        const failed = error !== undefined;
        const text = String(error ?? result ?? "undefined");
        const resultText = text.slice(0, MAX_OUTPUT);
        const consoleText = (output ?? "").slice(0, MAX_OUTPUT - resultText.length);
        return {
          ok: !failed,
          ...(failed ? { error: resultText } : { result: resultText }),
          output: consoleText,
          truncated: text.length + (output?.length ?? 0) > MAX_OUTPUT,
        };
      },
      "/screenshot": async ({ path }) => {
        const out = path || join(DIR, `${session}-${Date.now()}.png`);
        const { result, error } = await runJs(`await tab.screenshot(${JSON.stringify(out)})`);
        if (error !== undefined) throw new Error(error);
        return { ok: true, path: result };
      },
      "/stop": async () => {
        const s = await shutdown("stop requested");
        setImmediate(() => process.exit(0));
        return { ok: s.stopped, browserId: id, ...s };
      },
    };
    let queue = Promise.resolve();
    const server = createServer((req, res) => {
      let text = "";
      req.on("data", (c) => {
        text += c;
        if (text.length > 100000) req.destroy();
      });
      req.on("end", () => {
        const handle = async () => {
          if (res.destroyed || stopping) return res.destroy();
          const activity = req.url !== "/health";
          if (activity) clearTimeout(idle);
          let body;
          try {
            const handler = handlers[req.url];
            if (!handler) throw new Error(`unknown command ${req.url}`);
            body = await handler(JSON.parse(text || "{}"));
          } catch (err) {
            body = { ok: false, error: String(err?.stack ?? err) };
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
          if (activity) touch();
        };
        if (["/stop", "/health"].includes(req.url)) void handle();
        else
          queue = queue.then(handle).catch((err) => {
            console.error(err.message);
            res.destroy();
            touch();
          });
      });
    });
    rmSync(p.sock, { force: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(p.sock, () => {
        chmodSync(p.sock, 0o600);
        resolve();
      });
    });
    return { browserId: id, liveUrl, timeoutAt, tabs: listTabs(), capabilities: browser.capabilities };
  } catch (error) {
    const stop = await shutdown("initialization failed");
    fail({ reason: "connect_failed", browserId: id, stop, error: privateError(error) });
  }
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      session: { type: "string", default: "default" },
      profile: { type: "string" },
      country: { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const [cmd, arg] = positionals;
  const session = values.session;
  if (!/^[\w-]{1,64}$/.test(session)) fail({ error: "session must be letters, digits, - or _" });
  const p = paths(session);
  switch (cmd) {
    case "preflight": {
      const r = await preflight();
      print(r);
      process.exit(r.ok ? 0 : 2);
      break;
    }
    case "open":
      return open(session, values);
    case "js": {
      const code = arg === undefined || arg === "-" ? await readStdin() : arg;
      const timeoutMs = Number(values["timeout-ms"] ?? 90_000);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)
        fail({ error: "timeout-ms must be an integer from 0 to 2147483647" });
      const r = await call(
        p.sock,
        "/js",
        { code, timeoutMs },
        timeoutMs === 0 ? 0 : Math.min(timeoutMs + 30_000, 2_147_483_647),
      ).catch((err) =>
        fail({ error: existsSync(p.sock) ? `daemon call failed: ${err.message}` : `no open browser: ${err.message}` }),
      );
      print(r);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case "screenshot": {
      const r = await call(p.sock, "/screenshot", { path: arg }).catch((err) =>
        fail({ error: existsSync(p.sock) ? `daemon call failed: ${err.message}` : `no open browser: ${err.message}` }),
      );
      print(r);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case "stop": {
      const r = await call(p.sock, "/stop", {}, 30000).catch((err) => {
        if (existsSync(p.sock)) console.error(`daemon unreachable, stopping directly: ${err.message}`);
        return null;
      });
      if (r?.ok) return print(r);
      if (r) console.error(`daemon stop failed: ${JSON.stringify(r)}`);
      if (!existsSync(p.state)) return print({ ok: true, stopped: false, note: "no open browser" });
      const { id } = JSON.parse(readFileSync(p.state, "utf8"));
      const s = await stopBrowser(id);
      rmSync(p.sock, { force: true });
      if (s.stopped) rmSync(p.state, { force: true });
      print({ ok: s.stopped, browserId: id, ...s });
      process.exit(s.stopped ? 0 : 1);
      break;
    }
    default:
      fail({
        error:
          "usage: browser.mjs preflight | open [--profile ID] [--country us|none] | js CODE|- | screenshot [PATH] | stop  (all accept --session NAME)",
      });
  }
}
await main();
