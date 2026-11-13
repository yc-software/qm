import { externalAppSharingAllowed } from "../../feature-flags.ts";
import { canEditAppPermissions } from "../../deploy/app-access.ts";
import { DeployAccessError, type DeployAccessErrorCode } from "../../deploy/deploy-service.ts";
import { deploymentView, type App } from "../app.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { isObj, livePersonTurn } from "./shared.ts";
import { parseScopeId, type Permission } from "../../types.ts";
import type { ApiCtx, Route } from "./route.ts";
import { resolveShareTarget as resolveShareTargetGrammar } from "../artifact-share.ts";

async function setDeploymentConnectors(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body, capability, actor } = ctx;
  const principalId = capability ? capability.actorId : actor?.p;
  if (!principalId)
    return sendJson(res, 403, {
      error: "forbidden",
      message: "only the publisher, in a live conversation or signed in, can lend an app their connectors",
    });
  if (!(await livePersonTurn(ctx))) return;
  const connectors = (body as { connectors?: unknown }).connectors;
  if (!Array.isArray(connectors) || !connectors.every((host) => typeof host === "string"))
    return sendJson(res, 400, { error: "bad_request", message: "connectors (array of connected-app hosts) required" });
  try {
    const deployment = await app.setDeploymentConnectors(params.id!, connectors, { createdBy: principalId });
    return sendJson(res, 200, { deployment: deploymentView(deployment) });
  } catch (e) {
    return sendShareFailure(res, e);
  }
}

type ShareTarget =
  | { kind: "ok"; scope: string; label: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: Array<{ principalId: string; displayName: string }> }
  | { kind: "invalid"; message: string };

export function resolveShareTarget(
  app: App,
  input: { scope?: string; recipient?: string; email?: string },
): Promise<ShareTarget> {
  return resolveShareTargetGrammar(app, input, {
    allowEmail: true,
    invalidScope: (scope) => `invalid scope "${scope}" — use "org" or a scope id like personal:<id> or org:<id>`,
    targetRequired: 'a target is required: pass `scope` ("org" or a scope id) or `recipient` (a teammate\'s name)',
  });
}

export async function getDeploymentShares(ctx: ApiCtx): Promise<void> {
  const { res, app, params } = ctx;
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p;
  if (!principalId) return sendJson(res, 403, { error: "forbidden" });
  const deployment = await app.getDeployment(params.id!);
  if (!deployment) return sendJson(res, 404, { error: "not_found" });
  if (!canEditAppPermissions(deployment.ownerScopeId, principalId))
    return sendJson(res, 403, { error: "forbidden", message: "Only the owner can edit app permissions." });
  const externalSharing = await externalAppSharingAllowed(ctx.deps.featureFlags, deployment.ownerScopeId);
  return sendJson(res, 200, {
    public: deployment.public === true && externalSharing,
    externalSharing,
    grantees: await app.deploymentGrantees(deployment.id),
  });
}

