import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { countTokens } from "../../../src/util/tokens.ts";

export interface ModelRequest {
  model: string;
  system?: unknown;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string }>;
  bytes: number;
  inputTokens: number;
}

export interface GatewayLimits {
  maxRequestBytes: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export const GATEWAY_MODEL_GROUP = "journey/claude";
export const GATEWAY_MODEL_ID = `gateway/${GATEWAY_MODEL_GROUP}`;
export const GATEWAY_API_KEY = "journey-gateway-key";
export const GATEWAY_API_KEY_HEADER = "x-gateway-key";
const PDF_BYTES_PER_TOKEN = 100;

export type ModelReply =
  { text: string } | { tool: string; input: Record<string, unknown> } | { failure: { status: number; body: unknown } };

export interface FakeGateway {
  url: string;
  requests: ModelRequest[];
  rejected: Array<{ status: number; reason: string; bytes: number; inputTokens: number }>;
  respond: (req: ModelRequest) => ModelReply | Promise<ModelReply>;
  hold: Promise<void> | null;
  close(): Promise<void>;
}

const PROVIDER_413 = "content length exceeds the request size limit";

function requestTokens(body: { system?: unknown; messages: Array<{ content: unknown }>; tools?: unknown }): number {
  const parts: string[] = [];
  let binaryBytes = 0;
  const push = (value: unknown): void => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(push);
    else if (value && typeof value === "object") {
      const block = value as { text?: unknown; source?: { data?: unknown }; content?: unknown; input?: unknown };
      if (typeof block.text === "string") parts.push(block.text);
      if (typeof block.source?.data === "string") {
        if ((block.source as { type?: unknown }).type === "base64") binaryBytes += block.source.data.length * 0.75;
        else parts.push(block.source.data);
      }
      if (block.content !== undefined) push(block.content);
      if (block.input !== undefined) parts.push(JSON.stringify(block.input));
    }
  };
  push(body.system);
  for (const message of body.messages) push(message.content);
  if (body.tools) parts.push(JSON.stringify(body.tools));
  return countTokens(parts.join("\n")) + Math.ceil(binaryBytes / PDF_BYTES_PER_TOKEN);
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamReply(
  res: ServerResponse,
  model: string,
  inputTokens: number,
  reply: Exclude<ModelReply, { failure: unknown }>,
): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  if ("text" in reply) {
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: reply.text },
    });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: countTokens(reply.text) },
    });
  } else {
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: `toolu_${Math.random().toString(36).slice(2)}`,
        name: reply.tool,
        input: {},
      },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.input) },
    });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 20 },
    });
  }
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startFakeGateway(
  limits: GatewayLimits,
  respond: FakeGateway["respond"] = () => ({ text: "ok" }),
): Promise<FakeGateway> {
  const fake: FakeGateway = { url: "", requests: [], rejected: [], respond, hold: null, close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    if (req.headers[GATEWAY_API_KEY_HEADER] !== GATEWAY_API_KEY) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad gateway key" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: GATEWAY_MODEL_GROUP }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/model_group/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              model_group: GATEWAY_MODEL_GROUP,
              mode: "chat",
              providers: ["anthropic"],
              supports_function_calling: true,
              supports_vision: true,
              supports_reasoning: false,
              max_input_tokens: limits.contextWindowTokens,
              max_output_tokens: limits.maxOutputTokens,
              input_cost_per_token: 0.000001,
              output_cost_per_token: 0.000005,
            },
          ],
        }),
      );
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no route ${req.url}` } }));
      return;
    }
    const raw = await readBody(req);
    const bytes = raw.byteLength;
    if (bytes > limits.maxRequestBytes) {
      fake.rejected.push({ status: 413, reason: PROVIDER_413, bytes, inputTokens: 0 });
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "request_too_large", message: PROVIDER_413 } }));
      return;
    }
    const body = JSON.parse(raw.toString("utf8")) as ModelRequest;
    const inputTokens = requestTokens(body);
    const record: ModelRequest = {
      model: body.model,
      system: body.system,
      messages: body.messages,
      ...(body.tools ? { tools: body.tools } : {}),
      bytes,
      inputTokens,
    };
    fake.requests.push(record);
    if (inputTokens > limits.contextWindowTokens) {
      const message = `prompt is too long: ${inputTokens} tokens > ${limits.contextWindowTokens} maximum`;
      fake.rejected.push({ status: 400, reason: message, bytes, inputTokens });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
      return;
    }
    if (fake.hold) await fake.hold;
    if (res.destroyed) return;
    const reply = await fake.respond(record);
    if ("failure" in reply) {
      res.writeHead(reply.failure.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.failure.body));
      return;
    }
    streamReply(res, body.model, inputTokens, reply);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  return fake;
}
