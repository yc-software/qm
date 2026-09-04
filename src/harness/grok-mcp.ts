import { randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { errMessage } from "../util/errors.ts";

const MAX_BODY_BYTES = 1024 * 1024;

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

interface RegisteredTool {
  definition: ToolDefinition;
  descriptor: Tool;
  validate: JsonSchemaValidator<Record<string, unknown>>;
}

interface Permit {
  name: string;
  arguments: Record<string, unknown>;
  expiresAt: number;
}

interface McpHttpRequestContext {
  requestIds: ReadonlySet<string>;
  terminatingRequestIds: Set<string>;
}

export interface GrokMcpBridge {
  url: string;
  bearerToken: string;
  acpToolNames: ReadonlySet<string>;
  waitUntilListed: Promise<void>;
  confirmAcpToolSurface(names: readonly string[]): boolean;
  requestPermission(params: RequestPermissionRequest): RequestPermissionResponse;
  close(): Promise<void>;
}

export interface GrokMcpBridgeOptions {
  signal: AbortSignal;
  onTerminate?(): void;
  maxBodyBytes?: number;
}

function authorized(value: string | undefined, bearerToken: string): boolean {
  if (value === undefined) return false;
  const expected = Buffer.from(`Bearer ${bearerToken}`);
  const actual = Buffer.from(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > limit) throw new McpError(ErrorCode.InvalidRequest, "MCP request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function end(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.end();
}

function mcpContent(result: ToolResult): CallToolResult["content"] {
  const content: CallToolResult["content"] = [];
  for (const part of result.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
    if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string")
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
  }
  return content;
}

function acpName(name: string): string {
  return `qm__${name}`;
}

function requestIdKey(id: unknown): string | undefined {
  if (typeof id === "string") return `s:${id}`;
  if (typeof id === "number" && Number.isFinite(id)) return `n:${id}`;
  return undefined;
}

function jsonRpcRequestIds(body: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const key = requestIdKey((message as Record<string, unknown>).id);
    if (key) ids.add(key);
  }
  return ids;
}

function grokToolSurface(tools: readonly Pick<ToolDefinition, "name">[]): ReadonlySet<string> {
  return new Set(["use_tool", ...tools.map((tool) => acpName(tool.name))]);
}

export async function createGrokMcpBridge(
  tools: readonly ToolDefinition[],
  options: GrokMcpBridgeOptions,
): Promise<GrokMcpBridge> {
  const bearerToken = randomBytes(32).toString("hex");
  const validators = new AjvJsonSchemaValidator();
  const registered = new Map<string, RegisteredTool>();
  for (const definition of tools) {
    if (registered.has(definition.name)) throw new Error(`Duplicate QM tool: ${definition.name}`);
    const inputSchema = definition.parameters as unknown as JsonSchemaType;
    registered.set(definition.name, {
      definition,
      descriptor: {
        name: definition.name,
        description: definition.description,
        inputSchema: inputSchema as Tool["inputSchema"],
      },
      validate: validators.getValidator<Record<string, unknown>>(inputSchema),
    });
  }
  const permits: Permit[] = [];
  let surfaceConfirmed = false;
  const requestContexts = new AsyncLocalStorage<McpHttpRequestContext>();
  let listedResolve: (() => void) | undefined;
  const waitUntilListed = new Promise<void>((resolve) => {
    listedResolve = resolve;
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomBytes(16).toString("hex") });
  const mcp = new Server({ name: "qm", version: "1" }, { capabilities: { tools: { listChanged: false } } });
  mcp.setRequestHandler(ListToolsRequestSchema, () => {
    listedResolve?.();
    listedResolve = undefined;
    return { tools: [...registered.values()].map((tool) => tool.descriptor) };
  });
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = registered.get(request.params.name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, "QM tool is unavailable");
    const args = request.params.arguments ?? {};
    const validation = tool.validate(args);
    if (!validation.valid) throw new McpError(ErrorCode.InvalidParams, "QM tool arguments are invalid");
    const now = Date.now();
    for (let index = permits.length - 1; index >= 0; index--)
      if (permits[index]!.expiresAt <= now) permits.splice(index, 1);
    const permit = permits.findIndex(
      (candidate) => candidate.name === request.params.name && isDeepStrictEqual(candidate.arguments, validation.data),
    );
    if (permit < 0) {
      permits.length = 0;
      throw new McpError(ErrorCode.InvalidRequest, "QM tool call has no matching permission");
    }
    permits.splice(permit, 1);
    if (options.signal.aborted || extra.signal.aborted)
      throw new McpError(ErrorCode.RequestTimeout, "QM tool call was cancelled");
    try {
      const execute = tool.definition.execute as (
        callId: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<ToolResult>;
      const result = await execute(
        String(extra.requestId),
        validation.data,
        AbortSignal.any([options.signal, extra.signal]),
      );
      if (result.terminate) {
        const context = requestContexts.getStore();
        const key = requestIdKey(extra.requestId);
        if (context && key && context.requestIds.has(key)) context.terminatingRequestIds.add(key);
      }
      return { content: mcpContent(result) };
    } catch (error) {
      return { content: [{ type: "text", text: errMessage(error) }], isError: true };
    }
  });
  await mcp.connect(transport);
  const http = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/mcp") {
        end(response, 404);
        return;
      }
      if (!authorized(request.headers.authorization, bearerToken)) {
        end(response, 401);
        return;
      }
      const declared = Number(request.headers["content-length"] ?? 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > (options.maxBodyBytes ?? MAX_BODY_BYTES)) {
        end(response, 413);
        return;
      }
      let body: unknown;
      try {
        body = await readBody(request, options.maxBodyBytes ?? MAX_BODY_BYTES);
      } catch (error) {
        end(response, error instanceof SyntaxError ? 400 : 413);
        return;
      }
      try {
        const context: McpHttpRequestContext = {
          requestIds: jsonRpcRequestIds(body),
          terminatingRequestIds: new Set(),
        };
        await requestContexts.run(context, () => transport.handleRequest(request, response, body));
        if (context.terminatingRequestIds.size > 0) {
          let terminated = false;
          const terminate = () => {
            if (terminated) return;
            terminated = true;
            options.onTerminate?.();
          };
          if (response.writableFinished) terminate();
          else {
            response.once("finish", terminate);
            response.once("close", terminate);
          }
        }
      } catch {
        if (!response.headersSent) end(response, 500);
        else response.destroy();
      }
    })();
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("QM MCP bridge did not bind to loopback");
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      permits.length = 0;
      http.closeAllConnections();
      await Promise.allSettled([transport.close(), mcp.close()]);
      if (http.listening)
        await new Promise<void>((resolve) => {
          http.close(() => resolve());
        });
    })();
    return closed;
  };
  const onAbort = () => {
    void close();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  const requestPermission = (params: RequestPermissionRequest): RequestPermissionResponse => {
    const deny = (): RequestPermissionResponse => {
      permits.length = 0;
      const option = params.options.find((candidate) => candidate.kind === "reject_once");
      return option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } };
    };
    if (options.signal.aborted) return { outcome: { outcome: "cancelled" } };
    if (!surfaceConfirmed) return deny();
    const input = params.toolCall.rawInput;
    if (!input || typeof input !== "object" || Array.isArray(input)) return deny();
    const raw = input as Record<string, unknown>;
    if (typeof raw.tool_name !== "string" || !raw.tool_name.startsWith("qm__")) return deny();
    const name = raw.tool_name.slice("qm__".length);
    const tool = registered.get(name);
    if (!tool || !raw.tool_input || typeof raw.tool_input !== "object" || Array.isArray(raw.tool_input)) return deny();
    const validation = tool.validate(raw.tool_input);
    const allow = params.options.find((option) => option.kind === "allow_once");
    if (!validation.valid || !allow || permits.length >= 100) return deny();
    permits.push({ name, arguments: validation.data, expiresAt: Date.now() + 30_000 });
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  };
  const acpToolNames = grokToolSurface(tools);
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    bearerToken,
    acpToolNames,
    waitUntilListed,
    confirmAcpToolSurface(names) {
      const actual = new Set(names);
      const native = names.filter((name) => !name.startsWith("qm__"));
      const external = names.filter((name) => name.startsWith("qm__"));
      surfaceConfirmed =
        actual.size === names.length &&
        native.length === 1 &&
        native[0] === "use_tool" &&
        external.every((name) => acpToolNames.has(name));
      if (!surfaceConfirmed) permits.length = 0;
      return surfaceConfirmed;
    },
    requestPermission,
    close: async () => {
      options.signal.removeEventListener("abort", onAbort);
      await close();
    },
  };
}
