import { isStrongSigningSecret } from "../../auth/source-auth.ts";
import { timingSafeEqual } from "node:crypto";
import { BackgroundOwnershipConflict, type BackgroundOwnership } from "../../runs/background-ownership.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048;
}

function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function status(ctx: ApiCtx, state: BackgroundOwnership): void {
  const control = ctx.deps.backgroundOwnership!;
  sendJson(ctx.res, 200, {
    protocol: 1,
    deploymentId: control.deploymentId,
    instanceId: control.instanceId,
    enabled: state.enabled,
    generation: state.generation,
    desiredDeploymentId: state.desiredDeploymentId,
    lastRequestId: state.lastRequestId,
    members: state.members,
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
    !generation(body.expectedGeneration) ||
    typeof body.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId)
  ) {
    return sendJson(ctx.res, 400, { error: "invalid_background_request" });
  }
  try {
    if (body.terminatedMembers !== undefined) {
      if (
        !keys(body, ["expectedGeneration", "requestId", "terminatedMembers"]) ||
        !Array.isArray(body.terminatedMembers) ||
        body.terminatedMembers.length < 1 ||
        body.terminatedMembers.length > 1000 ||
        !body.terminatedMembers.every(
          (member) =>
            isObj(member) &&
            keys(member, ["instanceId", "taskArn", "generation"]) &&
            identity(member.instanceId) &&
            identity(member.taskArn) &&
            generation(member.generation),
        )
      ) {
        return sendJson(ctx.res, 400, { error: "invalid_background_retirement" });
      }
      const terminatedMembers = body.terminatedMembers.map((member) => ({
        instanceId: member.instanceId as string,
        taskArn: member.taskArn as string,
        generation: member.generation as number,
      }));
      return status(
        ctx,
        await control.store.retire({
          expectedGeneration: body.expectedGeneration,
          requestId: body.requestId,
          terminatedMembers,
        }),
      );
    }
    if (
      !keys(body, ["expectedGeneration", "requestId", "desiredDeploymentId", "bootstrapTaskArns"]) ||
      !(body.desiredDeploymentId === null || identity(body.desiredDeploymentId)) ||
      (body.bootstrapTaskArns !== undefined &&
        (!Array.isArray(body.bootstrapTaskArns) ||
          body.bootstrapTaskArns.length < 1 ||
          body.bootstrapTaskArns.length > 1000 ||
          !body.bootstrapTaskArns.every(identity)))
    ) {
      return sendJson(ctx.res, 400, { error: "invalid_background_transition" });
    }
    return status(
      ctx,
      await control.store.transition({
        expectedGeneration: body.expectedGeneration,
        requestId: body.requestId,
        desiredDeploymentId: body.desiredDeploymentId,
        ...(body.bootstrapTaskArns ? { bootstrapTaskArns: body.bootstrapTaskArns as string[] } : {}),
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
