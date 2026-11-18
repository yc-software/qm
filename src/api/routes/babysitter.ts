import { BABYSITTER_MODES, DEFAULT_BABYSITTER, parseBabysitterSettings } from "../../agent/babysitter.ts";
import { personalScope } from "../../types.ts";
import { sendJson } from "../http.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";
import { audit } from "./shared.ts";

async function babysitterFor(ctx: ApiCtx) {
  const principal = ctx.actor?.p;
  if (!principal || !ctx.deps.config) return undefined;
  const scope = personalScope(principal);
  if ((await ctx.deps.featureFlags?.enabled("babysitter", scope)) !== true) return { principal, scope, enabled: false };
  return { principal, scope, enabled: true };
}

async function getBabysitter(ctx: ApiCtx): Promise<void> {
  const who = await babysitterFor(ctx);
  if (!who) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!who.enabled) return sendJson(ctx.res, 200, { enabled: false });
  const settings = ctx.deps.config!.getBabysitter(who.scope) ?? DEFAULT_BABYSITTER;
  return sendJson(ctx.res, 200, {
    enabled: true,
    ...settings,
    modes: BABYSITTER_MODES,
    defaultRules: DEFAULT_BABYSITTER.rules,
  });
}

async function putBabysitter(ctx: ApiCtx): Promise<void> {
  const who = await babysitterFor(ctx);
  if (!who) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (!who.enabled) return sendJson(ctx.res, 404, { error: "not_found" });
  const parsed = parseBabysitterSettings(ctx.body);
  if ("error" in parsed) return sendJson(ctx.res, 400, { error: "bad_request", message: parsed.error });
  await ctx.deps.config!.setBabysitter(who.scope, parsed);
  audit(ctx, { principalId: who.principal, action: "babysitter.update", resource: parsed.mode, scopeLabel: who.scope });
  return sendJson(ctx.res, 200, { ok: true, ...parsed });
}

export const babysitterRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "GET",
    path: "/v1/babysitter",
    browser: true,
    actor: "query.principalId",
    auth: "source",
    handle: getBabysitter,
  },
  ...withActor("body.principalId", [
    { method: "POST", path: "/v1/babysitter", browser: "self", auth: "source", handle: putBabysitter },
  ]),
];
