import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { SANDBOX_MODEL_AUD } from "../../auth/capability-token.ts";
import { gatewayRoot } from "../../model/provider-endpoints.ts";
import { SANDBOX_MODEL_PREFIX } from "../contract.ts";
import { pipeToResponse, sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

const ENDPOINTS = ["chat/completions", "responses", "messages"] as const;
type Endpoint = (typeof ENDPOINTS)[number];

const FORWARDED_HEADERS = ["accept", "anthropic-version", "anthropic-beta"];
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function redact(text: string, secret: string): string {
  const bare = secret.replace(/^\S+\s+/, "");
  return [secret, bare].filter((value) => value.length >= 8).reduce((out, value) => out.split(value).join("***"), text);
}

function endUser(actorId: string, secret: string): string {
  return createHmac("sha256", secret).update(actorId).digest("hex").slice(0, 32);
}

function attributed(endpoint: Endpoint, input: Record<string, unknown>, user: string): Record<string, unknown> {
  return endpoint === "messages" ? { ...input, metadata: { user_id: user } } : { ...input, user };
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

async function listModels(ctx: ApiCtx): Promise<void> {
  if (await denied(ctx)) return;
  const gateway = ctx.deps.modelGatewayTransport!;
  await gateway.refresh?.();
  sendJson(ctx.res, 200, {
    object: "list",
    data: Object.keys(gateway.models).map((id) => ({ id, object: "model", owned_by: "gateway" })),
  });
}

function forward(endpoint: Endpoint) {
  return async (ctx: ApiCtx): Promise<void> => {
    if (await denied(ctx)) return;
    const { deps, body, req, res, capability, secret } = ctx;
    const gateway = deps.modelGatewayTransport!;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as { model?: unknown }).model !== "string"
    )
      return sendJson(res, 400, { error: { message: "request body must be a JSON object with a model" } });
    const input = body as Record<string, unknown> & { model: string };
    await gateway.refresh?.();
    const target = gateway.models[input.model];
    if (!target)
      return sendJson(res, 400, {
        error: {
          message: `model "${input.model}" is not available; choose one of: ${Object.keys(gateway.models).join(", ")}`,
        },
      });
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
      const response = await fetch(`${gatewayRoot(gateway.url)}/v1/${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(
          attributed(
            endpoint,
            { ...input, model: target },
            endUser(capability!.actorId, deps.capabilitySecret ?? secret ?? ""),
          ),
        ),
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
      res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      pipeToResponse(res, Readable.fromWeb(response.body as WebReadableStream), "model stream failed");
    } catch {
      if (!res.headersSent)
        sendJson(res, 502, { error: { message: "the model gateway could not complete the request" } });
      else res.destroy();
    } finally {
      res.off("close", abort);
    }
  };
}

async function unsupported(ctx: ApiCtx): Promise<void> {
  sendJson(ctx.res, 404, {
    error: {
      message: `unsupported model endpoint; supported: GET /v1/models, ${ENDPOINTS.map((e) => `POST /v1/${e}`).join(", ")}`,
    },
  });
}

export const sandboxModelRoutes: Route[] = [
  { method: "GET", path: `${SANDBOX_MODEL_PREFIX}/v1/models`, auth: { aud: SANDBOX_MODEL_AUD }, handle: listModels },
  ...ENDPOINTS.map((endpoint) => ({
    method: "POST",
    path: `${SANDBOX_MODEL_PREFIX}/v1/${endpoint}`,
    auth: { aud: SANDBOX_MODEL_AUD },
    maxBodyBytes: MAX_BODY_BYTES,
    handle: forward(endpoint),
  })),
  {
    match: (_method, pathname) => pathname.startsWith(`${SANDBOX_MODEL_PREFIX}/`),
    auth: { aud: SANDBOX_MODEL_AUD },
    handle: unsupported,
  },
];
