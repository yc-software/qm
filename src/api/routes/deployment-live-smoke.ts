import { sendJson } from "../http.ts";
import type { BackgroundOwnership } from "../../runs/background-ownership.ts";
import { requireDeploymentControl } from "./background-work.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

const running = new WeakSet<object>();
const REQUEST_EXPIRY = Date.UTC(9999, 0, 1);

async function deploymentLiveSmoke(ctx: ApiCtx): Promise<void> {
  if (!requireDeploymentControl(ctx)) return;
  const control = ctx.deps.backgroundOwnership!;
  const run = ctx.deps.deploymentLiveSmoke;
  const replay = ctx.deps.replayDedupe;
  if (!run || !replay?.durable) return sendJson(ctx.res, 503, { error: "deployment_smoke_unavailable" });
  const body = ctx.body;
  if (
    !isObj(body) ||
    !Object.keys(body).every((key) =>
      ["requestId", "expectedDeploymentId", "expectedGeneration", "expectedTaskArns"].includes(key),
    ) ||
    typeof body.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId) ||
    typeof body.expectedDeploymentId !== "string" ||
    body.expectedDeploymentId !== control.deploymentId ||
    !Number.isSafeInteger(body.expectedGeneration) ||
    (body.expectedGeneration as number) < 1 ||
    !Array.isArray(body.expectedTaskArns) ||
    !body.expectedTaskArns.length ||
    body.expectedTaskArns.length > 1000 ||
    !body.expectedTaskArns.every((arn) => typeof arn === "string" && arn.length > 0 && arn.length <= 2048) ||
    new Set(body.expectedTaskArns).size !== body.expectedTaskArns.length
  )
    return sendJson(ctx.res, 400, { error: "invalid_deployment_smoke_request" });
  if (running.has(control)) return sendJson(ctx.res, 409, { error: "deployment_smoke_running" });
  const expectedTasks = new Set(body.expectedTaskArns as string[]);
  const valid = (state: BackgroundOwnership): boolean => {
    const members = state.members.filter((member) => !member.retired && member.state === "admitted");
    return (
      state.enabled &&
      state.generation === body.expectedGeneration &&
      state.desiredDeploymentId === control.deploymentId &&
      members.some((member) => member.instanceId === control.instanceId) &&
      members.length === expectedTasks.size &&
      new Set(members.map((member) => member.taskArn)).size === expectedTasks.size &&
      members.every(
        (member) =>
          member.deploymentId === control.deploymentId &&
          member.generation === state.generation &&
          member.state === "admitted" &&
          member.ready &&
          member.taskArn !== null &&
          expectedTasks.has(member.taskArn),
      )
    );
  };
  running.add(control);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const state = await control.store.get();
    if (!valid(state)) return sendJson(ctx.res, 409, { error: "deployment_smoke_ownership_conflict" });
    if (!(await replay.claim(`deployment-live-smoke:${body.requestId.toLowerCase()}`, REQUEST_EXPIRY))) {
      return sendJson(ctx.res, 409, { error: "deployment_smoke_replay" });
    }
    const member = state.members.find((entry) => entry.instanceId === control.instanceId)!;
    const identity = {
      requestId: body.requestId,
      deploymentId: control.deploymentId,
      instanceId: control.instanceId,
      taskArn: member.taskArn,
      generation: state.generation,
    };
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
      await run();
      if (!valid(await control.store.get())) error = "deployment_smoke_ownership_changed";
    } catch {
      error = "deployment_smoke_failed";
    }
    if (!ctx.res.destroyed)
      ctx.res.end(`${JSON.stringify({ ok: !error, ...identity, ...(error ? { error } : {}) })}\n`);
  } finally {
    clearInterval(heartbeat);
    running.delete(control);
  }
}

export const deploymentLiveSmokeRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/deployment/live-session", auth: "source", handle: deploymentLiveSmoke },
];
