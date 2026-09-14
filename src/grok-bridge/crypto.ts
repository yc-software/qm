import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const GROK_BRIDGE_PROTOCOL = "qm-grok-bridge/v1";
export const GROK_BRIDGE_SKILL_REVISION = "qm-grok-bridge/v1";
export const GROK_BRIDGE_QUEUE_CAP = 5;
export const GROK_BRIDGE_DEFAULT_TTL_MS = 30 * 60_000;
export const GROK_BRIDGE_MAX_TTL_MS = 2 * 60 * 60_000;

export function inboundRefFor(pairingId: string): string {
  return `grok-bridge:${pairingId}`;
}

export function mintCallbackToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(token: string, expectedHash: string): boolean {
  const got = hashToken(token);
  const a = Buffer.from(got);
  const b = Buffer.from(expectedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeAgentName(raw: string): string | undefined {
  const name = raw.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return undefined;
  return name;
}

export function grokDisplayName(agentName: string): string {
  return `QM · ${agentName.charAt(0).toUpperCase()}${agentName.slice(1)}`;
}

export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}
