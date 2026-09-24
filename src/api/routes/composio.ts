import { isBackendCredential } from "../../credentials/keychain.ts";
import { livePersonCapability } from "../artifact-share.ts";
import { mintSignedPayload, verifySignedPayload } from "../../auth/signed-token.ts";
import { canonicalPerson, personIds, samePerson } from "../../directory/person.ts";
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

function composioUserIds(principal: string): string[] {
  return [...new Set(personIds(principal).map((id) => composioUserId(orgId(), id)))];
}

async function activeRun(ctx: ApiCtx): Promise<boolean> {
  const cap = ctx.capability;
  if (!cap) return true;
  const run = cap.runId ? await ctx.deps.runs?.get(cap.runId) : null;
  if (
    !run ||
    run.status !== "running" ||
    !cap.runLeaseToken ||
    run.leaseToken !== cap.runLeaseToken ||
    run.attempts !== cap.runAttempt ||
    run.sessionId !== cap.sessionId ||
    !samePerson(run.request.actor.id, cap.actorId) ||
    (run.leaseExpiresAt ?? 0) <= Date.now()
  ) {
    sendJson(ctx.res, 403, {
      error: "inactive_run",
      message: "Connected app access requires this run's current capability.",
    });
    return false;
  }
  return true;
}

async function credential(ctx: ApiCtx): Promise<{ key: string; principal: string } | null> {
  if (!(await activeRun(ctx))) return null;
  const principal = ctx.capability?.actorId ?? ctx.actor?.p;
  if (!principal) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return null;
  }
  if (!(await activePrincipal(ctx.deps, principal))) {
    sendJson(ctx.res, 403, { error: "forbidden" });
    return null;
  }
  const personal = scopeId("personal", principal);
  if (ctx.capability) {
    const cap = ctx.capability;
    const shared = cap.scopeId !== personal;
    if (
      cap.ownerConnections !== true ||
      cap.deployment ||
      cap.botActor ||
      (shared &&
        livePersonCapability(cap) &&
        (await ctx.deps.config?.resolveSharingPostureDurable(personal, cap.scopeId)) !== "open")
    ) {
      sendJson(ctx.res, 403, {
        error: "private_connections",
        message:
          "Use your connected apps in your own conversation, or explicitly open sharing to this conversation on a human-started turn.",
      });
      return null;
    }
  }
  const own = (await ctx.deps.keychain?.listByOwner(principal)) ?? [];
  const candidates = own.filter(
    (c) => c.kind === "env" && isBackendCredential(c) && (!c.expiresAt || c.expiresAt > Date.now()),
  );
  if (candidates.length > 1) {
    sendJson(ctx.res, 409, {
      error: "ambiguous_credential",
      message: "Choose a single Composio credential in your keychain.",
    });
    return null;
  }
  if (candidates.length === 1) {
    const key = await ctx.deps.keychain!.composioKey(principal, candidates[0]!.id);
    if (key) return { key, principal };
    sendJson(ctx.res, 503, { error: "credential_unavailable" });
    return null;
  }
  const org = scopeId("org", orgId());
  const identity = ctx.deps.identity?.classify(principal) ?? { id: principal, type: "internal" as const };
  const audience = ctx.capability && ctx.capability.scopeId !== personal ? ctx.capability.keychainMembers : [identity];
  if (!audience?.length || audience.some((member) => member.type !== "internal")) {
    sendJson(ctx.res, 403, { error: "unknown_audience" });
    return null;
  }
  const grants =
    (await ctx.deps.acl?.grantsOfKind(
      "service-cred",
      audience,
      ctx.capability?.scopeId ?? personal,
      org,
      principalEntitledToScope,
    )) ?? [];
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
  if (ctx.capability && !livePersonCapability(ctx.capability))
    return sendJson(ctx.res, 403, { error: "human_consent_required" });
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
  const userId = composioUserId(orgId(), canonicalPerson(access.principal));
  try {
    const session = await request(ctx, access.key, "/tool_router/session", {
      user_id: userId,
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
    if (typeof callbackUrl === "string" && ctx.deps.composioReturns) {
      await ctx.deps.composioReturns.put(`${userId}:${link.connected_account_id}`, {
        url: callbackUrl,
        expiresAt: Date.now() + 20 * 60_000,
      });
    }
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
  const userIds = composioUserIds(access.principal);
  const query = new URLSearchParams({ user_ids: userIds.join(","), statuses: "ACTIVE", limit: "100" });
  if (cursor) query.set("cursor", cursor);
  try {
    const data = await request(ctx, access.key, `/connected_accounts?${query}`);
    if (!Array.isArray(data.items)) throw new Error("Invalid accounts");
    const items = data.items.flatMap((item) => {
      if (
        !item ||
        !userIds.includes(item.user_id) ||
        item.status !== "ACTIVE" ||
        item.is_disabled === true ||
        typeof item.id !== "string" ||
        !/^ca_[a-zA-Z0-9_-]+$/.test(item.id) ||
        typeof item.toolkit?.slug !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(item.toolkit.slug)
      )
        return [];
      return [{ id: item.id, toolkit: item.toolkit.slug, userId: item.user_id }];
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

async function tools(ctx: ApiCtx): Promise<void> {
  const access = await credential(ctx);
  if (!access) return;
  const toolkit = ctx.url.searchParams.get("toolkit") ?? "";
  const query = ctx.url.searchParams.get("query") ?? "";
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  if (!/^[a-z0-9_-]{1,100}$/.test(toolkit) || query.length > 1000 || cursor.length > 2048)
    return sendJson(ctx.res, 400, { error: "invalid_query" });
  const params = new URLSearchParams({ toolkit_slug: toolkit, query, limit: "25", toolkit_versions: "latest" });
  if (cursor) params.set("cursor", cursor);
  try {
    const data = await request(ctx, access.key, `/tools?${params}`);
    if (!Array.isArray(data.items)) throw new Error("Invalid tools");
    const items = data.items
      .filter((item) => item?.toolkit?.slug === toolkit)
      .map((item) => ({
        slug: item.slug,
        name: item.name,
        description: item.description,
        version: item.version,
        input_parameters: item.input_parameters,
      }));
    return sendJson(ctx.res, 200, {
      items,
      nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    });
  } catch {
    return sendJson(ctx.res, 502, { error: "composio_unavailable" });
  }
}

async function execute(ctx: ApiCtx): Promise<void> {
  if (!ctx.capability || ctx.actor) return sendJson(ctx.res, 403, { error: "agent_capability_required" });
  const access = await credential(ctx);
  if (!access) return;
  const body = ctx.body as Record<string, unknown> | null;
  if (
    !body ||
    Object.keys(body).some((key) => !["tool", "accountId", "version", "arguments"].includes(key)) ||
    typeof body.tool !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,199}$/.test(body.tool) ||
    body.tool.startsWith("COMPOSIO_") ||
    typeof body.accountId !== "string" ||
    !/^ca_[a-zA-Z0-9_-]+$/.test(body.accountId) ||
    typeof body.version !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(body.version) ||
    body.version === "latest" ||
    !body.arguments ||
    typeof body.arguments !== "object" ||
    Array.isArray(body.arguments)
  )
    return sendJson(ctx.res, 400, {
      error: "invalid_execution",
      message: "Supply tool, accountId, a concrete version, and arguments only.",
    });
  const resource = `${body.accountId}/${body.tool}@${body.version}`;
  try {
    const account = await request(ctx, access.key, `/connected_accounts/${encodeURIComponent(body.accountId)}`);
    const toolkit = (account.toolkit as { slug?: string } | undefined)?.slug;
    if (
      account.id !== body.accountId ||
      typeof account.user_id !== "string" ||
      !composioUserIds(access.principal).includes(account.user_id) ||
      account.status !== "ACTIVE" ||
      account.is_disabled === true ||
      !toolkit ||
      toolkit === "composio"
    )
      return sendJson(ctx.res, 403, { error: "connection_not_authorized" });
    const tool = await request(
      ctx,
      access.key,
      `/tools/${body.tool}?${new URLSearchParams({ toolkit_versions: body.version })}`,
    );
    if (
      tool.slug !== body.tool ||
      (tool.toolkit as { slug?: string } | undefined)?.slug !== toolkit ||
      tool.version !== body.version
    )
      return sendJson(ctx.res, 403, { error: "tool_not_authorized" });
    if (!(await activeRun(ctx))) return;
    if (!composioUserIds(access.principal).includes(account.user_id))
      return sendJson(ctx.res, 403, { error: "connection_not_authorized" });
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.execute.started",
      resource,
      scopeLabel: ctx.capability.scopeId,
    });
    const result = await request(ctx, access.key, `/tools/execute/${body.tool}`, {
      user_id: account.user_id,
      connected_account_id: body.accountId,
      version: body.version,
      arguments: body.arguments,
    });
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.execute.completed",
      resource,
      scopeLabel: ctx.capability.scopeId,
    });
    return sendJson(ctx.res, 200, {
      data: result.data,
      successful: result.successful === true,
      error: result.error ?? null,
    });
  } catch {
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.execute.failed",
      resource,
      scopeLabel: ctx.capability.scopeId,
    });
    return sendJson(ctx.res, 502, {
      error: "composio_execution_failed",
      message: "Execution failed or its outcome is unknown. Do not automatically retry a write.",
    });
  }
}

