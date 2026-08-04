import { resolvePgCaTrust } from "../persistence/pg-pool.ts";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PORTAL_IDENTITY_HEADER } from "../auth/portal-identity.ts";
import { mintSignedPayload } from "../auth/signed-token.ts";
import { signedRequestHeaders } from "../auth/source-auth-sign.ts";
import { loadConfig, type Config } from "../config.ts";
import { errMessage } from "../util/errors.ts";

export const PARALLEL_EXCEPTION_QUERY = `
  SELECT n.nspname AS schema_name, p.proname AS function_name
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE l.lanname = 'plpgsql'
    AND p.proparallel = 's'
    AND p.prosrc ~* '\\mEXCEPTION\\M'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
`;

export const INVALID_INDEX_QUERY = `
  SELECT n.nspname AS schema_name, c.relname AS index_name
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE (NOT i.indisvalid OR NOT i.indisready)
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
`;

export function firstAdminPrincipal(raw: string | undefined): string {
  const principal = raw
    ?.split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.endsWith(":org_admin"))
    ?.slice(0, -":org_admin".length)
    .trim();
  if (!principal) throw new Error("postdeploy smoke requires ADMIN_GRANTS with an org_admin");
  return principal;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function deployedHealthUrls(flyAppName: string | undefined, publicWebUrl: string | undefined): string[] {
  if (!flyAppName?.endsWith("-core")) throw new Error("postdeploy smoke requires FLY_APP_NAME ending in -core");
  if (!publicWebUrl) throw new Error("postdeploy smoke requires PUBLIC_WEB_URL");
  const prefix = flyAppName.slice(0, -"-core".length);
  return [
    "http://127.0.0.1:8080/healthz",
    `http://${prefix}-admin.internal:8080/healthz`,
    `http://${prefix}-web-ui.flycast/healthz`,
    `http://${prefix}-portal.internal:8080/healthz`,
    new URL("/healthz", publicWebUrl).toString(),
  ];
}

export async function checkDeployedHealth(urls: string[], fetchImpl: FetchLike = fetch): Promise<void> {
  for (const url of urls) {
    const response = await fetchImpl(url, { redirect: "manual" });
    if (!response.ok) throw new Error(`deployed staging health ${url} returned ${response.status}`);
  }
}