export async function shareDeployment(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p;
  if (!principalId)
    return sendJson(res, 403, {
      error: "forbidden",
      message: "sharing requires a signed-in person or an agent capability token",
    });
  const actor = { createdBy: principalId, botActor: ctx.capability?.botActor };
  const b = (isObj(body) ? body : {}) as {
    scope?: unknown;
    recipient?: unknown;
    email?: unknown;
    access?: unknown;
    public?: unknown;
    notify?: unknown;
  };
  if (b.notify !== undefined && typeof b.notify !== "boolean")
    return sendJson(res, 400, { error: "bad_request", message: "notify must be a boolean" });
  const notify = { notify: b.notify };
  if (b.public !== undefined) {
    if (typeof b.public !== "boolean")
      return sendJson(res, 400, { error: "bad_request", message: "public must be a boolean" });
    if (b.scope !== undefined || b.recipient !== undefined || b.email !== undefined || b.access !== undefined)
      return sendJson(res, 400, {
        error: "bad_request",
        message: "public access and person/scope access must be changed separately",
      });
    try {
      const deployment = await app.setDeploymentPublic(params.id!, b.public, actor);
      return sendJson(res, 200, {
        ok: true,
        public: deployment.public === true,
        reach: deployment.public === true ? "anyone with the link" : "restricted",
        grantees: await app.deploymentGrantees(deployment.id),
      });
    } catch (e) {
      return sendShareFailure(res, e);
    }
  }
  if (b.email !== undefined && typeof b.email !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "email must be a string" });
  if (b.email !== undefined && (b.scope !== undefined || b.recipient !== undefined))
    return sendJson(res, 400, { error: "bad_request", message: "pass only one of email, scope, or recipient" });
  const access = typeof b.access === "string" ? b.access.toLowerCase() : "view";
  if (access !== "view" && access !== "manage" && access !== "none") {
    return sendJson(res, 400, { error: "bad_request", message: 'access must be "view", "manage", or "none"' });
  }
  let permission: Permission | null = "read";
  if (access === "none") permission = null;
  else if (access === "manage") permission = "write";
  const target = await resolveShareTarget(app, {
    ...(typeof b.scope === "string" ? { scope: b.scope } : {}),
    ...(typeof b.recipient === "string" ? { recipient: b.recipient } : {}),
    ...(typeof b.email === "string" ? { email: b.email } : {}),
  });
  if (target.kind === "invalid") return sendJson(res, 400, { error: "bad_request", message: target.message });
  if (target.kind === "none")
    return sendJson(res, 404, {
      error: "recipient_not_found",
      message: `no teammate matches "${String(b.recipient)}"`,
    });
  if (target.kind === "ambiguous")
    return sendJson(res, 409, {
      error: "ambiguous_recipient",
      message: "more than one teammate matches",
      candidates: target.candidates,
    });
  try {
    const invite =
      typeof b.email === "string" && permission === "read"
        ? await app.inviteToDeployment(params.id!, b.email, actor, notify)
        : undefined;
    const grantees =
      invite?.grantees ?? (await app.shareDeployment(params.id!, target.scope, permission, actor, notify));
    const orgGrant = grantees.find((g) => parseScopeId(g.scope).kind === "org");
    let reach = "owner-only";
    if (orgGrant) reach = `everyone in ${parseScopeId(orgGrant.scope).ref}`;
    else if (grantees.length) reach = `${grantees.length} grantee${grantees.length === 1 ? "" : "s"}`;
    const deployment = await app.getDeployment(params.id!);
    return sendJson(res, 200, {
      ok: true,
      target: { scope: target.scope, label: target.label },
      access,
      reach,
      ...(invite ? { invitation: invite.invitation } : {}),
      public:
        deployment?.public === true &&
        (await externalAppSharingAllowed(ctx.deps.featureFlags, deployment.ownerScopeId)),
      grantees,
    });
  } catch (e) {
    return sendShareFailure(res, e);
  }
}

const DEPLOY_ACCESS_STATUS: Record<DeployAccessErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  external_sharing_disabled: 403,
  public_links_unavailable: 409,
  unknown_connector: 400,
};

function sendShareFailure(res: ApiCtx["res"], e: unknown): void {
  if (e instanceof DeployAccessError)
    return sendJson(res, DEPLOY_ACCESS_STATUS[e.code], { error: e.code, message: e.message });
  return sendJson(res, 400, { error: "share_failed", message: errMessage(e) });
}

export const deploymentSharingRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "GET",
    path: "/v1/deployments/:id/share",
    browser: true,
    actor: "person",
    auth: "either",
    handle: getDeploymentShares,
  },
  {
    method: "POST",
    path: "/v1/deployments/:id/share",
    browser: true,
    actor: "person",
    auth: "either",
    handle: shareDeployment,
  },
  { method: "POST", path: "/v1/deployments/:id/connectors", auth: "either", handle: setDeploymentConnectors },
];
