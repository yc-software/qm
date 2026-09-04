import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { errMessage } from "../../../util/errors.ts";
import { validateSlackInstallation } from "../../../surfaces/slack-installation.ts";
import { slackBotManifestCreationUrl } from "../../../surfaces/slack-manifest.ts";
import { resolveBranding } from "../../../resolution/branding.ts";

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
  if (!botToken) return sendJson(ctx.res, 404, { error: "not_configured" });
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
    return sendJson(ctx.res, 200, { emoji });
  } catch (error) {
    return sendJson(ctx.res, 502, { error: "slack_unreachable", message: errMessage(error) });
  }
}
