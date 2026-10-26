import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { reportBackendError } from "./error-reporting.ts";
import { gzipAccepted, withVary } from "./http.ts";
import { signedRequestHeaders } from "./source-auth-sign.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const CAPABILITY_HEADER = "x-agent-capability";

export function signedHeaders(
  secret: string | undefined,
  method: string,
  pathWithQuery: string,
  rawBody = "",
  signatureTail = rawBody,
): Record<string, string> {
  return signedRequestHeaders(secret, method, pathWithQuery, signatureTail, { "content-type": "application/json" });
}

export function withSourceAuthNonce(pathWithQuery: string, secret: string | undefined): string {
  if (!secret) return pathWithQuery;
  const url = new URL(pathWithQuery, "http://core.local");
  url.searchParams.set("_sourceAuthNonce", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return `${url.pathname}${url.search}`;
}

export async function fetchCoreText(input: {
  origin: string;
  secret?: string;
  method: HttpMethod;
  path: string;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  retrySafeRead?: boolean;
}): Promise<{ status: number; text: string }> {
  if (input.retrySafeRead && (input.method !== "GET" || input.body)) {
    throw new Error("Core read retries require a bodyless GET");
  }
  const signal = input.signal ?? (input.retrySafeRead ? AbortSignal.timeout(30_000) : undefined);
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const path = withSourceAuthNonce(input.path, input.secret);
    let phase = "headers";
    let requestId: string | null = null;
    let status: number | undefined;
    try {
      const response = await fetch(`${input.origin}${path}`, {
        method: input.method,
        headers: { ...input.headers, ...signedHeaders(input.secret, input.method, path, input.body) },
        ...(input.body ? { body: input.body } : {}),
        signal,
        redirect: "manual",
      });
      status = response.status;
      phase = "body";
      requestId = response.headers.get("x-request-id");
      return { status: response.status, text: await response.text() };
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      const retry =
        input.retrySafeRead === true &&
        attempt === 0 &&
        !signal?.aborted &&
        (status === undefined || (status >= 200 && status < 300)) &&
        typeof code === "string" &&
        ["UND_ERR_SOCKET", "ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(code);
      if (input.retrySafeRead)
        console.warn("core_read_interrupted", {
          status,
          phase,
          attempt: attempt + 1,
          code: typeof code === "string" ? code : "unknown",
          requestId: requestId?.slice(0, 128),
          retry,
          aborted: signal?.aborted,
        });
      if (!retry) throw error;
    }
  }
}

export async function relayCoreStream(
  res: ServerResponse,
  input: {
    origin: string;
    secret?: string;
    method: HttpMethod;
    path: string;
    body?: string;
    headers?: Record<string, string>;
  },
): Promise<void> {
  const path = withSourceAuthNonce(input.path, input.secret);
  const body = input.body ?? "";
  const url = new URL(`${input.origin}${path}`);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const browserGone = new AbortController();
  const onClose = () => browserGone.abort();
  res.once("close", onClose);
  let upstream: IncomingMessage;
  try {
    upstream = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = send(
        url,
        {
          method: input.method,
          signal: AbortSignal.any([browserGone.signal, AbortSignal.timeout(300_000)]),
          headers: {
            ...input.headers,
            ...signedHeaders(input.secret, input.method, path, body),
            "accept-encoding": gzipAccepted(res.req) ? "gzip" : "identity",
            ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}),
          },
        },
        resolve,
      );
      req.on("error", reject);
      req.end(body || undefined);
    });
  } catch (error) {
    if (browserGone.signal.aborted) return;
    throw error;
  } finally {
    res.off("close", onClose);
  }
  upstream.once("error", (error: Error & { code?: string }) => {
    if (res.destroyed) return;
    const detail = {
      method: input.method,
      path: url.pathname,
      status: upstream.statusCode,
      requestId: upstream.headers["x-request-id"],
      code: error.code ?? error.name,
      cause: String(error.cause ?? error.message),
    };
    console.warn("core_relay_interrupted", detail);
    reportBackendError(error, "core_relay_interrupted", detail);
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
    vary: withVary(res, "accept-encoding"),
  };
  for (const name of ["content-encoding", "content-length"] as const) {
    const value = upstream.headers[name];
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.statusCode ?? 502, headers);
  await pipeline(upstream, res).catch(() => undefined);
}
