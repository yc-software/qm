import { hasSlackAccount } from "./slack-composio.ts";
import { nativeSlackConfigured, nativeSlackConnection } from "./slack-native.ts";
import { verifySignedPayload } from "../../auth/signed-token.ts";
import { canonicalPerson, personIds, samePerson } from "../../directory/person.ts";
import { PrincipalLinkError } from "../../identity/principal-links.ts";
import { reportFailure } from "../../util/errors.ts";
import { slackWebClient } from "../../slack/web-client.ts";
import { slackErrorCode } from "../../slack/payloads.ts";
import { activePrincipal, audit } from "./shared.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "./route.ts";
import { tenant } from "../../tenant.ts";
import {
  credential,
  activeAccount,
  ownedAccount,
  composioUserId,
  ACCOUNT_ID,
  request,
  reportComposioFailure,
} from "./composio.ts";

export async function slackStatus(ctx: ApiCtx): Promise<RouteResult> {
  ctx.res.setHeader("Cache-Control", "no-store");
  const installation = await ctx.deps.slackInstallation?.get();
  const workspaceInstalled = Boolean(installation?.botToken || ctx.deps.slackEnvBotToken);
  let nativeOAuth = false;
  if (ctx.actor && !ctx.actor.imp && !ctx.capability) {
    try {
      if (!(await activePrincipal(ctx.deps, ctx.actor.p))) return reply(403, { error: "forbidden" });
      const native = await nativeSlackConnection(ctx);
      if (native)
        return ok({
          connected: true,
          user: native.user,
          workspace: native.workspace,
          nativeOAuth: true,
          workspaceInstalled,
        });
      nativeOAuth = await nativeSlackConfigured(ctx);
      if (nativeOAuth && !(await hasSlackAccount(ctx)))
        return ok({ connected: false, nativeOAuth, workspaceInstalled });
    } catch (error) {
      reportFailure("Slack connection status", error);
      return reply(502, { error: "slack_unavailable" });
    }
  }
  const access = await credential(ctx);
  if (!access) return;
  let failed = false;
  for (const id of personIds(access.principal)) {
    const record = await ctx.deps.slackAccounts?.get(id);
    if (!record || !samePerson(record.memberId, access.principal)) continue;
    try {
      if (activeAccount(await ownedAccount(ctx, access, record.accountId), "slack"))
        return ok({
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
    ? reply(502, { error: "status_unavailable" })
    : ok({ connected: false, workspaceInstalled, nativeOAuth });
}

async function installedSlackTeam(deps: ApiCtx["deps"]): Promise<string | undefined> {
  const installation = await deps.slackInstallation?.get();
  const botToken = installation?.botToken ?? deps.slackEnvBotToken;
  if (installation?.teamId || !botToken) return installation?.teamId;
  const bot = (await slackWebClient(botToken, deps.slackWebClient, 10_000)
    .apiCall("auth.test")
    .catch((error: unknown) => {
      if (slackErrorCode(error)) return undefined;
      throw error;
    })) as { team_id?: string } | undefined;
  return bot?.team_id;
}

async function hasEstablishedConnections(ctx: ApiCtx, key: string, memberId: string): Promise<boolean> {
  const { deps } = ctx;
  const existingCredentials = (await deps.keychain?.listByOwner(memberId)) ?? [];
  const projectKeys = new Set([key]);
  const companyCredentials = (await deps.serviceCreds?.listServiceCredentials(tenant().orgScope)) ?? [];
  for (const candidate of companyCredentials) {
    if (candidate.envKey !== "COMPOSIO_API_KEY" || !candidate.hasSecret) continue;
    const material = await deps.serviceCreds!.getServiceCredentialSecret(tenant().orgScope, candidate.slug);
    if (!material?.secret) throw Error("Could not inspect existing connections");
    projectKeys.add(material.secret);
  }
  let hasPriorAccounts = false;
  for (const projectKey of projectKeys) {
    const priorAccounts = await request(
      ctx,
      projectKey,
      `/connected_accounts?${new URLSearchParams({ user_ids: composioUserId(tenant().orgId, memberId), limit: "1" })}`,
    );
    if (!Array.isArray(priorAccounts.items)) throw Error("Could not inspect existing connections");
    hasPriorAccounts ||= priorAccounts.items.length > 0;
  }
  return existingCredentials.length > 0 || hasPriorAccounts;
}

export async function completeSlack(ctx: ApiCtx): Promise<RouteResult> {
  const access = await credential(ctx);
  if (!access) return;
  const { deps } = ctx;
  if (!deps.signingSecret || !deps.principalLinks || !deps.directory || !deps.slackAccounts || ctx.actor?.imp)
    return reply(403, { error: "link_unavailable", message: "Sign in as yourself to connect Slack." });
  const ticket = (ctx.body as { ticket?: unknown } | null)?.ticket;
  const proof =
    typeof ticket === "string"
      ? ((await verifySignedPayload(ticket, deps.signingSecret)) as Record<string, unknown> | null)
      : null;
  if (
    !proof ||
    proof.purpose !== "slack-account-link" ||
    proof.org !== tenant().orgId ||
    proof.principal !== access.principal ||
    typeof proof.exp !== "number" ||
    proof.exp <= Date.now() ||
    typeof proof.accountId !== "string" ||
    !ACCOUNT_ID.test(proof.accountId)
  )
    return reply(400, {
      error: "invalid_link",
      message:
        "This connection expired or belongs to another QM account. Start again from the account you want to connect.",
    });
  try {
    const owned = await ownedAccount(ctx, access, proof.accountId);
    if (owned?.toolkit !== "slack" || owned.account.is_disabled === true)
      return reply(403, {
        error: "wrong_account",
        message: "This Slack connection does not belong to your QM account.",
      });
    if (owned.account.status !== "ACTIVE")
      return reply(409, {
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
      return reply(400, {
        error: "not_user",
        message: "Connect your personal Slack account, not a bot account.",
      });
    const teamId = await installedSlackTeam(deps);
    if (!teamId)
      return reply(409, {
        error: "workspace_unavailable",
        message:
          "Slack access is authorized. Ask an administrator to finish installing the company bot, then check the connection again.",
      });
    if (teamId !== slack.team_id)
      return reply(409, {
        error: "wrong_workspace",
        message: "Connect the Slack workspace where your company uses QM.",
      });
    const members = (await deps.directory.list()).filter(
      (m) => m.slackId === slack.user_id || m.principalId === slack.user_id,
    );
    if (members.length !== 1 || members[0]!.type !== "internal")
      return reply(409, {
        error: "member_unavailable",
        message:
          "QM could not find your company Slack membership. Message the bot and try again, or ask your administrator for help.",
      });
    const member = members[0]!;
    await deps.identity?.refresh(true);
    if (!(await activePrincipal(deps, member.principalId)) || !(await activePrincipal(deps, access.principal)))
      return reply(403, {
        error: "inactive_account",
        message: "An account is inactive. Ask your administrator for help.",
      });
    if (!samePerson(member.principalId, access.principal)) {
      if (await hasEstablishedConnections(ctx, access.key, member.principalId))
        return reply(409, {
          error: "established_account",
          message:
            "Your Slack identity already has connected services. Ask your administrator to combine these accounts so those connections are preserved.",
        });

      if (canonicalPerson(member.principalId) !== member.principalId)
        return reply(409, {
          error: "already_linked",
          message: "This Slack identity is connected to another QM account. Ask your administrator for help.",
        });
      await deps.principalLinks.link({
        principalId: member.principalId,
        canonicalId: access.principal,
        linkedBy: access.principal,
      });
      await deps.identity?.refresh(true);
      audit(deps, {
        principalId: access.principal,
        action: "principal_link.create",
        resource: `${member.principalId} -> ${access.principal}`,
        scopeLabel: tenant().orgScope,
      });
    }
    await deps.slackAccounts.put({
      principalId: access.principal,
      accountId: proof.accountId,
      memberId: member.principalId,
      userId: slack.user_id!,
      teamId: slack.team_id!,
      user: slack.user ?? member.displayName,
      workspace: slack.team ?? slack.team_id!,
    });
    return ok({ connected: true, user: slack.user, workspace: slack.team });
  } catch (error) {
    if (!(error instanceof PrincipalLinkError)) reportComposioFailure("composio: slack link", access.key, error);
    return reply(error instanceof PrincipalLinkError ? 409 : 502, {
      error: "slack_link_failed",
      message:
        error instanceof PrincipalLinkError
          ? "These accounts need an administrator's help to connect. Your existing data has not been moved."
          : "Could not verify the Slack connection. Please try again.",
    });
  }
}
