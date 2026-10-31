import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { swallowAs } from "../util/errors.ts";
import { publicFetch, type AddressFetch } from "../util/network.ts";

const MAX_TOOLS = 64;
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
  constructor(message: string, detail: { status?: number; code?: string; cause?: unknown }) {
    super(message, { cause: detail.cause });
    this.status = detail.status;
    this.code = detail.code;
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

function envelopeOf(value: unknown): McpEnvelope {
  if (!value || typeof value !== "object") return {};
  const { code, status, error } = value as { code?: unknown; status?: unknown; error?: { code?: unknown } };
  const nested = error && typeof error === "object" ? error.code : undefined;
  const found = typeof code === "string" ? code : nested;
  return {
    ...(typeof found === "string" && /^[\w.:-]{1,64}$/.test(found) ? { code: found } : {}),
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

interface McpRemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpListing {
  tools: McpRemoteTool[];
  about?: string;
}

export type McpAuth =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "client-credentials"; clientId: string; clientSecret: string };

export interface McpClient {
  listTools(opts?: { headers?: Record<string, string>; maxTools?: number }): Promise<McpListing>;
  callTool(name: string, args: Record<string, unknown>, headers?: Record<string, string>): Promise<CallToolResult>;
}

export function createMcpClient(opts: { url: string; auth: McpAuth; fetch?: AddressFetch }): McpClient {
  const trimmed = opts.url.replace(/\/+$/g, "");
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
    work: (client: Client) => Promise<T>,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const headers = { ...extraHeaders, ...(auth.mode === "bearer" ? { authorization: `Bearer ${auth.token}` } : {}) };
    const transport = new StreamableHTTPClientTransport(endpoint, {
      ...(authProvider ? { authProvider } : {}),
      ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
      fetch: (url, init) => fetchFn(url, { ...init, redirect: "error" }),
    });
    const client = new Client({ name: "qm", version: "1.0.0" });
    try {
      await client.connect(transport);
      return await work(client);
    } catch (e) {
      const status = httpStatus(e);
      throw new McpCallError(`mcp ${op} failed${status ? ` (HTTP ${status})` : ""}`, {
        ...(status ? { status } : {}),
        ...(e instanceof OAuthError ? { code: e.errorCode } : {}),
        cause: e,
      });
    } finally {
      await transport.terminateSession().catch(swallowAs("mcp: end session", undefined));
      await client.close();
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
      ),
    async callTool(name, args, headers) {
      const result = (await session(
        "tools/call",
        (client) => client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }),
        headers,
      )) as CallToolResult;
      if (result.isError) {
        const code = errorCode(result);
        const detail =
          mcpResultText(result) ||
          (result.structuredContent ? JSON.stringify(result.structuredContent) : "(no detail)");
        throw new McpCallError(`mcp tool ${name} error: ${detail}`, code ? { code } : {});
      }
      return result;
    },
  };
}
