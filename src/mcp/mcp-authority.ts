import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import type { QmAnalyticsNativeCard, TrustedAnalyticsCard } from "../types.ts";
import { parseAnalyticsNativeDelivery } from "./mcp-native-card.ts";

export interface McpHumanCallContext {
  surface: "slack";
  conversationType: "dm";
  principalId: string;
  slackTeamId: string;
  slackUserId: string;
  slackChannelId: string;
  slackMessageTs: string;
  slackThreadTs: string;
  deliveryTarget: string;
}

export interface McpAuthorityPayload {
  version: 1;
  issuer: string;
  organizationId: string;
  principalId: string;
  slackTeamId: string;
  slackUserId: string;
  slackChannelId: string;
  slackConversationType: "im";
  slackMessageTs: string;
  slackThreadTs: string;
  tool: "analytics_query";
  bodySha256: string;
  jti: string;
  iat: number;
  exp: number;
}

interface McpAuthorityEnvelope {
  token: string;
  payload: McpAuthorityPayload;
}

export interface McpAuthoritySigner {
  sign(tool: string, body: Record<string, unknown>, context: McpHumanCallContext | undefined): McpAuthorityEnvelope;
  sealAnalyticsCard(card: QmAnalyticsNativeCard, authority: McpAuthorityPayload, target: string): TrustedAnalyticsCard;
  verifyAnalyticsCard(token: unknown, target: string): QmAnalyticsNativeCard | null;
}

export interface McpAuthoritySignerConfig {
  issuer: string;
  organizationId: string;
  principalId: string;
  slackTeamId: string;
  slackUserId: string;
  slackDmChannelId: string;
  privateKey: string;
  previousPublicKeys?: string[];
  ttlSeconds: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const CANONICAL_EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SLACK_TS = /^\d{10,12}\.\d{6}$/;

function canonicalEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const at = value.lastIndexOf("@");
  return (
    value.length <= 254 &&
    at > 0 &&
    at <= 64 &&
    value === value.trim() &&
    value === value.toLowerCase() &&
    CANONICAL_EMAIL.test(value)
  );
}

function codeUnitOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => codeUnitOrder(left, right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function cardAuthority(authority: McpAuthorityPayload): Record<string, unknown> {
  return {
    organizationId: authority.organizationId,
    principalId: authority.principalId,
    slackTeamId: authority.slackTeamId,
    slackUserId: authority.slackUserId,
    slackChannelId: authority.slackChannelId,
    slackConversationType: authority.slackConversationType,
    slackMessageTs: authority.slackMessageTs,
    slackThreadTs: authority.slackThreadTs,
    jti: authority.jti,
  };
}

function fixedAuthorityMatchesConfig(authority: McpAuthorityPayload, config: McpAuthoritySignerConfig): boolean {
  return (
    authority.issuer === config.issuer &&
    authority.organizationId === config.organizationId &&
    authority.principalId === config.principalId &&
    authority.slackTeamId === config.slackTeamId &&
    authority.slackUserId === config.slackUserId &&
    authority.slackChannelId === config.slackDmChannelId &&
    authority.slackConversationType === "im"
  );
}

const CARD_TOKEN_PREFIX = "qm.analytics.card.delivery.v1";
const MAX_CARD_TOKEN_CHARS = 48_000;

function exactConfig(config: McpAuthoritySignerConfig): McpAuthoritySignerConfig {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,127}$/.test(config.issuer) ||
    !IDENTIFIER.test(config.organizationId) ||
    !canonicalEmail(config.principalId) ||
    !/^T[A-Z0-9]{2,31}$/.test(config.slackTeamId) ||
    !/^U[A-Z0-9]{2,31}$/.test(config.slackUserId) ||
    !/^D[A-Z0-9]{2,31}$/.test(config.slackDmChannelId) ||
    !Number.isSafeInteger(config.ttlSeconds) ||
    config.ttlSeconds < 10 ||
    config.ttlSeconds > 60 ||
    (config.previousPublicKeys !== undefined &&
      (!Array.isArray(config.previousPublicKeys) ||
        config.previousPublicKeys.length > 3 ||
        config.previousPublicKeys.some((value) => typeof value !== "string" || value.length === 0)))
  ) {
    throw new Error("QM MCP authority signer configuration is invalid");
  }
  return config;
}

