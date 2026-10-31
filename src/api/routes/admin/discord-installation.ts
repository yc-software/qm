import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import {
  discordLinkRedirectUri,
  DiscordInstallationError,
  parseDiscordSettings,
  validateDiscordToken,
} from "../../../surfaces/discord-installation.ts";

async function withSource(ctx: ApiCtx) {
  const store = ctx.deps.discordInstallation!;
  return { ...(await store.status()), redirectUri: discordLinkRedirectUri(ctx.deps.portalUrl ?? "") };
}

export async function getDiscordInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.discordInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  audit(ctx.deps, {
    principalId: actor.id,
    action: "discord-installation.read",
    resource: "discord-installation",
    scopeLabel: scope,
  });
  return sendJson(ctx.res, 200, await withSource(ctx));
}

export async function putDiscordInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.discordInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  try {
    const { botToken, oauthClientSecret, ...settings } = parseDiscordSettings(ctx.body);
    const bot = botToken
      ? { token: botToken, ...(await validateDiscordToken(botToken, ctx.deps.discordInstallationFetch)) }
      : undefined;
    await ctx.deps.discordInstallation.set({
      ...settings,
      ...(bot ? { bot } : {}),
      ...(oauthClientSecret ? { oauthClientSecret } : {}),
      updatedBy: actor.id,
    });
    audit(ctx.deps, {
      principalId: actor.id,
      action: "discord-installation.update",
      resource: "discord-installation",
      scopeLabel: scope,
    });
    return sendJson(ctx.res, 200, await withSource(ctx));
  } catch (err) {
    if (err instanceof DiscordInstallationError) {
      return sendJson(ctx.res, err.status, { error: "invalid_discord_installation", message: err.message });
    }
    throw err;
  }
}

export async function deleteDiscordInstallation(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.discordInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  await ctx.deps.discordInstallation.delete();
  audit(ctx.deps, {
    principalId: actor.id,
    action: "discord-installation.delete",
    resource: "discord-installation",
    scopeLabel: scope,
  });
  return sendJson(ctx.res, 200, await withSource(ctx));
}
