import { z } from "zod";
import type { SecretSource } from "../credentials/secret-source.ts";

const BASE_URL = "https://backend.composio.dev/api/v3.1";
const MAX_RESPONSE_BYTES = 2_000_000;
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const toolkitSchema = z.object({
  slug: identifier,
  name: z.string(),
  composio_managed_auth_schemes: z.array(z.string()).optional(),
  auth_schemes: z.array(z.string()).optional(),
  no_auth: z.boolean().optional(),
  type: z.enum(["native", "custom"]).optional(),
  base_url: z.string().optional(),
  meta: z.object({ description: z.string().optional() }).optional(),
});
const accountSchema = z.object({
  id: identifier,
  user_id: z.string().optional(),
  status: z.string(),
  is_disabled: z.boolean(),
  toolkit: z.object({ slug: identifier }),
  auth_config: z.object({ id: identifier, is_disabled: z.boolean() }),
  experimental: z
    .object({
      account_type: z.enum(["PRIVATE", "SHARED"]),
      acl_config_for_shared: z
        .object({
          allow_all_users: z.boolean().optional(),
          allowed_user_ids: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});

interface ComposioToolkit {
  slug: string;
  name: string;
  description: string;
  managedAuthSchemes: string[];
  authSchemes: string[];
  noAuth: boolean;
  native: boolean;
  baseUrl?: string;
}

interface ComposioBinaryData {
  url: string;
  contentType: string;
  size: number;
  expiresAt?: string;
}

interface ComposioAccount {
  id: string;
  userId?: string;
  toolkit: string;
  authConfigId: string;
  status: string;
  disabled: boolean;
  private: boolean;
}

export class ComposioRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Composio request failed (HTTP ${status})`);
    this.name = "ComposioRequestError";
    this.status = status;
  }
}

export interface ComposioProxyRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  binaryBody?: { base64: string; contentType: string };
}

export interface ComposioClient {
  configured(): Promise<boolean>;
  listToolkits(options?: {
    search?: string;
    cursor?: string;
  }): Promise<{ items: ComposioToolkit[]; nextCursor?: string }>;
  toolkit(slug: string): Promise<ComposioToolkit & { enabled: boolean }>;
  createSession(userId: string): Promise<string>;
  authorizeSession(sessionId: string, slug: string): Promise<{ connectedAccountId: string; redirectUrl: string }>;
  completeAuth(
    sessionUri: string,
    authenticatedUserId: string,
  ): Promise<{ connectedAccountId: string; toolkit: string }>;
  getAccount(id: string): Promise<ComposioAccount>;
  deleteAccount(id: string): Promise<void>;
  proxy(
    id: string,
    request: ComposioProxyRequest,
  ): Promise<{ status: number; data: unknown; headers: Record<string, string>; binaryData?: ComposioBinaryData }>;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Invalid Composio response");
  return result.data;
}

function id(value: string): string {
  if (!identifier.safeParse(value).success) throw new Error("Invalid Composio identifier");
  return value;
}

function httpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Composio URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) {
    throw new Error("Invalid Composio URL");
  }
  return url.toString();
}

function toolkit(value: z.infer<typeof toolkitSchema>): ComposioToolkit {
  return {
    slug: value.slug,
    name: value.name,
    description: value.meta?.description ?? "",
    managedAuthSchemes: value.composio_managed_auth_schemes ?? [],
    authSchemes: value.auth_schemes ?? [],
    noAuth: value.no_auth === true,
    native: value.type === "native",
    ...(value.base_url ? { baseUrl: value.base_url } : {}),
  };
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Composio response too large");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("Invalid or oversized Composio response");
  } finally {
    reader.releaseLock();
  }
}

export function createComposioClient(options: { secrets: SecretSource; fetchImpl?: typeof fetch }): ComposioClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const key = await options.secrets.get("COMPOSIO_API_KEY");
    if (!key) throw new Error("Composio is not configured");
    let response: Response;
    try {
      response = await fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers: { "x-api-key": key, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Composio request failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ComposioRequestError(response.status);
    }
    if (response.status === 204) return null;
    return readResponse(response);
  }
  return {
    configured: async () => Boolean(await options.secrets.get("COMPOSIO_API_KEY")),
    async listToolkits(options = {}) {
      const query = new URLSearchParams({ limit: "100", sort_by: "usage", include_deprecated: "false" });
      if (options.search) query.set("search", options.search);
      if (options.cursor) query.set("cursor", options.cursor);
      const page = parse(
        z.object({ items: z.array(toolkitSchema), next_cursor: z.string().nullish() }),
        await request("GET", `/toolkits?${query}`),
      );
      return { items: page.items.map(toolkit), ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}) };
    },
    async toolkit(slug) {
      const value = parse(
        toolkitSchema.extend({ enabled: z.boolean() }),
        await request("GET", `/toolkits/${id(slug)}`),
      );
      return { ...toolkit(value), enabled: value.enabled };
    },
    async createSession(userId) {
      if (!userId || userId.length > 256) throw new Error("Invalid Composio user");
      const value = parse(
        z.object({ session_id: identifier, config: z.object({ user_id: z.string() }) }),
        await request("POST", "/tool_router/session", {
          user_id: userId,
          manage_connections: { enable: false },
          workbench: { enable: false },
          multi_account: { enable: true, require_explicit_selection: true },
        }),
      );
      if (value.config.user_id !== userId) throw new Error("Composio session owner mismatch");
      return value.session_id;
    },
    async authorizeSession(sessionId, slug) {
      const value = parse(
        z.object({ connected_account_id: identifier, redirect_url: z.string() }),
        await request("POST", `/tool_router/session/${id(sessionId)}/link`, {
          toolkit: id(slug),
          experimental: { account_type: "PRIVATE" },
        }),
      );
      return { connectedAccountId: value.connected_account_id, redirectUrl: httpsUrl(value.redirect_url) };
    },
    async completeAuth(sessionUri, authenticatedUserId) {
      if (!sessionUri || sessionUri.length > 8192 || !authenticatedUserId || authenticatedUserId.length > 256)
        throw new Error("Invalid Composio completion");
      const value = parse(
        z.object({ connected_account_id: identifier, toolkit_slug: identifier }),
        await request("POST", "/connected_accounts/complete_auth", {
          session_uri: sessionUri,
          user_id: authenticatedUserId,
        }),
      );
      return { connectedAccountId: value.connected_account_id, toolkit: value.toolkit_slug };
    },
    async getAccount(accountId) {
      const value = parse(accountSchema, await request("GET", `/connected_accounts/${id(accountId)}`));
      if (value.id !== accountId) throw new Error("Composio account mismatch");
      const acl = value.experimental?.acl_config_for_shared;
      return {
        id: value.id,
        userId: value.user_id,
        toolkit: value.toolkit.slug,
        authConfigId: value.auth_config.id,
        status: value.status,
        disabled: value.is_disabled || value.auth_config.is_disabled,
        private:
          value.experimental?.account_type === "PRIVATE" && !acl?.allow_all_users && !acl?.allowed_user_ids?.length,
      };
    },
    async deleteAccount(accountId) {
      await request("DELETE", `/connected_accounts/${id(accountId)}`);
    },
    async proxy(accountId, input) {
      id(accountId);
      const endpoint = httpsUrl(input.url);
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(input.method))
        throw new Error("Invalid Composio proxy method");
      if (input.body !== undefined && input.binaryBody !== undefined)
        throw new Error("Choose one Composio request body");
      const parameters: Array<{ name: string; value: string; type: "query" | "header" }> = [];
      for (const [name, value] of Object.entries(input.query ?? {})) parameters.push({ name, value, type: "query" });
      for (const [name, value] of Object.entries(input.headers ?? {})) {
        if (!["accept", "content-type"].includes(name.toLowerCase()) || /[\r\n]/.test(value))
          throw new Error("Unsupported Composio proxy header");
        parameters.push({ name, value, type: "header" });
      }
      const result = parse(
        z.object({
          status: z.number().int().min(100).max(599),
          data: z.unknown(),
          binary_data: z
            .object({
              url: z.string(),
              content_type: z.string(),
              size: z.number().int().nonnegative(),
              expires_at: z.string().optional(),
            })
            .optional(),
          headers: z.record(z.string(), z.string()).default({}),
        }),
        await request("POST", "/tools/execute/proxy", {
          connected_account_id: accountId,
          endpoint,
          method: input.method,
          parameters,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.binaryBody === undefined
            ? {}
            : { binary_body: { base64: input.binaryBody.base64, content_type: input.binaryBody.contentType } }),
        }),
      );
      const headers = Object.fromEntries(
        Object.entries(result.headers).filter(([name]) =>
          ["content-type", "content-length", "retry-after"].includes(name.toLowerCase()),
        ),
      );
      return {
        status: result.status,
        data: result.data,
        headers,
        ...(result.binary_data
          ? {
              binaryData: {
                url: httpsUrl(result.binary_data.url),
                contentType: result.binary_data.content_type,
                size: result.binary_data.size,
                ...(result.binary_data.expires_at ? { expiresAt: result.binary_data.expires_at } : {}),
              },
            }
          : {}),
      };
    },
  };
}
