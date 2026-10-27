import {
  DESKTOP_LAUNCH_SCRIPT,
  DESKTOP_LAUNCH_SCRIPT_HASH,
  desktopChallenge,
  mintDesktopLogin,
  openDesktopLogin,
} from "./desktop-login.ts";
import { INVITE_LOGIN_SCRIPT, INVITE_LOGIN_SCRIPT_HASH } from "./invite-login.ts";
import { reportFailure } from "../../chassis/src/error-reporting.ts";
import { provisionTrustedAdmin } from "./trusted-admin.ts";
import { createHash } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { ADMIN_LOGIN_SCRIPT, ADMIN_LOGIN_SCRIPT_HASH, openAdminLogin } from "./admin-login.ts";
import { createTrustedEntry } from "./trusted-entry.ts";
import {
  seal,
  openTmp,
  setCookie,
  clearCookie,
  readCookie,
  randomToken,
  safeEqual,
  sanitizeReturnTo,
  type TmpClaims,
} from "./session.ts";
import { pkcePair, buildAuthorizeUrl, exchangeCode, fetchUserinfo, resolvePrincipal, verifyIdToken } from "./oidc.ts";
import { coreClaimStore, claimOnce, ClaimStoreUnavailableError } from "../../chassis/src/claims.ts";
import { coreEmailAdmission } from "../../chassis/src/external-members.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { LOCK_ICON } from "../../chassis/src/card-page.ts";
import { json, escapeHtml, readBody, PayloadTooLargeError } from "../../chassis/src/http.ts";
import { CORE_API_URL as CORE, coreOrgId, coreSigningSecret, portalIdentitySecret } from "../../chassis/src/env.ts";

import {
  SESSION_SECRET,
  SESSION_MAX_TTL_S,
  SECURE_COOKIES,
  AUTH_BROKER_PREFIX,
  PRINCIPAL_RULE,
  site,
  type Site,
} from "./config.ts";
import { coreCall, adminCache, adminProbeAttempt } from "./core-calls.ts";
import { cardPage, PAGE_CSP, sendHtml, redirect, signInErrorHtml } from "./pages.ts";
import {
  LOCAL_LOGOUT_COOKIE,
  sameOriginRequest,
  localDevSession,
  currentSession,
  sessionCookieSet,
  setSession,
  renewSessionCookie,
  setAuthenticatedSession,
} from "./sessions.ts";

const trustedEntries = new WeakMap<Site, ReturnType<typeof createTrustedEntry>>();

function trustedEntryOf(current: Site): ReturnType<typeof createTrustedEntry> | null {
  if (!current.trusted) return null;
  let entry = trustedEntries.get(current);
  if (!entry) {
    entry = createTrustedEntry(current.trusted, current.sessionSecret, (key, expiresAt) =>
      claimOnce(coreClaimStore(CORE, coreSigningSecret(), "portal"), key, expiresAt),
    );
    trustedEntries.set(current, entry);
  }
  return entry;
}

const returnTarget = (returnTo: string | null): string =>
  sanitizeReturnTo(returnTo, site().publicUrl, site().appsDomain);
const TMP_TTL_S = 600;

