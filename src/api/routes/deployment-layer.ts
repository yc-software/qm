import { errMessage } from "../../util/errors.ts";
import {
  DeploymentLayerPersistedError,
  DeploymentLayerValidationError,
  type DeploymentLayerBundle,
} from "../../deployment/deployment-layer-store.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

function bundleFrom(body: unknown): DeploymentLayerBundle | null {
  if (!isObj(body) || body.contract !== 1 || !Array.isArray(body.tools) || !Array.isArray(body.skills)) return null;
  return body as unknown as DeploymentLayerBundle;
}

async function getDeploymentLayer(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.deploymentLayer;
  if (!store) return sendJson(ctx.res, 404, { error: "not_found" });
  const record = await store.get();
  if (!record) {
    const live = store.live();
    return sendJson(ctx.res, 200, {
      contract: 1,
      version: 0,
      contentHash: null,
      source: live.source,
      resolved: live.resolved,
    });
  }
  const live = store.live();
  return sendJson(ctx.res, 200, {
    contract: 1,
    version: record.version,
    contentHash: record.contentHash,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    status: (await store.isApplied(record.contentHash)) ? "applied" : "degraded",
    runtimeContentHash: live.contentHash,
    source: live.source,
    bundle: record.bundle,
    resolved: live.resolved,
  });
}

async function putDeploymentLayer(ctx: ApiCtx): Promise<void> {
  const store = ctx.deps.deploymentLayer;
  if (!store) return sendJson(ctx.res, 404, { error: "not_found" });
  const bundle = bundleFrom(ctx.body);
  if (!bundle) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "contract: 1, tools[], and skills[] required" });
  }
  const updatedBy = "source-authenticated deployment CLI";
  try {
    const record = await store.put(bundle, updatedBy);
    return sendJson(ctx.res, 200, {
      ok: true,
      version: record.version,
      contentHash: record.contentHash,
      durable: store.durable,
      resolved: record.resolved,
    });
  } catch (error) {
    if (error instanceof DeploymentLayerPersistedError) {
      const record = error.record;
      return sendJson(ctx.res, 202, {
        ok: true,
        status: "degraded",
        message: errMessage(error),
        version: record.version,
        contentHash: record.contentHash,
        durable: store.durable,
        resolved: record.resolved,
      });
    }
    if (error instanceof DeploymentLayerValidationError) {
      return sendJson(ctx.res, 400, { error: "invalid_deployment_layer", message: errMessage(error) });
    }
    throw error;
  }
}

export const deploymentLayerRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/deployment-layer", auth: "source", handle: getDeploymentLayer },
  { method: "PUT", path: "/v1/deployment-layer", auth: "source", handle: putDeploymentLayer },
];
