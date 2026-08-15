import { createHmac } from "node:crypto";

const TOKEN_SKEW_MS = 60_000;
const MAX_RESULT_CHARS = 60_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 30_000;

export type PipedreamEnvironment = "development" | "production";

export interface PipedreamConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: PipedreamEnvironment;
  externalIdSecret: string;
  apiUrl?: string;
  mcpUrl?: string;
}

export interface PipedreamAccount {
  id: string;
  name: string;
  healthy: boolean;
  dead: boolean;
  app: {
    name_slug: string;
    name: string;
    img_src?: string;
  };
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface PipedreamTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface AccessToken {
  value: string;
  expiresAt: number;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseMcpBody(text: string, contentType: string | null): Record<string, unknown> {
  if (!contentType?.toLowerCase().includes("text/event-stream")) return jsonObject(JSON.parse(text));
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const parsed = jsonObject(JSON.parse(data));
    if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
  }
  return {};
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("Pipedream response exceeded the size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Pipedream response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const text = await boundedText(response);
  return jsonObject(JSON.parse(text));
}

export class PipedreamClient {
  private token: AccessToken | null = null;
  private rpcId = 0;
  private readonly config: PipedreamConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly apiUrl: string;
  private readonly mcpUrl: string;

  constructor(config: PipedreamConfig, fetchImpl: typeof fetch = fetch, now: () => number = () => Date.now()) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.apiUrl = (config.apiUrl ?? "https://api.pipedream.com").replace(/\/$/, "");
    this.mcpUrl = config.mcpUrl ?? "https://remote.mcp.pipedream.net/v3";
  }

  externalUserId(principalId: string): string {
    return `qm_${createHmac("sha256", this.config.externalIdSecret).update(principalId).digest("hex").slice(0, 40)}`;
  }

  private request(input: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - TOKEN_SKEW_MS) return this.token.value;
    const response = await this.request(`${this.apiUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });
    if (!response.ok) throw new Error(`Pipedream authentication failed (HTTP ${response.status})`);
    const body = await boundedJson(response);
    const value = typeof body.access_token === "string" ? body.access_token : "";
    if (!value) throw new Error("Pipedream authentication returned no access token");
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.token = { value, expiresAt: this.now() + expiresIn * 1000 };
    return value;
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.accessToken()}`,
      "x-pd-environment": this.config.environment,
      accept: "application/json",
    };
  }

  async createConnectLink(principalId: string, redirectUri?: string): Promise<{ url: string; expiresAt: string }> {
    const response = await this.request(
      `${this.apiUrl}/v1/connect/${encodeURIComponent(this.config.projectId)}/tokens`,
      {
        method: "POST",
        headers: { ...(await this.headers()), "content-type": "application/json" },
        body: JSON.stringify({
          external_user_id: this.externalUserId(principalId),
          scope: "connect:accounts:read connect:accounts:write",
          expires_in: 900,
          ...(redirectUri ? { success_redirect_uri: redirectUri, error_redirect_uri: redirectUri } : {}),
        }),
      },
    );
    if (!response.ok) throw new Error(`Pipedream Connect link failed (HTTP ${response.status})`);
    const body = await boundedJson(response);
    const url = typeof body.connect_link_url === "string" ? body.connect_link_url : "";
    if (!url) throw new Error("Pipedream Connect returned no link");
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:") throw new Error("Pipedream Connect returned an insecure link");
    return { url, expiresAt: typeof body.expires_at === "string" ? body.expires_at : "" };
  }

  async listAccounts(principalId: string): Promise<PipedreamAccount[]> {
    const query = new URLSearchParams({
      external_user_id: this.externalUserId(principalId),
      include_credentials: "false",
      limit: "100",
    });
    const response = await this.request(
      `${this.apiUrl}/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts?${query}`,
      { headers: await this.headers() },
    );
    if (!response.ok) throw new Error(`Pipedream account list failed (HTTP ${response.status})`);
    const body = await boundedJson(response);
    return Array.isArray(body.data) ? (body.data as PipedreamAccount[]) : [];
  }

  async deleteAccount(accountId: string): Promise<void> {
    const response = await this.request(
      `${this.apiUrl}/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts/${encodeURIComponent(accountId)}`,
      { method: "DELETE", headers: await this.headers() },
    );
    if (!response.ok && response.status !== 204) {
      throw new Error(`Pipedream account removal failed (HTTP ${response.status})`);
    }
  }

  private async rpc(
    externalUserId: string,
    accountId: string,
    appSlug: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = ++this.rpcId;
    const response = await this.request(this.mcpUrl, {
      method: "POST",
      headers: {
        ...(await this.headers()),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-pd-project-id": this.config.projectId,
        "x-pd-external-user-id": externalUserId,
        "x-pd-account-id": accountId,
        "x-pd-app-slug": appSlug,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new Error(`Pipedream MCP ${method} failed (HTTP ${response.status})`);
    const envelope = parseMcpBody(await boundedText(response), response.headers.get("content-type"));
    const error = jsonObject(envelope.error);
    if (typeof error.message === "string") throw new Error(`Pipedream MCP ${method}: ${error.message}`);
    return jsonObject(envelope.result);
  }

  async listTools(connection: {
    externalUserId: string;
    accountId: string;
    appSlug: string;
  }): Promise<PipedreamTool[]> {
    const result = await this.rpc(
      connection.externalUserId,
      connection.accountId,
      connection.appSlug,
      "tools/list",
      {},
    );
    if (!Array.isArray(result.tools)) return [];
    return result.tools.flatMap((value) => {
      const tool = jsonObject(value);
      if (typeof tool.name !== "string" || !tool.name) return [];
      return [
        {
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: jsonObject(tool.inputSchema),
        },
      ];
    });
  }

  async callTool(
    connection: { externalUserId: string; accountId: string; appSlug: string },
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.rpc(connection.externalUserId, connection.accountId, connection.appSlug, "tools/call", {
      name,
      arguments: args,
    });
    if (result.isError === true) throw new Error(`Pipedream tool ${name} failed`);
    const content = Array.isArray(result.content) ? result.content : [];
    const text =
      content
        .map((item) => jsonObject(item))
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text as string)
        .join("\n") || JSON.stringify(result.structuredContent ?? result);
    return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
  }
}
