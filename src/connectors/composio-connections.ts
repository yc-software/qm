import { createHash, randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { brokerPathAllowed } from "../api/credential-broker.ts";
import { ComposioRequestError, type ComposioClient, type ComposioProxyRequest } from "./composio-client.ts";

interface ComposioActor {
  tenantId: string;
  principalId: string;
  scopeId: string;
}

type ConnectionState = "pending" | "verifying" | "redeemed" | "active" | "failed" | "disconnected";

export interface ComposioConnectionRecord {
  id: string;
  tenantId: string;
  principalId: string;
  toolkit: string;
  userId: string;
  state: ConnectionState;
  createdAt: number;
  expiresAt: number;
  verificationExpiresAt?: number;
  sessionId?: string;
  accountId?: string;
  authConfigId?: string;
  apiBaseUrl?: string;
}

function publicConnection(record: ComposioConnectionRecord) {
  return { id: record.id, toolkit: record.toolkit, state: record.state };
}

function userId(actor: ComposioActor): string {
  if (!actor.tenantId || !actor.principalId || !actor.scopeId) throw new Error("Missing Composio actor");
  return `qm_${createHash("sha256")
    .update(JSON.stringify([actor.tenantId, actor.principalId]))
    .digest("hex")}`;
}

function apiBase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      /[{}<>]/.test(value)
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function canonicalRequest(record: ComposioConnectionRecord, input: ComposioProxyRequest): ComposioProxyRequest {
  if (!record.apiBaseUrl) throw new Error("This integration does not support a verified HTTP target");
  const request = structuredClone(input);
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error("Invalid connector request URL");
  }
  const base = new URL(record.apiBaseUrl);
  if (
    /[\x00-\x20\\]/.test(request.url) ||
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !brokerPathAllowed(url.pathname, [base.pathname])
  ) {
    throw new Error("Connector request target is not allowed");
  }
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(request.method))
    throw new Error("Connector request method is not allowed");
  for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value);
  request.url = url.href;
  delete request.query;
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (!["accept", "content-type"].includes(name.toLowerCase()) || /[\r\n]/.test(value))
      throw new Error("Connector request header is not allowed");
  }
  if (request.body !== undefined && request.binaryBody !== undefined)
    throw new Error("Choose one connector request body");
  return request;
}

