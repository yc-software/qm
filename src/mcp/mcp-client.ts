import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LRUCache } from "lru-cache";
import { boundedResponse } from "../util/bytes.ts";
import { reportFailureAs, swallowAs } from "../util/errors.ts";
import { publicFetch, type AddressFetch } from "../util/network.ts";
import { trimTrailingSlashes } from "../util/text.ts";

const MAX_TOOLS = 64;
export const CATALOG_MAX_TOOLS = 5_000;
const LISTING_TTL_MS = 60_000;
const LISTING_CACHE_MAX = 1_000;
const CALL_TIMEOUT_MS = 300_000;
const OAUTH_DENIALS: ReadonlySet<string> = new Set([
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "invalid_token",
  "insufficient_scope",
  "access_denied",
]);

export class McpCallError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly unsent: boolean;
  readonly answered: boolean;
  constructor(
    message: string,
    detail: { status?: number; code?: string; unsent?: boolean; answered?: boolean; cause?: unknown },
  ) {
    super(message, { cause: detail.cause });
    this.status = detail.status;
    this.code = detail.code;
    this.unsent = detail.unsent ?? false;
    this.answered = detail.answered ?? false;
  }
}

export function mcpResultText(result: CallToolResult): string {
  return result.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("\n")
    .trim();
}

export interface McpEnvelope {
  code?: string;
  status?: string;
}

export const providerCode = (value: unknown): string | undefined =>
  typeof value === "string" && /^[\w.:-]{1,64}$/.test(value) ? value : undefined;

function envelopeOf(value: unknown): McpEnvelope {
  if (!value || typeof value !== "object") return {};
  const { code, status, error } = value as { code?: unknown; status?: unknown; error?: { code?: unknown } };
  const nested = error && typeof error === "object" ? error.code : undefined;
  const found = providerCode(typeof code === "string" ? code : nested);
  return {
    ...(found ? { code: found } : {}),
    ...(typeof status === "string" ? { status } : {}),
  };
}

export const mcpEnvelope = (result: CallToolResult): McpEnvelope => envelopeOf(result.structuredContent);

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorCode(result: CallToolResult): string | undefined {
  return [result.structuredContent, ...result.content.map((c) => (c.type === "text" ? jsonOf(c.text) : undefined))]
    .map((value) => envelopeOf(value).code)
    .find((code) => code !== undefined);
}

function httpStatus(error: unknown): number | undefined {
  if (error instanceof StreamableHTTPError && (error.code ?? 0) > 0) return error.code;
  if (error instanceof UnauthorizedError) return 401;
  if (error instanceof OAuthError && OAUTH_DENIALS.has(error.errorCode)) return 401;
  return undefined;
}

export interface McpRemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpListing {
  tools: McpRemoteTool[];
  about?: string;
}

interface ToolListing {
  label: string;
  list(): Promise<McpRemoteTool[]>;
}

export type ToolListings = LRUCache<string, McpRemoteTool[], ToolListing>;

export function toolListings(): ToolListings {
  return new LRUCache<string, McpRemoteTool[], ToolListing>({
    max: LISTING_CACHE_MAX,
    ttl: LISTING_TTL_MS,
    allowStale: true,
    ignoreFetchAbort: true,
    fetchMethod: (_key, stale, { context, options }) =>
      context.list().catch((error: unknown) => {
        if (!stale || !options.allowStale) throw error;
        return reportFailureAs(context.label, stale)(error);
      }),
  });
}

export type McpAuth =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "client-credentials"; clientId: string; clientSecret: string };

export interface McpClient {
  listTools(opts?: { headers?: Record<string, string>; maxTools?: number; signal?: AbortSignal }): Promise<McpListing>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
}

