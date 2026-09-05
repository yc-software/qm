import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, PayloadTooLargeError, serveEmojiFavicon } from "../../chassis/src/http.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import type { AuthConfig } from "./config.ts";
import { validEmail } from "./config.ts";
import { claimOnce, withinRateLimit, ClaimStoreUnavailableError, type ClaimStore } from "../../chassis/src/claims.ts";
import { coreEmailAllowed } from "../../chassis/src/external-members.ts";
import { mintIdToken, pkceMatches, safeEqual, subjectFor, TokenSigner, type AuthRequest } from "./tokens.ts";
import { ID_TOKEN_ALG, type SigningKey } from "./keys.ts";
import { renderSignInEmail, type Mailer } from "./email.ts";
import type { PasswordChecker } from "./credentials.ts";
import {
  changePasswordPage,
  confirmSignInPage,
  emailFormPage,
  linkSentPage,
  passwordFormPage,
  problemPage,
  CONFIRM_PAGE_CSP,
  PAGE_CSP,
} from "./pages.ts";

const MAX_FORM_BYTES = 8 * 1024;
const MIN_PASSWORD_LENGTH = 8;
/**
 * One message for a wrong password, an unknown address, a deactivated account
 * and a rate-limited attempt. The form must not reveal who has an account.
 */
const SIGN_IN_REFUSED = "That email address and password did not match an account that can sign in.";
const ID_TOKEN_TTL_S = 300;
const MAX_INFLIGHT_SENDS = 32;

export interface AuthDeps {
  cfg: AuthConfig;
  signingKey: SigningKey;
  signer: TokenSigner;
  claims: ClaimStore;
  mailer: Mailer;
  passwords?: PasswordChecker;
  brandName?: () => string;
  emailAllowed?: (email: string) => Promise<boolean>;
  now?: () => number;
  onBackgroundTask?: (task: Promise<void>) => void;
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function clientIpOf(req: IncomingMessage): string {
  const forwarded = req.headers["x-qm-client-ip"];
  const declared = typeof forwarded === "string" ? forwarded.trim() : "";
  return declared || req.socket.remoteAddress || "unknown";
}

function noStore(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, noStore({ "content-type": "application/json" }));
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string, csp = PAGE_CSP): void {
  res.writeHead(
    status,
    noStore({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    }),
  );
  res.end(html);
}

function basicCredentials(header: string | undefined): { id: string; secret: string } | null {
  if (!header || !/^basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1) return null;
  return { id: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
}

function readAuthorizeRequest(
  cfg: AuthConfig,
  params: URLSearchParams,
): { request: AuthRequest } | { problem: string } {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!clientId || !safeEqual(clientId, cfg.clientId))
    return { problem: "This sign-in request is for an unknown application." };
  if (!redirectUri || !safeEqual(redirectUri, cfg.redirectUri))
    return { problem: "This sign-in request would return you to an address that is not registered." };
  if ((params.get("response_type") ?? "") !== "code")
    return { problem: "Only the authorization-code flow is supported." };
  if ((params.get("code_challenge_method") ?? "") !== "S256")
    return { problem: "This sign-in request must use PKCE with S256." };
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge))
    return { problem: "This sign-in request carries a malformed PKCE challenge." };
  const state = params.get("state") ?? "";
  const nonce = params.get("nonce") ?? "";
  if (!state || state.length > 512) return { problem: "This sign-in request is missing its state." };
  if (!nonce || nonce.length > 512) return { problem: "This sign-in request is missing its nonce." };
  const scope = params.get("scope") ?? "openid";
  if (!scope.split(/\s+/).includes("openid")) return { problem: "This sign-in request must ask for the openid scope." };
  return { request: { clientId, redirectUri, state, nonce, codeChallenge, scope } };
}

