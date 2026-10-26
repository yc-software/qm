import { resolvePgCaTrust } from "../persistence/pg-pool.ts";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PORTAL_IDENTITY_HEADER } from "../auth/portal-identity.ts";
import { mintSignedPayload } from "../auth/signed-token.ts";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { loadConfig, type Config } from "../config.ts";
import { errMessage } from "../util/errors.ts";
import { sleep } from "../util/async.ts";

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

export async function stagingApiHeaders(
  principalId: string,
  sourceSecret: string,
  portalIdentitySecret: string,
  method: string,
  path: string,
  body = "",
  base: Record<string, string> = {},
  nowMs = Date.now(),
): Promise<Record<string, string>> {
  const portalIdentity = await mintSignedPayload({ p: principalId, exp: nowMs + 60_000 }, portalIdentitySecret);
  return signedRequestHeaders(
    sourceSecret,
    method,
    path,
    body,
    {
      ...base,
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
  timing: { now: () => number; sleep: (ms: number) => Promise<void>; timeout?: (ms: number) => AbortSignal } = {
    now: Date.now,
    sleep,
  },
): Promise<void> {
  const { orgId, portalIdentitySecret, signingSecret: sourceSecret } = config;
  if (!orgId) throw new Error("live session smoke requires ORG_ID");
  if (!sourceSecret) throw new Error("live session smoke requires CORE_SIGNING_SECRET");
  if (!portalIdentitySecret) throw new Error("live session smoke requires PORTAL_IDENTITY_SECRET");
  const principalId = firstAdminPrincipal(config.adminGrants);
  const root = baseUrl.replace(/\/+$/, "");
  const request = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    admin = false,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers = await stagingApiHeaders(
      principalId,
      sourceSecret,
      portalIdentitySecret,
      method,
      path,
      raw,
      admin ? { "x-admin-actor": `${principalId}@${orgId}` } : {},
    );
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: { ...headers, ...(raw ? { "content-type": "application/json" } : {}) },
      ...(raw ? { body: raw } : {}),
      ...(signal ? { signal } : {}),
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
    const titleDeadline = timing.now() + 60_000;
    const titleSignal = (timing.timeout ?? AbortSignal.timeout)(60_000);
    let persisted = (await request("GET", sessionPath, undefined, false, titleSignal)) as {
      session?: { title?: string | null };
      entries?: Array<{ type?: string }>;
    };
    while (!persisted.session?.title?.trim() && timing.now() < titleDeadline && !titleSignal.aborted) {
      await timing.sleep(Math.min(500, titleDeadline - timing.now()));
      if (timing.now() >= titleDeadline || titleSignal.aborted) break;
      persisted = (await request("GET", sessionPath, undefined, false, titleSignal)) as typeof persisted;
    }
    if (timing.now() >= titleDeadline || titleSignal.aborted || !persisted.session?.title?.trim())
      throw new Error("live session has no generated title");
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

type PostdeployConfig = Pick<
  Config,
  | "adminGrants"
  | "databaseUrl"
  | "databaseCaCert"
  | "databaseCaCertFile"
  | "orgId"
  | "portalIdentitySecret"
  | "signingSecret"
>;

async function checkDatabase(config: PostdeployConfig): Promise<void> {
  const { databaseUrl } = config;
  if (!databaseUrl) throw new Error("postdeploy smoke requires DATABASE_URL");
  const pg = (await import("pg")).default;
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
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
}

export async function runSessionSmoke(config: PostdeployConfig, baseUrl: string): Promise<void> {
  await checkLiveSession(config, baseUrl, (input, init) => {
    const timeout = AbortSignal.timeout(
      init?.method === "POST" && new URL(String(input)).pathname === "/v1/turns" ? 300_000 : 30_000,
    );
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout });
  });
  if (config.databaseUrl) await checkDatabase(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  await runSessionSmoke(config, process.argv[3] ?? `http://127.0.0.1:${config.port}`);
  console.log("database and live session smoke passed");
}