export function createMcpClient(opts: {
  url: string;
  auth: McpAuth;
  fetch?: AddressFetch;
  maxResponseBytes?: number;
}): McpClient {
  const trimmed = trimTrailingSlashes(opts.url);
  const endpoint = new URL(new URL(trimmed).pathname === "/" ? `${trimmed}/mcp` : trimmed);
  const { auth } = opts;
  const fetchFn = opts.fetch ?? publicFetch;
  const authProvider =
    auth.mode === "client-credentials"
      ? new ClientCredentialsProvider({
          clientId: auth.clientId,
          clientSecret: auth.clientSecret,
          expectedIssuer: new URL("/", endpoint).href,
        })
      : undefined;

  async function session<T>(
    op: string,
    work: (client: Client, signal: AbortSignal) => Promise<T>,
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = { ...extraHeaders, ...(auth.mode === "bearer" ? { authorization: `Bearer ${auth.token}` } : {}) };
    const overflow = new AbortController();
    const stop = signal ? AbortSignal.any([signal, overflow.signal]) : overflow.signal;
    const { maxResponseBytes } = opts;
    let detached = false;
    const transport = new StreamableHTTPClientTransport(endpoint, {
      ...(authProvider ? { authProvider } : {}),
      ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
      fetch: async (url, init) => {
        const target = new URL(url);
        if (endpoint.protocol === "https:" && target.protocol !== "https:")
          throw new Error(
            `${endpoint.origin} sent QM to ${target.origin}, and an https server's requests stay on https`,
          );
        const response = await fetchFn(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any(
            [init?.signal, detached ? AbortSignal.timeout(CALL_TIMEOUT_MS) : stop].filter((s): s is AbortSignal => !!s),
          ),
        });
        if (maxResponseBytes === undefined) return response;
        return boundedResponse(response, maxResponseBytes, () => {
          const error = new Error(`${new URL(url).origin} sent a response larger than ${maxResponseBytes} bytes`);
          overflow.abort(error);
          return error;
        });
      },
    });
    const client = new Client({ name: "qm", version: "1.0.0" });
    let opened = false;
    try {
      await client.connect(transport, { signal: stop });
      opened = true;
      return await work(client, stop);
    } catch (e) {
      const status = httpStatus(e);
      throw new McpCallError(`mcp ${op} failed${status ? ` (HTTP ${status})` : ""}`, {
        ...(status ? { status } : {}),
        ...(e instanceof OAuthError ? { code: e.errorCode } : {}),
        ...(opened
          ? {
              answered:
                e instanceof McpError
                  ? e.code !== ErrorCode.RequestTimeout && e.code !== ErrorCode.ConnectionClosed
                  : (status ?? 500) < 500,
            }
          : { unsent: true }),
        cause: e,
      });
    } finally {
      detached = stop.aborted;
      const end = async () => {
        await transport.terminateSession().catch(swallowAs("mcp: end session", undefined));
        await client.close();
      };
      if (detached) void end().catch(swallowAs("mcp: close", undefined));
      else await end();
    }
  }

  return {
    listTools: (opts) =>
      session(
        "tools/list",
        async (client) => {
          const tools: McpRemoteTool[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor === undefined ? undefined : { cursor });
            for (const t of page.tools)
              tools.push({
                name: t.name,
                description: t.description ?? "",
                inputSchema: t.inputSchema,
                ...(t.annotations ? { annotations: t.annotations } : {}),
              });
            cursor = page.nextCursor;
          } while (cursor && tools.length < (opts?.maxTools ?? MAX_TOOLS));
          const about = (client.getServerVersion()?.description || client.getInstructions() || "").trim();
          return {
            tools: tools.slice(0, opts?.maxTools ?? MAX_TOOLS),
            ...(about ? { about } : {}),
          };
        },
        opts?.headers,
        opts?.signal,
      ),
    async callTool(name, args, headers, signal) {
      const result = (await session(
        "tools/call",
        (client, stop) =>
          client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, signal: stop }),
        headers,
        signal,
      )) as CallToolResult;
      if (result.isError) {
        const code = errorCode(result);
        const detail =
          mcpResultText(result) ||
          (result.structuredContent ? JSON.stringify(result.structuredContent) : "(no detail)");
        throw new McpCallError(`mcp tool ${name} error: ${detail}`, { ...(code ? { code } : {}), answered: true });
      }
      return result;
    },
  };
}
