import { resolveBrowserModel } from "../../model/browser-model.ts";
import { BrowserCompletionError, nativeBrowserCompletion } from "../../model/browser-completion.ts";
import { BROWSER_MODEL_AUD } from "../../auth/capability-token.ts";
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
  const gateway = deps.browserModelGateway;
  if (!capability?.browserModel) return sendJson(res, 403, { error: "browser model grant required" });
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
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  try {
    const selected = await resolveBrowserModel({
      actorId: capability.actorId,
      config: deps.config,
      credentials: deps.userModelCredentials,
      companyModel: capability.browserModel,
    });
    if (selected.account !== capability.browserAccount || selected.model !== capability.browserModel)
      return sendJson(res, 409, {
        error: "AI access changed or is unavailable; start a new turn to refresh browser access",
      });
    if (selected.account !== "company" || !gateway) {
      if (selected.account !== "company" && !selected.routing)
        return sendJson(res, 409, { error: "Reconnect your selected AI account in Settings" });
      if (selected.routing?.kind === "oauth" && selected.routing.provider === "anthropic")
        return sendJson(res, 422, {
          error:
            "Claude subscription access does not support the browser agent. Choose company access, ChatGPT, or a Claude API key in Settings.",
        });
      return sendJson(
        res,
        200,
        await nativeBrowserCompletion({
          selection: selected,
          credentials: deps.userModelCredentials,
          companyProviderKeys: selected.account === "company" ? await deps.resolveBrowserCompanyKeys?.() : undefined,
          companySubscriptionProvider: selected.account === "company" ? deps.harnessCarriedModelAuth : undefined,
          actorId: capability.actorId,
          body: input,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        }),
      );
    }
    await gateway.refresh?.();
    const target = gateway.models[capability.browserModel];
    if (!target) return sendJson(res, 503, { error: "browser model unavailable" });
    const response = await fetch(`${gateway.url.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", [gateway.apiKeyHeader]: gateway.apiKey },
      body: JSON.stringify({ ...input, model: target, stream: false }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return sendJson(res, response.status === 429 ? 429 : 502, {
        error: "Selected AI account could not complete the browser request",
      });
    }
    const result = await response.json();
    sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof BrowserCompletionError) return sendJson(res, error.status, { error: error.message });
    if (!res.destroyed) sendJson(res, 502, { error: "Selected AI account could not complete the browser request" });
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
