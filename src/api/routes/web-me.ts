import { bootTenant, tenancyBooted } from "../../tenants/boot.ts";
import { analyticsHookConfig } from "../../../plugins/chassis/src/analytics-config.ts";
import { browserErrorConfig } from "../../../plugins/chassis/src/browser-error-config.ts";
import { parseSuggestedActivities, type SuggestedActivity } from "../../../plugins/chassis/src/suggested-activities.ts";
import { orgId } from "../../config.ts";
import { starterActivities } from "../../suggestions/company-seeds.ts";
import { resolveBranding } from "../../resolution/branding.ts";
import { swallowAs } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { tenantOf, type ApiCtx, type Route } from "./route.ts";
import { orgScope } from "./shared.ts";
import { modelAuthStatus } from "./user-model-auth.ts";
import { adminPermissions } from "./admin/scope-config.ts";
import { inboxPreviewEnabled } from "./loops.ts";
import { webNotificationsOn } from "../../notifications/web-push.ts";
import { personalScope } from "../../types.ts";

export interface WebMeConfig {
  analytics?: { module: string; options?: unknown };
  browserErrors?: ReturnType<typeof browserErrorConfig>;
  suggestedActivities: SuggestedActivity[];
}

export function webMeConfig(env: NodeJS.ProcessEnv): WebMeConfig {
  const { analytics } = analyticsHookConfig(env.WEB_UI_ANALYTICS);
  const browserErrors = browserErrorConfig(env);
  return {
    ...(analytics ? { analytics } : {}),
    ...(browserErrors ? { browserErrors } : {}),
    suggestedActivities: parseSuggestedActivities(env.WEB_UI_SUGGESTED_ACTIVITIES),
  };
}

async function permissionsOf(ctx: ApiCtx, user: string): Promise<string[]> {
  const [admin, preview, notifications] = await Promise.all([
    ctx.actor?.imp
      ? null
      : adminPermissions(ctx.deps, tenantOf(ctx), { id: user, type: "internal" }).catch(
          swallowAs("web: /me admin status", null),
        ),
    inboxPreviewEnabled(ctx.deps, user).catch(swallowAs("web: /me inbox preview flag", false)),
    webNotificationsOn(ctx.deps, user).catch(swallowAs("web: /me notifications flag", false)),
  ]);
  const permissions = [...(admin?.permissions ?? [])];
  if (preview) permissions.push("loops", "inbox");
  if (notifications) permissions.push("notifications");
  return permissions;
}

async function me(ctx: ApiCtx): Promise<void> {
  const { res, deps, app, actor } = ctx;
  const config = deps.web?.me;
  if (!actor || !config) return sendJson(res, 404, { error: "not_found" });
  const user = actor.p;
  const [permissions, slack, auth, branding, starters, teammate] = await Promise.all([
    permissionsOf(ctx, user),
    app.directoryMeta().catch(swallowAs("web: /me directory meta", { workspaceUrl: null, appIconUrl: null })),
    modelAuthStatus(deps, user),
    resolveBranding(deps.config, orgScope(deps), deps.brandingDefault),
    starterActivities({ ...deps, fallback: config.suggestedActivities }, orgScope(deps), user),
    deps.directory?.teammateName(tenantOf(ctx), user).catch(swallowAs("web: /me teammate", null)),
  ]);
  const generated = Boolean(deps.suggestedActivities);
  return sendJson(res, 200, {
    user,
    personalScope: personalScope(user),
    org: orgId(),
    companyName: branding.orgName?.trim() || null,
    workspace: tenancyBooted() && !bootTenant() ? branding.orgName?.trim() || null : null,
    ...(config.analytics && !actor.imp ? { analytics: config.analytics } : {}),
    ...(config.browserErrors && !actor.imp ? { browserErrors: config.browserErrors } : {}),
    mode: "portal",
    slackWorkspaceUrl: slack.workspaceUrl,
    slackAppIconUrl: slack.appIconUrl,
    chatSurfaces: app.chatSurfaces(),
    individualModelAuth: auth.individualModelAuth,
    modelAuthConnected: auth.connections.some(
      (c) => !auth.account || auth.account === "personal" || auth.account === c.provider,
    ),
    impersonatedBy: actor.imp ?? null,
    displayName: actor.n?.trim() || null,
    ...(teammate ? { teammate } : {}),
    ...(generated ? { suggestedActivitiesGeneration: true } : {}),
    ...(starters.welcome ? { welcome: starters.welcome } : {}),
    ...(starters.activities.length && !generated ? { suggestedActivities: starters.activities } : {}),
    permissions,
  });
}

export const webMeRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/web/me", browser: true, actor: "person", auth: "source", handle: me },
];
