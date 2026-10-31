import { createHash, timingSafeEqual } from "node:crypto";
import { exchangeAuthorizationCode, type FetchLike } from "../../connectors/oauth.ts";
import { mintSignedPayload, verifySignedPayload } from "../../auth/signed-token.ts";
import { orgId } from "../../config.ts";
import { canonicalPerson, foldPrincipalId, personIds, samePerson } from "../../directory/person.ts";
import { SNOWFLAKE } from "../../util/snowflake.ts";
import { discordExternalId, discordUserIdOf } from "../../discord/config.ts";
import { isDiscordMember } from "../../directory/directory-store.ts";
import { PrincipalLinkError } from "../../identity/principal-links.ts";
import { DISCORD_API, discordLinkRedirectUri } from "../../surfaces/discord-installation.ts";
import { scopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { activePrincipal, audit } from "./shared.ts";

export const DISCORD_LINK_STATE_TTL_MS = 10 * 60_000;
const DISCORD_OAUTH_TIMEOUT_MS = 10_000;
const LINK_PURPOSE = "discord-account-link";
const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const NONCE_HASH = /^[0-9a-f]{64}$/;

async function linkingPrincipal(ctx: ApiCtx): Promise<string | null> {
  ctx.res.setHeader("Cache-Control", "no-store");
  if (!ctx.actor || ctx.actor.imp || ctx.capability) {
    sendJson(ctx.res, 403, { error: "browser_identity_required" });
    return null;
  }
  if (!(await activePrincipal(ctx.deps, ctx.actor.p))) {
    sendJson(ctx.res, 403, {
      error: "inactive_account",
      message: "Only active members of the organization can link Discord.",
    });
    return null;
  }
  return ctx.actor.p;
}

async function oauthConfig(ctx: ApiCtx) {
  const install = await ctx.deps.discordInstallation?.get();
  if (!install?.applicationId || !install?.oauthClientSecret || !ctx.deps.signingSecret || !ctx.deps.portalUrl)
    return null;
  return {
    clientId: install.applicationId,
    clientSecret: install.oauthClientSecret,
    redirectUri: discordLinkRedirectUri(ctx.deps.portalUrl),
    signingSecret: ctx.deps.signingSecret,
  };
}

async function selfLink(ctx: ApiCtx, principal: string) {
  const links = ctx.deps.principalLinks ? await ctx.deps.principalLinks.list() : [];
  const matches = personIds(principal).flatMap((alias) => {
    if (discordUserIdOf(alias) === null) return [];
    const link = links.find((l) => foldPrincipalId(l.principalId) === foldPrincipalId(alias));
    return link ? [{ link, alias }] : [];
  });
  const target = matches.find((m) => ownedBy(m.link, principal)) ?? matches[0];
  return { link: target?.link ?? null, alias: target?.alias ?? null };
}

function hasOtherDiscordLink(principal: string, discordUserId: string): boolean {
  return personIds(principal).some((id) => {
    const did = discordUserIdOf(id);
    return did !== null && did !== discordUserId;
  });
}

function otherAccountLinked(ctx: ApiCtx): void {
  return sendJson(ctx.res, 409, {
    error: "other_account_linked",
    message: "Disconnect your current Discord account first.",
  });
}

function invalidLink(ctx: ApiCtx): void {
  return sendJson(ctx.res, 400, {
    error: "invalid_link",
    message: "This Discord connection expired or belongs to another QM account. Start again from your settings.",
  });
}

function ownedBy(link: { linkedBy: string; canonicalId: string } | null, principal: string): boolean {
  return link !== null && samePerson(link.linkedBy, principal) && samePerson(link.canonicalId, principal);
}

async function status(ctx: ApiCtx): Promise<void> {
  const principal = await linkingPrincipal(ctx);
  if (!principal) return;
  const cfg = await oauthConfig(ctx);
  const { link, alias } = await selfLink(ctx, principal);
  const member = alias
    ? (await ctx.deps.directory?.list())?.find(
        (m) => isDiscordMember(m) && foldPrincipalId(m.principalId) === foldPrincipalId(alias),
      )
    : undefined;
  return sendJson(ctx.res, 200, {
    available: cfg !== null,
    linked: personIds(principal).some((id) => discordUserIdOf(id) !== null),
    canUnlink: ownedBy(link, principal),
    ...(member ? { tag: member.displayName } : {}),
  });
}

async function authorize(ctx: ApiCtx): Promise<void> {
  const principal = await linkingPrincipal(ctx);
  if (!principal) return;
  const cfg = await oauthConfig(ctx);
  if (!cfg) return sendJson(ctx.res, 404, { error: "link_unavailable" });
  const { nonceHash } = (ctx.body ?? {}) as { nonceHash?: unknown };
  if (typeof nonceHash !== "string" || !NONCE_HASH.test(nonceHash)) {
    return sendJson(ctx.res, 400, {
      error: "invalid_request",
      message: "A valid nonceHash is required.",
    });
  }
  const state = await mintSignedPayload(
    { purpose: LINK_PURPOSE, principal, org: orgId(), nonceHash, exp: Date.now() + DISCORD_LINK_STATE_TTL_MS },
    cfg.signingSecret,
  );
  const url = new URL(DISCORD_AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: "identify",
    redirect_uri: cfg.redirectUri,
    state,
    prompt: "consent",
  }).toString();
  return sendJson(ctx.res, 200, { url: url.href });
}

