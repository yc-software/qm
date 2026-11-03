import { errMessage } from "../util/errors.ts";
import { CAPABILITY_HEADER } from "../api/contract.ts";

export interface SelfApiResponse {
  status: number;
  body: unknown;
  requestId?: string;
}

export type SelfApiCall = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<SelfApiResponse>;

export function createSelfApiCall(baseUrl: string, capability: string): SelfApiCall {
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  return async (method, path, body, signal) => {
    const [pathname = ""] = path.split("?");
    if (pathname.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error(`Invalid API path: ${path}`);
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { [CAPABILITY_HEADER]: capability, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal,
    });
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
    const result = { status: response.status, ...(requestId ? { requestId } : {}) };
    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw new Error(`HTTP ${response.status}${requestId ? ` request ${requestId}` : ""}: ${errMessage(error)}`, {
        cause: error,
      });
    }
    try {
      return { ...result, body: JSON.parse(raw) as unknown };
    } catch {
      return { ...result, body: raw };
    }
  };
}