export function createAuthHandler(deps: AuthDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { cfg, signer, claims, mailer, signingKey } = deps;
  const passwords = deps.passwords;
  const brandName = deps.brandName ?? ((): string => cfg.brandName);
  const invited =
    deps.emailAllowed ??
    ((email: string): Promise<boolean> => coreEmailAllowed(cfg.coreApiUrl, cfg.coreSigningSecret, email, "auth"));
  const emailAllowed = async (email: string): Promise<boolean> =>
    // In password mode the account list is the user store, so an allow-list is
    // an optional extra filter rather than the only gate. When one is
    // configured it still applies, in either mode.
    (cfg.credentialTransport === "password" && !cfg.allowedEmails.length && !cfg.allowedEmailDomain) ||
    cfg.allowedEmails.includes(email) ||
    (Boolean(cfg.allowedEmailDomain) && email.endsWith(`@${cfg.allowedEmailDomain}`)) ||
    invited(email);
  const now = deps.now ?? Date.now;
  const notify = deps.onBackgroundTask ?? ((task: Promise<void>) => void task.catch(() => undefined));
  const formAction = `${cfg.publicPath}/authorize`;
  const changeAction = `${cfg.publicPath}/password`;
  const linkTtlMinutes = Math.max(1, Math.round(cfg.linkTtlS / 60));
  let inFlightSends = 0;
  const background = (task: () => Promise<void>): void => {
    if (inFlightSends >= MAX_INFLIGHT_SENDS) {
      console.warn("[auth] sign-in link suppressed: too many deliveries already in flight");
      return;
    }
    inFlightSends++;
    notify(
      task().finally(() => {
        inFlightSends--;
      }),
    );
  };

  const problem = (res: ServerResponse, status: number, heading: string, msg: string, detail?: string): void =>
    sendHtml(res, status, problemPage({ brandName: brandName(), heading, msg, ...(detail ? { detail } : {}) }));

  const signInUrl = ((): string | undefined => {
    try {
      return new URL("/auth/login", cfg.redirectUri).toString();
    } catch {
      return undefined;
    }
  })();

  const staleLink = (res: ServerResponse): void =>
    sendHtml(
      res,
      400,
      problemPage({
        brandName: brandName(),
        heading: "This sign-in link no longer works",
        msg: "Sign-in links work once and expire quickly. Request a fresh one and open it right away.",
        ...(signInUrl ? { retryUrl: signInUrl } : {}),
      }),
    );

  async function authorizeForm(res: ServerResponse, params: URLSearchParams): Promise<void> {
    const parsed = readAuthorizeRequest(cfg, params);
    if ("problem" in parsed)
      return problem(
        res,
        400,
        "This sign-in link isn't valid",
        "Start again from the page you were trying to reach.",
        parsed.problem,
      );
    const sealed = await signer.sealRequest(parsed.request, cfg.requestTtlS, now());
    if (cfg.credentialTransport === "password") {
      return sendHtml(
        res,
        200,
        passwordFormPage({ brandName: brandName(), action: formAction, requestToken: sealed.token }),
      );
    }
    return sendHtml(
      res,
      200,
      emailFormPage({ brandName: brandName(), action: formAction, requestToken: sealed.token }),
    );
  }

  async function sendLink(request: AuthRequest, email: string, ip: string): Promise<void> {
    const nowMs = now();
    const within = async (kind: string, value: string, limit: number): Promise<boolean> =>
      withinRateLimit(claims, { secret: cfg.tokenSecret, kind, value, limit, windowS: cfg.sendWindowS, nowMs });
    if (!(await emailAllowed(email))) {
      console.warn(`[auth] sign-in link suppressed: ${email} is not on the permitted list`);
      return;
    }
    try {
      if (!(await within("ip", ip, cfg.sendLimitPerIp))) {
        console.warn("[auth] sign-in link suppressed: per-address rate limit reached for the requesting client");
        return;
      }
      if (!(await within("mailbox", email, cfg.sendLimitPerEmail))) {
        console.warn("[auth] sign-in link suppressed: per-mailbox rate limit reached");
        return;
      }
    } catch (e) {
      if (!(e instanceof ClaimStoreUnavailableError)) throw e;
      console.error(
        "[auth] sign-in link suppressed: core is unreachable, so rate limits cannot be enforced — sign-in fails closed until core is healthy (this is a core outage, not a rate limit)",
      );
      return;
    }
    const sealed = await signer.sealLink({ ...request, email }, cfg.linkTtlS, nowMs);
    const link = `${cfg.issuer}/verify#token=${encodeURIComponent(sealed.token)}`;
    try {
      const receipt = await mailer.send(
        renderSignInEmail({ to: email, brandName: brandName(), link, ttlMinutes: linkTtlMinutes }),
      );
      console.log(`[auth] sign-in link sent to ${email} (${receipt})`);
    } catch (e) {
      console.error(`[auth] sign-in link to ${email} could not be delivered: ${errMessage(e)}`);
    }
  }

  /** Finish a verified sign-in: mint the authorization code and return. */
  async function completeSignIn(res: ServerResponse, request: AuthRequest, email: string): Promise<void> {
    const code = await signer.sealCode(
      {
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        nonce: request.nonce,
        codeChallenge: request.codeChallenge,
        email,
      },
      cfg.codeTtlS,
      now(),
    );
    const destination = new URL(request.redirectUri);
    destination.searchParams.set("code", code.token);
    destination.searchParams.set("state", request.state);
    res.writeHead(302, noStore({ location: destination.toString() }));
    res.end();
  }

  const retryPassword = async (
    res: ServerResponse,
    request: AuthRequest,
    email: string,
    reason: string,
  ): Promise<void> => {
    const sealed = await signer.sealRequest(request, cfg.requestTtlS, now());
    return sendHtml(
      res,
      400,
      passwordFormPage({
        brandName: brandName(),
        action: formAction,
        requestToken: sealed.token,
        email,
        problem: reason,
      }),
    );
  };

  async function passwordSubmit(
    req: IncomingMessage,
    res: ServerResponse,
    request: AuthRequest,
    form: URLSearchParams,
  ): Promise<void> {
    if (!passwords) {
      return problem(
        res,
        503,
        "Sign-in is not available",
        "This deployment is configured for password sign-in but cannot reach the service that verifies it.",
      );
    }
    const email = normalizeEmail(form.get("email") ?? "");
    const password = form.get("password") ?? "";
    // A malformed address takes the same path as a wrong one: answering it
    // differently would say that the well-formed address exists.
    if (!validEmail(email) || !password || !(await emailAllowed(email)))
      return retryPassword(res, request, email, SIGN_IN_REFUSED);

    const ip = clientIpOf(req);
    const verdict = await passwords.verify({ identifier: email, password, ip });
    if (!verdict.ok && "unavailable" in verdict) {
      return problem(
        res,
        503,
        "Sign-in is not available",
        "The service that verifies passwords did not answer. Nobody is signed in; try again shortly.",
      );
    }
    if (!verdict.ok) return retryPassword(res, request, email, SIGN_IN_REFUSED);
    if (verdict.mustChange) {
      const sealed = await signer.sealChange({ ...request, email }, cfg.requestTtlS, now());
      return sendHtml(
        res,
        200,
        changePasswordPage({
          brandName: brandName(),
          action: changeAction,
          changeToken: sealed.token,
          minLength: MIN_PASSWORD_LENGTH,
        }),
      );
    }
    return completeSignIn(res, request, email);
  }

  async function passwordChange(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (cfg.credentialTransport !== "password" || !passwords) return sendJson(res, 404, { error: "not_found" });
    let raw: string;
    try {
      raw = await readBody(req, MAX_FORM_BYTES);
    } catch {
      return problem(res, 413, "That didn't work", "The sign-in form sent more data than we accept.");
    }
    const form = new URLSearchParams(raw);
    const opened = await signer.openChange(form.get("change") ?? "", now());
    if (!opened) {
      return problem(
        res,
        400,
        "This sign-in page expired",
        "Sign-in pages are only valid for a short while. Start again from the page you were trying to reach.",
      );
    }
    const { email, ...request } = opened;
    const current = form.get("current") ?? "";
    const next = form.get("password") ?? "";
    const confirm = form.get("confirm") ?? "";
    const retry = async (reason: string): Promise<void> => {
      const sealed = await signer.sealChange(opened, cfg.requestTtlS, now());
      return sendHtml(
        res,
        400,
        changePasswordPage({
          brandName: brandName(),
          action: changeAction,
          changeToken: sealed.token,
          minLength: MIN_PASSWORD_LENGTH,
          problem: reason,
        }),
      );
    };
    if (next !== confirm) return retry("The two new passwords did not match.");
    if (next.length < MIN_PASSWORD_LENGTH)
      return retry(`A password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (next === current) return retry("Choose a password different from the one your administrator set.");

    const verdict = await passwords.change({ identifier: email, password: current, next, ip: clientIpOf(req) });
    if (!verdict.ok && "unavailable" in verdict) {
      return problem(
        res,
        503,
        "Sign-in is not available",
        "The service that stores passwords did not answer. Your password was not changed; try again shortly.",
      );
    }
    if (!verdict.ok) return retry(SIGN_IN_REFUSED);
    return completeSignIn(res, request, email);
  }

  async function authorizeSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, MAX_FORM_BYTES);
    } catch (e) {
      if (e instanceof PayloadTooLargeError)
        return problem(res, 413, "That didn't work", "The sign-in form sent more data than we accept.");
      throw e;
    }
    const form = new URLSearchParams(raw);
    const request = await signer.openRequest(form.get("request") ?? "", now());
    if (!request) {
      return problem(
        res,
        400,
        "This sign-in page expired",
        "Sign-in pages are only valid for a short while. Start again from the page you were trying to reach.",
      );
    }
    if (cfg.credentialTransport === "password") return passwordSubmit(req, res, request, form);
    const email = normalizeEmail(form.get("email") ?? "");
    if (!validEmail(email)) {
      const sealed = await signer.sealRequest(request, cfg.requestTtlS, now());
      return sendHtml(
        res,
        400,
        emailFormPage({
          brandName: brandName(),
          action: formAction,
          requestToken: sealed.token,
          problem: "That doesn't look like an email address.",
        }),
      );
    }
    const ip = clientIpOf(req);
    sendHtml(res, 200, linkSentPage({ brandName: brandName(), email, ttlMinutes: linkTtlMinutes }));
    background(() => sendLink(request, email, ip));
  }

  function confirmVerify(res: ServerResponse): void {
    return sendHtml(
      res,
      200,
      confirmSignInPage({ brandName: brandName(), action: `${cfg.publicPath}/verify` }),
      CONFIRM_PAGE_CSP,
    );
  }

  async function verify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, MAX_FORM_BYTES);
    } catch {
      return problem(res, 413, "That didn't work", "The sign-in form sent more data than we accept.");
    }
    const opened = await signer.openLink(new URLSearchParams(raw).get("token") ?? "", now());
    if (!opened) return staleLink(res);
    let linkClaimed: boolean;
    try {
      linkClaimed = await claimOnce(claims, `link:${opened.jti}`, opened.expiresAtMs);
    } catch (e) {
      if (!(e instanceof ClaimStoreUnavailableError)) throw e;
      return problem(
        res,
        503,
        "Sign-in is temporarily unavailable",
        "The sign-in service cannot reach its backend. Try again in a minute — this link stays valid.",
      );
    }
    if (!linkClaimed) return staleLink(res);
    const { claims: link } = opened;
    if (!safeEqual(link.clientId, cfg.clientId) || !safeEqual(link.redirectUri, cfg.redirectUri)) {
      return problem(
        res,
        400,
        "This sign-in link no longer works",
        "The sign-in configuration changed after this link was sent. Start again.",
      );
    }
    if (!(await emailAllowed(link.email))) {
      return problem(res, 403, "This address can't sign in", "Your administrator has not allowed this email address.");
    }
    const code = await signer.sealCode(
      {
        clientId: link.clientId,
        redirectUri: link.redirectUri,
        nonce: link.nonce,
        codeChallenge: link.codeChallenge,
        email: link.email,
      },
      cfg.codeTtlS,
      now(),
    );
    const destination = new URL(link.redirectUri);
    destination.searchParams.set("code", code.token);
    destination.searchParams.set("state", link.state);
    res.writeHead(302, noStore({ location: destination.toString() }));
    res.end();
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const credentials = basicCredentials(req.headers.authorization);
    const idOk = credentials !== null && safeEqual(credentials.id, cfg.clientId);
    const secretOk = credentials !== null && safeEqual(credentials.secret, cfg.clientSecret);
    if (!idOk || !secretOk) {
      res.writeHead(401, noStore({ "content-type": "application/json", "www-authenticate": `Basic realm="qm-auth"` }));
      return void res.end(JSON.stringify({ error: "invalid_client" }));
    }
    let raw: string;
    try {
      raw = await readBody(req, MAX_FORM_BYTES);
    } catch {
      return sendJson(res, 400, { error: "invalid_request" });
    }
    const form = new URLSearchParams(raw);
    if (form.get("grant_type") !== "authorization_code") return sendJson(res, 400, { error: "unsupported_grant_type" });
    const opened = await signer.openCode(form.get("code") ?? "", now());
    if (!opened) return sendJson(res, 400, { error: "invalid_grant" });
    const { claims: granted } = opened;
    const redirectUri = form.get("redirect_uri") ?? "";
    if (
      !safeEqual(granted.clientId, cfg.clientId) ||
      !safeEqual(granted.redirectUri, redirectUri) ||
      !safeEqual(redirectUri, cfg.redirectUri)
    ) {
      return sendJson(res, 400, { error: "invalid_grant" });
    }
    let codeClaimed: boolean;
    try {
      codeClaimed = await claimOnce(claims, `code:${opened.jti}`, opened.expiresAtMs);
    } catch (e) {
      if (!(e instanceof ClaimStoreUnavailableError)) throw e;
      return sendJson(res, 503, { error: "temporarily_unavailable" });
    }
    if (!codeClaimed) return sendJson(res, 400, { error: "invalid_grant" });
    if (!pkceMatches(form.get("code_verifier") ?? "", granted.codeChallenge))
      return sendJson(res, 400, { error: "invalid_grant" });
    if (!(await emailAllowed(granted.email))) return sendJson(res, 400, { error: "invalid_grant" });

    const nowMs = now();
    const sub = subjectFor(cfg.issuer, granted.email);
    const idToken = await mintIdToken(signingKey, {
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      sub,
      email: granted.email,
      nonce: granted.nonce,
      ttlS: ID_TOKEN_TTL_S,
      nowMs,
    });
    const access = await signer.sealAccess({ sub, email: granted.email }, cfg.accessTtlS, nowMs);
    return sendJson(res, 200, {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: cfg.accessTtlS,
      id_token: idToken,
      scope: "openid email",
    });
  }

  async function userinfo(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers.authorization ?? "";
    if (!/^bearer /i.test(header)) {
      res.writeHead(401, noStore({ "content-type": "application/json", "www-authenticate": "Bearer" }));
      return void res.end(JSON.stringify({ error: "invalid_token" }));
    }
    const opened = await signer.openAccess(header.slice(7).trim(), now());
    if (!opened) {
      res.writeHead(
        401,
        noStore({ "content-type": "application/json", "www-authenticate": `Bearer error="invalid_token"` }),
      );
      return void res.end(JSON.stringify({ error: "invalid_token" }));
    }
    return sendJson(res, 200, { sub: opened.sub, email: opened.email, email_verified: true });
  }

  function discovery(res: ServerResponse): void {
    sendJson(res, 200, {
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/authorize`,
      token_endpoint: `${cfg.issuer}/token`,
      userinfo_endpoint: `${cfg.issuer}/userinfo`,
      jwks_uri: `${cfg.issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [ID_TOKEN_ALG],
      scopes_supported: ["openid", "email"],
      claims_supported: ["sub", "iss", "aud", "exp", "iat", "nonce", "azp", "email", "email_verified"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
    });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://auth.local");
    const path = url.pathname;

    if (method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true });
    if (method === "GET" && path === "/readyz") {
      try {
        const r = await fetch(`${cfg.coreApiUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
        if (r.ok) return sendJson(res, 200, { ok: true });
        return sendJson(res, 503, { ok: false, core: `HTTP ${r.status}` });
      } catch (e) {
        return sendJson(res, 503, { ok: false, core: errMessage(e) });
      }
    }
    if (method === "GET" && (path === "/favicon.ico" || path === "/favicon.svg")) {
      return serveEmojiFavicon(res, "✉️", "max-age=86400");
    }
    if (method === "GET" && path === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
      return void res.end(JSON.stringify({ keys: [signingKey.publicJwk] }));
    }
    if (method === "GET" && path === "/.well-known/openid-configuration") return discovery(res);
    if (method === "GET" && path === "/authorize") return authorizeForm(res, url.searchParams);
    if (method === "POST" && path === "/authorize") return authorizeSubmit(req, res);
    if (method === "POST" && path === "/password") return passwordChange(req, res);
    // The mailed link does not exist in password mode: its endpoints are gone,
    // not merely unused.
    if (cfg.credentialTransport !== "password") {
      if (method === "GET" && path === "/verify") return confirmVerify(res);
      if (method === "POST" && path === "/verify") return verify(req, res);
    }
    if (method === "POST" && path === "/token") return token(req, res);
    if ((method === "GET" || method === "POST") && path === "/userinfo") return userinfo(req, res);
    return sendJson(res, 404, { error: "not_found" });
  };
}
