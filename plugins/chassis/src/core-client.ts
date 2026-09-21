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
  tenantId?: string,
): Record<string, string> {
  return signedRequestHeaders(
    secret,
    method,
    pathWithQuery,
    signatureTail,
    { "content-type": "application/json" },
    undefined,
    tenantId,
  );
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
  tenantId?: string;
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
        headers: {
          ...input.headers,
          ...signedHeaders(input.secret, input.method, path, input.body, input.body, input.tenantId),
        },
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
