import { createServer as createNetServer } from "node:net";
import { parseEnv } from "node:util";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/api/server.ts";
import { PROVIDERS } from "../src/connectors/oauth.ts";
import { scopeId } from "../src/types.ts";
import { buildGoogleWorkspaceReadSmokeCommand } from "./google-workspace-read-smoke-command.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";

type Json = Record<string, unknown>;

function parseEnvFile(path: string): NodeJS.Dict<string> {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8"));
}

function loadEnvFallbacks(): string[] {
  const loaded: string[] = [];
  const paths = [
    resolve(".env"),
    resolve(".env.local"),
    process.env.GOOGLE_OAUTH_ENV_FILE ? resolve(process.env.GOOGLE_OAUTH_ENV_FILE) : "",
  ].filter(Boolean);
  for (const path of paths) {
    const parsed = parseEnvFile(path);
    if (Object.keys(parsed).length === 0) continue;
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    loaded.push(path);
  }
  return [...new Set(loaded)];
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolvePort(port));
    });
    server.on("error", reject);
  });
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${url}${last ? ` (${last})` : ""}`);
}

async function readJson(res: Response): Promise<Json> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error(`expected JSON from ${res.url}, got HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

function assertOk(res: Response, body: Json, label: string): void {
  if (!res.ok) {
    const error = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    const message = typeof body.message === "string" ? `: ${body.message}` : "";
    throw new Error(`${label} failed (${error}${message})`);
  }
}

function providerStatus(body: Json): { connected: boolean } {
  const providers = body.providers as Record<string, unknown> | undefined;
  const google = providers?.google as { connected?: unknown } | undefined;
  return { connected: google?.connected === true };
}

async function runWorkspaceReadSmoke(input: {
  built: ReturnType<typeof buildApp>;
  actor: string;
  orgId: string;
  hosts: string[];
}): Promise<void> {
  input.built.config.setEgress(scopeId("personal", input.actor), { allowedHosts: input.hosts });
  const result = await input.built.app.turn({
    surface: "test",
    actor: { externalId: input.actor, displayName: input.actor },
    conversation: { kind: "dm", threadRef: `google-oauth-read:${input.actor}:${Date.now()}` },
    text: `!run ${buildGoogleWorkspaceReadSmokeCommand()}`,
  });
  if (result.status !== "ok" || !result.reply?.includes("google read ok:")) {
    throw new Error(`Google Workspace read smoke failed: ${JSON.stringify(result)}`);
  }
  console.log(result.reply);
  console.log("connector_read: ok target=calendar-settings host=www.googleapis.com");
}

async function probeGoogleTokenEndpoint(redirectUri: string): Promise<string> {
  if (process.env.GOOGLE_OAUTH_SMOKE_SKIP_PROVIDER_PROBE === "1") return "skipped";
  const res = await fetch(PROVIDERS.google!.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: "qm-oauth-smoke-invalid-code",
      redirect_uri: redirectUri,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  const error = typeof body.error === "string" ? body.error : "";
  if (error === "invalid_client" || res.status === 401) {
    throw new Error("Google token endpoint rejected GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET");
  }
  if (error === "redirect_uri_mismatch") {
    throw new Error(`Google token endpoint rejected the redirect URI; register ${redirectUri}`);
  }
  return error || `http_${res.status}`;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolveStop) => {
    child.once("exit", () => resolveStop());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000).unref();
  });
}

const loadedEnv = loadEnvFallbacks();
const missing = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`google oauth smoke blocked: missing ${missing.join(", ")}`);
  console.error(
    "set them in .env.local, GOOGLE_OAUTH_ENV_FILE, or the process environment; secret values are never printed",
  );
  process.exit(2);
}

const provider = PROVIDERS.google;
if (!provider) throw new Error("google OAuth provider is not registered");

const interactive = process.env.GOOGLE_OAUTH_SMOKE_INTERACTIVE === "1";
const runReadAfterConnect = interactive && process.env.GOOGLE_OAUTH_SMOKE_SKIP_READ !== "1";
const actor = process.env.GOOGLE_OAUTH_SMOKE_PRINCIPAL ?? `google-oauth-smoke-${Date.now()}`;
const orgId = process.env.ORG_ID ?? "acme";
const secret = process.env.CORE_SIGNING_SECRET ?? `google-oauth-smoke-${randomUUID()}`;
const corePort = await freePort();
const webPort = await freePort();
const coreBase = `http://127.0.0.1:${corePort}`;
const webBase = `http://127.0.0.1:${webPort}`;
const redirectUri = `${webBase}/connectors/oauth/google/callback`;
const expectedRedirect = process.env.GOOGLE_OAUTH_REDIRECT_URI ?? process.env.GOOGLE_OAUTH_REGISTERED_REDIRECT_URI;

if (expectedRedirect && expectedRedirect !== redirectUri) {
  console.error(`google oauth smoke blocked: redirect URI mismatch`);
  console.error(`required redirect URI for this run: ${redirectUri}`);
  console.error("GOOGLE_OAUTH_REDIRECT_URI / GOOGLE_OAUTH_REGISTERED_REDIRECT_URI is set to a different value");
  process.exit(2);
}