export function createComposioConnections(options: {
  client: ComposioClient;
  records: DurableMap<ComposioConnectionRecord>;
  lock: AdvisoryLock;
  authorizeRequest: (
    actor: ComposioActor,
    connection: ReturnType<typeof publicConnection>,
    request: ComposioProxyRequest,
  ) => Promise<void>;
  audit: (event: { actor: ComposioActor; connectionId: string; action: string; outcome: string }) => Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const { client, records, lock } = options;
  async function owned(actor: ComposioActor, connectionId: string): Promise<ComposioConnectionRecord> {
    const expectedUser = userId(actor);
    const record = await records.get(connectionId);
    if (
      !record ||
      record.tenantId !== actor.tenantId ||
      record.principalId !== actor.principalId ||
      record.userId !== expectedUser
    )
      throw new Error("Connection not found");
    return record;
  }
  function withConnection<T>(
    actor: ComposioActor,
    connectionId: string,
    fn: (record: ComposioConnectionRecord) => Promise<T>,
  ): Promise<T> {
    return lock.withLock(`composio:${connectionId}`, async () => fn(await owned(actor, connectionId)));
  }
  async function verifiedAccount(record: ComposioConnectionRecord) {
    if (!record.accountId) throw new Error("Connection is not ready");
    const account = await client.getAccount(record.accountId);
    if (
      account.id !== record.accountId ||
      account.toolkit !== record.toolkit ||
      !account.private ||
      (account.userId !== undefined && account.userId !== record.userId) ||
      (record.authConfigId !== undefined && account.authConfigId !== record.authConfigId)
    )
      throw new Error("Connection verification failed");
    return account;
  }
  return {
    async start(actor: ComposioActor, slug: string) {
      const remoteUserId = userId(actor);
      const toolkit = await client.toolkit(slug);
      if (toolkit.slug !== slug || !toolkit.enabled) throw new Error("Integration is unavailable");
      if (!toolkit.managedAuthSchemes.length) throw new Error("This integration needs additional authentication setup");
      const record: ComposioConnectionRecord = {
        id: randomUUID(),
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        toolkit: slug,
        userId: remoteUserId,
        state: "pending",
        createdAt: now(),
        expiresAt: now() + 10 * 60_000,
        ...(toolkit.native && apiBase(toolkit.baseUrl) ? { apiBaseUrl: apiBase(toolkit.baseUrl) } : {}),
      };
      await records.put(record.id, record);
      return withConnection(actor, record.id, async (record) => {
        if (record.state !== "pending") throw new Error("Connection attempt was canceled");
        try {
          await options.audit({ actor, connectionId: record.id, action: "connect", outcome: "started" });
          const sessionId = await client.createSession(record.userId);
          await records.merge(record.id, { sessionId });
          const link = await client.authorizeSession(sessionId, slug);
          await records.merge(record.id, { accountId: link.connectedAccountId });
          return { ...publicConnection(record), connectUrl: link.redirectUrl, expiresAt: record.expiresAt };
        } catch {
          await records.merge(record.id, { state: "failed" });
          throw new Error("Could not start connection; start a new connection attempt");
        }
      });
    },
    complete(actor: ComposioActor, connectionId: string, sessionUri: string) {
      return withConnection(actor, connectionId, async (record) => {
        if (record.state === "pending") {
          if (record.expiresAt <= now() || !record.accountId)
            throw new Error("Connection attempt is not pending or has expired");
          await records.merge(record.id, { state: "verifying", verificationExpiresAt: now() + 120_000 });
          let completed;
          try {
            completed = await client.completeAuth(sessionUri, userId(actor));
          } catch {
            await records.merge(record.id, { state: "failed" });
            throw new Error("Could not verify connection; disconnect this attempt before starting again");
          }
          if (completed.connectedAccountId !== record.accountId || completed.toolkit !== record.toolkit) {
            await records.merge(record.id, { state: "failed" });
            throw new Error("Could not verify connection; disconnect this attempt before starting again");
          }
          await records.merge(record.id, { state: "redeemed" });
        } else if (record.state !== "redeemed") {
          throw new Error("Connection attempt is not pending; disconnect uncertain attempts before starting again");
        }
        const account = await verifiedAccount(record);
        if (account.status !== "ACTIVE" || account.disabled) throw new Error("Connection is not active");
        await options.audit({ actor, connectionId, action: "connect", outcome: "verified" });
        await records.merge(record.id, { state: "active", authConfigId: account.authConfigId });
        return publicConnection({ ...record, state: "active" });
      });
    },
    status(actor: ComposioActor, connectionId: string) {
      return withConnection(actor, connectionId, async (record) => {
        if (record.state === "verifying" && (record.verificationExpiresAt ?? record.expiresAt) <= now()) {
          await records.merge(record.id, { state: "failed" });
          return { ...publicConnection({ ...record, state: "failed" }), restartRequired: true };
        }
        if (record.state !== "active") return publicConnection(record);
        try {
          const account = await verifiedAccount(record);
          return { ...publicConnection(record), needsReconnect: account.disabled || account.status !== "ACTIVE" };
        } catch (error) {
          if (error instanceof ComposioRequestError && error.status === 404)
            return { ...publicConnection(record), needsReconnect: true };
          throw error;
        }
      });
    },
    disconnect(actor: ComposioActor, connectionId: string) {
      return withConnection(actor, connectionId, async (record) => {
        await records.merge(record.id, { state: "disconnected" });
        await options.audit({ actor, connectionId, action: "disconnect", outcome: "blocked_locally" });
        if (record.accountId) await client.deleteAccount(record.accountId);
        return publicConnection({ ...record, state: "disconnected" });
      });
    },
    request(actor: ComposioActor, connectionId: string, input: ComposioProxyRequest) {
      return withConnection(actor, connectionId, async (record) => {
        if (record.state !== "active" || !record.accountId) throw new Error("Connection is not active");
        const request = canonicalRequest(record, input);
        await options.authorizeRequest(actor, publicConnection(record), structuredClone(request));
        const account = await verifiedAccount(record);
        if (account.status !== "ACTIVE" || account.disabled) throw new Error("Connection needs reconnecting");
        await options.audit({ actor, connectionId, action: "request", outcome: "authorized" });
        const response = await client.proxy(record.accountId, request);
        try {
          await options.audit({ actor, connectionId, action: "request", outcome: String(response.status) });
          return response;
        } catch {
          return { ...response, auditWarning: "Request executed but outcome audit failed; do not retry the operation" };
        }
      });
    },
  };
}
