import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

  async function session<T>(
    op: string,
    work: (client: Client) => Promise<T>,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const headers = { ...extraHeaders, ...(auth.mode === "bearer" ? { authorization: `Bearer ${auth.token}` } : {}) };
    const transport = new StreamableHTTPClientTransport(endpoint, {
      ...(authProvider ? { authProvider } : {}),
      ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
      fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
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
      if (result.isError) throw new Error(`mcp tool ${name} error: ${mcpResultText(result) || "(no detail)"}`);
      return result;
    },
  };
}
