const TOKEN_SKEW_MS = 60_000;
const MCP_ACCEPT = "application/json, text/event-stream";

interface McpHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

export type McpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<McpHttpResponse>;

const realFetch: McpFetch = (url, init) => fetch(url, init);

function baseUrl(mcpUrl: string): string {
  return mcpUrl.replace(/\/+$/g, "").replace(/\/mcp$/g, "");
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface McpEnvelope {
  result?: unknown;
  error?: { message?: string };
  id?: unknown;
}

function parseSseEnvelopes(body: string): McpEnvelope[] {
  const out: McpEnvelope[] = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    const parsed = safeJson(data) as McpEnvelope | null;
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseMcpEnvelope(text: string, contentType: string | null | undefined, id?: unknown): McpEnvelope | null {
  const isSse = !!contentType && contentType.toLowerCase().includes("text/event-stream");
  if (isSse) {
    const envelopes = parseSseEnvelopes(text);
    const carries = (e: McpEnvelope): boolean => e.result !== undefined || e.error !== undefined;
    return (
      (id !== undefined ? envelopes.find((e) => e.id === id && carries(e)) : undefined) ??
      envelopes.find(carries) ??
      null
    );
  }
  return safeJson(text) as McpEnvelope | null;
}

export interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export function mcpResultText(result: McpToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c?.type === "text")
    .map((c) => String(c.text ?? ""))
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
  readonly base: string;
  readonly host: string;
  listTools(): Promise<McpRemoteTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export function createMcpClient(opts: {
  url: string;
  auth: McpAuth;
  fetchImpl?: McpFetch;
  now?: () => number;
}): McpClient {
  const fetchImpl = opts.fetchImpl ?? realFetch;
  const now = opts.now ?? (() => Date.now());
  const base = baseUrl(opts.url);
  const host = hostOf(base);
  let cached: CachedToken | null = null;
  let rpcId = 0;
  let session: Promise<string | null> | null = null;

  async function mintToken(clientId: string, clientSecret: string): Promise<string> {
    if (cached && now() < cached.expiresAt - TOKEN_SKEW_MS) return cached.accessToken;
    const res = await fetchImpl(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    if (!res.ok) throw new Error(`mcp token mint failed (HTTP ${res.status})`);
    const body = (safeJson(await res.text()) ?? {}) as { access_token?: unknown; expires_in?: unknown };
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    if (!accessToken) throw new Error("mcp token mint returned no access_token");
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 0;
    cached = { accessToken, expiresAt: expiresIn > 0 ? now() + expiresIn * 1000 : Infinity };
    return accessToken;
  }

  async function authHeaders(): Promise<Record<string, string>> {
    const auth = opts.auth;
    if (auth.mode === "none") return {};
    if (auth.mode === "bearer") return { authorization: `Bearer ${auth.token}` };
    return { authorization: `Bearer ${await mintToken(auth.clientId, auth.clientSecret)}` };
  }

  async function post(payload: Record<string, unknown>, active: string | null): Promise<McpHttpResponse> {
    return fetchImpl(`${base}/mcp`, {
      method: "POST",
      headers: {
        ...(await authHeaders()),
        "content-type": "application/json",
        accept: MCP_ACCEPT,
        ...(active ? { "mcp-session-id": active } : {}),
      },
      body: JSON.stringify(payload),
    });
  }

  async function negotiate(): Promise<string | null> {
    const id = ++rpcId;
    const res = await post(
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "qm-mcp-client", version: "1.0" },
        },
      },
      null,
    );
    if (res.status === 401 || res.status === 403) throw new Error(`mcp initialize failed (HTTP ${res.status})`);
    if (!res.ok) return null;
    const parsed = parseMcpEnvelope(await res.text(), res.headers?.get("content-type"), id);
    if (!parsed || parsed.error) return null;
    const negotiated = res.headers?.get("mcp-session-id") ?? null;
    if (!negotiated) return null;
    const ack = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, negotiated);
    await ack.text();
    if (!ack.ok) throw new Error(`mcp notifications/initialized failed (HTTP ${ack.status})`);
    return negotiated;
  }

  function sessionOnce(): Promise<string | null> {
    session ??= negotiate().catch((e: unknown) => {
      session = null;
      throw e;
    });
    return session;
  }

  async function rpc(method: string, params: Record<string, unknown>, retried = false): Promise<unknown> {
    const pending = sessionOnce();
    const active = await pending;
    const id = ++rpcId;
    const res = await post({ jsonrpc: "2.0", id, method, params }, active);
    if (!res.ok) {
      if (res.status === 404 && active && !retried) {
        if (session === pending) session = null;
        return rpc(method, params, true);
      }
      throw new Error(`mcp ${method} failed (HTTP ${res.status})`);
    }
    const parsed = parseMcpEnvelope(await res.text(), res.headers?.get("content-type"), id);
    if (!parsed) throw new Error(`mcp ${method} returned non-JSON`);
    if (parsed.error) throw new Error(`mcp ${method} error: ${parsed.error.message ?? "unknown"}`);
    return parsed.result ?? {};
  }

  return {
    base,
    host,
    async listTools() {
      const result = (await rpc("tools/list", {})) as { tools?: unknown };
      if (!Array.isArray(result.tools)) return [];
      const out: McpRemoteTool[] = [];
      for (const raw of result.tools) {
        const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof t.name !== "string" || !t.name) continue;
        out.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          inputSchema:
            t.inputSchema && typeof t.inputSchema === "object"
              ? (t.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
        });
      }
      return out;
    },
    async callTool(name, args) {
      const result = (await rpc("tools/call", { name, arguments: args })) as McpToolResult;
      if (result.isError) throw new Error(`mcp tool ${name} error: ${mcpResultText(result) || "(no detail)"}`);
      return result;
    },
  };
}
