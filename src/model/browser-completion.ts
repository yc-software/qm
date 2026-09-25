import { Type } from "typebox";
import type { Context, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { buildModelRuntime, type ProviderKeys } from "../harness/pi-harness.ts";
import { zeroUsage } from "../harness/replay.ts";
import {
  CODEX_SUBSCRIPTION_PROVIDER,
  codexSubscriptionModelId,
  resolveModel,
  type ModelProvider,
} from "./pi-models.ts";
import type { resolveBrowserModel } from "./browser-model.ts";
import type { UserModelCredentialStore } from "./user-model-credential-store.ts";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export class BrowserCompletionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function nativeBrowserCompletion(
  input: {
    selection: Awaited<ReturnType<typeof resolveBrowserModel>>;
    credentials?: UserModelCredentialStore;
    companyProviderKeys?: ProviderKeys;
    companySubscriptionProvider?: ModelProvider;
    actorId: string;
    body: Record<string, unknown>;
    signal: AbortSignal;
  },
  runtimeFactory: (
    keys: Parameters<typeof buildModelRuntime>[0],
  ) => Promise<Pick<Awaited<ReturnType<typeof buildModelRuntime>>, "completeSimple">> = buildModelRuntime,
) {
  const { selection, body } = input;
  const routing = selection.routing;
  let model = selection.model ? resolveModel(selection.model, selection.account === "company") : undefined;
  if ((!routing && selection.account !== "company") || !model)
    throw new BrowserCompletionError("Selected browser model is unavailable", 409);
  if (selection.account === "company" && input.companySubscriptionProvider === model.provider) {
    if (model.provider === "anthropic")
      throw new BrowserCompletionError("Claude subscription access does not support browser inference", 422);
    if (model.provider === "openai") {
      model = resolveModel(codexSubscriptionModelId(selection.model!), false);
      if (!model) throw new BrowserCompletionError("Selected browser model is unavailable", 409);
    }
  }
  if (routing?.kind === "oauth" && routing.provider !== "openai")
    throw new BrowserCompletionError("Claude subscription access does not support browser inference", 422);
  if (body.tools || body.tool_choice || body.parallel_tool_calls || !Array.isArray(body.messages))
    throw new BrowserCompletionError("Unsupported browser completion request");
  const context: Context = { messages: [] };
  const systems: string[] = [];
  for (const raw of body.messages) {
    const message = object(raw);
    if (!message || !["system", "developer", "user", "assistant"].includes(String(message.role)))
      throw new BrowserCompletionError("Unsupported browser message");
    const content: (TextContent | ImageContent)[] = [];
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (!Array.isArray(parts)) throw new BrowserCompletionError("Invalid browser message content");
    for (const rawPart of parts) {
      const part = object(rawPart);
      if (part?.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
      else if (part?.type === "image_url" && message.role === "user") {
        const url = object(part.image_url)?.url;
        const match =
          typeof url === "string"
            ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url)
            : null;
        if (!match) throw new BrowserCompletionError("Browser screenshots must be inline image data");
        content.push({ type: "image", mimeType: match[1]!, data: match[2]! });
      } else throw new BrowserCompletionError("Unsupported browser message content");
    }
    const text = content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (message.role === "system" || message.role === "developer") systems.push(text);
    else if (message.role === "user") context.messages.push({ role: "user", content, timestamp: Date.now() });
    else
      context.messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      });
  }
  const format = object(body.response_format);
  const schema = object(object(format?.json_schema)?.schema);
  if (format && (format.type !== "json_schema" || !schema))
    throw new BrowserCompletionError("Browser responses require a JSON schema");
  if (schema) {
    context.tools = [
      {
        name: "browser_result",
        description: "Return the browser agent's structured result.",
        parameters: Type.Unsafe(schema),
      },
    ];
    systems.push("Return your result by calling browser_result exactly once.");
  }
  context.systemPrompt = systems.join("\n\n");
  const limit = body.max_completion_tokens ?? body.max_tokens ?? 4096;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)
    throw new BrowserCompletionError("Invalid browser output token limit");
  let keys: ProviderKeys;
  if (selection.account === "company") {
    const key = input.companyProviderKeys?.[model.provider];
    if (!key) throw new BrowserCompletionError("Company model credentials are unavailable", 503);
    keys = { [model.provider]: key };
  } else {
    if (!routing) throw new BrowserCompletionError("Selected browser model is unavailable", 409);
    const auth =
      routing.kind === "apikey"
        ? routing.apiKey
        : (await input.credentials?.derivedOAuth(input.actorId, "openai"))?.accessToken;
    if (!auth) throw new BrowserCompletionError("Reconnect your selected AI account in Settings", 409);
    keys = { [routing.kind === "apikey" ? routing.provider : CODEX_SUBSCRIPTION_PROVIDER]: auth };
  }
  const runtime = await runtimeFactory(keys);
  const modelApi = model.api;
  const result = await runtime.completeSimple(model, context, {
    signal: input.signal,
    maxTokens: Math.min(limit, model.maxTokens),
    maxRetries: 0,
    onPayload: schema
      ? (raw) => {
          const payload = object(raw);
          if (!payload) throw new BrowserCompletionError("Invalid model request");
          let toolChoice: object = { type: "function", name: "browser_result" };
          if (modelApi === "anthropic-messages") toolChoice = { type: "tool", name: "browser_result" };
          if (modelApi === "openai-completions")
            toolChoice = { type: "function", function: { name: "browser_result" } };
          return { ...payload, tool_choice: toolChoice };
        }
      : undefined,
  });
  if (result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "length")
    throw new BrowserCompletionError("Selected AI account could not complete the browser request", 502);
  const structured = result.content.find((part) => part.type === "toolCall" && part.name === "browser_result");
  if (schema && !structured)
    throw new BrowserCompletionError("Selected AI account did not return a structured browser result", 502);
  const text =
    structured?.type === "toolCall"
      ? JSON.stringify(structured.arguments)
      : result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  return {
    id: "browser-completion",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: selection.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: result.usage.input,
      completion_tokens: result.usage.output,
      total_tokens: result.usage.totalTokens,
    },
  };
}
