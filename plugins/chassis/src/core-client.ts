import { signedRequestHeaders } from "./source-auth-sign.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const CAPABILITY_HEADER = "x-agent-capability";

export { signedRequestHeaders };

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
