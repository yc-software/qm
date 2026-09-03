import { UPDATE_JOB_STATES, type UpdateJobState } from "../../../updates/update-job-store.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";

const VERSION = /^\d+\.\d+\.\d+$/;
const transitions: Record<UpdateJobState, readonly UpdateJobState[]> = {
  dispatching: ["queued", "running", "succeeded", "failed"],
  queued: ["running", "succeeded", "failed"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

async function actor(ctx: ApiCtx) {
  return authorizeAdmin(ctx, orgScope(ctx.deps));
}

function newerVersion(current: string, target: string): boolean {
  const left = current.split(".").map(Number);
  const right = target.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return right[i]! > left[i]!;
  }
  return false;
}

export async function latestUpdate(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.updateJobs) return sendJson(ctx.res, 503, { error: "durable_store_required" });
  return sendJson(ctx.res, 200, { job: await ctx.deps.updateJobs.latest(orgScope(ctx.deps)) });
}

export async function createUpdate(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.updateJobs) return sendJson(ctx.res, 503, { error: "durable_store_required" });
  if (!isObj(ctx.body)) return sendJson(ctx.res, 400, { error: "bad_request" });
  const currentVersion = ctx.body.currentVersion;
  const targetVersion = ctx.body.targetVersion;
  if (
    typeof currentVersion !== "string" ||
    typeof targetVersion !== "string" ||
    !VERSION.test(currentVersion) ||
    !VERSION.test(targetVersion) ||
    !newerVersion(currentVersion, targetVersion)
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "valid current and target versions are required" });
  }
  const result = await ctx.deps.updateJobs.create({
    scopeId: orgScope(ctx.deps),
    requestedBy: authorized.id,
    currentVersion,
    targetVersion,
  });
  if (!result.created) return sendJson(ctx.res, 409, { error: "update_in_progress", job: result.job });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "qm.update.request",
    resource: result.job.id,
    scopeLabel: orgScope(ctx.deps),
    detail: `${currentVersion} -> ${targetVersion}`,
  });
  return sendJson(ctx.res, 202, { job: result.job });
}

export async function updateUpdate(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.updateJobs) return sendJson(ctx.res, 503, { error: "durable_store_required" });
  if (!isObj(ctx.body)) return sendJson(ctx.res, 400, { error: "bad_request" });
  const state = ctx.body.state;
  const detail = ctx.body.detail;
  const runUrl = ctx.body.runUrl;
  if (
    typeof state !== "string" ||
    !(UPDATE_JOB_STATES as readonly string[]).includes(state) ||
    (detail !== undefined && (typeof detail !== "string" || detail.length > 500)) ||
    (runUrl !== undefined &&
      (typeof runUrl !== "string" || runUrl.length > 500 || !runUrl.startsWith("https://github.com/")))
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  const current = await ctx.deps.updateJobs.get(orgScope(ctx.deps), ctx.params.id ?? "");
  if (!current) return sendJson(ctx.res, 404, { error: "not_found" });
  const next = state as UpdateJobState;
  if (next !== current.state && !transitions[current.state].includes(next)) {
    return sendJson(ctx.res, 409, { error: "invalid_transition", job: current });
  }
  const job = await ctx.deps.updateJobs.update(orgScope(ctx.deps), current.id, current.state, {
    state: next,
    ...(typeof detail === "string" ? { detail } : {}),
    ...(typeof runUrl === "string" ? { runUrl } : {}),
  });
  if (!job) {
    const latest = await ctx.deps.updateJobs.get(orgScope(ctx.deps), current.id);
    if (!latest) return sendJson(ctx.res, 404, { error: "not_found" });
    return sendJson(ctx.res, 409, { error: "invalid_transition", job: latest });
  }
  if (next !== current.state) {
    audit(ctx.deps, {
      principalId: authorized.id,
      action: "qm.update.state",
      resource: current.id,
      scopeLabel: orgScope(ctx.deps),
      status: next,
      ...(typeof detail === "string" ? { detail } : {}),
    });
  }
  return sendJson(ctx.res, 200, { job });
}