async function completeAuth(ctx: ApiCtx): Promise<void> {
  if (!ctx.actor || ctx.actor.imp || ctx.capability)
    return sendJson(ctx.res, 403, { error: "browser_identity_required" });
  const access = await credential(ctx);
  if (!access) return;
  const sessionUri = (ctx.body as { sessionUri?: unknown } | null)?.sessionUri;
  if (typeof sessionUri !== "string" || !sessionUri || sessionUri.length > 8192)
    return sendJson(ctx.res, 400, { error: "invalid_session" });
  const userId = composioUserId(orgId(), canonicalPerson(access.principal));
  try {
    const result = await request(ctx, access.key, "/connected_accounts/complete_auth", {
      session_uri: sessionUri,
      user_id: userId,
    });
    if (typeof result.connected_account_id !== "string" || !/^ca_[a-zA-Z0-9_-]+$/.test(result.connected_account_id))
      throw new Error("Invalid account");
    const key = `${userId}:${result.connected_account_id}`;
    const saved = await ctx.deps.composioReturns?.get(key);
    await ctx.deps.composioReturns?.delete(key);
    return sendJson(ctx.res, 200, { returnTo: saved && saved.expiresAt > Date.now() ? saved.url : null });
  } catch {
    return sendJson(ctx.res, 400, {
      error: "verification_failed",
      message: "Sign in to the QM account that started this connection and try connecting again.",
    });
  }
}

