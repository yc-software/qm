import { analyticsHookConfig } from "../../../plugins/chassis/src/analytics-config.ts";
import { browserErrorConfig } from "../../../plugins/chassis/src/browser-error-config.ts";
import { principalInAllowlist, principalListed } from "../../../plugins/chassis/src/principal-allowlist.ts";
import { parseSuggestedActivities, type SuggestedActivity } from "../../../plugins/chassis/src/suggested-activities.ts";
import { orgId } from "../../config.ts";
import { resolveBranding } from "../../resolution/branding.ts";
import { scopeId } from "../../types.ts";
import { swallowAs } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { orgScope } from "./shared.ts";
import { modelAuthStatus } from "./user-model-auth.ts";

export interface WebMeConfig {
  analytics?: { module: string; options?: unknown };
  browserErrors?: ReturnType<typeof browserErrorConfig>;
  welcomeCohort?: string;
  suggestedActivities: SuggestedActivity[];
  loopsUsers?: string;
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
    ...(env.LOOPS_USERS ? { loopsUsers: env.LOOPS_USERS } : {}),
  };
}

async function permissionsOf(ctx: ApiCtx, user: string, loopsUsers: string | undefined): Promise<string[]> {
  const { deps } = ctx;
  const isAdmin = await (deps.admin?.adminStatusOf({ id: user, type: "internal" }) ?? Promise.resolve(null))
    .then((status) => status?.isAdmin === true)
    .catch(swallowAs("web: /me admin status", false));
  const permissions = isAdmin ? ["admin"] : [];
  const preview = await (deps.featureFlags?.enabled("inbox_loops", scopeId("personal", user)) ?? Promise.resolve(false))
    .then((enabled) => enabled === true)
    .catch(swallowAs("web: /me inbox preview flag", false));
  if (preview && principalListed(user, loopsUsers)) permissions.push("loops");
  if (preview && principalInAllowlist(user, deps.portalSession?.inboxUsers)) permissions.push("inbox");
  return permissions;
}

async function me(ctx: ApiCtx): Promise<void> {
  const { res, deps, app, actor } = ctx;
  if (!actor) return sendJson(res, 401, { error: "unauthorized" });
  const user = actor.p;
  const config = deps.webMe ?? { suggestedActivities: [] };
  const [permissions, workspaceUrl, auth, branding] = await Promise.all([
    permissionsOf(ctx, user, config.loopsUsers),
    app
      .directoryMeta()
      .then((meta) => meta.workspaceUrl ?? null)
      .catch(swallowAs("web: /me directory meta", null)),
    modelAuthStatus(deps, user),
    resolveBranding(deps.config, orgScope(deps), deps.brandingDefault),
  ]);
  const generated = Boolean(deps.suggestedActivities);
  return sendJson(res, 200, {
    user,
    org: orgId(),
    companyName: branding.orgName?.trim() || null,
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
    ...(config.suggestedActivities.length && !generated ? { suggestedActivities: config.suggestedActivities } : {}),
    permissions,
  });
}

export const webMeRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/web/me", browser: true, actor: "person", auth: "source", handle: me },
];
