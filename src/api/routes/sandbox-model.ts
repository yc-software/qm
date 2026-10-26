import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { SANDBOX_MODEL_AUD } from "../../auth/capability-token.ts";
import { gatewayRoot } from "../../model/provider-endpoints.ts";
import { SANDBOX_MODEL_PREFIX } from "../contract.ts";
import { pipeToResponse, sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

const FORWARDED_HEADERS = ["accept", "content-type", "anthropic-version", "anthropic-beta"];
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function redact(text: string, secret: string): string {
  const bare = secret.replace(/^\S+\s+/, "");
  return [secret, bare].filter((value) => value.length >= 8).reduce((out, value) => out.split(value).join("***"), text);
}

function endUser(actorId: string, secret: string): string {
  return createHmac("sha256", secret).update(actorId).digest("hex").slice(0, 32);
}

function attributed(path: string, input: Record<string, unknown>, user: string): Record<string, unknown> {
  return path === "/v1/messages" ? { ...input, metadata: { user_id: user } } : { ...input, user };
}

async function denied(ctx: ApiCtx): Promise<boolean> {
  const { capability, deps, res } = ctx;
  if (capability?.aud !== SANDBOX_MODEL_AUD) {
    sendJson(res, 403, { error: { message: "sandbox model grant required" } });
    return true;
  }
  if (deps.config && (await deps.config.getSecurityPostureDurable(capability.scopeId)) === "strict") {
    sendJson(res, 403, { error: { message: "model requests are disabled in strict posture" } });
    return true;
  }
  if (!deps.modelGatewayTransport) {
    sendJson(res, 503, { error: { message: "no model gateway is configured" } });
    return true;
  }
  if (deps.budget && !(await deps.budget.check(capability.actorId)).allowed) {
    sendJson(res, 429, { error: { message: "your model budget for this window is spent" } });
    return true;
  }
  return false;
}

async function proxy(ctx: ApiCtx): Promise<void> {
  if (await denied(ctx)) return;
  const { deps, body, req, res, capability, secret, url, pathname, method } = ctx;
  const gateway = deps.modelGatewayTransport!;
  const path = pathname.slice(SANDBOX_MODEL_PREFIX.length);
  await gateway.refresh?.();
  if (method === "GET" && path === "/v1/models")
    return sendJson(res, 200, {
      object: "list",
      data: Object.keys(gateway.models).map((id) => ({ id, object: "model", owned_by: "gateway" })),
    });
  let payload = body;
  if (body && typeof body === "object" && !Array.isArray(body) && "model" in body) {
    const input = body as Record<string, unknown>;
    const target = typeof input.model === "string" ? gateway.models[input.model] : undefined;
    if (!target)
      return sendJson(res, 400, {
        error: {
          message: `model ${JSON.stringify(input.model)} is not available; choose one of: ${Object.keys(gateway.models).join(", ")}`,
        },
      });
    payload = attributed(
      path,
      { ...input, model: target },
      endUser(capability!.actorId, deps.capabilitySecret ?? secret ?? ""),
    );
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [gateway.apiKeyHeader]: gateway.apiKey,
  };
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  try {
    const response = await fetch(`${gatewayRoot(gateway.url)}${path}${url.search}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(payload) }),
      signal: controller.signal,
      redirect: "error",
    });
    const contentType = response.headers.get("content-type") ?? "application/json";
    if (!response.ok || !response.body) {
      const text = redact(await response.text(), gateway.apiKey).slice(0, MAX_ERROR_BYTES);
      const retryAfter = response.headers.get("retry-after");
      const status =
        response.status >= 500 || response.status === 401 || response.status === 403 ? 502 : response.status;
      res.writeHead(status, { "content-type": contentType, ...(retryAfter ? { "retry-after": retryAfter } : {}) });
      return void res.end(text);
    }
    res.writeHead(response.status, { "content-type": contentType, "cache-control": "no-store" });
    pipeToResponse(res, Readable.fromWeb(response.body as WebReadableStream), "model stream failed");
  } catch {
    if (!res.headersSent)
      sendJson(res, 502, { error: { message: "the model gateway could not complete the request" } });
    else res.destroy();
  } finally {
    res.off("close", abort);
  }
}

export const sandboxModelRoutes: Route[] = [
  {
    match: (_method, pathname) => pathname.startsWith(`${SANDBOX_MODEL_PREFIX}/`),
    auth: { aud: SANDBOX_MODEL_AUD },
    maxBodyBytes: MAX_BODY_BYTES,
    handle: proxy,
  },
];
