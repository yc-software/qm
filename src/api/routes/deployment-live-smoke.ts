import { timingSafeEqual } from "node:crypto";
import { isBearerSecret, isStrongSigningSecret } from "../../auth/source-auth.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { uuidSchema } from "../../util/ids.ts";
import type { ApiCtx, Route } from "./route.ts";

const running = new WeakSet<object>();
const REQUEST_EXPIRY = Date.UTC(9999, 0, 1);

function requireDeploymentControl(ctx: ApiCtx): boolean {
  const secret = ctx.deps.deploymentControlSecret;
  if (
    !ctx.deps.deploymentLiveSmoke ||
    !ctx.secret ||
    !ctx.auth ||
    !isStrongSigningSecret(secret) ||
    !isBearerSecret(secret) ||
    secret === ctx.secret
  ) {
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

async function deploymentLiveSmoke(ctx: ApiCtx): Promise<void> {
  if (!requireDeploymentControl(ctx)) return;
  const smoke = ctx.deps.deploymentLiveSmoke!;
  const replay = ctx.deps.replayDedupe;
  if (!replay) return sendJson(ctx.res, 503, { error: "deployment_smoke_unavailable" });
  const body = ctx.body;
  if (
    !isObj(body) ||
    !Object.keys(body).every((key) => ["requestId", "expectedDeploymentId"].includes(key)) ||
    typeof body.requestId !== "string" ||
    !uuidSchema.safeParse(body.requestId).success ||
    body.expectedDeploymentId !== smoke.deploymentId
  )
    return sendJson(ctx.res, 400, { error: "invalid_deployment_smoke_request" });
  if (running.has(smoke)) return sendJson(ctx.res, 409, { error: "deployment_smoke_running" });
  running.add(smoke);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    if (smoke.superseded()) return sendJson(ctx.res, 409, { error: "deployment_smoke_superseded" });
    if (!(await replay.claim(`deployment-live-smoke:${body.requestId.toLowerCase()}`, REQUEST_EXPIRY))) {
      return sendJson(ctx.res, 409, { error: "deployment_smoke_replay" });
    }
    const identity = { requestId: body.requestId, deploymentId: smoke.deploymentId };
    ctx.res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    });
    ctx.res.write("\n");
    heartbeat = setInterval(() => {
      if (!ctx.res.destroyed) ctx.res.write("\n");
    }, 5000);
    heartbeat.unref();
    ctx.res.once("close", () => clearInterval(heartbeat));
    let error: string | undefined;
    try {
      await smoke.run();
      if (smoke.superseded()) error = "deployment_smoke_superseded";
    } catch {
      error = "deployment_smoke_failed";
    }
    if (!ctx.res.destroyed)
      ctx.res.end(`${JSON.stringify({ ok: !error, ...identity, ...(error ? { error } : {}) })}\n`);
  } finally {
    clearInterval(heartbeat);
    running.delete(smoke);
  }
}

export const deploymentLiveSmokeRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/deployment/live-session", actor: "system", auth: "source", handle: deploymentLiveSmoke },
];
