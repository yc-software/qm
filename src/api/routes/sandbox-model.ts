import { SANDBOX_MODEL_AUD } from "../../auth/capability-token.ts";
import { gatewayActorId, gatewayKey, gatewayRoot, modelGatewayHeaders } from "../../model/provider-endpoints.ts";
import { ChatCompletionError, completeChatRequest } from "../../model/chat-completion.ts";
import { routeLabel } from "../../model/model-route.ts";
import { createExactSecretValueMasker } from "../../security/secret-masking.ts";
import { errMessage, reportFailure } from "../../util/errors.ts";
import { runtimeConfigBody } from "../runtime-config.ts";
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

async function companyModels(ctx: ApiCtx): Promise<Record<string, "model_gateway" | "org_key">> {
  const { modelCatalog } = await runtimeConfigBody(ctx, ctx.capability!.scopeId);
  return Object.fromEntries(
    Object.entries(modelCatalog).map(([id, meta]) => [id, meta.billing === "org_key" ? "org_key" : "model_gateway"]),
  );
}

async function listModels(ctx: ApiCtx): Promise<void> {
  const gateway = ctx.deps.modelGatewayTransport?.actorKey ? ctx.deps.modelGatewayTransport : undefined;
  await gateway?.refresh?.();
  const company = await companyModels(ctx);
  const data: Array<{ id: string; object: "model"; owned_by: string; endpoints?: string[] }> = Object.keys(
    gateway?.models ?? {},
  )
    .filter((id) => company[id] !== "org_key")
    .map((id) => ({ id, object: "model", owned_by: "gateway" }));
  for (const [id, billing] of Object.entries(company))
    if (!data.some((model) => model.id === id))
      data.push({
        id,
        object: "model",
        owned_by: billing === "org_key" ? "organization" : "gateway",
        endpoints: ["/v1/chat/completions"],
      });
  sendJson(ctx.res, 200, { object: "list", data });
}

async function complete(ctx: ApiCtx, modelId: string, input: Record<string, unknown>): Promise<void> {
  const { deps, pathname, res } = ctx;
  if (pathname !== `${SANDBOX_MODEL_PREFIX}/v1/chat/completions` || input.stream === true)
    return sendJson(res, 400, {
      error: {
        message: `${modelId} is served through core's chat completions only: POST $MODEL_GATEWAY_URL/v1/chat/completions without stream`,
      },
    });
  const route = deps.modelRoutes && deps.modelRoutes.servable(await deps.modelRoutes.route(modelId));
  if (!route) return sendJson(res, 503, { error: { message: `${modelId} has no credential configured` } });
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  try {
    sendJson(res, 200, await completeChatRequest(route, input, controller.signal, "sandbox"));
  } catch (error) {
    if (error instanceof ChatCompletionError) return sendJson(res, error.status, { error: { message: error.message } });
    if (controller.signal.aborted) return;
    reportFailure("sandbox model: completion", error, routeLabel(route));
    if (!res.destroyed)
      sendJson(res, 502, {
        error: { message: `${routeLabel(route)} could not complete the request: ${errMessage(error)}` },
      });
  } finally {
    res.off("close", abort);
  }
}

async function proxy(ctx: ApiCtx): Promise<void> {
  if (await denied(ctx)) return;
  const { deps, body, req, res, capability, url, pathname, method } = ctx;
  const path = pathname.slice(SANDBOX_MODEL_PREFIX.length);
  if (method === "GET" && path === "/v1/models") return listModels(ctx);
  const input =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const requested = typeof input?.model === "string" ? input.model : undefined;
  const gateway = deps.modelGatewayTransport?.actorKey ? deps.modelGatewayTransport : undefined;
  await gateway?.refresh?.();
  const company = input && Object.hasOwn(input, "model") ? await companyModels(ctx) : {};
  const gatewayTarget =
    requested && gateway && Object.hasOwn(gateway.models, requested) && company[requested] !== "org_key"
      ? gateway.models[requested]
      : undefined;
  if (input && requested && !gatewayTarget && Object.hasOwn(company, requested)) return complete(ctx, requested, input);
  if (!gateway)
    return sendJson(res, 400, {
      error: {
        message: `name a model from GET $MODEL_GATEWAY_URL/v1/models: ${Object.keys(company).join(", ") || "none are configured"}`,
      },
    });
  let payload = body;
  if (input) {
    const user = gatewayActorId(capability!.actorId, gateway.actorKey!);
    if (!Object.hasOwn(input, "model")) payload = attributed(path, input, user);
    else if (!gatewayTarget)
      return sendJson(res, 400, {
        error: {
          message: `model ${JSON.stringify(input.model)} is not available; choose one of: ${[...new Set([...Object.keys(gateway.models), ...Object.keys(company)])].join(", ")}`,
        },
      });
    else payload = attributed(path, { ...input, model: gatewayTarget }, user);
  }
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
