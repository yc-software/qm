import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AssistantMessage, Context, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { buildModelRuntime, zeroUsage } from "./model-runtime.ts";
import { routeLabel, type ModelRoute } from "./model-route.ts";
import { providerTurnError } from "./provider-error.ts";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export class ChatCompletionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function failureStatus(result: AssistantMessage, signal: AbortSignal, responseStatus?: number): number {
  if (result.stopReason === "aborted") {
    return (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError" ? 504 : 502;
  }
  const status = result.providerError?.status ?? responseStatus;
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 401 && status !== 403) return status;
  if (providerTurnError(result).code === "refusal") return 422;
  return 502;
}

export async function completeChatRequest(
  route: ModelRoute,
  body: Record<string, unknown>,
  signal: AbortSignal,
  purpose: "browser" | "sandbox",
) {
  const { model } = route;
  if (body.tools || body.tool_choice || body.parallel_tool_calls || !Array.isArray(body.messages))
    throw new ChatCompletionError(
      "Only plain chat completions are supported here: no tools or tool_choice, and a messages array",
    );
  const context: Context = { messages: [] };
  const systems: string[] = [];
  for (const raw of body.messages) {
    const message = object(raw);
    if (!message || !["system", "developer", "user", "assistant"].includes(String(message.role)))
      throw new ChatCompletionError("Messages must have role system, developer, user or assistant");
    const content: (TextContent | ImageContent)[] = [];
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (!Array.isArray(parts)) throw new ChatCompletionError("Message content must be a string or an array of parts");
    for (const rawPart of parts) {
      const part = object(rawPart);
      if (part?.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
      else if (part?.type === "image_url" && message.role === "user") {
        const url = object(part.image_url)?.url;
        const match =
          typeof url === "string"
            ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url)
            : null;
        if (!match) throw new ChatCompletionError("Images must be inline data: URLs (png, jpeg, webp or gif)");
        content.push({ type: "image", mimeType: match[1]!, data: match[2]! });
      } else throw new ChatCompletionError("Content parts must be text, or image_url in user messages");
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
    throw new ChatCompletionError("response_format must be a json_schema with a schema");
  if (schema) {
    context.tools = [
      {
        name: "structured_result",
        description: "Return the structured result.",
        parameters: Type.Unsafe(schema),
      },
    ];
    systems.push("Return your result by calling structured_result exactly once.");
  }
  context.systemPrompt = systems.join("\n\n");
  const limit = body.max_completion_tokens ?? body.max_tokens ?? model.maxTokens;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)
    throw new ChatCompletionError("max_tokens must be a positive integer");
  const runtime = await buildModelRuntime(route.keys, route.gateway, purpose);
  const modelApi = model.api;
  let responseStatus: number | undefined;
  const result = await runtime.completeSimple(model, context, {
    signal,
    maxTokens: Math.min(limit, model.maxTokens),
    maxRetries: 0,
    onResponse: (response) => {
      responseStatus = response.status;
    },
    onPayload: schema
      ? (raw) => {
          const payload = object(raw);
          if (!payload) throw new ChatCompletionError("Invalid model request");
          let toolChoice: object = { type: "function", name: "structured_result" };
          if (modelApi === "anthropic-messages") toolChoice = { type: "auto" };
          if (modelApi === "openai-completions")
            toolChoice = { type: "function", function: { name: "structured_result" } };
          return { ...payload, tool_choice: toolChoice };
        }
      : undefined,
  });
  if (result.stopReason === "error" || result.stopReason === "aborted")
    throw new ChatCompletionError(
      `${routeLabel(route)} could not complete the ${purpose} request: ${result.errorMessage ?? result.stopReason}`,
      failureStatus(result, signal, responseStatus),
    );
  if (schema && result.stopReason === "length")
    throw new ChatCompletionError(`${routeLabel(route)} reached max_tokens before returning a structured result`, 422);
  const structured = result.content.find((part) => part.type === "toolCall" && part.name === "structured_result");
  const text =
    structured?.type === "toolCall"
      ? JSON.stringify(structured.arguments)
      : result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  if (schema && !structured) {
    const preview = text.trim();
    throw new ChatCompletionError(
      `${routeLabel(route)} did not return a structured result (stopReason=${result.stopReason}${preview ? `, text=${JSON.stringify(preview)}` : ""})`,
      502,
    );
  }
  return {
    id: `${purpose}-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: route.modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: result.stopReason === "length" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
      completion_tokens: result.usage.output,
      total_tokens: result.usage.totalTokens,
    },
  };
}
