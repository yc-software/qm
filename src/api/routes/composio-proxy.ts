import {
  ACCOUNT_ID,
  type ComposioAccountRecord,
  EXECUTE_TIMEOUT_MS,
  activeRun,
  composioUserIds,
  credential,
  activeOwnedAccount,
  request,
  sendExecutionFailure,
  usableAccount,
} from "./composio.ts";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { sendJson } from "../http.ts";
import { APP_CONNECTION_ROUTES } from "../../connectors/app-connection-routes.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { createExactSecretValueMasker } from "../../security/secret-masking.ts";
import { errMessage, reportFailure } from "../../util/errors.ts";
import { audit } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const BLOCKED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "x-api-key",
]);
const PASSED_HEADERS = ["location", "retry-after", "etag", "content-disposition", "dropbox-api-result"];
const COMPOSIO_REQUEST_LIMIT_BYTES = 4_500_000;

function toolkitsFor(url: URL): string[] {
  return Object.entries(APP_CONNECTION_ROUTES)
    .filter(([, routes]) =>
      routes.some(([host, prefix]) => url.hostname === host && url.pathname.startsWith(prefix ?? "/")),
    )
    .map(([toolkit]) => toolkit);
}

const BASE_ROUTE_TTL_MS = 60 * 60_000;
const baseRoutes = new Map<string, { route: readonly [host: string, pathPrefix: string] | null; expiresAt: number }>();

async function baseRoute(
  ctx: ApiCtx,
  key: string,
  toolkit: string,
): Promise<readonly [host: string, pathPrefix: string] | null> {
  const cached = baseRoutes.get(toolkit);
  if (cached && cached.expiresAt > Date.now()) return cached.route;
  const info = await request(ctx, key, `/toolkits/${encodeURIComponent(toolkit)}`).catch(() => null);
  if (!info) return null;
  let route: readonly [string, string] | null = null;
  if (info.is_local_toolkit !== true && typeof info.base_url === "string" && !info.base_url.includes("{")) {
    const base = URL.canParse(info.base_url) ? new URL(info.base_url) : null;
    if (base && base.protocol === "https:" && !base.username && !base.password && !base.port && !base.search)
      route = [base.hostname, base.pathname.replace(/\/+$/, "") + "/"];
  }
  baseRoutes.set(toolkit, { route, expiresAt: Date.now() + BASE_ROUTE_TTL_MS });
  return route;
}

async function baseRouteReaches(ctx: ApiCtx, key: string, toolkit: string, url: URL): Promise<boolean> {
  if (Object.hasOwn(APP_CONNECTION_ROUTES, toolkit)) return false;
  const route = await baseRoute(ctx, key, toolkit);
  if (!route) return false;
  const [host, prefix] = route;
  return url.hostname === host && (url.pathname + "/").startsWith(prefix);
}

function allowedSummary(): string {
  return Object.entries(APP_CONNECTION_ROUTES)
    .map(([toolkit, routes]) => `${toolkit}: ${routes.map(([host, prefix]) => `${host}${prefix ?? ""}`).join(", ")}`)
    .join("; ");
}

interface ProxyInput {
  url: URL;
  method: string;
  headers: Array<{ name: string; value: string }>;
  body: unknown;
  bodyBase64: string | undefined;
  accountId: string | undefined;
}

const INPUT_KEYS = ["url", "method", "query", "headers", "body", "bodyBase64", "accountId"];

