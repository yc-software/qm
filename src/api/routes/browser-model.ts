import { loadPersonalModelAuth } from "../../core/individual-auth-routing.ts";
import { ChatCompletionError, completeChatRequest } from "../../model/chat-completion.ts";
import { BROWSER_MODEL_AUD } from "../../auth/capability-token.ts";
import { routeLabel } from "../../model/model-route.ts";
import { errMessage, reportFailure } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

const REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "seed",
  "stop",
  "response_format",
  "reasoning_effort",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "verbosity",
  "stream",
]);

async function browserModel(ctx: ApiCtx): Promise<void> {
  const { capability, deps, body, res } = ctx;
  if (!capability?.browserModel || !capability.browserAccount)
    return sendJson(res, 403, { error: "browser model grant required" });
  if (deps.config && (await deps.config.getSecurityPostureDurable(capability.scopeId)) === "strict")
    return sendJson(res, 403, { error: "browser model requests are disabled in strict posture" });
  if (!body || typeof body !== "object" || Array.isArray(body))
    return sendJson(res, 400, { error: "invalid browser model request" });
  const input = body as Record<string, unknown>;
  if (
    input.model !== capability.browserModel ||
    !Array.isArray(input.messages) ||
    input.stream === true ||
    Object.keys(input).some((key) => !REQUEST_FIELDS.has(key))
  )
    return sendJson(res, 400, { error: "invalid browser model request" });
  if (!deps.modelRoutes) return sendJson(res, 503, { error: "browser model unavailable" });
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  try {
    const account = capability.browserAccount;
    const personal =
      account === "company" || !deps.userModelCredentials
        ? undefined
        : await loadPersonalModelAuth(deps.userModelCredentials, capability.actorId, account, capability.browserModel);
    if (account !== "company" && personal?.modelId !== capability.browserModel)
      return sendJson(res, 409, { error: "Reconnect your selected AI account in Settings, then start a new turn" });
    const route = await deps.modelRoutes.session({
      runtime: { modelId: capability.browserModel },
      ...(personal ? { providerKeys: personal.keys } : {}),
    });
    if (
      personal
        ? personal.subscription === "anthropic"
        : deps.companySubscriptionAuth === "anthropic" && route.model.provider === "anthropic"
    )
      return sendJson(res, 422, {
        error:
          "Claude subscription access does not support the browser agent. Choose company access, ChatGPT, or a Claude API key in Settings.",
      });
    if (!deps.modelRoutes.servable(route))
      return sendJson(res, 503, { error: `${routeLabel(route)} has no credential` });
    sendJson(
      res,
      200,
      await completeChatRequest(
        route,
        input,
        AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        "browser",
      ),
    );
  } catch (error) {
    if (error instanceof ChatCompletionError) return sendJson(res, error.status, { error: error.message });
    reportFailure("browser model request", error, capability.scopeId);
    if (!res.destroyed) sendJson(res, 502, { error: `the browser model request failed: ${errMessage(error)}` });
  } finally {
    res.off("close", abort);
  }
}

export const browserModelRoutes: Route[] = [
  {
    method: "POST",
    path: "/v1/browser-model/chat/completions",
    auth: { aud: BROWSER_MODEL_AUD },
    maxBodyBytes: 16 * 1024 * 1024,
    handle: browserModel,
  },
];
