import {
  ACCOUNT_ID,
  ComposioHttpError,
  activeRun,
  composioUserIds,
  credential,
  executeFailureCause,
  ownedAccount,
  request,
} from "./composio.ts";
import { sendJson } from "../http.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { createExactSecretValueMasker } from "../../security/secret-masking.ts";
import { errMessage, reportFailure } from "../../util/errors.ts";
import { audit } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

const PROXY_TOOLKIT_HOSTS: Readonly<Record<string, ReadonlyArray<readonly [host: string, pathPrefix?: string]>>> = {
  gmail: [["gmail.googleapis.com"]],
  googlecalendar: [["www.googleapis.com", "/calendar/"]],
  googletasks: [["www.googleapis.com", "/tasks/"]],
  googledrive: [
    ["www.googleapis.com", "/drive/"],
    ["www.googleapis.com", "/upload/drive/"],
  ],
  googledocs: [["docs.googleapis.com"]],
  googlesheets: [["sheets.googleapis.com"]],
  googleslides: [["slides.googleapis.com"]],
  dropbox: [["api.dropboxapi.com"], ["content.dropboxapi.com"]],
  linear: [["api.linear.app"]],
  zoom: [["api.zoom.us"]],
};

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
const PASSED_HEADERS = ["location", "retry-after", "etag", "content-disposition"];
const PROXY_TIMEOUT_MS = 90_000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

function toolkitsFor(url: URL): string[] {
  return Object.entries(PROXY_TOOLKIT_HOSTS)
    .filter(([, routes]) =>
      routes.some(([host, prefix]) => url.hostname === host && url.pathname.startsWith(prefix ?? "/")),
    )
    .map(([toolkit]) => toolkit);
}

function allowedSummary(): string {
  return Object.entries(PROXY_TOOLKIT_HOSTS)
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
    if (typeof body.url === "string" && body.url.length <= 8192) url = new URL(body.url);
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
      if (!/^[A-Za-z0-9-]{1,100}$/.test(name) || typeof value !== "string" || value.length > 8192)
        return "headers must be an object of strings.";
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
): Promise<{ id: string; userId: string } | null> {
  if (input.accountId) {
    const owned = await ownedAccount(ctx, access, input.accountId);
    if (!owned || owned.account.status !== "ACTIVE" || owned.account.is_disabled === true) {
      sendJson(ctx.res, 403, { error: "connection_not_authorized" });
      return null;
    }
    if (!toolkits.includes(owned.toolkit)) {
      sendJson(ctx.res, 403, {
        error: "url_not_allowed",
        message: `A ${owned.toolkit} connection cannot call ${input.url.hostname}${input.url.pathname}.`,
      });
      return null;
    }
    return { id: input.accountId, userId: String(owned.account.user_id) };
  }
  const userIds = composioUserIds(access.principal);
  const query = new URLSearchParams({
    user_ids: userIds.join(","),
    toolkit_slugs: toolkits.join(","),
    statuses: "ACTIVE",
    limit: "100",
  });
  const data = await request(ctx, access.key, `/connected_accounts?${query}`);
  if (!Array.isArray(data.items)) throw new Error("Invalid accounts");
  const accounts = (data.items as Array<Record<string, unknown> | null>).filter(
    (item): item is Record<string, unknown> =>
      !!item &&
      typeof item.id === "string" &&
      ACCOUNT_ID.test(item.id) &&
      userIds.includes(String(item.user_id)) &&
      item.status === "ACTIVE" &&
      item.is_disabled !== true &&
      toolkits.includes(String((item.toolkit as { slug?: unknown } | undefined)?.slug)),
  );
  if (accounts.length === 1) return { id: String(accounts[0]!.id), userId: String(accounts[0]!.user_id) };
  if (accounts.length === 0)
    sendJson(ctx.res, 409, {
      error: "not_connected",
      toolkits,
      message: `No active ${toolkits.join(" or ")} connection. Ask the user to connect it (composio skill), then retry.`,
    });
  else
    sendJson(ctx.res, 409, {
      error: "choose_account",
      accounts: accounts.map((item) => ({ id: item.id, toolkit: (item.toolkit as { slug?: unknown }).slug })),
      message: "Several connections match. Ask which account to use and pass its accountId.",
    });
  return null;
}

function tooLarge(ctx: ApiCtx): void {
  sendJson(ctx.res, 502, {
    error: "composio_proxy_failed",
    cause: "too_large",
    message: `The response is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB. Request a smaller range or export.`,
  });
}

