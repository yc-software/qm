import { z } from "zod";
import { resolveBranding } from "../../../resolution/branding.ts";
import { requestTeamsToken, TeamsTokenError } from "../../../surfaces/teams/client.ts";
import { teamsAppPackage } from "../../../surfaces/teams/manifest.ts";
import { tenantSettings } from "../../../tenants/settings.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import { tenantOf, type ApiCtx } from "../route.ts";

const ACTIVITIES_PATH = "/v1/surfaces/teams/activities";
const SIGN_IN_PATH = "/auth/callback";

const botSchema = z.object({
  tenantId: z.uuid("The directory (tenant) ID is a GUID like 0f2e7c64-5b1a-4d3e-9c8b-2a6f1e4d7b90."),
  appId: z.uuid("The bot ID is a GUID like 3d9b1f27-8e4c-4a6b-b5d2-7c1e9f0a4b63."),
  appSecret: z.string().trim().min(1).optional(),
});

function origin(ctx: ApiCtx): string | undefined {
  return ctx.deps.portalUrl ?? ctx.deps.publicUrl;
}

function status(ctx: ApiCtx) {
  const bot = tenantSettings().teams;
  const base = origin(ctx);
  return {
    configured: Boolean(bot),
    ...(bot ? { tenantId: bot.tenantId, appId: bot.appId } : {}),
    ...(base
      ? { endpoint: new URL(ACTIVITIES_PATH, base).href, signInRedirect: new URL(SIGN_IN_PATH, base).href }
      : {}),
  };
}

async function admin(ctx: ApiCtx, action: string) {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (actor) audit(ctx, { principalId: actor.id, action, resource: "teams", scopeLabel: scope });
  return actor;
}

export async function getTeams(ctx: ApiCtx): Promise<void> {
  if (!(await admin(ctx, "teams.read"))) return;
  return sendJson(ctx.res, 200, status(ctx));
}

export async function putTeams(ctx: ApiCtx): Promise<void> {
  if (!(await admin(ctx, "teams.update"))) return;
  if (!ctx.deps.directory?.setTeamsBot) return sendJson(ctx.res, 404, { error: "not_configured" });
  const parsed = botSchema.safeParse(ctx.body);
  if (!parsed.success)
    return sendJson(ctx.res, 400, { error: "invalid_teams_bot", message: parsed.error.issues[0]?.message });
  const current = tenantSettings().teams;
  const appSecret = parsed.data.appSecret ?? (current?.appId === parsed.data.appId ? current.appSecret : undefined);
  if (!appSecret)
    return sendJson(ctx.res, 400, { error: "invalid_teams_bot", message: "Paste the bot's client secret." });
  const bot = { tenantId: parsed.data.tenantId, appId: parsed.data.appId, appSecret };
  try {
    await requestTeamsToken(bot, ctx.deps.teamsTokenFetch);
  } catch (error) {
    if (!(error instanceof TeamsTokenError)) throw error;
    return sendJson(ctx.res, 400, {
      error: "invalid_teams_bot",
      message: `Microsoft refused these details: ${error.description}`,
    });
  }
  if ((await ctx.deps.directory.setTeamsBot(tenantOf(ctx), bot)) === "taken")
    return sendJson(ctx.res, 409, {
      error: "teams_tenant_taken",
      message: "Another workspace is already connected to this Microsoft organization.",
    });
  return sendJson(ctx.res, 200, status(ctx));
}

export async function deleteTeams(ctx: ApiCtx): Promise<void> {
  if (!(await admin(ctx, "teams.delete"))) return;
  if (!ctx.deps.directory?.setTeamsBot) return sendJson(ctx.res, 404, { error: "not_configured" });
  await ctx.deps.directory.setTeamsBot(tenantOf(ctx), null);
  return sendJson(ctx.res, 200, status(ctx));
}

export async function getTeamsAppPackage(ctx: ApiCtx): Promise<void> {
  if (!(await admin(ctx, "teams.app-package"))) return;
  const bot = tenantSettings().teams;
  const base = origin(ctx);
  if (!bot || !base) return sendJson(ctx.res, 404, { error: "not_configured" });
  const branding = await resolveBranding(ctx.deps.config, orgScope(ctx.deps), ctx.deps.brandingDefault);
  const name = branding.selfLabel ?? branding.orgName ?? "QM";
  const zip = teamsAppPackage(bot, { name, origin: base, version: `1.0.${Math.floor(Date.now() / 1000)}` });
  ctx.res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": 'attachment; filename="teams-app.zip"',
    "content-length": String(zip.byteLength),
    "cache-control": "no-store",
  });
  ctx.res.end(zip);
}
