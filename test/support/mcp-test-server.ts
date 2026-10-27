import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

interface McpRequest {
  method: string;
  path: string;
  rpc?: string;
  authorization?: string;
  actor?: string;
  approval?: string;
}

export interface McpTestServer {
  url: string;
  requests: McpRequest[];
  tokenRequests: string[];
  openSessions(): number;
  dropSessions(): Promise<void>;
  revokeTokens(): void;
}

const DEFAULT_TOOLS: Tool[] = [
  { name: "query", description: "Run a query", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "update", description: "Write a record", inputSchema: { type: "object", properties: {} } },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startMcpTestServer(
  t: { after(fn: () => Promise<void>): void },
  opts: {
    tools?: Tool[];
    pageSize?: number;
    json?: boolean;
    authorize?: (authorization: string | undefined) => boolean;
    clients?: Record<string, string>;
    authorizationServer?: string;
    call?: (name: string, args: Record<string, unknown>, authorization?: string) => CallToolResult;
    description?: string;
    instructions?: string;
  } = {},
): Promise<McpTestServer> {
  const tools = opts.tools ?? DEFAULT_TOOLS;
  const pageSize = opts.pageSize ?? tools.length;
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const tokens = new Map<string, string>();
  const requests: McpRequest[] = [];
  const tokenRequests: string[] = [];

  function mcpServer(): Server {
    const server = new Server(
      { name: "qm-test", version: "1.0.0", ...(opts.description ? { description: opts.description } : {}) },
      { capabilities: { tools: {} }, ...(opts.instructions ? { instructions: opts.instructions } : {}) },
    );
    server.setRequestHandler(ListToolsRequestSchema, (req) => {
      const start = Number(req.params?.cursor ?? 0);
      const end = start + pageSize;
      return { tools: tools.slice(start, end), ...(end < tools.length ? { nextCursor: String(end) } : {}) };
    });
    server.setRequestHandler(CallToolRequestSchema, (req, extra) => {
      const { name } = req.params;
      if (!tools.some((tool) => tool.name === name))
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
      const authorization = extra.requestInfo?.headers.authorization;
      const args = req.params.arguments ?? {};
      return (
        opts.call?.(name, args, typeof authorization === "string" ? authorization : undefined) ?? {
          content: [{ type: "text", text: `ran ${name}` }],
        }
      );
    });
    return server;
  }

  function token(req: IncomingMessage, body: string, res: ServerResponse): void {
    const form = new URLSearchParams(body);
    const basic = req.headers.authorization?.match(/^Basic (.+)$/)?.[1];
    const [clientId, secret] = basic
      ? Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent)
      : [form.get("client_id"), form.get("client_secret")];
    if (form.get("grant_type") !== "client_credentials" || !clientId || opts.clients?.[clientId] !== secret) {
      return json(res, 401, { error: "invalid_client" });
    }
    tokenRequests.push(clientId);
    const accessToken = `${clientId}-token-${tokenRequests.length}`;
    tokens.set(accessToken, clientId);
    json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600 });
  }

  function authorized(authorization: string | undefined): boolean {
    if (opts.clients) return tokens.has(authorization?.replace(/^Bearer /, "") ?? "");
    return opts.authorize ? opts.authorize(authorization) : true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const body = req.method === "POST" ? await readBody(req) : "";
    if (path === "/token" && opts.clients) return token(req, body, res);
    if (path.startsWith("/.well-known/oauth-protected-resource") && opts.authorizationServer) {
      return json(res, 200, { resource: `${url}/mcp`, authorization_servers: [opts.authorizationServer] });
    }
    if (path.startsWith("/.well-known/")) return json(res, 404, { error: "not_found" });
    const parsed = body ? (JSON.parse(body) as { method?: string }) : undefined;
    const authorization = req.headers.authorization;
    requests.push({
      method: req.method ?? "",
      path,
      ...(parsed?.method ? { rpc: parsed.method } : {}),
      ...(authorization ? { authorization } : {}),
      ...(typeof req.headers["x-qm-actor"] === "string" ? { actor: req.headers["x-qm-actor"] } : {}),
      ...(typeof req.headers["x-qm-approval"] === "string" ? { approval: req.headers["x-qm-approval"] } : {}),
    });
    if (!authorized(authorization)) {
      return json(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer error="invalid_token"' });
    }
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const transport = sessions.get(sessionId);
      if (!transport)
        return json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      return transport.handleRequest(req, res, parsed);
    }
    if (parsed?.method !== "initialize")
      return json(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "No session" }, id: null });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: opts.json ?? false,
      onsessioninitialized: (id) => void sessions.set(id, transport),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await mcpServer().connect(transport);
    await transport.handleRequest(req, res, parsed);
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { error: String(e) });
    });
  });
  http.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  async function dropSessions(): Promise<void> {
    await Promise.all([...sessions.values()].map((transport) => transport.close()));
    sessions.clear();
  }

  t.after(async () => {
    await dropSessions();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  return {
    url,
    requests,
    tokenRequests,
    openSessions: () => sessions.size,
    dropSessions,
    revokeTokens: () => tokens.clear(),
  };
}