const built = buildApp({
  ...loadConfig({}),
  port: corePort,
  dataDir: process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), "qm-google-oauth-smoke-")),
  orgId,
  sessionStore: "memory",
  runStore: "memory",
  harness: "mock",
});
const core = createServer(built.app, {
  signingSecret: secret,
  connectorTokens: built.connectorTokens,
  auditLog: built.auditLog,
  oauthEnv: process.env,
});

let web: ChildProcessWithoutNullStreams | null = null;
try {
  await new Promise<void>((resolveListen) => core.listen(corePort, "127.0.0.1", () => resolveListen()));
  web = spawn(process.execPath, ["plugins/web-ui/server/index.ts"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
      CORE_API_URL: coreBase,
      CORE_ORG_ID: orgId,
      CORE_SIGNING_SECRET: secret,
      PORT: String(webPort),
      WEB_UI_PUBLIC_URL: webBase,
      WEB_UI_PRINCIPALS: actor,
    },
  });
  web.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (!/WEB_UI_PRINCIPALS unset/.test(text)) process.stderr.write(`[web-ui] ${text}`);
  });
  await waitFor(`${webBase}/healthz`, 10_000);

  const identity = {
    [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: actor, exp: Date.now() + 10 * 60_000 }, secret),
  };

  const statusBefore = await fetch(`${webBase}/api/connectors`, { headers: identity });
  const statusBeforeBody = await readJson(statusBefore);
  assertOk(statusBefore, statusBeforeBody, "web connector status");

  const start = await fetch(`${webBase}/api/connectors/google/start`, { method: "POST", headers: identity });
  const startBody = await readJson(start);
  assertOk(start, startBody, "web connector start");
  const authorize = new URL(String(startBody.authorizeUrl ?? ""));
  if (authorize.origin + authorize.pathname !== provider.authUrl)
    throw new Error("Google consent URL has the wrong authorization endpoint");
  if (authorize.searchParams.get("redirect_uri") !== redirectUri)
    throw new Error("Google consent URL has the wrong redirect_uri");
  if (authorize.searchParams.get("client_id") !== process.env.GOOGLE_OAUTH_CLIENT_ID)
    throw new Error("Google consent URL has the wrong client_id");
  const state = authorize.searchParams.get("state");
  if (!state) throw new Error("Google consent URL is missing state");

  const forged = await fetch(
    `${webBase}/connectors/oauth/google/callback?code=forged-smoke-code&state=forged-smoke-state`,
    { redirect: "manual" },
  );
  if (forged.status !== 400)
    throw new Error(`web callback route did not forward/reject forged callback as expected (HTTP ${forged.status})`);
  const providerProbe = await probeGoogleTokenEndpoint(redirectUri);

  console.log("google oauth readiness ok");
  console.log(`env files considered: ${loadedEnv.length ? loadedEnv.join(", ") : "none"}`);
  console.log(`principal: ${actor}`);
  console.log(`redirect_uri: ${redirectUri}`);
  console.log(`hosts: ${provider.hosts.join(",")}`);
  console.log(`connected_before: ${providerStatus(statusBeforeBody).connected ? "yes" : "no"}`);
  console.log(`provider_probe: ${providerProbe}`);

  if (!interactive) {
    console.log("interactive_exchange: skipped (set GOOGLE_OAUTH_SMOKE_INTERACTIVE=1 to open the real consent flow)");
    console.log(
      "google oauth smoke complete: start/status/callback routing verified; external Google consent not attempted",
    );
  } else {
    const timeoutMs = Number(process.env.GOOGLE_OAUTH_SMOKE_TIMEOUT_MS ?? 180_000);
    console.log("Open this URL in a browser that can reach the redirect_uri:");
    console.log(authorize.toString());
    console.log(`waiting up to ${Math.round(timeoutMs / 1000)}s for Google to redirect back...`);
    const deadline = Date.now() + timeoutMs;
    let connected = false;
    while (Date.now() < deadline) {
      const status = await fetch(`${webBase}/api/connectors`, { headers: identity });
      const statusBody = await readJson(status);
      assertOk(status, statusBody, "web connector status during interactive wait");
      connected = providerStatus(statusBody).connected;
      if (connected) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!connected) {
      throw new Error(
        `interactive Google OAuth did not complete; confirm this redirect URI is registered in Google Cloud: ${redirectUri}`,
      );
    }
    console.log("interactive_exchange: connected");
    if (runReadAfterConnect) await runWorkspaceReadSmoke({ built, actor, orgId, hosts: provider.hosts });
    else console.log("connector_read: skipped (unset GOOGLE_OAUTH_SMOKE_SKIP_READ to run after interactive consent)");
    console.log("google oauth smoke complete: live Google callback stored a token without printing it");
  }
} finally {
  if (web) await stopChild(web);
  await closeServer(core);
  await built.runtime.stop();
}
