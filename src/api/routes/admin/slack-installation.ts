import { sendJson } from "../../http.ts";
import { bearerToken } from "../../request-tenant.ts";
import { inTenant } from "../../../tenants/claim.ts";
import { bootTenant } from "../../../tenants/boot.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { errMessage } from "../../../util/errors.ts";
import { validateSlackInstallation } from "../../../surfaces/slack-installation.ts";
import { SlackInstallStartError } from "../../../surfaces/slack-managed.ts";
import { slackBotManifestCreationUrl } from "../../../surfaces/slack-manifest.ts";
import { resolveBranding } from "../../../resolution/branding.ts";
import emojiData from "emoji-datasource/emoji.json" with { type: "json" };

type StandardEmojiEntry = [name: string, char: string, category: string];
let standardEmojiCache: StandardEmojiEntry[] | undefined;
function standardEmoji(): StandardEmojiEntry[] {
  if (!standardEmojiCache) {
    standardEmojiCache = [...emojiData]
      .filter((e) => e.category !== "Component" && e.unified)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((e) => [
        e.short_name,
        String.fromCodePoint(...e.unified.split("-").map((h) => parseInt(h, 16))),
        e.category,
      ]);
  }
  return standardEmojiCache;
}

export async function getSlackInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  audit(ctx, {
    principalId: actor.id,
    action: "slack-installation.read",
    resource: "slack-installation",
    scopeLabel: scope,
  });
  const branding = await resolveBranding(ctx.deps.config, scope, ctx.deps.brandingDefault);
  const name = ctx.url.searchParams.get("name")?.trim();
  const createUrl = slackBotManifestCreationUrl(name || branding.selfLabel);
  if (ctx.deps.managedSlack) {
    const status = await ctx.deps.slackInstallation.status();
    if (!status.managed && ctx.deps.slackEnvironmentState === "configured") {
      return sendJson(ctx.res, 200, { configured: true, managed: false, source: "environment", createUrl });
    }
    const installation = await ctx.deps.slackInstallation.get();
    const origin = ctx.deps.portalUrl ?? ctx.deps.publicUrl;
    const installUrl = origin ? new URL("/settings/slack-settings?slack=install", origin).href : undefined;
    let setup;
    let setupUnavailable = false;
    try {
      const progress = await ctx.deps.managedSlack.setupStatus();
      if (progress?.companyOwned && origin) {
        setup = {
          ...progress,
          tokenUrl: "https://api.slack.com/apps",
          submitUrl: new URL("/settings/slack-settings?slack=setup", origin).href,
          installUrl,
          statusUrl: new URL("/api/admin/slack-installation", origin).href,
        };
      }
    } catch (error) {
      setupUnavailable = true;
      console.warn(`[slack-installation] setup status unavailable: ${errMessage(error)}`);
    }
    return sendJson(ctx.res, 200, {
      ...status,
      setup,
      setupUnavailable,
      source: installation?.appToken ? "admin" : "service",
      installAvailable: !setupUnavailable,
      ...(setupUnavailable ? {} : { installUrl }),
      createUrl,
    });
  }
  const stored = await ctx.deps.slackInstallation.status();
  if (stored.managed) return sendJson(ctx.res, 200, { ...stored, source: "admin", createUrl });
  if (ctx.deps.slackEnvironmentState === "configured") {
    return sendJson(ctx.res, 200, { configured: true, managed: false, source: "environment", createUrl });
  }
  return sendJson(ctx.res, 200, {
    configured: false,
    managed: false,
    source: ctx.deps.slackEnvironmentState === "partial" ? "invalid_environment" : "none",
    createUrl,
  });
}

export async function putSlackInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  const body = ctx.body as { botToken?: unknown; appToken?: unknown; signingSecret?: unknown; appId?: unknown };
  const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
  const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
  const signingSecret = typeof body.signingSecret === "string" ? body.signingSecret.trim() : "";
  const appId = typeof body.appId === "string" ? body.appId.trim() : undefined;
  try {
    if (signingSecret && !appToken) {
      const prov = await ctx.deps.slackInstallation.attachHttpApp({
        botToken,
        signingSecret,
        ...(appId ? { appId } : {}),
        updatedBy: actor.id,
      });
      audit(ctx, {
        principalId: actor.id,
        action: "slack-installation.update",
        resource: "slack-installation",
        scopeLabel: scope,
      });
      return sendJson(ctx.res, 200, { ...prov, configured: true, managed: true, source: "admin" });
    }
    const workspace = await validateSlackInstallation(
      botToken,
      appToken,
      ctx.deps.slackInstallationFetch,
      ctx.deps.slackInstallationSocketAppId,
    );
    const status = await ctx.deps.slackInstallation.set({ botToken, appToken, ...workspace, updatedBy: actor.id });
    audit(ctx, {
      principalId: actor.id,
      action: "slack-installation.update",
      resource: "slack-installation",
      scopeLabel: scope,
    });
    return sendJson(ctx.res, 200, { ...status, source: "admin" });
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "invalid_slack_installation", message: errMessage(error) });
  }
}

