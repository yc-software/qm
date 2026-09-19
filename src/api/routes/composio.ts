import { mintSignedPayload, verifySignedPayload } from "../../auth/signed-token.ts";
import { canonicalPerson, samePerson } from "../../directory/person.ts";
import { PrincipalLinkError } from "../../identity/principal-links.ts";
import { createHash } from "node:crypto";
import { scopeId } from "../../types.ts";
import { parseRef } from "../../acl/resource-ref.ts";
import { orgId } from "../../config.ts";
import { principalEntitledToScope } from "../../resolution/context-filter.ts";
import { sendJson } from "../http.ts";
import { activePrincipal, audit } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

export function composioUserId(org: string, principal: string): string {
  return `qm_${createHash("sha256")
    .update(JSON.stringify([org, principal]))
    .digest("hex")}`;
}

async function credential(ctx: ApiCtx): Promise<{ key: string; principal: string } | null> {
  const principal = ctx.actor?.p;
  if (!principal) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return null;
  }
  if (!(await activePrincipal(ctx.deps, principal))) {
    sendJson(ctx.res, 403, { error: "forbidden" });
    return null;
  }
  const personal = scopeId("personal", principal);
  const own = (await ctx.deps.keychain?.listByOwner(principal)) ?? [];
  const candidates = own.filter(
    (c) => c.kind === "env" && c.envKey === "COMPOSIO_API_KEY" && (!c.expiresAt || c.expiresAt > Date.now()),
  );
  if (candidates.length > 1) {
    sendJson(ctx.res, 409, {
      error: "ambiguous_credential",
      message: "Choose a single Composio credential in your keychain.",
    });
    return null;
  }
  if (candidates.length === 1) {
    const material = await ctx.deps.keychain!.materializeOwnById(principal, candidates[0]!.id, personal);
    if (material.kind === "env") {
      const key = material.env.find((e) => e.key === "COMPOSIO_API_KEY")?.value;
      if (key) return { key, principal };
    }
    sendJson(ctx.res, 503, { error: "credential_unavailable" });
    return null;
  }
  const org = scopeId("org", orgId());
  const identity = ctx.deps.identity?.classify(principal) ?? { id: principal, type: "internal" as const };
  const grants =
    (await ctx.deps.acl?.grantsOfKind("service-cred", [identity], personal, org, principalEntitledToScope)) ?? [];
  const allowed = new Set(grants.map((g) => parseRef(g.ref).id));
  const records = ((await ctx.deps.serviceCreds?.listServiceCredentials(org)) ?? []).filter(
    (c) => c.enabled && c.hasSecret && c.delivery === "env" && c.envKey === "COMPOSIO_API_KEY" && allowed.has(c.slug),
  );
  if (records.length !== 1) {
    sendJson(ctx.res, records.length ? 409 : 403, {
      error: "composio_unavailable",
      message: "App connections aren’t available for your account yet. Ask your administrator to enable them.",
    });
    return null;
  }
  const record = await ctx.deps.serviceCreds!.getServiceCredentialSecret(org, records[0]!.slug);
  if (!record?.enabled || record.delivery !== "env" || record.envKey !== "COMPOSIO_API_KEY" || !record.secret) {
    sendJson(ctx.res, 403, { error: "composio_unavailable" });
    return null;
  }
  return { key: record.secret, principal };
}

async function request(ctx: ApiCtx, key: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await (ctx.deps.composioFetch ?? fetch)(`https://backend.composio.dev/api/v3.1${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("Composio request failed");
  return (await response.json()) as Record<string, unknown>;
}

async function catalog(ctx: ApiCtx): Promise<void> {
  const access = await credential(ctx);
  if (!access) return;
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  if (cursor.length > 2048) return sendJson(ctx.res, 400, { error: "bad_cursor" });
  const query = new URLSearchParams({ sort_by: "usage", limit: "1000" });
  if (cursor) query.set("cursor", cursor);
  try {
    const data = await request(ctx, access.key, `/toolkits?${query}`);
    if (!Array.isArray(data.items)) throw new Error("Invalid catalog");
    const items = data.items.flatMap((item) => {
      if (
        !item ||
        typeof item.slug !== "string" ||
        !/^[a-z0-9_-]{1,100}$/.test(item.slug) ||
        typeof item.name !== "string" ||
        (Array.isArray(item.auth_schemes) && item.auth_schemes.every((scheme: unknown) => scheme === "NO_AUTH"))
      )
        return [];
      return [
        {
          id: item.slug,
          logoUrl: `https://logos.composio.dev/api/${item.slug}`,
          name: item.name,
          description: typeof item.meta?.description === "string" ? item.meta.description : "",
        },
      ];
    });
    return sendJson(ctx.res, 200, {
      items,
      nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    });
  } catch {
    return sendJson(ctx.res, 502, { error: "composio_unavailable", message: "Could not load apps. Please try again." });
  }
}

