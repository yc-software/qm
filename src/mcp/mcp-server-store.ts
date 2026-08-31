import { createHash } from "node:crypto";
import {
  decryptSecret,
  deriveConnectorKey,
  encryptSecret,
  type SecretKey,
} from "../connectors/connector-client-store.ts";
import { parseMcpInputSchema } from "./mcp-client.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export type McpServerAuthMode = "none" | "bearer" | "client-credentials";
export type McpTokenAuthMethod = "client_secret_basic" | "client_secret_post";
export type McpTokenAudienceParameter = "audience" | "resource";
type McpCredentialState = "none" | "ready" | "reentry-required";

export interface McpAllowedTool {
  name: string;
  label: string;
  status: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  requestAuthority?: "qm.ed25519.founder-dm.v1";
  nativeRenderer?: "qm.analytics.card.v1";
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: McpServerAuthMode;
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  audience?: string;
  tokenAuthMethod?: McpTokenAuthMethod;
  tokenAudienceParameter?: McpTokenAudienceParameter;
  scopes: string[];
  allowedTools: McpAllowedTool[];
  readOnly: boolean;
  enabled: boolean;
  credentialState: McpCredentialState;
  updatedAt: number;
  updatedBy: string;
  recordVersion?: string;
}

export interface StoredMcpServer extends Omit<
  McpServer,
  "bearerToken" | "clientSecret" | "credentialState" | "recordVersion"
> {
  credentialEnc?: string;
  credentialState: McpCredentialState;
  bearerToken?: string;
  clientSecret?: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function isValidMcpServerId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function parseMcpAllowedTools(value: unknown): McpAllowedTool[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error("allowedTools must contain 1 through 64 exact tool contracts");
  }
  const names = new Set<string>();
  const labels = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("allowedTools entries are invalid");
    const record = entry as Record<string, unknown>;
    const allowedKeys = ["inputSchema", "label", "name", "nativeRenderer", "readOnly", "requestAuthority", "status"];
    if (
      Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
      !["inputSchema", "label", "name", "readOnly", "status"].every((key) => Object.hasOwn(record, key)) ||
      typeof record.name !== "string" ||
      !TOOL_NAME_PATTERN.test(record.name) ||
      typeof record.label !== "string" ||
      record.label !== record.label.trim() ||
      record.label.length < 2 ||
      record.label.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(record.label) ||
      typeof record.status !== "string" ||
      record.status !== record.status.trim() ||
      record.status.length < 2 ||
      record.status.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(record.status) ||
      typeof record.readOnly !== "boolean" ||
      (record.requestAuthority !== undefined && record.requestAuthority !== "qm.ed25519.founder-dm.v1") ||
      (record.nativeRenderer !== undefined && record.nativeRenderer !== "qm.analytics.card.v1") ||
      ((record.requestAuthority !== undefined || record.nativeRenderer !== undefined) && record.readOnly !== true) ||
      !parseMcpInputSchema(record.inputSchema)
    ) {
      throw new Error("allowedTools entries require exact name, label, status, and readOnly fields");
    }
    const labelKey = record.label.toLowerCase();
    if (names.has(record.name) || labels.has(labelKey)) throw new Error("allowedTools names and labels must be unique");
    names.add(record.name);
    labels.add(labelKey);
    return {
      name: record.name,
      label: record.label,
      status: record.status,
      readOnly: record.readOnly,
      inputSchema: parseMcpInputSchema(record.inputSchema)!,
      ...(record.requestAuthority === "qm.ed25519.founder-dm.v1" ? { requestAuthority: record.requestAuthority } : {}),
      ...(record.nativeRenderer === "qm.analytics.card.v1" ? { nativeRenderer: record.nativeRenderer } : {}),
    };
  });
}

export interface McpServerStore {
  list(): Promise<McpServer[]>;
  get(id: string): Promise<McpServer | null>;
  put(server: McpServer): Promise<void>;
  putIfCurrent(server: McpServer, expectedVersion: string | null): Promise<boolean>;
  disable(id: string, updatedBy: string, updatedAt: number): Promise<McpServer | null>;
  delete(id: string): Promise<void>;
  onChange(listener: () => void): () => void;
}

function withoutLegacySecrets(raw: StoredMcpServer): StoredMcpServer {
  const { bearerToken: _bearerToken, clientSecret: _clientSecret, credentialEnc: _credentialEnc, ...safe } = raw;
  return {
    ...safe,
    scopes: Array.isArray(raw.scopes) ? raw.scopes : [],
    allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools : [],
    enabled: false,
    credentialState: raw.auth === "none" ? "none" : "reentry-required",
  };
}

function hasLegacySecret(raw: StoredMcpServer): boolean {
  return Object.hasOwn(raw, "bearerToken") || Object.hasOwn(raw, "clientSecret");
}

