import { orgId as configOrgId } from "../config.ts";
import type { CandidateDestination, Destination, EgressPolicy, Principal, ScopeId } from "../types.ts";
import { mintSignedPayload, verifySignedPayload } from "./signed-token.ts";

export const CAPABILITY_TTL_MS = 60 * 60_000;

export const CONTROL_PLANE_AUD = "control-plane";
export const OAUTH_CONSENT_AUD = "oauth-consent";
export const CREDENTIAL_BROKER_AUD = "credential-broker";
export const EGRESS_PROXY_AUD = "egress-proxy";
export const BLOB_TRANSFER_AUD = "blob-transfer";
export const SECRET_DROP_AUD = "secret-drop";

interface BlobGrant {
  dir: "read" | "write";
  id?: string;
}

type BlobTransferClaims = CapabilityClaims & { aud: typeof BLOB_TRANSFER_AUD; blob: BlobGrant };

export interface CapabilityClaims {
  actorId: string;
  aud?: string;
  scopeId: ScopeId;
  scopeVersion?: string;
  timezone?: string;
  destination?: Destination;
  destinations?: CandidateDestination[];
  defaultDestinationKey?: string;
  credentials?: string[];
  members?: Principal[];
  keychainMembers?: Principal[];
  privateScope?: boolean;
  egress?: EgressPolicy;
  blob?: BlobGrant;
  drop?: string;
  memory?: { write?: ScopeId; orgWrite?: ScopeId; read: ScopeId[] };
  liveActor?: boolean;
  botActor?: boolean;
  liveAuthor?: boolean;
  triggered?: boolean;
  grants?: string[];
  threadRef?: string;
  exp: number;
}

export function mintCapabilityToken(claims: CapabilityClaims, secret: string): Promise<string> {
  return mintSignedPayload({ orgId: configOrgId(), ...claims }, secret);
}

export function isValidCapabilityTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string") return false;
  if (timezone.length === 0 || timezone.length > 64 || timezone.trim() !== timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export async function verifyCapabilityToken(
  token: string,
  secret: string | string[],
  now: number = Date.now(),
): Promise<CapabilityClaims | null> {
  const claims = (await verifySignedPayload(token, secret)) as CapabilityClaims | null;
  if (
    !claims ||
    typeof claims.actorId !== "string" ||
    typeof claims.scopeId !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (claims.timezone !== undefined && !isValidCapabilityTimezone(claims.timezone)) return null;
  if (claims.scopeVersion !== undefined && typeof claims.scopeVersion !== "string") return null;
  if (claims.destinations !== undefined && !Array.isArray(claims.destinations)) return null;
  if (claims.credentials !== undefined && !Array.isArray(claims.credentials)) return null;
  if (
    claims.grants !== undefined &&
    (!Array.isArray(claims.grants) || !claims.grants.every((g) => typeof g === "string"))
  )
    return null;
  if (claims.keychainMembers !== undefined && !Array.isArray(claims.keychainMembers)) return null;
  if (claims.memory !== undefined && !Array.isArray(claims.memory?.read)) return null;
  if (claims.liveActor !== undefined && typeof claims.liveActor !== "boolean") return null;
  if (claims.botActor !== undefined && typeof claims.botActor !== "boolean") return null;
  if (claims.liveAuthor !== undefined && typeof claims.liveAuthor !== "boolean") return null;
  if (claims.blob !== undefined && claims.blob?.dir !== "read" && claims.blob?.dir !== "write") return null;
  if (claims.drop !== undefined && typeof claims.drop !== "string") return null;
  if (now >= claims.exp) return null;
  return claims;
}

const BLOB_ID = /^[0-9a-f]{32}$/;

export async function verifyBlobTransferCapability(
  token: string,
  secret: string | string[],
  expected: { dir: "read"; id: string } | { dir: "write" },
  now: number = Date.now(),
): Promise<BlobTransferClaims | null> {
  const claims = await verifyCapabilityToken(token, secret, now);
  const grant = claims?.blob;
  if (!claims || claims.aud !== BLOB_TRANSFER_AUD || !grant || grant.dir !== expected.dir) return null;
  if (grant.id !== undefined && (typeof grant.id !== "string" || !BLOB_ID.test(grant.id))) return null;
  if (expected.dir === "read" ? grant.id !== expected.id : grant.id !== undefined) return null;
  return claims as BlobTransferClaims;
}
