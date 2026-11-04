import { orgId as configOrgId } from "../config.ts";
import { randomBytes, createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
import type { ConsentMode, OAuthClientResolver, ResolvedClient } from "./oauth.ts";
import { PROVIDERS, createSecretClientResolver } from "./oauth.ts";
import type { SecretSource } from "../credentials/secret-source.ts";

export interface StoredConnectorClient {
  scopeId: string;
  provider: string;
  clientId: string;
  secretEnc: string;
  scopes?: string[];
  redirectAllowlist?: string[];
  consentMode?: ConsentMode;
  hostedDomain?: string;
  enabled: boolean;
  updatedBy?: string;
  updatedAt: number;
}

export interface ConnectorClientInput {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  redirectAllowlist?: string[];
  consentMode?: ConsentMode;
  hostedDomain?: string;
  enabled?: boolean;
  updatedBy?: string;
}

export interface PublicConnectorClient {
  provider: string;
  clientId: string;
  scopes?: string[];
  redirectAllowlist?: string[];
  consentMode?: ConsentMode;
  hostedDomain?: string;
  enabled: boolean;
  hasSecret: boolean;
  updatedBy?: string;
  updatedAt: number;
}

export interface DecryptedConnectorClient {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  redirectAllowlist?: string[];
  consentMode?: ConsentMode;
  hostedDomain?: string;
  enabled: boolean;
}

export interface SecretKey {
  current: Buffer;
  legacy: Buffer;
  fallbacks?: SecretKey[];
}

const HKDF_SALT = "agent-platform.secret-box";

export function deriveConnectorKey(material: Buffer | string, purpose = "connector-secrets"): SecretKey {
  const ikm = Buffer.isBuffer(material) ? material : Buffer.from(material, "utf8");
  const current = Buffer.from(hkdfSync("sha256", ikm, HKDF_SALT, `${purpose}.v2`, 32));
  const legacy =
    Buffer.isBuffer(material) && material.length === 32 ? material : createHash("sha256").update(material).digest();
  return { current, legacy };
}

export function encryptSecret(plain: string, key: SecretKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.current, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(enc: string, key: SecretKey): string {
  const parts = enc.split(":");
  const v2 = parts[0] === "v2";
  const [ivB, tagB, ctB] = v2 ? parts.slice(1) : parts;
  if (parts.length !== (v2 ? 4 : 3) || !ivB || !tagB || ctB === undefined) {
    throw new Error("malformed encrypted secret");
  }
  const attempt = (k: SecretKey): string => {
    const decipher = createDecipheriv("aes-256-gcm", v2 ? k.current : k.legacy, Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
  };
  try {
    return attempt(key);
  } catch (e) {
    for (const fb of key.fallbacks ?? []) {
      try {
        return attempt(fb);
      } catch (error) {
        void error;
      }
    }
    throw e;
  }
}

export function toPublicConnectorClient(rec: StoredConnectorClient): PublicConnectorClient {
  return {
    provider: rec.provider,
    clientId: rec.clientId,
    ...(rec.scopes ? { scopes: rec.scopes } : {}),
    ...(rec.redirectAllowlist ? { redirectAllowlist: rec.redirectAllowlist } : {}),
    ...(rec.consentMode ? { consentMode: rec.consentMode } : {}),
    ...(rec.hostedDomain ? { hostedDomain: rec.hostedDomain } : {}),
    enabled: rec.enabled,
    hasSecret: !!rec.secretEnc,
    ...(rec.updatedBy ? { updatedBy: rec.updatedBy } : {}),
    updatedAt: rec.updatedAt,
  };
}

export interface ConnectorClientReader {
  getConnectorClientSecret(orgScopeId: string, provider: string): Promise<DecryptedConnectorClient | null>;
}

export function createConnectorClientResolver(opts: {
  reader: ConnectorClientReader;
  orgScopeId: (orgId: string) => string;
  secrets?: SecretSource;
}): OAuthClientResolver {
  const envResolver = createSecretClientResolver(opts.secrets);
  return async (providerName, ctx): Promise<ResolvedClient> => {
    if (!PROVIDERS[providerName]) throw new Error(`unknown OAuth provider: ${providerName}`);
    const orgId = configOrgId();
    const rec = await opts.reader.getConnectorClientSecret(opts.orgScopeId(orgId), providerName);
    if (rec) {
      if (!rec.enabled) throw new Error(`connector '${providerName}' is disabled for this org`);
      return {
        id: rec.clientId,
        secret: rec.clientSecret,
        clientRef: `org:${orgId}:${providerName}`,
        ...(rec.scopes ? { scopes: rec.scopes } : {}),
        ...(rec.redirectAllowlist ? { redirectAllowlist: rec.redirectAllowlist } : {}),
        ...(rec.hostedDomain ? { hostedDomain: rec.hostedDomain } : {}),
      };
    }
    return envResolver(providerName, ctx);
  };
}
