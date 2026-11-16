import { SANDBOX_MODEL_AUD } from "../../auth/capability-token.ts";
import {
  gatewayActorId,
  gatewayKey,
  gatewayRoot,
  modelGatewayHeaders,
  type ModelGatewayTransportConfig,
} from "../../model/provider-endpoints.ts";
import { routeLabel } from "../../model/model-route.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import { createExactSecretValueMasker } from "../../security/secret-masking.ts";
import { reportFailure } from "../../util/errors.ts";
import { runtimeConfigBody } from "../runtime-config.ts";
import { respondChatCompletion } from "./chat-completion-response.ts";
import { SANDBOX_MODEL_PREFIX } from "../contract.ts";
import { sendJson } from "../http.ts";
import { relayStream } from "../../../plugins/chassis/src/http.ts";
import { tenantOf, type ApiCtx, type Route } from "./route.ts";

const FORWARDED_HEADERS = ["accept", "content-type", "anthropic-version", "anthropic-beta"];
const UPSTREAM_REQUEST_LIMIT_BYTES = 32 * 1024 * 1024;

function redactGatewayKey(apiKey: string): (text: string) => string {
  return createExactSecretValueMasker([apiKey, apiKey.slice(apiKey.lastIndexOf(" ") + 1)]);
}

function attributed(path: string, input: Record<string, unknown>, user: string): Record<string, unknown> {
  const { user: _user, ...rest } = input;
  if (path !== "/v1/messages") return { ...rest, user };
  const metadata =
    rest.metadata && typeof rest.metadata === "object" && !Array.isArray(rest.metadata) ? rest.metadata : {};
  return { ...rest, metadata: { ...metadata, user_id: user } };
}

async function denied(ctx: ApiCtx): Promise<boolean> {
  const { capability, deps, res } = ctx;
  if (capability?.aud !== SANDBOX_MODEL_AUD) {
    sendJson(res, 403, { error: { message: "sandbox model grant required" } });
    return true;
  }
  const [posture, budget] = await Promise.all([
    deps.config?.getSecurityPostureDurable(capability.scopeId),
    deps.budget?.check(tenantOf(ctx), capability.actorId),
  ]);
  if (posture === "strict") {
    sendJson(res, 403, { error: { message: "model requests are disabled in strict posture" } });
    return true;
  }
  if (budget && !budget.allowed) {
    sendJson(res, 429, { error: { message: "your model budget for this window is spent" } });
    return true;
  }
  return false;
}

function gatewayTarget(gateway: ModelGatewayTransportConfig | undefined, modelId: string): string | undefined {
  return gateway && Object.hasOwn(gateway.models, modelId) ? gateway.models[modelId] : undefined;
}

async function listModels(ctx: ApiCtx, gateway: ModelGatewayTransportConfig | undefined): Promise<void> {
  const { modelCatalog } = await runtimeConfigBody(ctx, ctx.capability!.scopeId);
  const data: Array<{ id: string; object: "model"; owned_by: string; endpoints?: string[] }> = Object.keys(
    gateway?.models ?? {},
  ).map((id) => ({ id, object: "model", owned_by: "gateway" }));
  for (const [id, meta] of Object.entries(modelCatalog))
    if (!gatewayTarget(gateway, id))
      data.push({
        id,
        object: "model",
        owned_by: meta.billing === "org_key" ? "organization" : "gateway",
        endpoints: ["/v1/chat/completions"],
      });
  sendJson(ctx.res, 200, { object: "list", data });
}

async function complete(ctx: ApiCtx, modelId: string, input: Record<string, unknown>): Promise<void> {
  const { deps, pathname, res, capability } = ctx;
  const error = (message: string) => ({ error: { message } });
  const route = await deps.modelRoutes!.route(modelId);
  if (!deps.modelRoutes!.servable(route)) return sendJson(res, 503, error(`${routeLabel(route)} has no credential`));
  if (pathname !== `${SANDBOX_MODEL_PREFIX}/v1/chat/completions` || input.stream === true)
    return sendJson(
      res,
      400,
      error(`${modelId} takes only non-streamed chat completions: POST $MODEL_GATEWAY_URL/v1/chat/completions`),
    );
  const result = await respondChatCompletion(
    ctx,
    { ...route, model: { ...route.model, input: ["text", "image"] } },
    input,
    "sandbox",
    error,
  );
  if (result && route.billing === "org_key")
    await deps.budget
      ?.record(tenantOf(ctx), capability!.actorId, estimateCostUsd(result.usage.prompt_tokens))
      .catch((e: unknown) => reportFailure("sandbox model: budget record", e, capability!.actorId));
}

async function proxy(ctx: ApiCtx): Promise<void> {
  if (await denied(ctx)) return;
  const { deps, body, req, res, capability, url, pathname, method } = ctx;
  const path = pathname.slice(SANDBOX_MODEL_PREFIX.length);
  const gateway = deps.modelGatewayTransport?.actorKey ? deps.modelGatewayTransport : undefined;
  await gateway?.refresh?.();
  if (method === "GET" && path === "/v1/models") return listModels(ctx, gateway);
  const input =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const requested = typeof input?.model === "string" ? input.model : undefined;
  const target = requested ? gatewayTarget(gateway, requested) : undefined;
  if (input && requested && !target && deps.modelRoutes) {
    const { models } = await runtimeConfigBody(ctx, capability!.scopeId);
    if (models.includes(requested)) return complete(ctx, requested, input);
  }
  if (!gateway || (input && Object.hasOwn(input, "model") && !target))
    return sendJson(res, 400, {
      error: {
        message: `model ${JSON.stringify(input?.model)} is not available; GET $MODEL_GATEWAY_URL/v1/models lists the models you can use`,
      },
    });
  let payload = body;
  if (input)
    payload = attributed(
      path,
      target ? { ...input, model: target } : input,
      gatewayActorId(capability!.actorId, gateway.actorKey!),
    );
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...modelGatewayHeaders(gateway, "sandbox"),
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
      const text = redactGatewayKey(gatewayKey(gateway))(await response.text());
      const retryAfter = response.headers.get("retry-after");
      const operatorFault = response.status >= 500 || response.status === 401 || response.status === 403;
      if (operatorFault) reportFailure("sandbox model: gateway refused", new Error(`${response.status} ${path}`), text);
      res.writeHead(operatorFault ? 502 : response.status, {
        "content-type": contentType,
        ...(retryAfter ? { "retry-after": retryAfter } : {}),
      });
      return void res.end(text);
    }
    res.writeHead(response.status, { "content-type": contentType, "cache-control": "no-store" });
    relayStream(response.body, res, {
      onError: (error) => {
        if (!controller.signal.aborted) reportFailure("sandbox model: gateway stream", error, path);
      },
    });
  } catch (error) {
    if (!controller.signal.aborted) reportFailure("sandbox model: gateway request", error, path);
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
    auth: { aud: SANDBOX_MODEL_AUD, bearer: true },
    maxBodyBytes: UPSTREAM_REQUEST_LIMIT_BYTES,
    handle: proxy,
  },
];