function parse(raw: unknown): ProxyInput | string {
  const body = raw as Record<string, unknown> | null;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !INPUT_KEYS.includes(k))
  )
    return `Supply only ${INPUT_KEYS.join(", ")}.`;
  let url: URL | null = null;
  try {
    if (typeof body.url === "string") url = new URL(body.url);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
    return "url must be an absolute https URL without credentials, port or fragment.";
  const method = body.method ?? "GET";
  if (typeof method !== "string" || !METHODS.has(method)) return `method must be one of ${[...METHODS].join(", ")}.`;
  if (body.query !== undefined) {
    if (!body.query || typeof body.query !== "object" || Array.isArray(body.query)) return "query must be an object.";
    for (const [name, value] of Object.entries(body.query)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (!["string", "number", "boolean"].includes(typeof item))
          return "query values must be strings, numbers, booleans, or lists of them.";
        url.searchParams.append(name, String(item));
      }
    }
  }
  const headers: Array<{ name: string; value: string }> = [];
  if (body.headers !== undefined) {
    if (!body.headers || typeof body.headers !== "object" || Array.isArray(body.headers))
      return "headers must be an object of strings.";
    for (const [name, value] of Object.entries(body.headers)) {
      if (typeof value !== "string") return "headers must be an object of strings.";
      if (BLOCKED_HEADERS.has(name.toLowerCase()))
        return `Do not send ${name}; the connection supplies authentication.`;
      headers.push({ name, value });
    }
  }
  if (body.body !== undefined && body.bodyBase64 !== undefined) return "Send body or bodyBase64, not both.";
  if (
    body.bodyBase64 !== undefined &&
    (typeof body.bodyBase64 !== "string" ||
      !body.bodyBase64 ||
      Buffer.from(body.bodyBase64, "base64").toString("base64") !== body.bodyBase64)
  )
    return "bodyBase64 must be standard padded base64.";
  if (body.accountId !== undefined && (typeof body.accountId !== "string" || !ACCOUNT_ID.test(body.accountId)))
    return "accountId must be a connection id from /v1/composio/connections.";
  return {
    url,
    method,
    headers,
    body: body.body,
    bodyBase64: body.bodyBase64 as string | undefined,
    accountId: body.accountId as string | undefined,
  };
}

async function pickAccount(
  ctx: ApiCtx,
  access: { key: string; principal: string },
  input: ProxyInput,
  toolkits: string[],
): Promise<string | null> {
  const reaches = async (toolkit: string) =>
    toolkits.length ? toolkits.includes(toolkit) : baseRouteReaches(ctx, access.key, toolkit, input.url);
  const notAllowed = (message: string) => {
    sendJson(ctx.res, 403, { error: "url_not_allowed", message });
    return null;
  };
  if (input.accountId) {
    const owned = await activeOwnedAccount(ctx, access, input.accountId);
    if (!owned) {
      sendJson(ctx.res, 403, { error: "connection_not_authorized" });
      return null;
    }
    if (!(await reaches(owned.toolkit)))
      return notAllowed(`A ${owned.toolkit} connection cannot call ${input.url.hostname}${input.url.pathname}.`);
    return input.accountId;
  }
  const userIds = composioUserIds(access.principal);
  const query = new URLSearchParams({
    user_ids: userIds.join(","),
    ...(toolkits.length ? { toolkit_slugs: toolkits.join(",") } : {}),
    statuses: "ACTIVE",
    limit: "100",
  });
  const data = await request(ctx, access.key, `/connected_accounts?${query}`);
  if (!Array.isArray(data.items)) throw new Error("Invalid accounts");
  const accounts: Array<ComposioAccountRecord & { id: string; toolkit: { slug: string } }> = [];
  for (const item of data.items as Array<ComposioAccountRecord | null>)
    if (usableAccount(item, userIds) && (await reaches(item.toolkit.slug))) accounts.push(item);
  if (accounts.length === 1) return accounts[0]!.id;
  if (accounts.length === 0) {
    if (!toolkits.length)
      return notAllowed(
        `No connected app's API covers ${input.url.hostname}${input.url.pathname}. Raw requests reach a connected app's own API base URL, or for these apps: ${allowedSummary()}. Connect the app (composio skill), or use /v1/composio/execute for apps without a REST base URL.`,
      );
    sendJson(ctx.res, 409, {
      error: "not_connected",
      toolkits,
      message: `No active ${toolkits.join(" or ")} connection. Ask the user to connect it (composio skill), then retry.`,
    });
  } else
    sendJson(ctx.res, 409, {
      error: "choose_account",
      accounts: accounts.map((item) => ({ id: item.id, toolkit: item.toolkit.slug })),
      message: "Several connections match. Ask which account to use and pass its accountId.",
    });
  return null;
}

