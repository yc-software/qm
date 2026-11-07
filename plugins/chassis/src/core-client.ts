import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { signedRequestHeaders } from "./source-auth-sign.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

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
}): Promise<{ status: number; text: string }> {
  const path = withSourceAuthNonce(input.path, input.secret);
  const response = await fetch(`${input.origin}${path}`, {
    method: input.method,
    headers: { ...input.headers, ...signedHeaders(input.secret, input.method, path, input.body) },
    ...(input.body ? { body: input.body } : {}),
    signal: input.signal,
    redirect: "manual",
  });
  return { status: response.status, text: await response.text() };
}

export async function relayCoreDownload(
  res: ServerResponse,
  input: {
    origin: string;
    secret?: string;
    path: string;
    headers?: Record<string, string>;
    copyHeaders: string[];
    responseHeaders?: Record<string, string>;
  },
): Promise<void> {
  const path = withSourceAuthNonce(input.path, input.secret);
  const upstream = await fetch(`${input.origin}${path}`, {
    headers: { ...signedHeaders(input.secret, "GET", path, ""), ...input.headers },
    redirect: "manual",
  });
  const headers: Record<string, string> = { ...input.responseHeaders };
  for (const name of input.copyHeaders) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return void res.end();
  await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res).catch(() => undefined);
}