export async function checkSlackCredentials(
  botToken: string | undefined,
  appToken: string | undefined,
  apiUrl: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (!botToken) throw new Error("postdeploy smoke requires SLACK_BOT_TOKEN");
  if (!appToken) throw new Error("postdeploy smoke requires SLACK_APP_TOKEN");
  const root = (apiUrl ?? "https://slack.com").replace(/\/+$/, "");
  const base = root.endsWith("/api") ? `${root}/` : `${root}/api/`;
  for (const [method, token] of [
    ["auth.test", botToken],
    ["apps.connections.open", appToken],
  ] as const) {
    const response = await fetchImpl(`${base}${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const result = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || result.ok !== true) {
      throw new Error(`staging Slack ${method} failed: ${result.error ?? `HTTP ${response.status}`}`);
    }
  }
}

export async function stagingApiHeaders(
  orgId: string,
  principalId: string,
  sourceSecret: string,
  portalIdentitySecret: string,
  path: string,
  nowMs = Date.now(),
): Promise<Record<string, string>> {
  const portalIdentity = await mintSignedPayload({ p: principalId, exp: nowMs + 60_000 }, portalIdentitySecret);
  return signedRequestHeaders(
    sourceSecret,
    "GET",
    path,
    "",
    {
      "x-admin-actor": `${principalId}@${orgId}`,
      [PORTAL_IDENTITY_HEADER]: portalIdentity,
    },
    Math.floor(nowMs / 1000),
  );
}

type LiveSessionConfig = Pick<Config, "adminGrants" | "orgId" | "portalIdentitySecret" | "signingSecret">;

export async function checkLiveSession(
  config: LiveSessionConfig,
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const { orgId, portalIdentitySecret, signingSecret: sourceSecret } = config;
  if (!orgId) throw new Error("live session smoke requires ORG_ID");
  if (!sourceSecret) throw new Error("live session smoke requires CORE_SIGNING_SECRET");
  if (!portalIdentitySecret) throw new Error("live session smoke requires PORTAL_IDENTITY_SECRET");
  const principalId = firstAdminPrincipal(config.adminGrants);
  const root = baseUrl.replace(/\/+$/, "");
  const request = async (method: "GET" | "POST", path: string, body?: unknown, admin = false): Promise<unknown> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers = admin
      ? await stagingApiHeaders(orgId, principalId, sourceSecret, portalIdentitySecret, path)
      : signedRequestHeaders(sourceSecret, method, path, raw);
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: { ...headers, ...(raw ? { "content-type": "application/json" } : {}) },
      ...(raw ? { body: raw } : {}),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`live session ${method} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`live session ${method} ${path} returned unparseable JSON`);
    }
  };

  const nonce = randomUUID();
  const expectedReply = "QM deployment canary passed.";
  const threadRef = `web:${principalId}:deployment-canary-${nonce}`;
  let turn: { status?: string; sessionId?: string; reply?: string } | undefined;
  let failure: unknown;
  try {
    turn = (await request("POST", "/v1/turns", {
      surface: "web",
      actor: { externalId: principalId },
      conversation: { kind: "dm", threadRef },
      text: `Reply with exactly: ${expectedReply}`,
      origin: { kind: "human" },
      addressed: true,
      readOnly: true,
      skipMemory: true,
      idempotencyKey: nonce,
    })) as { status?: string; sessionId?: string; reply?: string };
    if (!turn.sessionId) throw new Error(`live session model turn failed with status ${turn.status ?? "missing"}`);
    if (turn.status !== "ok") throw new Error(`live session model turn failed with status ${turn.status ?? "missing"}`);
    if (turn.reply?.trim() !== expectedReply) throw new Error("live session received an unexpected model reply");

    const sessionPath = `/v1/sessions/${encodeURIComponent(turn.sessionId)}?viewer=${encodeURIComponent(principalId)}&tailTurns=1`;
    const persisted = (await request("GET", sessionPath)) as {
      session?: { title?: string | null };
      entries?: Array<{ type?: string }>;
    };
    if (!persisted.session?.title?.trim()) throw new Error("live session has no generated title");
    if (!persisted.entries?.some((entry) => entry.type === "user"))
      throw new Error("live session has no persisted user turn");
    if (!persisted.entries.some((entry) => entry.type === "assistant")) {
      throw new Error("live session has no persisted assistant turn");
    }

    const errorsPath = `/v1/admin/errors?scope=${encodeURIComponent(`personal:${principalId}`)}&sessionId=${encodeURIComponent(turn.sessionId)}`;
    const logged = (await request("GET", errorsPath, undefined, true)) as { errors?: unknown[] };
    if (!Array.isArray(logged.errors)) throw new Error("live session error log response has no errors array");
    if (logged.errors.length) throw new Error(`live session recorded ${logged.errors.length} error event(s)`);
  } catch (error) {
    failure = error;
  }
  let sessionId = turn?.sessionId;
  if (!sessionId) {
    try {
      const sessionsPath = `/v1/admin/sessions?scope=${encodeURIComponent(`personal:${principalId}`)}&category=all&limit=200`;
      const listed = (await request("GET", sessionsPath, undefined, true)) as {
        sessions?: Array<{ id?: string; threadRef?: string }>;
      };
      sessionId = listed.sessions?.find((session) => session.threadRef === threadRef)?.id;
    } catch (error) {
      if (failure)
        throw new AggregateError(
          [failure, error],
          `${errMessage(failure)}; session recovery failed: ${errMessage(error)}`,
          { cause: error },
        );
      throw error;
    }
  }
  if (sessionId) {
    try {
      await request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}`, { principalId, archived: true });
    } catch (error) {
      if (failure)
        throw new AggregateError(
          [failure, error],
          `${errMessage(failure)}; session archive failed: ${errMessage(error)}`,
          { cause: error },
        );
      throw error;
    }
  }
  if (failure) throw failure;
}

async function checkApi(
  orgId: string,
  principalId: string,
  sourceSecret: string,
  portalIdentitySecret: string,
  port: string,
): Promise<void> {
  const path = `/v1/admin/sessions?scope=${encodeURIComponent(`org:${orgId}`)}&limit=5&_smoke=${randomUUID()}`;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: await stagingApiHeaders(orgId, principalId, sourceSecret, portalIdentitySecret, path),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`staging session API returned ${response.status}: ${body.slice(0, 500)}`);
  const parsed = JSON.parse(body) as { sessions?: unknown[] };
  if (!Array.isArray(parsed.sessions)) throw new Error("staging session API response has no sessions array");
}

type PostdeployConfig = Pick<
  Config,
  | "adminGrants"
  | "databaseUrl"
  | "databaseCaCert"
  | "databaseCaCertFile"
  | "flyAppName"
  | "orgId"
  | "port"
  | "portalIdentitySecret"
  | "publicWebUrl"
  | "signingSecret"
  | "slack"
>;

async function runPostdeploySmoke(config: PostdeployConfig): Promise<void> {
  const { databaseUrl, orgId, portalIdentitySecret, signingSecret: sourceSecret } = config;
  if (!databaseUrl) throw new Error("postdeploy smoke requires DATABASE_URL");
  if (!orgId) throw new Error("postdeploy smoke requires ORG_ID");
  if (!sourceSecret) throw new Error("postdeploy smoke requires CORE_SIGNING_SECRET");
  if (!portalIdentitySecret) throw new Error("postdeploy smoke requires PORTAL_IDENTITY_SECRET");

  const pg = (await import("pg")).default;
  const client = new pg.Client({
    connectionString: databaseUrl,
    ...resolvePgCaTrust({
      ...(config.databaseCaCert ? { cert: config.databaseCaCert } : {}),
      ...(config.databaseCaCertFile ? { certFile: config.databaseCaCertFile } : {}),
    }),
  });
  await client.connect();
  try {
    const unsafe = await client.query(PARALLEL_EXCEPTION_QUERY);
    if (unsafe.rows.length) {
      throw new Error(`parallel-safe PL/pgSQL exception handlers: ${JSON.stringify(unsafe.rows)}`);
    }
    const invalid = await client.query(INVALID_INDEX_QUERY);
    if (invalid.rows.length) throw new Error(`invalid PostgreSQL indexes: ${JSON.stringify(invalid.rows)}`);
  } finally {
    await client.end();
  }

  await checkApi(
    orgId,
    firstAdminPrincipal(config.adminGrants),
    sourceSecret,
    portalIdentitySecret,
    String(config.port),
  );
  await checkDeployedHealth(deployedHealthUrls(config.flyAppName, config.publicWebUrl));
  await checkSlackCredentials(config.slack?.botToken, config.slack?.appToken, config.slack?.apiUrl);
  console.log("deployed staging database, API, services, public route, and Slack smoke passed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  if (process.argv[2] === "session") {
    await checkLiveSession(config, process.argv[3] ?? `http://127.0.0.1:${config.port}`);
    console.log("live session smoke passed");
  } else {
    await runPostdeploySmoke(config);
  }
}
