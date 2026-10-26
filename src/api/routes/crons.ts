import { isCronRuntime } from "../../cron/runtime.ts";
import type { Cron } from "../../types.ts";
import type { CreateCronInput, CronPatch } from "../../cron/cron-store.ts";
import { describeRunNowRefusal } from "../../cron/scheduler.ts";
import { userScheduleFromBody } from "../../cron/schedule.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { notifyOwnerOfCronEdit } from "../../triggers/edit-notice.ts";
import { canAdministerCron } from "../control-service.ts";
import { CRON_PATCH_NOTHING_TO_CHANGE } from "../control-service.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";

function isCreateCron(b: unknown): b is CreateCronInput {
  return (
    isObj(b) &&
    isCronRuntime(b.runtime) &&
    userScheduleFromBody(b.schedule) !== null &&
    (typeof b.action === "string" || typeof (b as { message?: unknown }).message === "string") &&
    (b as { unattendedGrants?: unknown }).unattendedGrants === undefined &&
    typeof b.ownerScopeId === "string" &&
    typeof b.owner === "string" &&
    typeof b.createdBy === "string" &&
    ((b as { title?: unknown }).title === undefined || typeof (b as { title?: unknown }).title === "string") &&
    (b.destination === undefined || isObj(b.destination))
  );
}

function withoutFireLog<T extends Cron>(cron: T): Omit<T, "fireLog"> {
  const { fireLog: _fireLog, ...rest } = cron;
  return rest;
}

async function gateSourceCron(ctx: ApiCtx, id: string): Promise<Cron | null> {
  const { res, app, url } = ctx;
  const cron = await app.getCron(id);
  if (!cron) {
    sendJson(res, 404, { error: "not_found" });
    return null;
  }
  const principalId = url.searchParams.get("principalId");
  if (!principalId) return cron;
  if (await canAdministerCron(app, cron, principalId)) return cron;
  sendJson(res, 404, { error: "not_found" });
  return null;
}

async function gateSourceCronRead(ctx: ApiCtx, id: string): Promise<Cron | null> {
  const { res, app, url } = ctx;
  const cron = await app.getCron(id);
  if (!cron) {
    sendJson(res, 404, { error: "not_found" });
    return null;
  }
  const principalId = url.searchParams.get("principalId");
  if (!principalId || (await canAdministerCron(app, cron, principalId))) return cron;
  const { visible } = await app.listCronsForViewer(principalId);
  if (visible.some((candidate) => candidate.id === id)) return cron;
  sendJson(res, 404, { error: "not_found" });
  return null;
}

function isCronPatch(b: unknown): b is {
  runtime?: Cron["runtime"];
  title?: string;
  task?: string;
  action?: string;
  schedule?: unknown;
  enabled?: boolean;
  archived?: boolean;
  unfurlLinks?: boolean;
  unattendedGrants?: string[];
  session?: boolean;
} {
  if (!isObj(b) || !isCronRuntime(b.runtime)) return false;
  if (!hasCronPatchFields(b)) return true;
  const hasTitle = b.title !== undefined;
  const hasAction = b.action !== undefined;
  const hasTask = b.task !== undefined;
  const hasSchedule = b.schedule !== undefined;
  const hasEnabled = b.enabled !== undefined;
  const hasArchived = b.archived !== undefined;
  const hasUnfurlLinks = b.unfurlLinks !== undefined;
  const hasUnattendedGrants = b.unattendedGrants !== undefined;
  if (hasTitle && typeof b.title !== "string") return false;
  if (hasAction && typeof b.action !== "string") return false;
  if (hasTask && typeof b.task !== "string") return false;
  if (hasEnabled && typeof b.enabled !== "boolean") return false;
  if (hasArchived && typeof b.archived !== "boolean") return false;
  if (hasUnfurlLinks && typeof b.unfurlLinks !== "boolean") return false;
  if (
    hasUnattendedGrants &&
    (!Array.isArray(b.unattendedGrants) || !b.unattendedGrants.every((grant) => typeof grant === "string"))
  )
    return false;
  if (hasSchedule && userScheduleFromBody(b.schedule) === null) return false;
  if (b.session !== undefined && typeof b.session !== "boolean") return false;
  return true;
}

function hasCronPatchFields(b: Record<string, unknown>): boolean {
  return (
    b.runtime !== undefined ||
    b.title !== undefined ||
    b.action !== undefined ||
    b.task !== undefined ||
    b.schedule !== undefined ||
    b.enabled !== undefined ||
    b.archived !== undefined ||
    b.unfurlLinks !== undefined ||
    b.unattendedGrants !== undefined ||
    b.session !== undefined
  );
}

const CRON_ERROR_STATUS: Record<string, number> = {
  bad_request: 400,
  already_running: 409,
};

async function createCron(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  if (!isCreateCron(body)) return sendJson(res, 400, { error: "bad_request", message: "expected a CreateCronInput" });
  try {
    const cron = await app.createCron(body);
    return sendJson(res, 200, { cron: withoutFireLog(cron) });
  } catch (e) {
    return sendJson(res, 400, { error: "cron_create_failed", message: errMessage(e) });
  }
}

async function listCrons(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const viewer = url.searchParams.get("viewer");
  if (!viewer) return sendJson(res, 200, { crons: (await app.listCrons()).map(withoutFireLog) });
  const { owned, visible } = await app.listCronsForViewer(viewer);
  const decorate = async (cron: Cron) => ({
    ...withoutFireLog(cron),
    permission: (await canAdministerCron(app, cron, viewer)) ? "manage" : "read",
  });
  return sendJson(res, 200, {
    crons: await Promise.all(owned.map(decorate)),
    visible: await Promise.all(visible.map(decorate)),
  });
}