export async function deleteSlackInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  const deleteRemote =
    ctx.url.searchParams.get("deleteRemote") === "true" ||
    Boolean((ctx.body as { deleteRemote?: unknown } | undefined)?.deleteRemote === true);
  await ctx.deps.slackInstallation.deleteApp({ updatedBy: actor.id, deleteRemote });
  audit(ctx, {
    principalId: actor.id,
    action: "slack-installation.delete",
    resource: "slack-installation",
    scopeLabel: scope,
  });
  return sendJson(ctx.res, 200, { configured: false, managed: true, source: "admin" });
}

export async function getSlackEmojiList(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const managed = await ctx.deps.slackInstallation?.get();
  const botToken = managed?.botToken ?? ctx.deps.slackEnvBotToken ?? "";
  if (!botToken) {
    const cached = await ctx.deps.config?.getSlackEmojiCatalogDurable(scope);
    if (cached && Object.keys(cached.emoji).length) {
      return sendJson(ctx.res, 200, { emoji: cached.emoji, standard: standardEmoji() });
    }
    return sendJson(ctx.res, 404, { error: "not_configured" });
  }
  const doFetch = ctx.deps.slackInstallationFetch ?? fetch;
  try {
    const res = await doFetch("https://slack.com/api/emoji.list", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/x-www-form-urlencoded" },
    });
    const data = (await res.json()) as { ok?: boolean; error?: string; emoji?: Record<string, string> };
    if (!data.ok) return sendJson(ctx.res, 502, { error: "slack_error", message: data.error ?? "unknown" });
    const emoji: Record<string, string> = {};
    for (const [name, url] of Object.entries(data.emoji ?? {})) {
      if (typeof url === "string" && url.startsWith("alias:")) continue;
      emoji[name] = url;
    }
    return sendJson(ctx.res, 200, { emoji, standard: standardEmoji() });
  } catch (error) {
    return sendJson(ctx.res, 502, { error: "slack_unreachable", message: errMessage(error) });
  }
}

export async function startSlackInstallation(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  if (!ctx.deps.managedSlack) return sendJson(ctx.res, 404, { error: "not_configured" });
  try {
    const step = (ctx.body as { step?: unknown } | undefined)?.step ?? "install";
    if (step !== "setup" && step !== "install") return sendJson(ctx.res, 400, { error: "invalid_step" });
    const origin = ctx.req.headers.origin;
    const result = await ctx.deps.managedSlack.start(step, typeof origin === "string" ? origin : undefined);
    return sendJson(ctx.res, 200, result);
  } catch (error) {
    console.warn(`[slack-installation] start failed: ${errMessage(error)}`);
    return sendJson(ctx.res, 502, {
      error: "slack_installation_unavailable",
      message:
        error instanceof SlackInstallStartError
          ? error.message
          : "The Slack installation service didn't respond. Try again in a few minutes.",
    });
  }
}

async function managedSlackTenant(ctx: ApiCtx, team: string | undefined, named?: unknown): Promise<string | undefined> {
  const own = await ctx.app.tenantFor("slack_bridge", bearerToken(ctx.req) ?? undefined);
  if (own || !ctx.deps.managedSlack?.relayed(ctx.req)) return own ?? bootTenant();
  if (typeof named === "string") return named;
  return (await ctx.app.tenantFor("slack_team", team)) ?? bootTenant();
}

function slackTeam(value: unknown): string | undefined {
  const body = (value as { body?: { team_id?: unknown; team?: { id?: unknown } } } | undefined)?.body;
  const team = body?.team_id ?? body?.team?.id;
  return typeof team === "string" ? team : undefined;
}

export async function managedSlackRequest(ctx: ApiCtx): Promise<void> {
  const slack = ctx.deps.managedSlack;
  if (!slack) return sendJson(ctx.res, 404, { error: "not_configured" });
  const input = ctx.body as { teamId?: unknown; tenant?: unknown } | undefined;
  const teamId = input?.teamId;
  const tenant = await managedSlackTenant(
    ctx,
    typeof teamId === "string" ? teamId : undefined,
    ctx.req.method === "POST" ? input?.tenant : undefined,
  );
  if (!tenant) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (ctx.req.method === "POST" && typeof teamId === "string") {
    const owner = await ctx.app.tenantFor("slack_team", teamId);
    if (owner && owner !== tenant) return sendJson(ctx.res, 409, { error: "installation_conflict" });
  }
  return inTenant(tenant, () => slack.handle(ctx.req, ctx.res, ctx.body));
}

