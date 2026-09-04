import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";

type FetchLike = typeof fetch;

export interface OidcConfig {
  authEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  issuer: string;
  jwksUri: string;
  expectedTeamId?: string;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(cfg: OidcConfig, args: { state: string; nonce: string; challenge: string }): string {
  const u = new URL(cfg.authEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scopes);
  u.searchParams.set("state", args.state);
  u.searchParams.set("nonce", args.nonce);
  u.searchParams.set("code_challenge", args.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export interface TokenResponse {
  accessToken: string;
  idToken: string | null;
}

export async function exchangeCode(
  cfg: OidcConfig,
  args: { code: string; codeVerifier: string },
  fetchImpl: FetchLike = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: cfg.redirectUri,
    code_verifier: args.codeVerifier,
  });
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const r = await fetchImpl(cfg.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
      accept: "application/json",
    },
    body: body.toString(),
  });
  const json = await readJson(r, "token endpoint");
  if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status}`);
  if (json.ok === false) throw new Error(`token exchange failed: ${String(json.error ?? "ok:false")}`);
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new Error("token response missing access_token");
  return { accessToken, idToken: typeof json.id_token === "string" ? json.id_token : null };
}

export async function fetchUserinfo(
  cfg: OidcConfig,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  const r = await fetchImpl(cfg.userinfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const json = await readJson(r, "userinfo");
  if (!r.ok) throw new Error(`userinfo failed: HTTP ${r.status}`);
  if (json.ok === false) throw new Error(`userinfo failed: ${String(json.error ?? "ok:false")}`);
  return json;
}

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyIdToken(
  cfg: OidcConfig,
  idToken: string | null,
  nonce: string,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  if (!idToken) throw new Error("token response missing id_token");
  const keySet =
    fetchImpl === fetch
      ? (remoteKeySets.get(cfg.jwksUri) ??
        (() => {
          const created = createRemoteJWKSet(new URL(cfg.jwksUri));
          remoteKeySets.set(cfg.jwksUri, created);
          return created;
        })())
      : createRemoteJWKSet(new URL(cfg.jwksUri), { [customFetch]: fetchImpl });
  const { payload } = await jwtVerify(idToken, keySet, {
    issuer: cfg.issuer,
    audience: cfg.clientId,
    algorithms: ["RS256", "ES256", "EdDSA"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    clockTolerance: 5,
  });
  if (payload.nonce !== nonce) throw new Error("nonce mismatch");
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (
    (audiences.length > 1 && typeof payload.azp !== "string") ||
    (payload.azp !== undefined && payload.azp !== cfg.clientId)
  ) {
    throw new Error("authorized party mismatch");
  }
  return payload as JWTPayload & Record<string, unknown>;
}

export interface PrincipalRule {
  claim: "sub" | "email";
  allowedEmailDomain?: string;
  allowedEmails?: readonly string[];
}

export function resolvePrincipal(
  rule: PrincipalRule,
  args: { sub: string; claims: Record<string, unknown>; userinfo: Record<string, unknown> },
): string {
  if (rule.claim === "sub") return args.sub;
  const rawEmail = args.userinfo.email;
  if (typeof rawEmail !== "string" || !rawEmail.includes("@")) throw new Error("identity provider returned no email");
  const verified = args.userinfo.email_verified;
  if (verified !== true && verified !== "true") throw new Error("email is not verified by the identity provider");
  const email = rawEmail.trim().toLowerCase();
  if (
    rule.allowedEmails?.length &&
    !rule.allowedEmails.map((allowed) => allowed.trim().toLowerCase()).includes(email)
  ) {
    throw new Error("account is not on the permitted email list");
  }
  if (rule.allowedEmailDomain) {
    const domain = rule.allowedEmailDomain.toLowerCase();
    if (!email.endsWith(`@${domain}`)) throw new Error("account is outside the permitted domain");
    const hd = args.userinfo.hd ?? args.claims.hd;
    if (typeof hd === "string" && hd.toLowerCase() !== domain)
      throw new Error("account is outside the permitted domain");
  }
  return email;
}

async function readJson(r: Response, what: string): Promise<Record<string, unknown>> {
  const text = await r.text();
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${what} returned non-JSON (HTTP ${r.status})`);
  }
}
