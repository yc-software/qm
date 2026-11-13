import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bootTenant, tenancyBooted } from "../../tenants/boot.ts";
import { externalOrgId } from "../../tenants/external-org.ts";
import { analyticsHookConfig } from "../../../plugins/chassis/src/analytics-config.ts";
import { browserErrorConfig } from "../../../plugins/chassis/src/browser-error-config.ts";
import {
  parseActivitySeeds,
  parseSuggestedActivities,
  type ActivitySeeds,
  type SuggestedActivity,
} from "../../../plugins/chassis/src/suggested-activities.ts";
import { isDnsLabel } from "../../../plugins/chassis/src/dns-label.ts";
import { orgId } from "../../config.ts";
import { resolveBranding } from "../../resolution/branding.ts";
import { swallowAs } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { tenantOf, type ApiCtx, type Route } from "./route.ts";
import { orgScope } from "./shared.ts";
import { modelAuthStatus } from "./user-model-auth.ts";
import { adminPermissions } from "./admin/scope-config.ts";
import { inboxPreviewEnabled } from "./loops.ts";

export interface WebMeConfig {
  analytics?: { module: string; options?: unknown };
  browserErrors?: ReturnType<typeof browserErrorConfig>;
  welcomeCohort?: string;
  suggestedActivities: SuggestedActivity[];
  activitySeedsDir?: string;
}

export function webMeConfig(env: NodeJS.ProcessEnv): WebMeConfig {
  const welcomeCohort = env.WEB_UI_WELCOME_COHORT?.trim().slice(0, 40) || undefined;
  const { analytics } = analyticsHookConfig(env.WEB_UI_ANALYTICS);
  const browserErrors = browserErrorConfig(env);
  return {
    ...(analytics ? { analytics } : {}),
    ...(browserErrors ? { browserErrors } : {}),
    ...(welcomeCohort ? { welcomeCohort } : {}),
    suggestedActivities: parseSuggestedActivities(env.WEB_UI_SUGGESTED_ACTIVITIES),
    ...(env.DEPLOYMENT_LAYER ? { activitySeedsDir: resolve(env.DEPLOYMENT_LAYER, "activity-seeds") } : {}),
  };
}

export async function companyActivitySeeds(config: WebMeConfig): Promise<ActivitySeeds | undefined> {
  if (!config.activitySeedsDir) return undefined;
  const company = externalOrgId();
  if (!isDnsLabel(company)) return undefined;
  const text = await readFile(join(config.activitySeedsDir, `${company}.json`), "utf8").catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    },
  );
  return text === undefined ? undefined : parseActivitySeeds(text);
}

async function permissionsOf(ctx: ApiCtx, user: string): Promise<string[]> {
  const [admin, preview] = await Promise.all([
    ctx.actor?.imp
      ? null
      : adminPermissions(ctx.deps, tenantOf(ctx), { id: user, type: "internal" }).catch(
          swallowAs("web: /me admin status", null),
        ),
    inboxPreviewEnabled(ctx.deps, user).catch(swallowAs("web: /me inbox preview flag", false)),
  ]);
  const permissions = [...(admin?.permissions ?? [])];
  if (preview) permissions.push("loops", "inbox");
  return permissions;
}

async function me(ctx: ApiCtx): Promise<void> {
  const { res, deps, app, actor } = ctx;
  const config = deps.web?.me;
  if (!actor || !config) return sendJson(res, 404, { error: "not_found" });
  const user = actor.p;
  const [permissions, workspaceUrl, auth, branding, seeds] = await Promise.all([
    permissionsOf(ctx, user),
    app
      .directoryMeta()
      .then((meta) => meta.workspaceUrl ?? null)
      .catch(swallowAs("web: /me directory meta", null)),
    modelAuthStatus(deps, user),
    resolveBranding(deps.config, orgScope(deps), deps.brandingDefault),
    companyActivitySeeds(config).catch(swallowAs("web: /me activity seeds", undefined)),
  ]);
  const generated = Boolean(deps.suggestedActivities);
  const fallback = seeds?.activities ?? config.suggestedActivities;
  return sendJson(res, 200, {
    user,
    org: orgId(),
    companyName: branding.orgName?.trim() || null,
    workspace: tenancyBooted() && !bootTenant() ? branding.orgName?.trim() || null : null,
    ...(config.analytics && !actor.imp ? { analytics: config.analytics } : {}),
    ...(config.browserErrors && !actor.imp ? { browserErrors: config.browserErrors } : {}),
    mode: "portal",
    slackWorkspaceUrl: workspaceUrl,
    individualModelAuth: auth.individualModelAuth,
    modelAuthConnected: auth.connections.some(
      (c) => !auth.account || auth.account === "personal" || auth.account === c.provider,
    ),
    impersonatedBy: actor.imp ?? null,
    displayName: actor.n?.trim() || null,
    ...(config.welcomeCohort ? { welcomeCohort: config.welcomeCohort } : {}),
    ...(generated ? { suggestedActivitiesGeneration: true } : {}),
    ...(seeds ? { welcome: seeds } : {}),
    ...(fallback.length && !generated ? { suggestedActivities: fallback } : {}),
    permissions,
  });
}

export const webMeRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/web/me", browser: true, actor: "person", auth: "source", handle: me },
];