export function createMcpAuthoritySigner(
  configInput: McpAuthoritySignerConfig,
  now = () => Date.now(),
): McpAuthoritySigner {
  const config = exactConfig(configInput);
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey({ key: Buffer.from(config.privateKey, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("QM MCP authority signer private key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("QM MCP authority signer private key must be Ed25519");
  const publicKey = createPublicKey(key);
  const verificationKeys = [publicKey];
  try {
    for (const encoded of config.previousPublicKeys ?? []) {
      const previous = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
      if (previous.asymmetricKeyType !== "ed25519") throw new Error("invalid key type");
      verificationKeys.push(previous);
    }
  } catch {
    throw new Error("QM MCP authority signer previous public key is invalid");
  }
  return {
    sign(tool, body, context) {
      if (
        tool !== "analytics_query" ||
        !context ||
        context.surface !== "slack" ||
        context.conversationType !== "dm" ||
        !canonicalEmail(context.principalId) ||
        context.principalId !== config.principalId ||
        context.slackUserId !== config.slackUserId ||
        context.slackChannelId !== config.slackDmChannelId ||
        context.slackTeamId !== config.slackTeamId ||
        !SLACK_TS.test(context.slackMessageTs) ||
        !SLACK_TS.test(context.slackThreadTs) ||
        (context.deliveryTarget !== config.slackDmChannelId &&
          context.deliveryTarget !== `${config.slackDmChannelId}:${context.slackThreadTs}`)
      ) {
        throw new Error("MCP founder DM authority denied");
      }
      const iat = Math.floor(now() / 1_000);
      const payload: McpAuthorityPayload = {
        version: 1,
        issuer: config.issuer,
        organizationId: config.organizationId,
        principalId: config.principalId,
        slackTeamId: config.slackTeamId,
        slackUserId: config.slackUserId,
        slackChannelId: config.slackDmChannelId,
        slackConversationType: "im",
        slackMessageTs: context.slackMessageTs,
        slackThreadTs: context.slackThreadTs,
        tool: "analytics_query",
        bodySha256: createHash("sha256").update(canonicalJson(body)).digest("hex"),
        jti: randomBytes(32).toString("base64url"),
        iat,
        exp: iat + config.ttlSeconds,
      };
      const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
      return {
        payload,
        token: `${encoded}.${sign(null, Buffer.from(encoded, "ascii"), key).toString("base64url")}`,
      };
    },
    sealAnalyticsCard(card, authority, target) {
      if (target !== authority.slackChannelId && target !== `${authority.slackChannelId}:${authority.slackThreadTs}`) {
        throw new Error("QM analytics card delivery target is invalid");
      }
      const accepted = parseAnalyticsNativeDelivery(
        { version: 1, delivery: { ...card, authority: cardAuthority(authority) } },
        authority,
      );
      if (!accepted) throw new Error("QM analytics card delivery is invalid");
      const payload = {
        version: 1,
        target,
        authority,
        card: accepted.unsignedCard,
      };
      const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
      const signature = sign(null, Buffer.from(`${CARD_TOKEN_PREFIX}.${encoded}`, "ascii"), key).toString("base64url");
      const token = `${encoded}.${signature}`;
      if (token.length > MAX_CARD_TOKEN_CHARS) throw new Error("QM analytics card delivery exceeds its bound");
      return token as TrustedAnalyticsCard;
    },
    verifyAnalyticsCard(token, target) {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_CARD_TOKEN_CHARS) return null;
      const pieces = token.split(".");
      if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return null;
      try {
        const [encoded, signature] = pieces as [string, string];
        const signed = Buffer.from(`${CARD_TOKEN_PREFIX}.${encoded}`, "ascii");
        const signatureBytes = Buffer.from(signature, "base64url");
        if (!verificationKeys.some((verificationKey) => verify(null, signed, verificationKey, signatureBytes))) {
          return null;
        }
        const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
        const payload = decoded as Record<string, unknown>;
        if (Object.keys(payload).sort().join(",") !== "authority,card,target,version") return null;
        if (payload.version !== 1 || payload.target !== target) return null;
        if (!payload.authority || typeof payload.authority !== "object" || Array.isArray(payload.authority))
          return null;
        const authority = payload.authority as McpAuthorityPayload;
        if (
          authority.version !== 1 ||
          authority.tool !== "analytics_query" ||
          !fixedAuthorityMatchesConfig(authority, config) ||
          (payload.target !== authority.slackChannelId &&
            payload.target !== `${authority.slackChannelId}:${authority.slackThreadTs}`)
        ) {
          return null;
        }
        const parsed = parseAnalyticsNativeDelivery(
          { version: 1, delivery: { ...(payload.card as object), authority: cardAuthority(authority) } },
          authority,
        );
        return parsed?.card ?? null;
      } catch {
        return null;
      }
    },
  };
}

export function mcpAuthoritySignerConfigFromEnv(env: NodeJS.ProcessEnv): McpAuthoritySignerConfig | undefined {
  const names = [
    "QM_MCP_AUTHORITY_ISSUER",
    "QM_MCP_AUTHORITY_ORGANIZATION_ID",
    "QM_MCP_AUTHORITY_PRINCIPAL_ID",
    "QM_MCP_AUTHORITY_SLACK_TEAM_ID",
    "QM_MCP_AUTHORITY_SLACK_USER_ID",
    "QM_MCP_AUTHORITY_SLACK_DM_CHANNEL_ID",
    "QM_MCP_AUTHORITY_ED25519_PRIVATE_KEY",
    "QM_MCP_AUTHORITY_TTL_SECONDS",
  ] as const;
  if (names.every((name) => !env[name])) return undefined;
  if (names.some((name) => !env[name])) throw new Error("QM MCP authority signer configuration is incomplete");
  return exactConfig({
    issuer: env.QM_MCP_AUTHORITY_ISSUER!,
    organizationId: env.QM_MCP_AUTHORITY_ORGANIZATION_ID!,
    principalId: env.QM_MCP_AUTHORITY_PRINCIPAL_ID!,
    slackTeamId: env.QM_MCP_AUTHORITY_SLACK_TEAM_ID!,
    slackUserId: env.QM_MCP_AUTHORITY_SLACK_USER_ID!,
    slackDmChannelId: env.QM_MCP_AUTHORITY_SLACK_DM_CHANNEL_ID!,
    privateKey: env.QM_MCP_AUTHORITY_ED25519_PRIVATE_KEY!,
    ...(env.QM_MCP_AUTHORITY_ED25519_PREVIOUS_PUBLIC_KEYS
      ? { previousPublicKeys: env.QM_MCP_AUTHORITY_ED25519_PREVIOUS_PUBLIC_KEYS.split(",") }
      : {}),
    ttlSeconds: Number(env.QM_MCP_AUTHORITY_TTL_SECONDS),
  });
}
