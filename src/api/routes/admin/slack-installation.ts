import { refusal } from "../../http.ts";
import { orgAdmin } from "./common.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "../route.ts";
import { errMessage, reportFailure, swallow } from "../../../util/errors.ts";
import { validateSlackInstallation } from "../../../surfaces/slack-installation.ts";
import { slackBotManifestCreationUrl } from "../../../surfaces/slack-manifest.ts";
import { slackWebClient } from "../../../slack/web-client.ts";
import { slackErrorCode } from "../../../slack/payloads.ts";
import { resolveBranding } from "../../../resolution/branding.ts";
import { tenant } from "../../../tenant.ts";
import { isHomeTenant } from "../../../tenants/directory.ts";
import emojiData from "emoji-datasource/emoji.json" with { type: "json" };

type StandardEmojiEntry = [name: string, char: string, category: string];
let standardEmojiCache: StandardEmojiEntry[] | undefined;
const standardEmoji = (): StandardEmojiEntry[] =>
  (standardEmojiCache ??= [...emojiData]
    .filter((e) => e.category !== "Component" && e.unified)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((e) => [e.short_name, String.fromCodePoint(...e.unified.split("-").map((h) => parseInt(h, 16))), e.category]));

const environmentSlack = (ctx: ApiCtx) =>
  isHomeTenant(tenant())
    ? { state: ctx.deps.slackEnvironmentState, botToken: ctx.deps.slackEnvBotToken }
    : { state: "absent" as const };

export async function getSlackInstallation(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  const { scope } = authz;
  if (!ctx.deps.slackInstallation) return reply(404, { error: "not_configured" });
  authz.audit("slack-installation.read", "slack-installation");
  const environment = environmentSlack(ctx).state;
  const branding = await resolveBranding(ctx.deps.config, scope, ctx.deps.brandingDefault);
  const createUrl = slackBotManifestCreationUrl(branding.selfLabel);
  const status = await ctx.deps.slackInstallation.status();
  const fromEnvironment = () => ok({ configured: true, managed: false, source: "environment", createUrl });
  if (ctx.deps.managedSlack) {
    if (!status.managed && environment === "configured") return fromEnvironment();
    const installation = await ctx.deps.slackInstallation.get();
    let setup;
    let setupUnavailable = false;
    try {
      const progress = await ctx.deps.managedSlack.setupStatus();
      const origin = ctx.deps.portalUrl ?? ctx.deps.publicUrl;
      if (progress?.companyOwned && origin) {
        setup = {
          ...progress,
          tokenUrl: "https://api.slack.com/apps",
          submitUrl: new URL("/settings/slack-settings?slack=setup", origin).href,
          installUrl: new URL("/settings/slack-settings?slack=install", origin).href,
          statusUrl: new URL("/api/admin/slack-installation", origin).href,
        };
      }
    } catch (error) {
      swallow("slack installation: setup status", error);
      setupUnavailable = true;
    }
    return ok({
      ...status,
      setup,
      setupUnavailable,
      source: installation?.appToken ? "admin" : "service",
      installAvailable: true,
      createUrl,
    });
  }
  if (status.managed) return ok({ ...status, source: "admin", createUrl });
  if (environment === "configured") return fromEnvironment();
  return ok({
    configured: false,
    managed: false,
    source: environment === "partial" ? "invalid_environment" : "none",
    createUrl,
  });
}

export async function putSlackInstallation(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  const { actor } = authz;
  if (!ctx.deps.slackInstallation) return reply(404, { error: "not_configured" });
  const body = ctx.body as { botToken?: unknown; appToken?: unknown };
  const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
  const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
  try {
    const workspace = await validateSlackInstallation(
      botToken,
      appToken,
      ctx.deps.slackWebClient,
      ctx.deps.slackInstallationSocketAppId,
    );
    const status = await ctx.deps.slackInstallation.set({ botToken, appToken, ...workspace, updatedBy: actor.id });
    authz.audit("slack-installation.update", "slack-installation");
    return ok({ ...status, source: "admin" });
  } catch (error) {
    throw refusal(400, "invalid_slack_installation", error);
  }
}

export async function deleteSlackInstallation(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  const { actor } = authz;
  if (!ctx.deps.slackInstallation) return reply(404, { error: "not_configured" });
  await ctx.deps.slackInstallation.delete(actor.id);
  authz.audit("slack-installation.delete", "slack-installation");
  return ok({ configured: false, managed: true, source: "admin" });
}

export async function getSlackEmojiList(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  const { scope } = authz;
  const managed = await ctx.deps.slackInstallation?.get();
  const botToken = managed?.botToken ?? environmentSlack(ctx).botToken ?? "";
  if (!botToken) {
    const cached = await ctx.deps.config?.getSlackEmojiCatalogDurable(scope);
    if (cached && Object.keys(cached.emoji).length) return ok({ emoji: cached.emoji, standard: standardEmoji() });
    return reply(404, { error: "not_configured" });
  }
  try {
    const data = (await slackWebClient(botToken, ctx.deps.slackWebClient).apiCall("emoji.list")) as {
      emoji?: Record<string, string>;
    };
    const emoji: Record<string, string> = {};
    for (const [name, url] of Object.entries(data.emoji ?? {})) {
      if (typeof url === "string" && url.startsWith("alias:")) continue;
      emoji[name] = url;
    }
    return ok({ emoji, standard: standardEmoji() });
  } catch (error) {
    const code = slackErrorCode(error);
    if (code) return reply(502, { error: "slack_error", message: code });
    return reply(502, { error: "slack_unreachable", message: errMessage(error) });
  }
}

export async function startSlackInstallation(ctx: ApiCtx): Promise<RouteResult> {
  await orgAdmin(ctx);
  if (!ctx.deps.managedSlack) return reply(404, { error: "not_configured" });
  try {
    const step = (ctx.body as { step?: unknown } | undefined)?.step ?? "install";
    if (step !== "setup" && step !== "install") return reply(400, { error: "invalid_step" });
    const result = await ctx.deps.managedSlack.start(step);
    return ok(result);
  } catch (error) {
    reportFailure("slack installation: start", error);
    return reply(502, { error: "slack_installation_unavailable" });
  }
}

export async function managedSlackRequest(ctx: ApiCtx): Promise<RouteResult> {
  if (!ctx.deps.managedSlack) return reply(404, { error: "not_configured" });
  await ctx.deps.managedSlack.handle(ctx.req, ctx.res, ctx.body);
}
