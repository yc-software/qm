import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { swallow } from "../util/errors.ts";

const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 300_000;
const MAX_LIST_PAGES = 20;

export type McpFetch = FetchLike;
export type McpToolResult = Pick<CallToolResult, "content" | "structuredContent" | "isError">;
type McpRemoteTool = Pick<Tool, "name" | "description" | "inputSchema">;

export type McpAuth =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "client-credentials"; clientId: string; clientSecret: string };

interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpClient {
  readonly host: string;
  listTools(limit?: number): Promise<McpRemoteTool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<McpToolResult>;
  close(): Promise<void>;
}

interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  closing: boolean;
}

const noRedirectFetch: McpFetch = (url, init) => fetch(url, { ...init, redirect: "error" });

function contentText(block: CallToolResult["content"][number]): string {
  if (block.type === "text") return block.text;
  if (block.type === "resource")
    return "text" in block.resource ? block.resource.text : `[resource ${block.resource.uri}]`;
  if (block.type === "resource_link") return `[resource ${block.uri}]`;
  return `[${block.type} ${block.mimeType}]`;
}

export function mcpResultText(result: McpToolResult): string {
  const text = (result.content ?? []).map(contentText).join("\n").trim();
  if (text) return text;
  return result.structuredContent == null ? "" : JSON.stringify(result.structuredContent);
}

function sessionLost(error: unknown, sessionId: string | undefined): boolean {
  return !!sessionId && error instanceof StreamableHTTPError && error.code === 404;
}

export function createMcpClient(opts: { url: string; auth: McpAuth; fetchImpl?: McpFetch }): McpClient {
  const url = new URL(opts.url);
  const authProvider =
    opts.auth.mode === "client-credentials"
      ? new ClientCredentialsProvider({
          clientId: opts.auth.clientId,
          clientSecret: opts.auth.clientSecret,
          expectedIssuer: url.origin,
        })
      : undefined;
  const headers: Record<string, string> =
    opts.auth.mode === "bearer" ? { authorization: `Bearer ${opts.auth.token}` } : {};
  let connection: Promise<Connection> | undefined;

  function connect(): Promise<Connection> {
    connection ??= (async () => {
      const transport = new StreamableHTTPClientTransport(url, {
        fetch: opts.fetchImpl ?? noRedirectFetch,
        requestInit: { headers },
        ...(authProvider ? { authProvider } : {}),
      });
      const client = new Client({ name: "qm", version: "1" });
      const open: Connection = { client, transport, closing: false };
      client.onerror = (error) => {
        if (!open.closing) swallow("mcp: transport", error);
      };
      await client.connect(transport, { timeout: LIST_TIMEOUT_MS });
      return open;
    })().catch((error: unknown) => {
      connection = undefined;
      throw error;
    });
    return connection;
  }

  async function shut(open: Connection): Promise<void> {
    open.closing = true;
    await open.client.close();
  }

  function connected(signal?: AbortSignal): Promise<Connection> {
    if (!signal) return connect();
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const stop = () => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      connect()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", stop));
    });
  }

  async function withSession<T>(run: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const open = await connected(signal);
    try {
      return await run(open.client);
    } catch (error) {
      if (!sessionLost(error, open.transport.sessionId)) throw error;
      connection = undefined;
      await shut(open).catch((closeError: unknown) => swallow("mcp: close lost session", closeError));
      return run((await connected(signal)).client);
    }
  }

  return {
    host: url.host,
    async listTools(limit = Infinity) {
      return withSession(async (client) => {
        const tools: McpRemoteTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_LIST_PAGES && tools.length < limit; page++) {
          const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_TIMEOUT_MS });
          tools.push(...result.tools);
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        return tools.slice(0, limit);
      });
    },
    async callTool(name, args, options) {
      const timeoutMs = options?.timeoutMs ?? CALL_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      const budget = AbortSignal.timeout(timeoutMs);
      const signal = options?.signal ? AbortSignal.any([options.signal, budget]) : budget;
      const result = (await withSession(
        (client) =>
          client.callTool({ name, arguments: args }, undefined, {
            timeout: Math.max(1, deadline - Date.now()),
            signal,
          }),
        signal,
      )) as McpToolResult;
      if (result.isError) throw new Error(`mcp tool ${name} error: ${mcpResultText(result) || "(no detail)"}`);
      return result;
    },
    async close() {
      const current = connection;
      connection = undefined;
      const open = await current?.catch(() => undefined);
      if (open) await shut(open);
    },
  };
}
