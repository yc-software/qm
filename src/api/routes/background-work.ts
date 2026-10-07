import { isStrongSigningSecret } from "../../auth/source-auth.ts";
import { timingSafeEqual } from "node:crypto";
import { BackgroundOwnershipConflict, type BackgroundOwnership } from "../../runs/background-ownership.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048;
}

function status(ctx: ApiCtx, state: BackgroundOwnership): void {
  const control = ctx.deps.backgroundOwnership!;
  sendJson(ctx.res, 200, {
    protocol: 2,
    deploymentId: control.deploymentId,
    instanceId: control.instanceId,
    ownerDeploymentId: state.ownerDeploymentId,
    setAt: state.setAt,
    setBy: state.setBy,
    active: control.active(),
  });
}

export function requireDeploymentControl(ctx: ApiCtx): boolean {
  const control = ctx.deps.backgroundOwnership;
  const secret = ctx.deps.deploymentControlSecret;
  if (!control || !ctx.secret || !ctx.auth || !isStrongSigningSecret(secret) || secret === ctx.secret) {
    sendJson(ctx.res, 503, { error: "background_control_unavailable" });
    return false;
  }
  const bearer = ctx.req.headers.authorization;
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(typeof bearer === "string" ? bearer : "");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

async function backgroundWork(ctx: ApiCtx): Promise<void> {
  if (!requireDeploymentControl(ctx)) return;
  const control = ctx.deps.backgroundOwnership!;
  if (ctx.method === "GET") return status(ctx, await control.store.get());
  const body = ctx.body;
  if (
    !isObj(body) ||
    !Object.keys(body).every((key) => ["ownerDeploymentId", "expectedOwnerDeploymentId"].includes(key)) ||
    !(body.ownerDeploymentId === null || identity(body.ownerDeploymentId)) ||
    !(
      body.expectedOwnerDeploymentId === undefined ||
      body.expectedOwnerDeploymentId === null ||
      identity(body.expectedOwnerDeploymentId)
    )
  ) {
    return sendJson(ctx.res, 400, { error: "invalid_background_request" });
  }
  try {
    return status(
      ctx,
      await control.store.set({
        ownerDeploymentId: body.ownerDeploymentId,
        setBy: control.deploymentId,
        ...(body.expectedOwnerDeploymentId !== undefined
          ? { expectedOwnerDeploymentId: body.expectedOwnerDeploymentId }
          : {}),
      }),
    );
  } catch (error) {
    if (error instanceof BackgroundOwnershipConflict) {
      return sendJson(ctx.res, 409, { error: "background_ownership_conflict", message: error.message });
    }
    throw error;
  }
}

export const backgroundWorkRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/background-work", auth: "source", handle: backgroundWork },
  { method: "POST", path: "/v1/background-work", auth: "source", handle: backgroundWork },
];
