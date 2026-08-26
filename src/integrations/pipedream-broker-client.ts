import { createHmac } from "node:crypto";
import {
  normalizePipedreamAppSlug,
  type PipedreamAccount,
  type PipedreamApp,
  type PipedreamConnectClient,
  type PipedreamTool,
} from "./pipedream-client.ts";

const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface BrokerConfig {
  url: string;
  token: string;
  externalIdSecret: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw new Error("Integration broker response was too large");
  if (!response.body) return {};
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
        throw new Error("Integration broker response was too large");
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
  return object(JSON.parse(new TextDecoder().decode(body)));
}

export class PipedreamBrokerClient implements PipedreamConnectClient {
  private readonly base: string;
  private readonly config: BrokerConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: BrokerConfig, fetchImpl: typeof fetch = fetch) {
    const url = new URL(config.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("PIPEDREAM_BROKER_URL must be an HTTPS URL without credentials, query, or fragment");
    }
    if (!config.token.trim() || /\s/.test(config.token)) throw new Error("PIPEDREAM_BROKER_TOKEN is invalid");
    this.base = url.toString().replace(/\/$/, "");
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  externalUserId(principalId: string): string {
    return `qm_${createHmac("sha256", this.config.externalIdSecret).update(principalId).digest("hex").slice(0, 40)}`;
  }

  managementOwnerId(account: PipedreamAccount, principalId: string): string {
    const value = (account as PipedreamAccount & { management_owner_id?: unknown }).management_owner_id;
    return typeof value === "string" && value.trim() ? value.trim() : principalId;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Integration broker request failed (HTTP ${response.status})`);
    return response.status === 204 ? {} : responseJson(response);
  }

  async listApps(query: string): Promise<PipedreamApp[]> {
    const body = await this.request(`/apps?q=${encodeURIComponent(query.trim().slice(0, 120))}`);
    return Array.isArray(body.apps) ? (body.apps as PipedreamApp[]) : [];
  }

  async createConnectLink(
    principalId: string,
    appSlug: string,
    redirectUri?: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const app = normalizePipedreamAppSlug(appSlug);
    if (!app) throw new Error("A valid integration app is required");
    const body = await this.request("/connect-link", {
      method: "POST",
      body: JSON.stringify({ principal_id: principalId, app, ...(redirectUri ? { redirect_uri: redirectUri } : {}) }),
    });
    const url = typeof body.url === "string" ? body.url : "";
    if (!url) throw new Error("Integration broker returned no link");
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== "https://pipedream.com" ||
      parsed.pathname !== "/_static/connect.html" ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error("Integration broker returned an invalid link");
    }
    return { url: parsed.toString(), expiresAt: typeof body.expires_at === "string" ? body.expires_at : "" };
  }

  async listAccounts(principalId: string): Promise<PipedreamAccount[]> {
    const body = await this.request(`/accounts?principal_id=${encodeURIComponent(principalId)}`);
    return Array.isArray(body.accounts) ? (body.accounts as PipedreamAccount[]) : [];
  }

  async deleteAccount(principalId: string, accountId: string): Promise<void> {
    await this.request(`/accounts/${encodeURIComponent(accountId)}?principal_id=${encodeURIComponent(principalId)}`, {
      method: "DELETE",
    });
  }

  async listTools(connection: {
    externalUserId: string;
    ownerId: string;
    accountId: string;
    appSlug: string;
  }): Promise<PipedreamTool[]> {
    const body = await this.request("/tools/list", {
      method: "POST",
      body: JSON.stringify({
        principal_id: connection.ownerId,
        account_id: connection.accountId,
        app: connection.appSlug,
      }),
    });
    return Array.isArray(body.tools) ? (body.tools as PipedreamTool[]) : [];
  }

  async callTool(
    connection: {
      externalUserId: string;
      ownerId: string;
      accountId: string;
      appSlug: string;
      target?: { type: string; id: string; name: string; verified: true };
    },
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const body = await this.request("/tools/call", {
      method: "POST",
      body: JSON.stringify({
        principal_id: connection.ownerId,
        account_id: connection.accountId,
        app: connection.appSlug,
        tool: name,
        ...(connection.target?.verified ? { target_id: connection.target.id } : {}),
        arguments: args,
      }),
    });
    if (typeof body.result !== "string") throw new Error("Integration broker returned no result");
    return body.result;
  }
}
