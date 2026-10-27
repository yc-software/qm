import { type IncomingMessage, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import {
  fetchCoreText,
  relayCoreStream,
  signedHeaders,
  withSourceAuthNonce,
  CAPABILITY_HEADER,
  type HttpMethod,
} from "../../chassis/src/core-client.ts";
import { json, readBody as readBodyCapped, sendBuffered } from "../../chassis/src/http.ts";
import { PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { createBrandingCache } from "../../chassis/src/branding.ts";
import { perEdgeTenant } from "../../chassis/src/tenant-hosts.ts";

import { CORE_API_URL as CORE, coreSigningSecret } from "../../chassis/src/env.ts";

export const enc = encodeURIComponent;

export const brandingCache = perEdgeTenant(() =>
  createBrandingCache(async () => {
    const r = await coreFetch("GET", "/v1/surface-config", "", 2_000);
    if (r.status !== 200) throw new Error(`surface-config ${r.status}`);
    const b = (JSON.parse(r.text) as { branding?: Record<string, unknown> }).branding;
    const keys = ["orgName", "accent", "mark", "markUrl", "selfLabel"];
    return Object.fromEntries(keys.flatMap((key) => (typeof b?.[key] === "string" ? [[key, b[key]]] : [])));
  }),
);

export const portalTokenStore = new AsyncLocalStorage<string | undefined>();

export const portalHeaders = (): Record<string, string> => {
  const token = portalTokenStore.getStore();
  return token ? { [PORTAL_IDENTITY_HEADER]: token } : {};
};

export function fetchCoreGet(path: string, init: RequestInit = {}, extra = portalHeaders()): Promise<Response> {
  const signed = withSourceAuthNonce(path, coreSigningSecret());
  return fetch(`${CORE}${signed}`, {
    ...init,
    headers: { ...signedHeaders(coreSigningSecret(), "GET", signed, ""), ...extra },
  });
}

export function pipeWeb(res: ServerResponse, body: ReadableStream): ServerResponse {
  const stream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroy());
  return stream.pipe(res);
}

export function pipeUpstream(res: ServerResponse, up: Response, names: string[], headers: Record<string, string> = {}) {
  for (const name of names) {
    const value = up.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(up.status, headers);
  return up.body ? pipeWeb(res, up.body) : res.end();
}

export function relay(res: ServerResponse, r: { status: number; text: string }): void {
  sendBuffered(res, r.status, { "content-type": "application/json", "x-content-type-options": "nosniff" }, r.text);
}

export function tryParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function coreJson<T>(res: ServerResponse, path: string): Promise<T | undefined> {
  const r = await coreFetch("GET", path);
  if (r.status !== 200) return void relay(res, r);
  const data = tryParse<T>(r.text);
  if (!data) json(res, 502, { error: "bad_core_response" });
  return data ?? undefined;
}

const MAX_BODY_BYTES = 1_000_000;

export const readBody = (req: IncomingMessage): Promise<string> => readBodyCapped(req, MAX_BODY_BYTES);

export async function coreFetch(
  method: HttpMethod,
  pathWithQuery: string,
  rawBody = "",
  timeoutMs?: number,
  headers = portalHeaders(),
): Promise<{ status: number; text: string }> {
  return fetchCoreText({
    origin: CORE,
    secret: coreSigningSecret(),
    method,
    path: pathWithQuery,
    body: rawBody,
    headers,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
}

export async function mintSessionCap(): Promise<{ token: string } | { status: number; text: string }> {
  const cap = await coreFetch("POST", "/v1/session-cap", "");
  if (cap.status !== 200) return { status: cap.status === 401 ? 401 : 503, text: cap.text };
  const token = tryParse<{ token?: string }>(cap.text)?.token;
  if (!token)
    return { status: 503, text: JSON.stringify({ error: "not_configured", message: "no session capability" }) };
  return { token };
}

export async function relayCore(
  res: ServerResponse,
  method: HttpMethod,
  path: string,
  body = "",
  headers = portalHeaders(),
): Promise<void> {
  return relayCoreStream(res, { origin: CORE, secret: coreSigningSecret(), method, path, body, headers });
}

export async function relayCap(
  res: ServerResponse,
  method: HttpMethod,
  pathWithQuery: string,
  rawBody = "",
): Promise<void> {
  const cap = await mintSessionCap();
  if (!("token" in cap)) return relay(res, cap);
  return relayCoreStream(res, {
    origin: CORE,
    method,
    path: pathWithQuery,
    body: rawBody,
    headers: { [CAPABILITY_HEADER]: cap.token },
  });
}

export async function readJson<T extends object>(
  req: IncomingMessage,
  res: ServerResponse,
  allowEmpty = true,
  maxBytes = MAX_BODY_BYTES,
): Promise<T | null> {
  const raw = await readBodyCapped(req, maxBytes);
  const parsed = raw || allowEmpty ? tryParse<unknown>(raw || "{}") : undefined;
  if (typeof parsed === "object" && parsed !== null) return parsed as T;
  json(res, 400, { error: "bad_request" });
  return null;
}

export interface WebCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  user: string;
  params: Record<string, string>;
}

export type WebRoute = { handle: (c: WebCtx) => unknown } & (
  { method: string; path: string } | { match: (method: string, pathname: string) => boolean }
);

export const corePathFor = (template: string, c: WebCtx): string =>
  template.replace(/^\/api\//, "/v1/").replace(/:(\w+)/g, (_, key: string) => enc(c.params[key]!));

export interface Relay {
  core?: string;
  to?: HttpMethod;
  who?: "principalId" | "viewer";
  query?: (c: WebCtx) => string | Record<string, string> | URLSearchParams;
  principal?: boolean;
  body?: object;
  pick?: readonly string[];
  strings?: boolean;
  read?: "json" | "strict";
  shape?: (p: Record<string, unknown>, c: WebCtx) => object;
  raw?: boolean;
  cap?: boolean;
  noStore?: boolean;
  gate?: (c: WebCtx) => Promise<boolean>;
}

async function relayBody(c: WebCtx, o: Relay): Promise<string | null> {
  if (o.raw) return readBody(c.req);
  if (o.body) return JSON.stringify(o.body);
  const head = o.principal ? { principalId: c.user } : {};
  if (!o.pick && !o.shape && !o.read) return o.principal ? JSON.stringify(head) : "";
  const p = o.read
    ? await readJson<Record<string, unknown>>(c.req, c.res, o.read === "json")
    : (JSON.parse((await readBody(c.req)) || "{}") as Record<string, unknown>);
  if (o.read && !p) return null;
  if (o.shape) return JSON.stringify({ ...head, ...o.shape(p!, c) });
  if (!o.pick) return JSON.stringify(p);
  const picked = o.pick.filter((k) => !o.strings || typeof p![k] === "string").map((k) => [k, p![k]]);
  return JSON.stringify({ ...head, ...Object.fromEntries(picked) });
}

export function relayRoute(method: HttpMethod, path: string, o: Relay = {}): WebRoute {
  return {
    method,
    path,
    handle: async (c) => {
      if (o.gate && !(await o.gate(c))) return;
      if (o.noStore) c.res.setHeader("Cache-Control", "no-store");
      const body = await relayBody(c, o);
      if (body === null) return;
      let target = corePathFor(o.core ?? path, c);
      if (o.who) target += `?${o.who}=${enc(c.user)}`;
      const query = o.query?.(c);
      const qs = typeof query === "string" ? query : query && new URLSearchParams(query).toString();
      if (qs) target += `?${qs}`;
      return (o.cap ? relayCap : relayCore)(c.res, o.to ?? method, target, body);
    },
  };
}

export function copyParams(
  c: WebCtx,
  keys: readonly string[],
  init: Record<string, string> = { principalId: c.user },
  keepEmpty = false,
  max = Infinity,
): URLSearchParams {
  const qs = new URLSearchParams(init);
  for (const key of keys) {
    const value = c.url.searchParams.get(key);
    if (value !== null && (keepEmpty || value)) qs.set(key, value.slice(0, max));
  }
  return qs;
}

export const route = (method: HttpMethod, path: string, handle: WebRoute["handle"]): WebRoute => ({
  method,
  path,
  handle,
});