type ProvenUserResult =
  | { ok: true; user: { id: string; tag: string } }
  | { ok: false; status: 400 | 502; error: "oauth_failed" | "discord_unavailable" };

function logOAuthFailure(category: "network" | "parse" | "timeout"): void {
  console.error(`[discord-link] Discord OAuth call failed (${category})`);
}

function failureCategory(err: unknown): "network" | "timeout" {
  if (err && typeof err === "object") {
    const name = (err as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
  }
  return "network";
}

async function provenDiscordUser(
  ctx: ApiCtx,
  cfg: NonNullable<Awaited<ReturnType<typeof oauthConfig>>>,
  code: string,
): Promise<ProvenUserResult> {
  const fetchImpl = ctx.deps.discordInstallationFetch ?? fetch;
  const guarded = { redirect: "error" as const };
  let tokenStatus = 0;
  const trackedFetch: FetchLike = async (url, init) => {
    const res = await fetchImpl(url, { ...guarded, ...init, signal: AbortSignal.timeout(DISCORD_OAUTH_TIMEOUT_MS) });
    tokenStatus = res.status;
    return res;
  };
  let accessToken: string;
  try {
    ({ accessToken } = await exchangeAuthorizationCode(`${DISCORD_API}/oauth2/token`, code, cfg.redirectUri, {
      client: { id: cfg.clientId, secret: cfg.clientSecret, clientRef: "discord" },
      fetchImpl: trackedFetch,
    }));
  } catch (err) {
    if (tokenStatus === 0) logOAuthFailure(failureCategory(err));
    else if (tokenStatus < 300) logOAuthFailure("parse");
    const unavailable = tokenStatus === 0 || tokenStatus < 300 || tokenStatus >= 500 || tokenStatus === 429;
    return unavailable
      ? { ok: false, status: 502, error: "discord_unavailable" }
      : { ok: false, status: 400, error: "oauth_failed" };
  }
  if (!accessToken) {
    return { ok: false, status: 400, error: "oauth_failed" };
  }

  let me: Response;
  try {
    me = await fetchImpl(`${DISCORD_API}/users/@me`, {
      ...guarded,
      signal: AbortSignal.timeout(DISCORD_OAUTH_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    logOAuthFailure(failureCategory(err));
    return { ok: false, status: 502, error: "discord_unavailable" };
  }
  if (me.status >= 500 || me.status === 429) {
    return { ok: false, status: 502, error: "discord_unavailable" };
  }
  if (!me.ok) {
    return { ok: false, status: 400, error: "oauth_failed" };
  }
  let userBody: { id?: unknown; username?: unknown; discriminator?: unknown };
  try {
    userBody = (await me.json()) as { id?: unknown; username?: unknown; discriminator?: unknown };
  } catch {
    logOAuthFailure("parse");
    return { ok: false, status: 502, error: "discord_unavailable" };
  }
  if (typeof userBody.id !== "string" || !SNOWFLAKE.test(userBody.id) || typeof userBody.username !== "string") {
    return { ok: false, status: 400, error: "oauth_failed" };
  }
  const tag =
    userBody.discriminator && userBody.discriminator !== "0"
      ? `${userBody.username}#${String(userBody.discriminator)}`
      : userBody.username;
  return { ok: true, user: { id: userBody.id, tag } };
}

async function complete(ctx: ApiCtx): Promise<void> {
  const principal = await linkingPrincipal(ctx);
  if (!principal) return;
  const cfg = await oauthConfig(ctx);
  if (!cfg || !ctx.deps.principalLinks) return sendJson(ctx.res, 404, { error: "link_unavailable" });
  const { code, state, nonce } = (ctx.body ?? {}) as { code?: unknown; state?: unknown; nonce?: unknown };
  const proof =
    typeof state === "string"
      ? ((await verifySignedPayload(state, cfg.signingSecret)) as Record<string, unknown> | null)
      : null;
  if (
    typeof code !== "string" ||
    !proof ||
    proof.purpose !== LINK_PURPOSE ||
    proof.org !== orgId() ||
    proof.principal !== principal ||
    typeof proof.nonceHash !== "string" ||
    !NONCE_HASH.test(proof.nonceHash) ||
    typeof proof.exp !== "number" ||
    proof.exp <= Date.now()
  )
    return invalidLink(ctx);
  if (typeof nonce !== "string") return invalidLink(ctx);
  const computedHash = createHash("sha256").update(nonce).digest();
  const expectedHash = Buffer.from(proof.nonceHash, "hex");
  if (computedHash.length !== expectedHash.length || !timingSafeEqual(computedHash, expectedHash))
    return invalidLink(ctx);
  const proven = await provenDiscordUser(ctx, cfg, code);
  if (!proven.ok) {
    if (proven.status === 502) {
      return sendJson(ctx.res, 502, {
        error: "discord_unavailable",
        message: "Discord did not answer. Try again in a minute.",
      });
    }
    return sendJson(ctx.res, 400, {
      error: "oauth_failed",
      message: "Discord did not confirm the account. Try again.",
    });
  }
  const user = proven.user;
  const alias = discordExternalId(user.id);
  const existing = canonicalPerson(alias);
  if (existing !== alias && !samePerson(existing, principal))
    return sendJson(ctx.res, 409, {
      error: "already_linked",
      message: "This Discord account is connected to another QM account. Ask your administrator for help.",
    });
  if (hasOtherDiscordLink(principal, user.id)) return otherAccountLinked(ctx);

  if (existing === alias) {
    const credentials = (await ctx.deps.keychain?.listByOwner(alias)) ?? [];
    if (credentials.length)
      return sendJson(ctx.res, 409, {
        error: "established_account",
        message: "This Discord identity already has saved credentials. Ask your administrator to combine the accounts.",
      });
    try {
      await ctx.deps.principalLinks.link({
        principalId: alias,
        canonicalId: principal,
        evidence: `Discord OAuth2 identify: user ${user.id} (${user.tag}) authorized by ${principal}`,
        linkedBy: principal,
      });
    } catch (err) {
      if (err instanceof PrincipalLinkError) {
        if (hasOtherDiscordLink(principal, user.id)) return otherAccountLinked(ctx);
        return sendJson(ctx.res, 409, { error: "already_linked", message: "Ask your administrator for help." });
      }
      throw err;
    }
    audit(ctx.deps, {
      principalId: principal,
      action: "principal_link.create",
      resource: `${alias} -> ${principal}`,
      scopeLabel: scopeId("org", orgId()),
    });
  }
  await ctx.deps.identity?.refresh(true);
  return sendJson(ctx.res, 200, { linked: true, tag: user.tag });
}

async function unlink(ctx: ApiCtx): Promise<void> {
  const principal = await linkingPrincipal(ctx);
  if (!principal) return;
  if (!ctx.deps.principalLinks) return sendJson(ctx.res, 404, { error: "not_linked" });
  const { link, alias } = await selfLink(ctx, principal);
  const linked = personIds(principal).some((id) => discordUserIdOf(id) !== null);
  if (!ownedBy(link, principal)) {
    if (!linked) return sendJson(ctx.res, 404, { error: "not_linked" });
    return sendJson(ctx.res, 409, {
      error: "admin_link",
      message: "An administrator linked this Discord account. Ask an administrator to remove it.",
    });
  }
  const targetAlias = alias ?? link!.principalId;
  await ctx.deps.principalLinks.unlink(targetAlias);
  await ctx.deps.identity?.refresh(true);
  audit(ctx.deps, {
    principalId: principal,
    action: "principal_link.delete",
    resource: `${targetAlias} -> ${principal}`,
    scopeLabel: scopeId("org", orgId()),
  });
  return sendJson(ctx.res, 200, {
    linked: personIds(principal).some((id) => discordUserIdOf(id) !== null),
  });
}

export const discordLinkRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/discord/link", auth: "source", handle: status },
  { method: "POST", path: "/v1/discord/link/authorize", auth: "source", handle: authorize },
  { method: "POST", path: "/v1/discord/link/complete", auth: "source", handle: complete },
  { method: "DELETE", path: "/v1/discord/link", auth: "source", handle: unlink },
];
