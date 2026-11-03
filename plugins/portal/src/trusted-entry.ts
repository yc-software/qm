import { createHash } from "node:crypto";
import { buildAuthorizeUrl, exchangeCode, fetchUserinfo, pkcePair, verifyIdToken, type OidcConfig } from "./oidc.ts";
import { deriveKey, openTmp, randomToken, safeEqual, seal, type TmpClaims } from "./session.ts";

export function trustedEntryConfig(env: NodeJS.ProcessEnv, publicUrl: string): OidcConfig | null {
  const raw = env.PORTAL_TRUSTED_OIDC;
  const secret = env.PORTAL_TRUSTED_OIDC_CLIENT_SECRET;
  if (!raw && !secret) return null;
  if (!raw || !secret || secret.length < 32)
    throw new Error("Trusted entry requires configuration and a separate client secret of at least 32 characters");
  if ([env.OIDC_CLIENT_SECRET, env.PORTAL_SESSION_SECRET, env.CORE_SIGNING_SECRET].includes(secret))
    throw new Error("Trusted entry requires a distinct client secret");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid trusted OIDC configuration");
  const obj = parsed as Record<string, unknown>;
  for (const field of ["issuer", "authEndpoint", "tokenEndpoint", "userinfoEndpoint", "jwksUri"]) {
    if (typeof obj[field] !== "string") throw new Error(`Trusted OIDC requires ${field}`);
    const url = new URL(obj[field]);
    const local =
      env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || url.username || url.password || url.hash || url.search)
      throw new Error(`Invalid trusted OIDC ${field}`);
  }
  if (typeof obj.clientId !== "string" || !obj.clientId.trim()) throw new Error("Trusted OIDC requires clientId");
  return {
    issuer: obj.issuer as string,
    authEndpoint: obj.authEndpoint as string,
    tokenEndpoint: obj.tokenEndpoint as string,
    userinfoEndpoint: obj.userinfoEndpoint as string,
    jwksUri: obj.jwksUri as string,
    clientId: obj.clientId,
    clientSecret: secret,
    redirectUri: `${publicUrl}/auth/trusted/callback`,
    scopes: "openid profile",
    prompt: "login",
  };
}

export function trustedPrincipal(issuer: string, sub: string): string {
  if (!sub || sub.length > 255) throw new Error("Invalid trusted subject");
  return `oidc:${createHash("sha256").update(issuer).digest("hex")}:${Buffer.from(sub).toString("base64url")}`;
}

export function createTrustedEntry(
  cfg: OidcConfig,
  sessionSecret: string,
  claim: (key: string, expiresAt: number) => Promise<boolean>,
  fetchImpl: typeof fetch = fetch,
) {
  const key = deriveKey(sessionSecret, "trusted-entry-tmp");
  const ttl = 600;
  return {
    start(returnTo: string) {
      const { verifier, challenge } = pkcePair();
      const now = Math.floor(Date.now() / 1000);
      const tmp: TmpClaims = {
        k: "tmp",
        state: randomToken(),
        nonce: randomToken(),
        pkceVerifier: verifier,
        returnTo,
        iat: now,
        exp: now + ttl,
      };
      return {
        cookie: seal(tmp, key),
        location: buildAuthorizeUrl(cfg, { state: tmp.state, nonce: tmp.nonce, challenge }),
        ttl,
      };
    },
    async finish(cookie: string | null, url: URL) {
      const tmp = openTmp(cookie, key, Date.now());
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !tmp || !state || !code || !safeEqual(state, tmp.state))
        throw new Error("Invalid trusted login state");
      if (!(await claim(`trusted-entry:${tmp.state}`, tmp.exp * 1000))) throw new Error("Trusted login already used");
      const { accessToken, idToken } = await exchangeCode(cfg, { code, codeVerifier: tmp.pkceVerifier }, fetchImpl);
      const claims = await verifyIdToken(cfg, idToken, tmp.nonce, fetchImpl);
      const info = await fetchUserinfo(cfg, accessToken, fetchImpl);
      if (typeof claims.sub !== "string" || claims.sub !== info.sub)
        throw new Error("Trusted identity subject mismatch");
      return {
        subject: claims.sub,
        sub: trustedPrincipal(cfg.issuer, claims.sub),
        name: typeof info.name === "string" ? info.name.trim().slice(0, 200) : "",
        returnTo: tmp.returnTo,
      };
    },
  };
}
