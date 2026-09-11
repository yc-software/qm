import { DEPLOY_RELEASE_AUD, verifyDeployReleaseCapability } from "../../auth/capability-token.ts";
import { CAPABILITY_HEADER } from "../contract.ts";
import { headerValue, pipeToResponse, sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

async function getDeployRelease(ctx: BaseCtx): Promise<void> {
  const { req, res, deps, params, secret } = ctx;
  if (!deps.deployReleaseTransfer) {
    req.resume();
    return sendJson(res, 501, { error: "not_configured", message: "no deploy release store wired" });
  }
  const id = params.id!;
  const capSecret = deps.capabilitySecret ?? secret;
  const capToken = headerValue(req, CAPABILITY_HEADER);
  if (!capSecret || !capToken || !(await verifyDeployReleaseCapability(capToken, capSecret, id))) {
    req.resume();
    return sendJson(res, 403, { error: "forbidden", message: "deploy release capability is not valid" });
  }
  const release = await deps.deployReleaseTransfer.open(id);
  if (!release) return sendJson(res, 404, { error: "not_found" });
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(release.sizeBytes) });
  pipeToResponse(res, release.stream, "deploy release read failed");
}

export const deployReleaseRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "GET", path: "/v1/deploy-releases/:id", auth: { aud: DEPLOY_RELEASE_AUD }, handle: getDeployRelease },
];
