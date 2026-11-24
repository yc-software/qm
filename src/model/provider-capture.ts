import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { MAX_PROVIDER_ERROR_BODY_CHARS, truncateErrorText } from "@earendil-works/pi-ai/utils/error-body";
import { isRecord } from "../agent/provider-payload.ts";

export interface ProviderErrorInfo {
  status?: number;
  type?: string;
  code?: string;
  body?: unknown;
}

export type CapturedAssistantMessage = AssistantMessage & { providerError?: ProviderErrorInfo; serviceTier?: string };

type CaptureOptions = Pick<StreamOptions, "fetch" | "onPayload" | "onProviderStreamEvent" | "signal">;

const SERVED_TIER_APIS = new Set(["openai-responses", "azure-openai-responses"]);
const SERVED_TIER_EVENTS = new Set(["response.completed", "response.incomplete"]);

function servedTierOf(api: string, data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  if (api === "anthropic-messages") {
    const usage = data.type === "message_start" && isRecord(data.message) ? data.message.usage : undefined;
    return isRecord(usage) && typeof usage.speed === "string" ? usage.speed : undefined;
  }
  if (!SERVED_TIER_APIS.has(api) || !SERVED_TIER_EVENTS.has(String(data.type)) || !isRecord(data.response))
    return undefined;
  return typeof data.response.service_tier === "string" ? data.response.service_tier : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function parseBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
  }
}

function errorInfo(status: number | undefined, parsed: unknown): ProviderErrorInfo | undefined {
  if (status === undefined && parsed === undefined) return undefined;
  const nested = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  const type = firstString(nested?.type, isRecord(parsed) && parsed.type !== "error" ? parsed.type : undefined);
  const code = firstString(nested?.code, isRecord(parsed) ? parsed.code : undefined);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(parsed !== undefined ? { body: nested ?? parsed } : {}),
  };
}

function streamErrorInfo(api: string, block: string): ProviderErrorInfo | undefined {
  let event = "";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length || !data.some((part) => part.includes("error"))) return undefined;
  const parsed = parseBody(data.join("\n"));
  if (api === "anthropic-messages") return event === "error" ? errorInfo(undefined, parsed) : undefined;
  return isRecord(parsed) && isRecord(parsed.error) ? errorInfo(undefined, parsed) : undefined;
}

function watchEventStream(api: string, body: ReadableStream<Uint8Array>, found: (info: ProviderErrorInfo) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  const scan = (final: boolean) => {
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = final ? "" : (blocks.pop() ?? "");
    for (const block of blocks) {
      const info = streamErrorInfo(api, block);
      if (info) found(info);
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        scan(false);
      },
      flush() {
        buffer += decoder.decode();
        scan(true);
      },
    }),
  );
}

export function captureProviderResponse<T extends CaptureOptions | undefined>(
  model: Pick<Model<Api>, "api">,
  options: T,
): { options: T; annotate: (stream: AssistantMessageEventStream) => AssistantMessageEventStream } {
  const api = String(model.api);
  let failure: ProviderErrorInfo | undefined;
  let servedTier: string | undefined;
  const baseFetch = options?.fetch;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await (baseFetch ?? globalThis.fetch)(input, init);
    if (!response.ok) {
      failure = errorInfo(response.status, parseBody(await response.clone().text()));
      return response;
    }
    failure = undefined;
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
    return new Response(
      watchEventStream(api, response.body, (info) => (failure = info)),
      response,
    );
  };
  const captured = {
    ...options,
    ...(api.startsWith("google-") ? {} : { fetch }),
    onPayload: async (payload: unknown, payloadModel: Model<Api>) => {
      try {
        return options?.onPayload ? await options.onPayload(payload, payloadModel) : undefined;
      } catch (error) {
        const { status, type } = error as { status?: unknown; type?: unknown };
        if (typeof status === "number") failure = { status, ...(typeof type === "string" ? { type } : {}) };
        throw error;
      }
    },
    onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
      servedTier = servedTierOf(api, data) ?? servedTier;
      await options?.onProviderStreamEvent?.(data, eventModel);
    },
  } as T;
  const annotate = (source: AssistantMessageEventStream): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        if (event.type === "done" && servedTier) (event.message as CapturedAssistantMessage).serviceTier = servedTier;
        if (event.type !== "error") {
          out.push(event);
          continue;
        }
        const message: CapturedAssistantMessage = event.error;
        if (servedTier) message.serviceTier = servedTier;
        if (failure) message.providerError = failure;
        if (options?.signal?.aborted) message.stopReason = "aborted";
        out.push(options?.signal?.aborted ? { ...event, reason: "aborted" } : event);
      }
      out.end();
    })();
    return out;
  };
  return { options: captured, annotate };
}
