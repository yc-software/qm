import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { withSourceAuthNonce } from "../../plugins/chassis/src/core-client.ts";
import { stagingApiHeaders } from "../../src/deployment/postdeploy-smoke.ts";

const repoRoot = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const PLAYWRIGHT_VERSION = "1.65.1";
const toolsDir = join(homedir(), ".cache", "qm-qa");
const playwrightCli = join(toolsDir, "node_modules", "playwright", "cli.js");

function procEnv(pid) {
  const pairs = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
  return Object.fromEntries(pairs.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

function coreProcess() {
  if (!existsSync("/proc/self/environ")) throw new Error("finding the dev instance needs Linux /proc");
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      if (readlinkSync(`/proc/${pid}/cwd`) !== repoRoot) continue;
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("src/index.ts")) continue;
      const env = procEnv(pid);
      if (env.CORE_SIGNING_SECRET && env.PUBLIC_PORT && env.PORT) return env;
    } catch {
      continue;
    }
  }
  throw new Error(`no running dev instance for ${repoRoot}: start one with npm run dev-instance:web`);
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function connectInstance() {
  const env = coreProcess();
  const principal = env.PORTAL_DEV_PRINCIPAL;
  if (!principal) throw new Error("the dev instance has no PORTAL_DEV_PRINCIPAL, so its portal signs nobody in");
  const core = `http://127.0.0.1:${env.PORT}`;
  const api = async (method, route, body) => {
    const path = withSourceAuthNonce(route, env.CORE_SIGNING_SECRET);
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers = await stagingApiHeaders(
      principal,
      env.CORE_SIGNING_SECRET,
      env.PORTAL_IDENTITY_SECRET,
      method,
      path,
      raw,
    );
    const res = await fetch(`${core}${path}`, {
      method,
      headers: { ...headers, ...(raw ? { "content-type": "application/json" } : {}) },
      ...(raw ? { body: raw } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${text}`);
    return parseBody(text);
  };
  return { principal, portal: `http://localhost:${env.PUBLIC_PORT}`, api };
}

function loadFrom(dir) {
  return createRequire(join(dir, "noop.js"))("playwright");
}

export function loadPlaywright(browsers) {
  try {
    return loadFrom(toolsDir);
  } catch {
    mkdirSync(toolsDir, { recursive: true });
    console.error(`installing playwright ${PLAYWRIGHT_VERSION} and ${browsers.join(", ")} into ${toolsDir}`);
    const quiet = ["--no-audit", "--no-fund", "--loglevel=error"];
    execFileSync("npm", ["install", "--prefix", toolsDir, ...quiet, `playwright@${PLAYWRIGHT_VERSION}`], {
      stdio: "inherit",
    });
    execFileSync(process.execPath, [playwrightCli, "install", ...browsers], { stdio: "inherit" });
    return loadFrom(toolsDir);
  }
}

export async function launch(playwright, name, headed) {
  try {
    return await playwright[name].launch({ headless: !headed });
  } catch (err) {
    console.error(
      `${name} failed to start; install its system libraries with: sudo node ${playwrightCli} install-deps ${name}`,
    );
    throw err;
  }
}

export function outDir(kind) {
  const dir = join(toolsDir, "runs", `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function withPage(browser, dir, name, fn) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  const notes = [];
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("response", (res) => {
    const path = new URL(res.url()).pathname;
    if (res.status() >= 500) problems.push(`HTTP ${res.status()} ${res.request().method()} ${path}`);
    else if (res.status() >= 400 && path.startsWith("/api/"))
      notes.push(`HTTP ${res.status()} ${res.request().method()} ${path}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource"))
      notes.push(`console error: ${msg.text()}`);
  });
  const started = Date.now();
  let error = null;
  try {
    await fn(page, problems);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  let shot = join(dir, `${browser.browserType().name()}-${name}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch((err) => {
    notes.push(`screenshot failed: ${err.message}`);
    shot = null;
  });
  await context.close();
  const browserName = browser.browserType().name();
  return {
    browser: browserName,
    name,
    ok: !error && !problems.length,
    ms: Date.now() - started,
    error,
    problems,
    notes,
    shot,
  };
}

export function finish(dir, qa, results, started) {
  for (const r of results) {
    const detail = [r.error?.split("\n")[0], ...r.problems].filter(Boolean).join("; ");
    const notes = r.notes.length ? ` (${r.notes.length} notes in report.json)` : "";
    console.log(
      `${r.ok ? "PASS" : "FAIL"} ${r.browser} ${r.name} ${(r.ms / 1000).toFixed(1)}s${detail ? ` ${detail}` : ""}${notes}`,
    );
  }
  writeFileSync(join(dir, "report.json"), JSON.stringify({ portal: qa.portal, results }, null, 2));
  const passed = results.filter((r) => r.ok).length;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${passed}/${results.length} passed in ${secs}s; screenshots and report.json in ${dir}`);
  process.exit(passed === results.length ? 0 : 1);
}
