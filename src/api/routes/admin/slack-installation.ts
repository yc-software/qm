import { sendJson } from "../../http.ts";
import { bearerToken } from "../../request-tenant.ts";
import { inTenant } from "../../../tenants/claim.ts";
import { bootTenant } from "../../../tenants/boot.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { errMessage } from "../../../util/errors.ts";
import { validateSlackInstallation } from "../../../surfaces/slack-installation.ts";
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
  audit(ctx.deps, {
    principalId: actor.id,
    action: "slack-installation.read",
    resource: "slack-installation",
    scopeLabel: scope,
  });
  const branding = await resolveBranding(ctx.deps.config, scope, ctx.deps.brandingDefault);
  const createUrl = slackBotManifestCreationUrl(branding.selfLabel);
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
    } catch {
      setupUnavailable = true;
    }
    return sendJson(ctx.res, 200, {
      ...status,
      setup,
      setupUnavailable,
      source: installation?.appToken ? "admin" : "service",
      installAvailable: true,
      installUrl,
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
  const body = ctx.body as { botToken?: unknown; appToken?: unknown };
  const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
  const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
  try {
    const workspace = await validateSlackInstallation(
      botToken,
      appToken,
      ctx.deps.slackInstallationFetch,
      ctx.deps.slackInstallationSocketAppId,
    );
    const status = await ctx.deps.slackInstallation.set({ botToken, appToken, ...workspace, updatedBy: actor.id });
    audit(ctx.deps, {
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
  await ctx.deps.slackInstallation.delete(actor.id);
  audit(ctx.deps, {
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
  } catch {
    return sendJson(ctx.res, 502, { error: "slack_installation_unavailable" });
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
  const tenant = await managedSlackTenant(ctx, slackTeam(ctx.body));
  if (!tenant) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if ((await ctx.app.tenantFor("slack_team", slackTeam(ctx.body))) !== tenant)
    return sendJson(ctx.res, 409, { error: "installation_mismatch" });
  return inTenant(tenant, () => slack.handle(ctx.req, ctx.res, ctx.body));
}
