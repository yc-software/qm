import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface AdminBootstrapClaims {
  k: "admin-bootstrap";
  jti: string;
  org: string;
  principal: string;
  iat: number;
  exp: number;
}

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("qm.admin-bootstrap.v1").digest();
}

function signature(body: string, secret: string): Buffer {
  return createHmac("sha256", key(secret)).update(body).digest();
}

export function mintAdminBootstrapToken(
  input: { org: string; principal: string; ttlSeconds?: number },
  secret: string,
  nowMs = Date.now(),
): { token: string; claims: AdminBootstrapClaims } {
  const now = Math.floor(nowMs / 1000);
  const claims: AdminBootstrapClaims = {
    k: "admin-bootstrap",
    jti: randomUUID(),
    org: input.org,
    principal: input.principal.trim().toLowerCase(),
    iat: now,
    exp: now + (input.ttlSeconds ?? 600),
  };
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return { token: `${body}.${signature(body, secret).toString("base64url")}`, claims };
}

export function openAdminBootstrapToken(
  token: string | null | undefined,
  secret: string,
  nowMs = Date.now(),
): AdminBootstrapClaims | null {
  if (!token) return null;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const body = token.slice(0, separator);
  const got = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = signature(body, secret);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<AdminBootstrapClaims>;
    if (
      claims.k !== "admin-bootstrap" ||
      typeof claims.jti !== "string" ||
      !claims.jti ||
      typeof claims.org !== "string" ||
      !claims.org ||
      typeof claims.principal !== "string" ||
      !claims.principal ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number" ||
      claims.iat > Math.floor(nowMs / 1000) + 60 ||
      claims.exp <= Math.floor(nowMs / 1000) ||
      claims.exp - claims.iat > 600
    ) {
      return null;
    }
    return claims as AdminBootstrapClaims;
  } catch {
    return null;
  }
}
