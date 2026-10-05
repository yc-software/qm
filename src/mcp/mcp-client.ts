// Generic Model Context Protocol (MCP) client — HTTP transport only.
//
// Speaks JSON-RPC 2.0 over a single POST endpoint, accepting both plain JSON
// and SSE-framed responses (the two response shapes the spec's streamable
// HTTP transport allows). Supports three auth modes: none, static bearer
// token, and OAuth2 client-credentials minted against `<base>/token`.
//
// This is the transport layer only: no registry, no tool injection, no
// policy. See mcp-tool-service.ts for the layer that turns registered
// servers into agent tools.

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

const realFetch: McpFetch = (url, init) => fetch(url, { ...init, redirect: "error" });

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

interface McpContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

export interface McpToolResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

function base64Size(data: string | undefined): string {
  const bytes = Math.floor(((data ?? "").replace(/=+$/, "").length * 3) / 4);
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

/**
 * Text the model sees for an MCP result. Non-text blocks become a short descriptor instead of
 * vanishing, so an image-only or resource-only result no longer reads as "[empty result]".
 */
function blockText(c: McpContentBlock): string {
  switch (c?.type) {
    case "text":
      return String(c.text ?? "");
    case "image":
    case "audio":
      return `[${c.type}: ${c.mimeType ?? "unknown type"}, ${base64Size(c.data)}]`;
    case "resource": {
      const r = c.resource ?? {};
      if (typeof r.text === "string") return r.uri ? `[resource ${r.uri}]\n${r.text}` : r.text;
      return `[resource: ${r.uri ?? "unnamed"}${r.mimeType ? `, ${r.mimeType}` : ""}, ${base64Size(r.blob)}]`;
    }
    case "resource_link":
      return `[resource link: ${c.name ? `${c.name} ` : ""}${c.uri ?? ""}${c.mimeType ? ` (${c.mimeType})` : ""}]`;
    default:
      return c?.type ? `[${c.type} content]` : "";
  }
}

export function mcpResultText(result: McpToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content.map(blockText).filter(Boolean).join("\n").trim();
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

  async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++rpcId;
    const res = await fetchImpl(`${base}/mcp`, {
      method: "POST",
      headers: {
        ...(await authHeaders()),
        "content-type": "application/json",
        accept: MCP_ACCEPT,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!res.ok) throw new Error(`mcp ${method} failed (HTTP ${res.status})`);
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