async function authorize(ctx: ApiCtx, linkSlack = false): Promise<void> {
  const access = await credential(ctx);
  if (!access) return;
  const toolkit = linkSlack ? "slack" : (ctx.body as { toolkit?: unknown } | null)?.toolkit;
  if (linkSlack && (!ctx.deps.signingSecret || !ctx.deps.principalLinks || ctx.actor?.imp))
    return sendJson(ctx.res, 403, { error: "link_unavailable", message: "Sign in as yourself to connect Slack." });
  if (typeof toolkit !== "string" || !/^[a-z0-9_-]{1,100}$/.test(toolkit))
    return sendJson(ctx.res, 400, { error: "invalid_toolkit" });
  const callbackUrl = (ctx.body as { callbackUrl?: unknown }).callbackUrl;
  if (callbackUrl !== undefined) {
    try {
      if (typeof callbackUrl !== "string" || callbackUrl.length > 4096) throw new Error("Invalid callback");
      const callback = new URL(callbackUrl);
      if (
        callback.username ||
        callback.password ||
        callback.hash ||
        !(
          callback.protocol === "https:" ||
          (callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname))
        )
      )
        throw new Error("Invalid callback");
    } catch {
      return sendJson(ctx.res, 400, { error: "invalid_callback" });
    }
  }
  try {
    const session = await request(ctx, access.key, "/tool_router/session", {
      user_id: composioUserId(orgId(), access.principal),
      toolkits: { enable: [toolkit] },
      manage_connections: { enable: false },
      workbench: { enable: false },
    });
    if (typeof session.session_id !== "string" || !/^trs_[a-zA-Z0-9_-]+$/.test(session.session_id))
      throw new Error("Invalid session");
    const link = await request(ctx, access.key, `/tool_router/session/${encodeURIComponent(session.session_id)}/link`, {
      toolkit,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    });
    if (typeof link.connected_account_id !== "string" || !/^ca_[a-zA-Z0-9_-]+$/.test(link.connected_account_id))
      throw new Error("Invalid account");
    const url = new URL(String(link.redirect_url));
    if (
      !(
        (url.origin === "https://connect.composio.dev" && /^\/link\/lk_[a-zA-Z0-9_-]+$/.test(url.pathname)) ||
        (url.origin === "https://app.composio.dev" && /^\/link\/lt_[a-zA-Z0-9_-]+$/.test(url.pathname))
      ) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid authorization URL");
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.authorize",
      resource: toolkit,
      scopeLabel: scopeId("personal", access.principal),
    });
    const ticket = linkSlack
      ? await mintSignedPayload(
          {
            purpose: "slack-account-link",
            principal: access.principal,
            org: orgId(),
            accountId: link.connected_account_id,
            exp: Date.now() + 20 * 60_000,
          },
          ctx.deps.signingSecret!,
        )
      : undefined;
    return sendJson(ctx.res, 200, {
      url: url.href,
      accountId: link.connected_account_id,
      ...(ticket ? { ticket } : {}),
    });
  } catch {
    return sendJson(ctx.res, 502, {
      error: "composio_authorization_failed",
      message: "Could not start authorization. Please try again.",
    });
  }
}

async function connections(ctx: ApiCtx): Promise<void> {
  const access = await credential(ctx);
  if (!access) return;
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  if (cursor.length > 2048) return sendJson(ctx.res, 400, { error: "bad_cursor" });
  const userId = composioUserId(orgId(), access.principal);
  const query = new URLSearchParams({ user_ids: userId, statuses: "ACTIVE", limit: "100" });
  if (cursor) query.set("cursor", cursor);
  try {
    const data = await request(ctx, access.key, `/connected_accounts?${query}`);
    if (!Array.isArray(data.items)) throw new Error("Invalid accounts");
    const items = data.items.flatMap((item) => {
      if (
        !item ||
        item.user_id !== userId ||
        item.status !== "ACTIVE" ||
        item.is_disabled === true ||
        typeof item.id !== "string" ||
        !/^ca_[a-zA-Z0-9_-]+$/.test(item.id) ||
        typeof item.toolkit?.slug !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(item.toolkit.slug)
      )
        return [];
      return [{ id: item.id, toolkit: item.toolkit.slug }];
    });
    ctx.res.setHeader("Cache-Control", "no-store");
    return sendJson(ctx.res, 200, {
      items,
      nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    });
  } catch {
    return sendJson(ctx.res, 502, {
      error: "composio_unavailable",
      message: "Could not check connected apps. Please try again.",
    });
  }
}

