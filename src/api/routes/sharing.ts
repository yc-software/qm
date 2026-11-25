import { externalAppSharingAllowed } from "../../feature-flags.ts";
import { DeployAccessError, type DeployAccessErrorCode } from "../../deploy/deploy-service.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { isObj, requirePersonAuthority } from "./shared.ts";
import { scopeId, scopeLabel } from "../../types.ts";
import type { CapabilityClaims } from "../../auth/capability-token.ts";
import { isArtifactType, type ArtifactType } from "../artifact-share.ts";
import { actionApproved, routeSignOff } from "../action-approval.ts";
import { tenantOf, type ApiCtx, type Route } from "./route.ts";

const DEPLOY_ACCESS_STATUS: Record<DeployAccessErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  external_sharing_disabled: 403,
  public_links_unavailable: 409,
  unknown_connector: 400,
};

export const SHARE_ERROR_STATUS: Record<string, number> = {
  ...DEPLOY_ACCESS_STATUS,
  bad_request: 400,
  recipient_not_found: 404,
  ambiguous_recipient: 409,
  share_failed: 400,
  approval_required: 202,
};

export function sendShareFailure(res: ApiCtx["res"], e: unknown): void {
  if (e instanceof DeployAccessError)
    return sendJson(res, DEPLOY_ACCESS_STATUS[e.code], { error: e.code, message: e.message });
  return sendJson(res, 400, { error: "share_failed", message: errMessage(e) });
}

function claimsOf(ctx: ApiCtx): CapabilityClaims | null {
  if (ctx.capability) return ctx.capability;
  const person = ctx.actor;
  return person
    ? {
        actorId: person.p,
        scopeId: scopeId("personal", person.p),
        exp: person.exp,
        internalAudience: true,
        personAuthority: true,
      }
    : null;
}

async function shareView(ctx: ApiCtx, type: ArtifactType, id: string, claims: CapabilityClaims) {
  const r = await ctx.deps.control.shareAccess(type, id, claims, tenantOf(ctx));
  if (!r.ok) return r;
  const labels = Object.fromEntries([r.owner, ...r.access.map((g) => g.scope)].map((s) => [s, scopeLabel(s)]));
  const view = { ok: true as const, owner: r.owner, offers: r.offers, grantees: r.access, labels };
  if (type !== "deploy") return view;
  const externalSharing = await externalAppSharingAllowed(ctx.deps.featureFlags, r.owner);
  return { ...view, public: (await ctx.app.getApp(r.id))?.public === true && externalSharing, externalSharing };
}

function sendView(ctx: ApiCtx, view: Awaited<ReturnType<typeof shareView>>, extra: object = {}): void {
  if (!view.ok)
    return sendJson(ctx.res, SHARE_ERROR_STATUS[view.code] ?? 400, { error: view.code, message: view.message });
  return sendJson(ctx.res, 200, { ...view, ...extra });
}

export async function readShares(ctx: ApiCtx): Promise<void> {
  const { res, params } = ctx;
  const claims = claimsOf(ctx);
  if (!claims) return sendJson(res, 403, { error: "forbidden" });
  if (!isArtifactType(params.type!)) return sendJson(res, 404, { error: "not_found" });
  return sendView(ctx, await shareView(ctx, params.type, params.id!, claims));
}

export async function changeShares(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body } = ctx;
  const claims = claimsOf(ctx);
  if (!claims)
    return sendJson(res, 403, {
      error: "forbidden",
      message: "sharing requires a signed-in person or an agent capability token",
    });
  if (!isArtifactType(params.type!)) return sendJson(res, 404, { error: "not_found" });
  const type = params.type;
  if (type === "deploy" && !requirePersonAuthority(ctx)) return;
  const b = (isObj(body) ? body : {}) as Record<string, unknown>;
  if (b.notify !== undefined && typeof b.notify !== "boolean")
    return sendJson(res, 400, { error: "bad_request", message: "notify must be a boolean" });
  if (b.public !== undefined) {
    if (type !== "deploy")
      return sendJson(res, 400, { error: "bad_request", message: "only an app has a public link" });
    if (typeof b.public !== "boolean")
      return sendJson(res, 400, { error: "bad_request", message: "public must be a boolean" });
    if (b.scope !== undefined || b.recipient !== undefined || b.email !== undefined || b.access !== undefined)
      return sendJson(res, 400, {
        error: "bad_request",
        message: "public access and person/scope access must be changed separately",
      });
    const { signOff, held } = routeSignOff(ctx);
    try {
      await app.setAppPublic(params.id!, b.public, { createdBy: claims.actorId, botActor: claims.botActor, signOff });
    } catch (e) {
      return sendShareFailure(res, e);
    }
    if (held()) return;
    return sendView(ctx, await shareView(ctx, type, params.id!, claims));
  }
  for (const field of ["scope", "recipient", "email"] as const)
    if (b[field] !== undefined && typeof b[field] !== "string")
      return sendJson(res, 400, { error: "bad_request", message: `${field} must be a string` });
  const access = typeof b.access === "string" ? b.access.toLowerCase() : "view";
  if (access !== "view" && access !== "manage" && access !== "none")
    return sendJson(res, 400, { error: "bad_request", message: 'access must be "view", "manage", or "none"' });
  const r = await ctx.deps.control.shareArtifact(
    {
      type,
      id: params.id!,
      ...(typeof b.scope === "string" ? { scope: b.scope } : {}),
      ...(typeof b.recipient === "string" ? { recipient: b.recipient } : {}),
      ...(typeof b.email === "string" ? { email: b.email } : {}),
      permission: ({ view: "read", manage: "write", none: "none" } as const)[access],
      ...(typeof b.notify === "boolean" ? { notify: b.notify } : {}),
    },
    claims,
    ({ summary }) => actionApproved(ctx, { summary }),
  );
  if (res.writableEnded) return;
  if (!r.ok)
    return sendJson(res, SHARE_ERROR_STATUS[r.code] ?? 400, {
      error: r.code,
      message: r.message,
      ...(r.candidates ? { candidates: r.candidates.map((c) => ({ principalId: c.id, displayName: c.label })) } : {}),
    });
  return sendView(ctx, await shareView(ctx, type, r.id, claims), {
    target: r.target,
    access,
    ...(r.invitation ? { invitation: r.invitation } : {}),
    ...(r.copy ? { copy: r.copy } : {}),
  });
}

export const sharingRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/shares/:type/:id", browser: true, actor: "person", auth: "either", handle: readShares },
  {
    method: "POST",
    path: "/v1/shares/:type/:id",
    browser: true,
    actor: "person",
    auth: "either",
    handle: changeShares,
  },
];