export interface ComposioReturn {
  url: string;
  expiresAt: number;
}

async function identity(ctx: ApiCtx): Promise<void> {
  const principal = ctx.actor?.p ?? ctx.capability?.actorId;
  if (!principal || !(await activePrincipal(ctx.deps, principal)))
    return sendJson(ctx.res, 403, { error: "forbidden" });
  const userIds = composioUserIds(principal);
  return sendJson(ctx.res, 200, { userId: userIds[0], userIds });
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
  ctx.res.setHeader("Cache-Control", "no-store");
  let failed = false;
  for (const id of personIds(access.principal)) {
    const record = await ctx.deps.slackAccounts?.get(id);
    if (!record || !samePerson(record.memberId, access.principal)) continue;
    try {
      const account = await request(ctx, access.key, `/connected_accounts/${encodeURIComponent(record.accountId)}`);
      const toolkit = account.toolkit as { slug?: string } | undefined;
      if (
        account.id === record.accountId &&
        composioUserIds(access.principal).includes(String(account.user_id)) &&
        toolkit?.slug === "slack" &&
        account.status === "ACTIVE" &&
        account.is_disabled !== true
      )
        return sendJson(ctx.res, 200, {
          connected: true,
          workspaceInstalled,
          user: record.user,
          workspace: record.workspace,
        });
    } catch {
      failed = true;
    }
  }
  return failed
    ? sendJson(ctx.res, 502, { error: "status_unavailable" })
    : sendJson(ctx.res, 200, { connected: false, workspaceInstalled });
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
      !composioUserIds(access.principal).includes(String(account.user_id)) ||
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
  { method: "GET", path: "/v1/composio/tools", auth: "either", handle: tools },
  { method: "POST", path: "/v1/composio/execute", auth: "either", handle: execute },
  { method: "POST", path: "/v1/composio/complete-auth", auth: "source", handle: completeAuth },
  { method: "GET", path: "/v1/composio/slack", auth: "source", handle: slackStatus },
  { method: "POST", path: "/v1/composio/slack/authorize", auth: "source", handle: (ctx) => authorize(ctx, true) },
  { method: "POST", path: "/v1/composio/slack/complete", auth: "source", handle: completeSlack },
  { method: "GET", path: "/v1/composio/connections", auth: "either", handle: connections },
  { method: "GET", path: "/v1/composio/toolkits", auth: "either", handle: catalog },
  { method: "POST", path: "/v1/composio/authorize", auth: "either", handle: authorize },
  { method: "GET", path: "/v1/composio/identity", auth: "either", handle: identity },
];