export async function desktopLogin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  res.setHeader("cache-control", "no-store");
  if (!SESSION_SECRET || SESSION_SECRET.trim().length < 32 || !coreSigningSecret()) {
    return json(res, 503, { error: "not_configured" });
  }
  if (url.pathname.endsWith("/redeem")) {
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
    if ((req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) && !sameOriginRequest(req))
      return json(res, 403, { error: "forbidden" });
    let body: URLSearchParams;
    try {
      body = new URLSearchParams(await readBody(req, 12288));
    } catch (error) {
      if (error instanceof PayloadTooLargeError) return json(res, 413, { error: "payload_too_large" });
      throw error;
    }
    const claims = openDesktopLogin(
      body.get("code") ?? "",
      body.get("verifier") ?? "",
      body.get("state") ?? "",
      site().sessionSecret,
      site().origin,
      coreOrgId(),
      SESSION_MAX_TTL_S,
    );
    if (!claims) return json(res, 400, { error: "invalid_desktop_login" });
    try {
      if (
        !(await claimOnce(
          coreClaimStore(CORE, coreSigningSecret(), "portal"),
          `desktop-login:${claims.jti}`,
          claims.expiresAtMs,
        ))
      ) {
        return json(res, 400, { error: "desktop_login_already_used" });
      }
    } catch (error) {
      if (error instanceof ClaimStoreUnavailableError) return json(res, 503, { error: "temporarily_unavailable" });
      throw error;
    }
    setSession(res, [
      ...sessionCookieSet(seal(claims.session, site().sessionKey), claims.session.sub),
      clearCookie("portal_impersonate", "/", SECURE_COOKIES),
    ]);
    return json(res, 200, { ok: true });
  }
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  const challenge = url.searchParams.get("challenge") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!desktopChallenge(challenge) || !desktopChallenge(state))
    return json(res, 400, { error: "invalid_desktop_request" });
  if (req.method === "POST" && !sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
  const session = renewSessionCookie(req, res) ?? currentSession(req);
  if (!session || session.anon) {
    return redirect(res, 303, `/auth/login?returnTo=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  if (req.method === "GET") {
    return sendHtml(
      res,
      200,
      cardPage({
        title: "Open QM Desktop",
        heading: "Sign in to QM Desktop",
        icon: LOCK_ICON,
        msg: `Continue as ${session.sub}.`,
        actions: `<form method="post" action="${escapeHtml(`${url.pathname}${url.search}`)}"><button class="btn primary" type="submit">Open QM Desktop</button></form>`,
        help: "Only continue if you just started sign-in in the QM desktop app on this computer.",
      }),
    );
  }
  const callback = new URL("qm-desktop://auth/callback");
  callback.searchParams.set("code", mintDesktopLogin(session, site().sessionSecret, site().origin, challenge, state));
  callback.searchParams.set("state", state);
  return sendHtml(
    res,
    200,
    cardPage({
      title: "Ready to open QM",
      heading: "Opening QM Desktop…",
      icon: LOCK_ICON,
      msg: "If QM doesn’t open automatically, use the button below.",
      actions: `<a id="desktop-launch" class="btn primary" href="${escapeHtml(callback.href)}">Open QM Desktop</a><script>${DESKTOP_LAUNCH_SCRIPT}</script>`,
      help: "This link expires in two minutes and works only for the app that requested it.",
    }),
    `${PAGE_CSP}; script-src '${DESKTOP_LAUNCH_SCRIPT_HASH}'`,
  );
}

export async function inviteLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!SESSION_SECRET || !coreSigningSecret()) return json(res, 503, { error: "not_configured" });
  if (req.method === "GET")
    return sendHtml(
      res,
      200,
      cardPage({
        title: "Accept invitation",
        heading: "You're invited",
        icon: LOCK_ICON,
        msg: "",
        extra: '<p id="invite-status"></p><noscript>JavaScript is required to open this invitation.</noscript>',
        actions: `<form method="post" action="/auth/invite"><input id="invite-token" name="token" type="hidden"><button id="invite-confirm" class="btn primary" type="submit" disabled>Accept invitation</button></form><script>${INVITE_LOGIN_SCRIPT}</script>`,
        help: "",
      }),
      `${PAGE_CSP}; script-src '${INVITE_LOGIN_SCRIPT_HASH}'`,
    );
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
  let token: string;
  try {
    token = new URLSearchParams(await readBody(req, 8192)).get("token") ?? "";
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return json(res, 413, { error: "payload_too_large" });
    throw error;
  }
  if (!token || token.length > 4096) return sendHtml(res, 400, signInErrorHtml("This invitation is invalid."));
  try {
    const r = await coreCall<{ email: string }>("POST", "/v1/auth/invitations/redeem", {
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(10_000),
    });
    const unavailable = r.ok || r.status >= 500;
    if (!r.ok || typeof r.body.email !== "string")
      return sendHtml(
        res,
        unavailable ? 503 : 400,
        signInErrorHtml(
          unavailable
            ? "Sign-in is temporarily unavailable. Please try again."
            : "This invitation is expired, revoked, or already used. Ask your administrator for a new one.",
        ),
      );
    setAuthenticatedSession(res, r.body.email);
    redirect(res, 303, "/");
  } catch (error) {
    reportFailure("portal: invitation redeem", error);
    return sendHtml(res, 503, signInErrorHtml("Sign-in is temporarily unavailable. Please try again."));
  }
}

export async function adminLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!SESSION_SECRET || SESSION_SECRET.trim().length < 32 || !coreSigningSecret()) {
    return json(res, 503, { error: "not_configured" });
  }
  if (req.method === "GET") {
    return sendHtml(
      res,
      200,
      cardPage({
        title: "Admin sign-in",
        heading: "Sign in as an administrator",
        msg: "Only continue if you generated this link for your own admin account.",
        icon: LOCK_ICON,
        extra: '<p id="admin-email"></p><noscript>JavaScript is required to open this login link.</noscript>',
        actions: `<form method="post" action="/auth/admin-login"><input id="admin-token" name="token" type="hidden"><button id="admin-confirm" class="btn primary" style="width:100%" type="submit" disabled>Sign in</button></form><script>${ADMIN_LOGIN_SCRIPT}</script>`,
        help: "This link expires after five minutes and can be used once. Generate another with qm admin-login.",
      }),
      `${PAGE_CSP}; script-src '${ADMIN_LOGIN_SCRIPT_HASH}'`,
    );
  }
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
  let token: string;
  try {
    token = new URLSearchParams(await readBody(req, 8192)).get("token") ?? "";
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return json(res, 413, { error: "payload_too_large" });
    throw error;
  }
  const claims = openAdminLogin(token, site().sessionSecret, site().origin);
  const fail = () =>
    sendHtml(
      res,
      400,
      signInErrorHtml("This admin link is invalid, expired, or already used. Generate a new link with qm admin-login."),
    );
  if (!claims) return fail();
  const allowed = await adminProbeAttempt(claims.email);
  if (allowed === null)
    return sendHtml(res, 503, signInErrorHtml("Admin access could not be checked. Please try again."));
  if (!allowed) return sendHtml(res, 403, signInErrorHtml("This account does not have admin access."));
  try {
    const claimsStore = coreClaimStore(CORE, coreSigningSecret(), "portal");
    if (!(await claimOnce(claimsStore, `admin-login:${claims.jti}`, claims.expiresAtMs))) return fail();
  } catch (error) {
    if (error instanceof ClaimStoreUnavailableError) {
      return sendHtml(res, 503, signInErrorHtml("Sign-in is temporarily unavailable. Please try again."));
    }
    throw error;
  }
  setAuthenticatedSession(res, claims.email);
  redirect(res, 303, "/settings/history");
}

export async function trustedAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const current = site();
  const trustedEntry = trustedEntryOf(current);
  if (!trustedEntry || !current.trusted) return json(res, 404, { error: "not_found" });
  const cookieName = "portal_trusted_tmp";
  const path = "/auth/trusted";
  if (url.pathname === `${path}/login`) {
    const returnTo =
      url.searchParams.get("returnTo") ??
      openTmp(readCookie(req.headers.cookie, "portal_oidc_tmp"), current.tmpKey, Date.now())?.returnTo ??
      null;
    const existing = currentSession(req);
    const trustedPrefix = `oidc:${createHash("sha256").update(current.trusted.issuer).digest("hex")}:`;
    if (existing && !existing.anon && !existing.appOnly && existing.sub.startsWith(trustedPrefix)) {
      return redirect(res, 302, returnTarget(returnTo));
    }
    const login = trustedEntry.start(returnTarget(returnTo));
    setSession(res, [setCookie(cookieName, login.cookie, { path, maxAge: login.ttl, secure: SECURE_COOKIES })]);
    return redirect(res, 302, login.location);
  }
  if (url.pathname !== `${path}/callback`) return json(res, 404, { error: "not_found" });
  setSession(res, [clearCookie(cookieName, path, SECURE_COOKIES)]);
  try {
    const identity = await trustedEntry.finish(readCookie(req.headers.cookie, cookieName), url);
    if (current.trustedAdmin) {
      await provisionTrustedAdmin(
        {
          core: CORE,
          signingSecret: coreSigningSecret()!,
          identitySecret: portalIdentitySecret()!,
          org: coreOrgId(),
          issuer: current.trusted.issuer,
        },
        identity.subject,
      );
      adminCache().delete(identity.sub);
    }
    setAuthenticatedSession(res, identity.sub, identity.name);
    redirect(res, 302, returnTarget(identity.returnTo));
  } catch (error) {
    reportFailure("portal: trusted sign-in", error);
    sendHtml(
      res,
      400,
      signInErrorHtml("Trusted sign-in failed. Please start again from your provider.", "/auth/trusted/login"),
    );
  }
}

export function authLogin(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const { oidc, trusted, trustedLabel, brokerUpstream, tmpKey, sessionKey } = site();
  const returnTo = returnTarget(url.searchParams.get("returnTo"));
  if (
    trusted &&
    (!oidc ||
      (trustedLabel &&
        url.searchParams.get("provider") !== "primary" &&
        readCookie(req.headers.cookie, "portal_login_provider") ===
          createHash("sha256").update(trusted.issuer).digest("hex")))
  ) {
    return redirect(res, 302, `/auth/trusted/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (!oidc) return json(res, 404, { error: "not_found" });
  const localSession = localDevSession(req, Date.now(), true);
  if (localSession) {
    setSession(res, [
      ...sessionCookieSet(seal(localSession, sessionKey), localSession.sub),
      clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
      ...(brokerUpstream ? [clearCookie("qm_idp_session", AUTH_BROKER_PREFIX, true)] : []),
      clearCookie(LOCAL_LOGOUT_COOKIE, "/", SECURE_COOKIES),
    ]);
    return redirect(res, 302, returnTo);
  }
  const state = randomToken();
  const nonce = randomToken();
  const { verifier, challenge } = pkcePair();
  const now = Math.floor(Date.now() / 1000);
  const tmp: TmpClaims = { k: "tmp", state, nonce, pkceVerifier: verifier, returnTo, iat: now, exp: now + TMP_TTL_S };
  setSession(res, [
    setCookie("portal_oidc_tmp", seal(tmp, tmpKey), { path: "/auth", maxAge: TMP_TTL_S, secure: SECURE_COOKIES }),
  ]);
  redirect(res, 302, buildAuthorizeUrl(oidc, { state, nonce, challenge }));
}

export async function authCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { oidc, tmpKey } = site();
  if (!oidc) return json(res, 404, { error: "not_found" });
  const fail = (detail: string): void => {
    setSession(res, [clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES)]);
    sendHtml(res, 400, signInErrorHtml(detail));
  };

  if (url.searchParams.get("error")) return fail(`identity provider returned: ${url.searchParams.get("error") ?? ""}`);
  const code = url.searchParams.get("code") ?? "";
  const stateParam = url.searchParams.get("state") ?? "";

  const tmp = openTmp(readCookie(req.headers.cookie, "portal_oidc_tmp"), tmpKey, Date.now());
  if (!tmp) return fail("login session expired, please try again");
  if (!code || !stateParam || !safeEqual(stateParam, tmp.state)) return fail("invalid login state");
  try {
    if (
      !(await claimOnce(
        coreClaimStore(CORE, coreSigningSecret(), "portal"),
        `oidc-state:${tmp.state}`,
        Date.now() + 2 * TMP_TTL_S * 1000,
      ))
    )
      return fail("login already used, please try again");
  } catch (error) {
    if (!(error instanceof ClaimStoreUnavailableError)) throw error;
    console.warn(`[portal] sign-in state check unavailable: ${errMessage(error)}`);
    return fail("sign-in is temporarily unavailable, please try again");
  }

  let principal: { sub: string; appOnly?: true };
  let name = "";
  try {
    const { accessToken, idToken } = await exchangeCode(oidc, { code, codeVerifier: tmp.pkceVerifier });
    const claims = await verifyIdToken(oidc, idToken, tmp.nonce);
    if (oidc.expectedTeamId) {
      const team = claims["https://slack.com/team_id"];
      if (team !== oidc.expectedTeamId) throw new Error("workspace not permitted");
    }
    const info = await fetchUserinfo(oidc, accessToken);
    const infoSub = typeof info.sub === "string" ? info.sub : "";
    if (!infoSub) throw new Error("userinfo missing sub");
    if (typeof claims.sub === "string" && claims.sub !== infoSub) throw new Error("subject mismatch");
    principal = await resolvePrincipal(PRINCIPAL_RULE, { sub: infoSub, claims, userinfo: info }, (email) =>
      coreEmailAdmission(CORE, coreSigningSecret(), email, "portal"),
    );
    const rawName = info.name ?? claims.name;
    if (typeof rawName === "string") name = rawName.trim().slice(0, 200);
  } catch (e) {
    return fail(errMessage(e, "sign-in failed"));
  }

  setAuthenticatedSession(res, principal.sub, name, principal.appOnly);
  redirect(res, 302, returnTarget(tmp.returnTo));
}