async function relay(ctx: ApiCtx, accountId: string, result: Record<string, unknown>): Promise<boolean> {
  const status = typeof result.status === "number" && result.status >= 200 && result.status <= 599 ? result.status : 0;
  if (!status) throw new Error("Invalid proxy status");
  const upstream = (result.headers ?? {}) as Record<string, unknown>;
  const headers: Record<string, string> = { "x-composio-account": accountId };
  for (const name of PASSED_HEADERS) {
    const value = upstream[name];
    if (typeof value === "string") headers[name] = value;
  }
  const binary = result.binary_data as { url?: unknown; content_type?: unknown; size?: unknown } | undefined;
  let payload: Buffer | string = "";
  if (binary && typeof binary.url === "string") {
    const location = new URL(binary.url);
    if (location.protocol !== "https:" || location.username || location.password) throw new Error("Invalid file URL");
    if (typeof binary.size === "number" && binary.size > MAX_DOWNLOAD_BYTES) {
      tooLarge(ctx);
      return false;
    }
    const file = await (ctx.deps.composioFetch ?? fetch)(location.href, {
      redirect: "error",
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    if (!file.ok) throw new Error(`File download failed with status ${file.status}`);
    payload = Buffer.from(await file.arrayBuffer());
    if (payload.length > MAX_DOWNLOAD_BYTES) {
      tooLarge(ctx);
      return false;
    }
    headers["content-type"] =
      typeof binary.content_type === "string" ? binary.content_type : "application/octet-stream";
  } else if (typeof result.data === "string" && result.data) {
    payload = result.data;
    const type = upstream["content-type"];
    headers["content-type"] = typeof type === "string" ? type : "text/plain; charset=utf-8";
  } else if (result.data !== undefined && result.data !== null && result.data !== "") {
    payload = JSON.stringify(result.data);
    headers["content-type"] = "application/json";
  }
  ctx.res.writeHead(status, headers);
  ctx.res.end(payload);
  return true;
}

async function proxy(ctx: ApiCtx): Promise<void> {
  if (!ctx.capability || ctx.actor) return sendJson(ctx.res, 403, { error: "agent_capability_required" });
  const access = await credential(ctx);
  if (!access) return;
  const input = parse(ctx.body);
  if (typeof input === "string") return sendJson(ctx.res, 400, { error: "invalid_request", message: input });
  const toolkits = toolkitsFor(input.url);
  if (!toolkits.length)
    return sendJson(ctx.res, 403, {
      error: "url_not_allowed",
      message: `Raw requests only reach a connected app's own API (${allowedSummary()}). For other apps use /v1/composio/execute.`,
    });
  const mask = createExactSecretValueMasker([access.key]);
  const resource = `${input.method} ${input.url.hostname}${input.url.pathname}`;
  let account: { id: string; userId: string } | null = null;
  try {
    account = await pickAccount(ctx, access, input, toolkits);
    if (!account) return;
    if (!(await activeRun(ctx))) return;
    if (!composioUserIds(access.principal).includes(account.userId))
      return sendJson(ctx.res, 403, { error: "connection_not_authorized" });
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
      resource: `${account.id}/${resource}`,
      scopeLabel: ctx.capability.scopeId,
    });
    const result = await request(
      ctx,
      access.key,
      "/tools/execute/proxy",
      {
        connected_account_id: account.id,
        endpoint: input.url.href,
        method: input.method,
        ...(input.headers.length
          ? { parameters: input.headers.map((h) => ({ name: h.name, value: h.value, type: "header" })) }
          : {}),
        ...payload,
      },
      PROXY_TIMEOUT_MS,
    );
    const relayed = await relay(ctx, account.id, result);
    audit(ctx.deps, {
      principalId: access.principal,
      action: relayed ? "composio.proxy.completed" : "composio.proxy.failed",
      resource: `${account.id}/${resource}`,
      scopeLabel: ctx.capability.scopeId,
    });
  } catch (error) {
    if (account)
      audit(ctx.deps, {
        principalId: access.principal,
        action: "composio.proxy.failed",
        resource: `${account.id}/${resource}`,
        scopeLabel: ctx.capability.scopeId,
      });
    reportFailure("composio: proxy", new Error(mask(redactSecrets(errMessage(error)))), resource);
    if (ctx.res.headersSent) return void ctx.res.destroy();
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const providerStatus = error instanceof ComposioHttpError ? error.status : undefined;
    let message = "The request failed or its outcome is unknown. Do not automatically retry a write.";
    if (timedOut)
      message = "The request timed out. For reads, request less per call. Do not automatically retry a write.";
    if (providerStatus === 413)
      message =
        "The request body is too large for one call (about 3 MB of file data). Use the provider's chunked or resumable upload. Do not automatically retry a write.";
    return sendJson(ctx.res, 502, {
      error: "composio_proxy_failed",
      cause: executeFailureCause(error, timedOut),
      ...(providerStatus ? { providerStatus } : {}),
      message,
    });
  }
}

export const composioProxyRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/composio/proxy", auth: "either", maxBodyBytes: 6_000_000, handle: proxy },
];
