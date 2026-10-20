import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface McpFixtureTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpFixtureRequest {
  method: string;
  authorization: string | undefined;
  sessionId: string | undefined;
}

export interface McpFixture {
  url: string;
  origin: string;
  requests: McpFixtureRequest[];
  calls: Array<{ name: string; args: Record<string, unknown>; authorization: string | undefined }>;
  cancelled: string[];
  mints: number;
  dropSessions(): void;
  revokeTokens(): void;
  close(): Promise<void>;
}

const DEFAULT_TOOLS: McpFixtureTool[] = [
  { name: "query", description: "Run a query", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "update", description: "Write a record" },
];

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : undefined;
}

export async function startMcpFixture(opts?: {
  path?: string;
  tools?: McpFixtureTool[];
  pageSize?: number;
  bearer?: string;
  clientCredentials?: Array<{ clientId: string; clientSecret: string }>;
  reply?: (name: string, args: Record<string, unknown>) => unknown;
  initializeDelayMs?: number;
}): Promise<McpFixture> {
  const path = opts?.path ?? "/mcp";
  const tools = opts?.tools ?? DEFAULT_TOOLS;
  const pageSize = opts?.pageSize ?? tools.length;
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const validTokens = new Set<string>(opts?.bearer ? [opts.bearer] : []);
  const fixture: McpFixture = {
    url: "",
    origin: "",
    requests: [],
    calls: [],
    cancelled: [],
    mints: 0,
    dropSessions: () => sessions.clear(),
    revokeTokens: () => validTokens.clear(),
    close: async () => {},
  };

  function mcpServer(): Server {
    const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, (request) => {
      const start = Number(request.params?.cursor ?? 0);
      const page = tools.slice(start, start + pageSize).map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as { type: "object" },
      }));
      const next = start + pageSize;
      return { tools: page, ...(next < tools.length ? { nextCursor: String(next) } : {}) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const authorization = extra.requestInfo?.headers.authorization;
      fixture.calls.push({
        name: request.params.name,
        args,
        authorization: typeof authorization === "string" ? authorization : undefined,
      });
      if (request.params.name === "slow") {
        await new Promise<void>((resolve) => extra.signal.addEventListener("abort", () => resolve(), { once: true }));
        fixture.cancelled.push(request.params.name);
        return { content: [{ type: "text", text: "late" }] };
      }
      const custom = await opts?.reply?.(request.params.name, args);
      if (custom) return custom as never;
      return { content: [{ type: "text", text: `ran ${request.params.name}${args.q ? ` ${String(args.q)}` : ""}` }] };
    });
    return server;
  }

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fixture");
      if (url.pathname === "/token" && opts?.clientCredentials) {
        const client = opts.clientCredentials.find(
          ({ clientId, clientSecret }) =>
            req.headers.authorization === `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        );
        if (!client) {
          res.writeHead(401, { "content-type": "application/json" }).end('{"error":"invalid_client"}');
          return;
        }
        const token = `${client.clientId}-${++fixture.mints}`;
        validTokens.add(token);
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 3600 }));
        return;
      }
      if (url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      const authorization = req.headers.authorization;
      if ((opts?.bearer || opts?.clientCredentials) && !validTokens.has(authorization?.replace(/^Bearer /, "") ?? "")) {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end();
        return;
      }
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const message = body as { method?: string } | undefined;
      fixture.requests.push({ method: message?.method ?? req.method ?? "", authorization, sessionId });
      if (message?.method === "initialize" && opts?.initializeDelayMs)
        await new Promise((resolve) => setTimeout(resolve, opts.initializeDelayMs));
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      let transport = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !transport) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"session not found"}');
        return;
      }
      if (!transport) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => void sessions.set(id, created),
        });
        await mcpServer().connect(created);
        transport = created;
      }
      await transport.handleRequest(req, res, body);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  fixture.origin = origin;
  fixture.url = `${origin}${path}`;
  fixture.close = async () => {
    sessions.clear();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  return fixture;
}
