import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { swallowAs } from "../util/errors.ts";
import type { AgentFetch } from "../egress/agent-egress.ts";

const MAX_TOOLS = 64;
const CALL_TIMEOUT_MS = 300_000;

export function mcpResultText(result: CallToolResult): string {
  return result.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("\n")
    .trim();
}

interface McpRemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export type McpAuth =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "client-credentials"; clientId: string; clientSecret: string };

export interface McpClient {
  listTools(opts?: {
    headers?: Record<string, string>;
    maxTools?: number;
    /** Person the request is for; selects the egress attribution when `fetchFor` is configured. */
    principalId?: string;
  }): Promise<McpRemoteTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    headers?: Record<string, string>,
    principalId?: string,
  ): Promise<CallToolResult>;
}

export function createMcpClient(opts: {
  url: string;
  auth: McpAuth;
  /** Builds the fetch used for a given caller, e.g. one routed through the agent egress proxy. */
  fetchFor?: (principalId: string | undefined) => AgentFetch;
}): McpClient {
  const trimmed = opts.url.replace(/\/+$/g, "");
  const endpoint = new URL(new URL(trimmed).pathname === "/" ? `${trimmed}/mcp` : trimmed);
  const { auth } = opts;
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
    principalId?: string,
  ): Promise<T> {
    const headers = { ...extraHeaders, ...(auth.mode === "bearer" ? { authorization: `Bearer ${auth.token}` } : {}) };
    const doFetch: AgentFetch = opts.fetchFor?.(principalId) ?? fetch;
    const transport = new StreamableHTTPClientTransport(endpoint, {
      ...(authProvider ? { authProvider } : {}),
      ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
      fetch: (url, init) => doFetch(url, { ...init, redirect: "error" }),
    });
    const client = new Client({ name: "qm", version: "1.0.0" });
    try {
      await client.connect(transport);
      return await work(client);
    } catch (e) {
      const status = e instanceof StreamableHTTPError && (e.code ?? 0) > 0 ? ` (HTTP ${e.code})` : "";
      throw new Error(`mcp ${op} failed${status}`, { cause: e });
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
          return tools.slice(0, opts?.maxTools ?? MAX_TOOLS);
        },
        opts?.headers,
        opts?.principalId,
      ),
    async callTool(name, args, headers, principalId) {
      const result = (await session(
        "tools/call",
        (client) => client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }),
        headers,
        principalId,
      )) as CallToolResult;
      if (result.isError) throw new Error(`mcp tool ${name} error: ${mcpResultText(result) || "(no detail)"}`);
      return result;
    },
  };
}