async function identity(ctx: ApiCtx): Promise<void> {
  const principal = ctx.actor?.p ?? ctx.capability?.actorId;
  if (!principal || !(await activePrincipal(ctx.deps, principal)))
    return sendJson(ctx.res, 403, { error: "forbidden" });
  return sendJson(ctx.res, 200, { userId: composioUserId(orgId(), principal) });
}

export interface SlackAccountLink {
  principalId: string;
  accountId: string;
  memberId: string;
  userId: string;
  teamId: string;
  user: string;
  workspace: string;
}

async function slackStatus(ctx: ApiCtx): Promise<void> {
  const access = await credential(ctx);
  if (!access) return;
  const installation = await ctx.deps.slackInstallation?.get();
  const workspaceInstalled = Boolean(installation?.botToken || ctx.deps.slackEnvBotToken);
  const record = await ctx.deps.slackAccounts?.get(access.principal);
  ctx.res.setHeader("Cache-Control", "no-store");
  if (!record || !samePerson(record.memberId, access.principal))
    return sendJson(ctx.res, 200, { connected: false, workspaceInstalled });
  try {
    const account = await request(ctx, access.key, `/connected_accounts/${encodeURIComponent(record.accountId)}`);
    const toolkit = account.toolkit as { slug?: string } | undefined;
    const connected =
      account.id === record.accountId &&
      account.user_id === composioUserId(orgId(), access.principal) &&
      toolkit?.slug === "slack" &&
      account.status === "ACTIVE" &&
      account.is_disabled !== true;
    return sendJson(ctx.res, 200, { connected, workspaceInstalled, user: record.user, workspace: record.workspace });
  } catch {
    return sendJson(ctx.res, 502, { error: "status_unavailable" });
  }
}