async function disableCron(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  const id = ctx.params.id!;
  if (!(await gateSourceCron(ctx, id))) return;
  await app.setCronEnabled(id, false);
  return sendJson(res, 200, { ok: true });
}

async function runCronNow(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const id = ctx.params.id!;
  const cron = await gateSourceCron(ctx, id);
  if (!cron) return;
  if (!deps.scheduler) return sendJson(res, 404, { error: "not_found", message: "scheduler not wired" });
  if (cron.archived || !cron.enabled)
    return sendJson(res, 400, {
      error: "bad_request",
      message: `cron ${id} is ${cron.archived ? "archived" : "paused"} — enable it before firing it on demand`,
    });
  const result = await deps.scheduler.runNow(id);
  if (!result.started) {
    const refusal = describeRunNowRefusal(id, result)!;
    return sendJson(res, CRON_ERROR_STATUS[refusal.error] ?? 400, refusal);
  }
  return sendJson(res, 200, { ok: true, fireKey: result.fireKey });
}

async function cronRuns(ctx: ApiCtx): Promise<void> {
  const { res, url, app } = ctx;
  const id = ctx.params.id!;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  const cron = await gateSourceCron(ctx, id);
  if (!cron) return;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return sendJson(res, 400, { error: "bad_request", message: "limit must be a positive integer" });
  }
  const { runs, total } = await app.listCronFires(id, limit !== undefined ? { limit } : {});
  return sendJson(res, 200, { cron: withoutFireLog(cron), runs, total });
}

const CRON_PATCH_BAD_REQUEST =
  "expected a cron patch: title (string), task (string), schedule, enabled (boolean), archived (boolean), unfurlLinks (boolean), unattendedGrants (string[]), and/or session (boolean)";

async function cronById(ctx: ApiCtx): Promise<void> {
  const { res, app, url, pathname, method, body } = ctx;
  const id = decodeURIComponent(pathname.slice("/v1/crons/".length));
  if (method === "GET") {
    const cron = await gateSourceCronRead(ctx, id);
    if (!cron) return;
    return sendJson(res, 200, { cron: withoutFireLog(cron) });
  }
  const cron = await gateSourceCron(ctx, id);
  if (!cron) return;
  if (method === "DELETE") {
    await app.deleteCron(id);
    const editor = url.searchParams.get("principalId");
    if (editor) await notifyOwnerOfCronEdit(app, { cron, editorId: editor, changeSummary: ["deleted"] });
    return sendJson(res, 200, { ok: true });
  }
  if ((cron.unattendedGrants?.length ?? 0) > 0) {
    return sendJson(res, 403, {
      error: "forbidden",
      message: "a privileged cron may only be patched by its owner from a live turn",
    });
  }
  if (!isCronPatch(body)) return sendJson(res, 400, { error: "bad_request", message: CRON_PATCH_BAD_REQUEST });
  if (!hasCronPatchFields(body)) {
    return sendJson(res, 400, { error: "bad_request", message: CRON_PATCH_NOTHING_TO_CHANGE });
  }
  const schedule = body.schedule !== undefined ? userScheduleFromBody(body.schedule)! : undefined;
  const task = body.action ?? body.task;
  if (body.unfurlLinks !== undefined && !cron.destination) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "unfurlLinks can only be set on a cron with a delivery destination",
    });
  }
  const patch: CronPatch = {
    ...(body.runtime !== undefined ? { runtime: body.runtime } : {}),
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(task !== undefined ? { action: task } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.archived !== undefined ? { archived: body.archived } : {}),
    ...(body.unfurlLinks !== undefined && cron.destination
      ? { destination: { ...cron.destination, unfurlLinks: body.unfurlLinks } }
      : {}),
  };
  try {
    const updated = await app.updateCron(id, patch);
    const editor = url.searchParams.get("principalId");
    if (updated && editor)
      await notifyOwnerOfCronEdit(app, {
        cron: updated,
        editorId: editor,
        changeSummary: [
          ...(body.runtime !== undefined ? ["runtime"] : []),
          ...(body.title !== undefined ? ["title"] : []),
          ...(task !== undefined ? ["task"] : []),
          ...(schedule !== undefined ? ["schedule"] : []),
          ...(body.enabled !== undefined ? [`enabled=${body.enabled}`] : []),
          ...(body.archived !== undefined ? [`archived=${body.archived}`] : []),
        ],
        ...(schedule !== undefined ? { detail: { schedule } } : {}),
      });
    return sendJson(res, 200, { cron: updated ? withoutFireLog(updated) : null });
  } catch (e) {
    return sendJson(res, 400, { error: "cron_update_failed", message: errMessage(e) });
  }
}

export const cronRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/crons", actor: "body.createdBy", auth: "source", handle: createCron },
  { method: "GET", path: "/v1/crons", actor: "query.viewer", auth: "source", handle: listCrons },
  ...withActor("query.principalId", [
    { method: "POST", path: "/v1/crons/:id/disable", auth: "source", handle: disableCron },
    { method: "POST", path: "/v1/crons/:id/run", auth: "source", handle: runCronNow },
    { method: "GET", path: "/v1/crons/:id/runs", auth: "source", handle: cronRuns },
    {
      match: (m, p) =>
        p.startsWith("/v1/crons/") &&
        !p.slice("/v1/crons/".length).includes("/") &&
        (m === "GET" || m === "PATCH" || m === "DELETE"),
      auth: "source",
      handle: cronById,
    },
  ]),
];