export async function managedSlackEvent(ctx: ApiCtx): Promise<void> {
  const slack = ctx.deps.managedSlack;
  if (!slack) return sendJson(ctx.res, 404, { error: "not_configured" });
  const teamId = slackTeam(ctx.body);
  const tenant = await managedSlackTenant(ctx, teamId);
  if (!tenant) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const resolvedTenant = await ctx.app.tenantFor("slack_team", teamId);
  if (resolvedTenant !== tenant) {
    console.warn(
      "[slack-installation] installation_mismatch",
      JSON.stringify({ teamId: teamId ?? null, tenant, resolvedTenant: resolvedTenant ?? null }),
    );
    return sendJson(ctx.res, 409, { error: "installation_mismatch" });
  }
  return inTenant(tenant, () => slack.handle(ctx.req, ctx.res, ctx.body));
}

export async function createSlackInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  const body = (ctx.body ?? {}) as {
    name?: unknown;
    description?: unknown;
    configToken?: unknown;
    refreshToken?: unknown;
    saveOrgConfigToken?: unknown;
    orgDeploy?: unknown;
  };
  const branding = await resolveBranding(ctx.deps.config, scope, ctx.deps.brandingDefault);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : (branding.selfLabel ?? "qm");
  let configToken: string | undefined;
  if (typeof body.refreshToken === "string" && body.refreshToken.trim()) configToken = body.refreshToken;
  else if (typeof body.configToken === "string") configToken = body.configToken;
  try {
    const created = await ctx.deps.slackInstallation.createApp({
      name,
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(configToken ? { configToken } : {}),
      saveOrgConfigToken: body.saveOrgConfigToken !== false,
      ...(body.orgDeploy === true ? { orgDeploy: true } : {}),
      updatedBy: actor.id,
    });
    audit(ctx, {
      principalId: actor.id,
      action: "slack-installation.create",
      resource: "slack-installation",
      scopeLabel: scope,
    });
    return sendJson(ctx.res, 200, created.status);
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "slack_app_create_failed", message: errMessage(error) });
  }
}

export async function slackOAuthCallback(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  const slackErr = ctx.url.searchParams.get("error");
  const state = ctx.url.searchParams.get("state") ?? "";
  const dot = state.indexOf(".");
  const target = dot > 0 ? state.slice(0, dot) : "base";
  const destPath = target === "base" ? "/settings/slack-settings" : `/personas/${encodeURIComponent(target)}`;
  const base = (ctx.deps.publicUrl ?? ctx.deps.portalUrl ?? "").replace(/\/+$/, "");
  const redirectTo = (query: string) => {
    ctx.res.writeHead(302, { location: `${base}${destPath}?${query}` });
    ctx.res.end();
  };
  if (slackErr) return redirectTo(`slack_error=${encodeURIComponent(slackErr)}`);
  const code = ctx.url.searchParams.get("code") ?? "";
  if (!code || !state) return redirectTo("slack_error=missing_oauth_params");
  try {
    await ctx.deps.slackInstallation.completeOAuth({ code, state });
    return redirectTo("slack=connected");
  } catch (error) {
    return redirectTo(`slack_error=${encodeURIComponent(errMessage(error))}`);
  }
}

export async function getSlackConfigToken(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  return sendJson(ctx.res, 200, await ctx.deps.slackInstallation.configTokenStatus());
}

export async function putSlackConfigToken(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  const body = (ctx.body ?? {}) as { accessToken?: unknown; refreshToken?: unknown };
  try {
    const status = await ctx.deps.slackInstallation.setConfigToken({
      ...(typeof body.accessToken === "string" ? { accessToken: body.accessToken } : {}),
      ...(typeof body.refreshToken === "string" ? { refreshToken: body.refreshToken } : {}),
      updatedBy: actor.id,
    });
    audit(ctx, {
      principalId: actor.id,
      action: "slack-config-token.update",
      resource: "slack-config-token",
      scopeLabel: scope,
    });
    return sendJson(ctx.res, 200, status);
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "invalid_config_token", message: errMessage(error) });
  }
}

export async function deleteSlackConfigToken(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  await ctx.deps.slackInstallation.deleteConfigToken();
  audit(ctx, {
    principalId: actor.id,
    action: "slack-config-token.delete",
    resource: "slack-config-token",
    scopeLabel: scope,
  });
  return sendJson(ctx.res, 200, { configured: false, hasRefreshToken: false });
}