async function completeSlack(ctx: ApiCtx): Promise<void> {
  const access = await credential(ctx);
  if (!access) return;
  const { deps, res } = ctx;
  if (!deps.signingSecret || !deps.principalLinks || !deps.directory || !deps.slackAccounts || ctx.actor?.imp)
    return sendJson(res, 403, { error: "link_unavailable", message: "Sign in as yourself to connect Slack." });
  const ticket = (ctx.body as { ticket?: unknown } | null)?.ticket;
  const proof =
    typeof ticket === "string"
      ? ((await verifySignedPayload(ticket, deps.signingSecret)) as Record<string, unknown> | null)
      : null;
  if (
    !proof ||
    proof.purpose !== "slack-account-link" ||
    proof.org !== orgId() ||
    proof.principal !== access.principal ||
    typeof proof.exp !== "number" ||
    proof.exp <= Date.now() ||
    typeof proof.accountId !== "string" ||
    !/^ca_[a-zA-Z0-9_-]+$/.test(proof.accountId)
  )
    return sendJson(res, 400, {
      error: "invalid_link",
      message:
        "This connection expired or belongs to another QM account. Start again from the account you want to connect.",
    });
  try {
    const account = await request(ctx, access.key, `/connected_accounts/${encodeURIComponent(proof.accountId)}`);
    const toolkit = account.toolkit as { slug?: string } | undefined;
    if (
      account.id !== proof.accountId ||
      account.user_id !== composioUserId(orgId(), access.principal) ||
      toolkit?.slug !== "slack" ||
      account.is_disabled === true
    )
      return sendJson(res, 403, {
        error: "wrong_account",
        message: "This Slack connection does not belong to your QM account.",
      });
    if (account.status !== "ACTIVE")
      return sendJson(res, 409, {
        error: "not_connected",
        message: "Slack authorization has not completed. Try again after approving access.",
      });
    const result = await request(ctx, access.key, "/tools/execute/proxy", {
      connected_account_id: proof.accountId,
      endpoint: "https://slack.com/api/auth.test",
      method: "GET",
    });
    const slack = result.data as
      { ok?: boolean; user_id?: string; team_id?: string; bot_id?: string; user?: string; team?: string } | undefined;
    if (
      slack?.ok !== true ||
      slack.bot_id ||
      !/^[UW][A-Z0-9]+$/.test(slack.user_id ?? "") ||
      !/^T[A-Z0-9]+$/.test(slack.team_id ?? "")
    )
      return sendJson(res, 400, {
        error: "not_user",
        message: "Connect your personal Slack account, not a bot account.",
      });
    const installation = await deps.slackInstallation?.get();
    let teamId = installation?.teamId;
    const botToken = installation?.botToken ?? deps.slackEnvBotToken;
    if (!teamId && botToken) {
      const response = await (deps.slackInstallationFetch ?? fetch)("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      const bot = (await response.json()) as { ok?: boolean; team_id?: string };
      if (response.ok && bot.ok) teamId = bot.team_id;
    }
    if (!teamId)
      return sendJson(res, 409, {
        error: "workspace_unavailable",
        message:
          "Slack access is authorized. Ask an administrator to finish installing the company bot, then check the connection again.",
      });
    if (teamId !== slack.team_id)
      return sendJson(res, 409, {
        error: "wrong_workspace",
        message: "Connect the Slack workspace where your company uses QM.",
      });
    const members = (await deps.directory.list()).filter(
      (m) => m.slackId === slack.user_id || m.principalId === slack.user_id,
    );
    if (members.length !== 1 || members[0]!.type !== "internal")
      return sendJson(res, 409, {
        error: "member_unavailable",
        message:
          "QM could not find your company Slack membership. Message the bot and try again, or ask your administrator for help.",
      });
    const member = members[0]!;
    await deps.identity?.refresh(true);
    if (!(await activePrincipal(deps, member.principalId)) || !(await activePrincipal(deps, access.principal)))
      return sendJson(res, 403, {
        error: "inactive_account",
        message: "An account is inactive. Ask your administrator for help.",
      });
    if (!samePerson(member.principalId, access.principal)) {
      const existingCredentials = (await deps.keychain?.listByOwner(member.principalId)) ?? [];
      const projectKeys = new Set([access.key]);
      const companyCredentials = (await deps.serviceCreds?.listServiceCredentials(scopeId("org", orgId()))) ?? [];
      for (const candidate of companyCredentials) {
        if (candidate.envKey !== "COMPOSIO_API_KEY" || !candidate.hasSecret) continue;
        const material = await deps.serviceCreds!.getServiceCredentialSecret(scopeId("org", orgId()), candidate.slug);
        if (!material?.secret) throw Error("Could not inspect existing connections");
        projectKeys.add(material.secret);
      }
      let hasPriorAccounts = false;
      for (const projectKey of projectKeys) {
        const priorAccounts = await request(
          ctx,
          projectKey,
          `/connected_accounts?${new URLSearchParams({ user_ids: composioUserId(orgId(), member.principalId), limit: "1" })}`,
        );
        if (!Array.isArray(priorAccounts.items)) throw Error("Could not inspect existing connections");
        hasPriorAccounts ||= priorAccounts.items.length > 0;
      }
      if (existingCredentials.length || hasPriorAccounts)
        return sendJson(res, 409, {
          error: "established_account",
          message:
            "Your Slack identity already has connected services. Ask your administrator to combine these accounts so those connections are preserved.",
        });

      if (canonicalPerson(member.principalId) !== member.principalId)
        return sendJson(res, 409, {
          error: "already_linked",
          message: "This Slack identity is connected to another QM account. Ask your administrator for help.",
        });
      await deps.principalLinks.link({
        principalId: member.principalId,
        canonicalId: access.principal,
        evidence: `Slack OAuth user ${slack.user_id} in workspace ${slack.team_id}, connection ${proof.accountId}`,
        linkedBy: access.principal,
      });
      await deps.identity?.refresh(true);
      audit(deps, {
        principalId: access.principal,
        action: "principal_link.create",
        resource: `${member.principalId} -> ${access.principal}`,
        scopeLabel: scopeId("org", orgId()),
      });
    }
    await deps.slackAccounts.put(access.principal, {
      principalId: access.principal,
      accountId: proof.accountId,
      memberId: member.principalId,
      userId: slack.user_id!,
      teamId: slack.team_id!,
      user: slack.user ?? member.displayName,
      workspace: slack.team ?? slack.team_id!,
    });
    return sendJson(res, 200, { connected: true, user: slack.user, workspace: slack.team });
  } catch (error) {
    return sendJson(res, error instanceof PrincipalLinkError ? 409 : 502, {
      error: "slack_link_failed",
      message:
        error instanceof PrincipalLinkError
          ? "These accounts need an administrator's help to connect. Your existing data has not been moved."
          : "Could not verify the Slack connection. Please try again.",
    });
  }
}

export const composioRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/composio/slack", auth: "source", handle: slackStatus },
  { method: "POST", path: "/v1/composio/slack/authorize", auth: "source", handle: (ctx) => authorize(ctx, true) },
  { method: "POST", path: "/v1/composio/slack/complete", auth: "source", handle: completeSlack },
  { method: "GET", path: "/v1/composio/connections", auth: "source", handle: connections },
  { method: "GET", path: "/v1/composio/toolkits", auth: "source", handle: catalog },
  { method: "POST", path: "/v1/composio/authorize", auth: "source", handle: authorize },
  { method: "GET", path: "/v1/composio/identity", auth: "either", handle: identity },
];