function storageNeedsSanitization(raw: StoredMcpServer): boolean {
  if (hasLegacySecret(raw)) return true;
  if (raw.auth === "none") return !!raw.credentialEnc || raw.credentialState !== "none";
  return !raw.credentialEnc && (raw.credentialState !== "reentry-required" || raw.enabled);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((field) => `${JSON.stringify(field)}:${canonical(record[field])}`)
    .join(",")}}`;
}

function credentialContract(server: StoredMcpServer | McpServer): string {
  const contract =
    server.auth === "bearer"
      ? { id: server.id, auth: server.auth, url: server.url }
      : {
          id: server.id,
          auth: server.auth,
          url: server.url,
          clientId: server.clientId,
          tokenUrl: server.tokenUrl,
          audience: server.audience,
          tokenAuthMethod: server.tokenAuthMethod,
          tokenAudienceParameter: server.tokenAudienceParameter,
          scopes: server.scopes,
        };
  return createHash("sha256").update(canonical(contract), "utf8").digest("hex");
}

function scopedKey(key: SecretKey, server: StoredMcpServer | McpServer): SecretKey {
  const purpose = `mcp-server.${credentialContract(server)}`;
  const current = deriveConnectorKey(key.current, purpose);
  return {
    ...current,
    fallbacks: (key.fallbacks ?? []).map((fallback) => deriveConnectorKey(fallback.current, purpose)),
  };
}

function recordVersion(raw: StoredMcpServer): string {
  return createHash("sha256").update(canonical(raw), "utf8").digest("hex");
}

function decrypted(raw: StoredMcpServer, secret: string | undefined, versionSource = raw): McpServer {
  const { credentialEnc: _credentialEnc, ...base } = raw;
  return {
    ...base,
    scopes: Array.isArray(raw.scopes) ? raw.scopes : [],
    allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools : [],
    ...(raw.auth === "bearer" && secret ? { bearerToken: secret } : {}),
    ...(raw.auth === "client-credentials" && secret ? { clientSecret: secret } : {}),
    recordVersion: recordVersion(versionSource),
  };
}

export function createMcpServerStore(backing: DurableMap<StoredMcpServer>, key: SecretKey): McpServerStore {
  if (!backing.update || !backing.insertIfAbsent) {
    throw new Error("MCP server storage requires atomic update and insert support");
  }
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  async function decode(id: string, raw: StoredMcpServer): Promise<McpServer | null> {
    let current = raw;
    if (storageNeedsSanitization(current)) {
      const updated = await backing.update!(id, (latest) =>
        storageNeedsSanitization(latest) ? withoutLegacySecrets(latest) : latest,
      );
      if (!updated) return null;
      current = updated;
    }
    if (current.auth === "none") return decrypted(current, undefined);
    if (!current.credentialEnc || current.credentialState !== "ready") {
      return decrypted(withoutLegacySecrets(current), undefined, current);
    }
    try {
      return decrypted(current, decryptSecret(current.credentialEnc!, scopedKey(key, current)));
    } catch {
      return decrypted(withoutLegacySecrets(current), undefined, current);
    }
  }

  function encode(server: McpServer): StoredMcpServer {
    let secret: string | undefined;
    if (server.auth === "bearer") secret = server.bearerToken;
    else if (server.auth === "client-credentials") secret = server.clientSecret;
    if (server.auth !== "none" && !secret) throw new Error(`MCP server ${server.id} requires credential re-entry`);
    const { bearerToken: _bearerToken, clientSecret: _clientSecret, recordVersion: _recordVersion, ...base } = server;
    return {
      ...base,
      credentialState: server.auth === "none" ? "none" : "ready",
      ...(secret ? { credentialEnc: encryptSecret(secret, scopedKey(key, server)) } : {}),
    };
  }

  return {
    async list() {
      const entries = await backing.entries();
      const servers = await Promise.all(entries.map(([id, value]) => decode(id, value)));
      return servers.filter((server): server is McpServer => !!server).sort((a, b) => a.id.localeCompare(b.id));
    },
    async get(id) {
      const raw = await backing.get(id);
      return raw ? decode(id, raw) : null;
    },
    async put(server) {
      await backing.put(server.id, encode(server));
      emit();
    },
    async putIfCurrent(server, expectedVersion) {
      const next = encode(server);
      if (expectedVersion === null) {
        const inserted = await backing.insertIfAbsent!(server.id, next);
        if (inserted) emit();
        return inserted;
      }
      let changed = false;
      const updated = await backing.update!(server.id, (current) => {
        if (recordVersion(current) !== expectedVersion) return current;
        changed = true;
        return next;
      });
      if (!updated || !changed) return false;
      emit();
      return true;
    },
    async disable(id, updatedBy, updatedAt) {
      const updated = await backing.update!(id, (current) => ({
        ...(hasLegacySecret(current) ? withoutLegacySecrets(current) : current),
        enabled: false,
        updatedBy,
        updatedAt,
      }));
      if (!updated) return null;
      emit();
      return decode(id, updated);
    },
    async delete(id) {
      await backing.delete(id);
      emit();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
