import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { swallowAs } from "../util/errors.ts";

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
}

export type McpAuth =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "client-credentials"; clientId: string; clientSecret: string };

export interface McpClient {
  listTools(): Promise<McpRemoteTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export function createMcpClient(opts: { url: string; auth: McpAuth }): McpClient {
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

  async function session<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      ...(authProvider ? { authProvider } : {}),
      ...(auth.mode === "bearer" ? { requestInit: { headers: { authorization: `Bearer ${auth.token}` } } } : {}),
      fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
    });
    const client = new Client({ name: "qm", version: "1.0.0" });
    try {
      await client.connect(transport);
      return await work(client);
    } finally {
      await transport.terminateSession().catch(swallowAs("mcp: end session", undefined));
      await client.close();
    }
  }

  return {
    listTools: () =>
      session(async (client) => {
        const tools: McpRemoteTool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor === undefined ? undefined : { cursor });
          for (const t of page.tools)
            tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
          cursor = page.nextCursor;
        } while (cursor && tools.length < MAX_TOOLS);
        return tools.slice(0, MAX_TOOLS);
      }),
    callTool: (name, args) =>
      session(async (client) => {
        const result = (await client.callTool({ name, arguments: args }, undefined, {
          timeout: CALL_TIMEOUT_MS,
        })) as CallToolResult;
        if (result.isError) throw new Error(`mcp tool ${name} error: ${mcpResultText(result) || "(no detail)"}`);
        return result;
      }),
  };
}