async function relay(ctx: ApiCtx, accountId: string, result: Record<string, unknown>): Promise<void> {
  const status = typeof result.status === "number" && result.status >= 200 && result.status <= 599 ? result.status : 0;
  if (!status) throw new Error("Invalid proxy status");
  const upstream = Object.fromEntries(
    Object.entries((result.headers ?? {}) as Record<string, unknown>).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  const headers: Record<string, string> = { "x-composio-account": accountId };
  for (const name of PASSED_HEADERS) {
    const value = upstream[name];
    if (typeof value === "string") headers[name] = value;
  }
  const binary = result.binary_data as { url?: unknown; content_type?: unknown } | undefined;
  if (binary && typeof binary.url === "string") {
    const location = new URL(binary.url);
    if (location.protocol !== "https:" || location.username || location.password) throw new Error("Invalid file URL");
    const headersDeadline = new AbortController();
    const timer = setTimeout(
      () => headersDeadline.abort(new DOMException("File download did not start in time", "TimeoutError")),
      EXECUTE_TIMEOUT_MS,
    );
    const file = await (ctx.deps.composioFetch ?? fetch)(location.href, {
      redirect: "error",
      signal: headersDeadline.signal,
    }).finally(() => clearTimeout(timer));
    if (!file.ok || !file.body) throw new Error(`File download failed with status ${file.status}`);
    headers["content-type"] =
      typeof binary.content_type === "string" ? binary.content_type : "application/octet-stream";
    ctx.res.writeHead(status, headers);
    await pipeline(Readable.fromWeb(file.body as WebReadableStream), ctx.res);
    return;
  }
  let payload = "";
  if (typeof result.data === "string" && result.data) {
    payload = result.data;
    const type = upstream["content-type"];
    headers["content-type"] = typeof type === "string" ? type : "text/plain; charset=utf-8";
  } else if (result.data !== undefined && result.data !== null && result.data !== "") {
    payload = JSON.stringify(result.data);
    headers["content-type"] = "application/json";
  }
  ctx.res.writeHead(status, headers);
  ctx.res.end(payload);
}

async function proxy(ctx: ApiCtx): Promise<void> {
  if (!ctx.capability || ctx.actor) return sendJson(ctx.res, 403, { error: "agent_capability_required" });
  const access = await credential(ctx);
  if (!access) return;
  const input = parse(ctx.body);
  if (typeof input === "string") return sendJson(ctx.res, 400, { error: "invalid_request", message: input });
  const toolkits = toolkitsFor(input.url);
  const mask = createExactSecretValueMasker([access.key]);
  const resource = `${input.method} ${input.url.hostname}${input.url.pathname}`;
  let account: string | null = null;
  try {
    account = await pickAccount(ctx, access, input, toolkits);
    if (!account) return;
    if (!(await activeRun(ctx))) return;
    const contentType = input.headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
    const binaryBody =
      input.bodyBase64 ??
      (typeof input.body === "string" ? Buffer.from(input.body, "utf8").toString("base64") : undefined);
    let payload: Record<string, unknown> = {};
    if (binaryBody !== undefined)
      payload = { binary_body: { base64: binaryBody, ...(contentType ? { content_type: contentType } : {}) } };
    else if (input.body !== undefined) payload = { body: input.body };
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.proxy.started",
      resource: `${account}/${resource}`,
      scopeLabel: ctx.capability.scopeId,
    });
    const result = await request(
      ctx,
      access.key,
      "/tools/execute/proxy",
      {
        connected_account_id: account,
        endpoint: input.url.href,
        method: input.method,
        ...(input.headers.length
          ? { parameters: input.headers.map((h) => ({ name: h.name, value: h.value, type: "header" })) }
          : {}),
        ...payload,
      },
      EXECUTE_TIMEOUT_MS,
    );
    await relay(ctx, account, result);
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.proxy.completed",
      resource: `${account}/${resource}`,
      scopeLabel: ctx.capability.scopeId,
    });
  } catch (error) {
    if (account)
      audit(ctx.deps, {
        principalId: access.principal,
        action: "composio.proxy.failed",
        resource: `${account}/${resource}`,
        scopeLabel: ctx.capability.scopeId,
      });
    reportFailure("composio: proxy", new Error(mask(redactSecrets(errMessage(error)))), resource);
    if (ctx.res.headersSent) return void ctx.res.destroy();
    return sendExecutionFailure(ctx, error, mask, "composio_proxy_failed");
  }
}

export const composioProxyRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/composio/proxy",
    auth: "either",
    maxBodyBytes: COMPOSIO_REQUEST_LIMIT_BYTES,
    handle: proxy,
  },
];
