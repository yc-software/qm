import type { Cron, CronSchedule } from "../../types.ts";
import type { CreateCronInput, CronPatch } from "../../cron/cron-store.ts";
import { DEFAULT_CRON_TIMEZONE } from "../../cron/schedule.ts";
import type { CapabilityClaims } from "../../auth/capability-token.ts";
import { errMessage, swallow } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { decideRecipientConsent } from "../../triggers/trigger-store.ts";
import { canAdministerCron } from "../control-service.ts";
import { CRON_PATCH_NOTHING_TO_CHANGE } from "../control-service.ts";
import { type ApiCtx, type Route } from "./route.ts";

function defaultTimezoneFor(capability: CapabilityClaims | null): string {
  return typeof capability?.timezone === "string" && capability.timezone.trim()
    ? capability.timezone
    : DEFAULT_CRON_TIMEZONE;
}

function hasOwn(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function scheduleFromBody(schedule: unknown, defaultTimezone: string = DEFAULT_CRON_TIMEZONE): CronSchedule | null {
  if (!isObj(schedule)) return null;
  const hasCron = hasOwn(schedule, "cron");
  const hasTimezone = hasOwn(schedule, "timezone");
  const hasEveryMs = hasOwn(schedule, "everyMs");
  const hasFirstFireAt = hasOwn(schedule, "firstFireAt");

  if (hasCron) {
    if (typeof schedule.cron !== "string" || hasEveryMs || hasFirstFireAt) return null;
    const timezone = hasTimezone ? schedule.timezone : defaultTimezone;
    if (typeof timezone !== "string") return null;
    const cron = schedule.cron;
    return { cron, timezone };
  }

  if (hasTimezone || (!hasEveryMs && !hasFirstFireAt)) return null;
  if (hasEveryMs && typeof schedule.everyMs !== "number") return null;
  if (hasFirstFireAt && typeof schedule.firstFireAt !== "number") return null;
  const everyMs = hasEveryMs ? (schedule.everyMs as number) : undefined;
  const firstFireAt = hasFirstFireAt ? (schedule.firstFireAt as number) : undefined;
  return { ...(everyMs !== undefined ? { everyMs } : {}), ...(firstFireAt !== undefined ? { firstFireAt } : {}) };
}

function isCreateCron(b: unknown): b is CreateCronInput {
  return (
    isObj(b) &&
    scheduleFromBody(b.schedule) !== null &&
    (typeof b.action === "string" || typeof (b as { message?: unknown }).message === "string") &&
    (b as { unattendedGrants?: unknown }).unattendedGrants === undefined &&
    typeof b.ownerScopeId === "string" &&
    typeof b.owner === "string" &&
    typeof b.createdBy === "string" &&
    ((b as { title?: unknown }).title === undefined || typeof (b as { title?: unknown }).title === "string") &&
    (b.destination === undefined || isObj(b.destination))
  );
}

type CapabilityCronBody = {
  schedule?: unknown;
  title?: unknown;
  task?: unknown;
  text?: unknown;
  action?: unknown;
  message?: unknown;
  destinationKey?: unknown;
  runAs?: unknown;
  recipient?: unknown;
  channel?: unknown;
  participants?: unknown;
  scope?: unknown;
  unfurlLinks?: unknown;
  unattendedGrants?: unknown;
};

function taskText(b: CapabilityCronBody): string | undefined {
  if (typeof b.action === "string") return b.action;
  if (typeof b.task === "string") return b.task;
  return undefined;
}

function exactText(b: CapabilityCronBody): string | undefined {
  if (typeof b.message === "string") return b.message;
  if (typeof b.text === "string") return b.text;
  return undefined;
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
  title?: string;
  task?: string;
  action?: string;
  schedule?: unknown;
  enabled?: boolean;
  archived?: boolean;
  unfurlLinks?: boolean;
  runAs?: "owner" | "scopeFloor" | "scopeShared";
  unattendedGrants?: string[];
} {
  if (!isObj(b)) return false;
  if (!hasCronPatchFields(b)) return true;
  const hasTitle = b.title !== undefined;
  const hasAction = b.action !== undefined;
  const hasTask = b.task !== undefined;
  const hasSchedule = b.schedule !== undefined;
  const hasEnabled = b.enabled !== undefined;
  const hasArchived = b.archived !== undefined;
  const hasUnfurlLinks = b.unfurlLinks !== undefined;
  const hasRunAs = b.runAs !== undefined;
  const hasUnattendedGrants = b.unattendedGrants !== undefined;
  if (hasTitle && typeof b.title !== "string") return false;
  if (hasAction && typeof b.action !== "string") return false;
  if (hasTask && typeof b.task !== "string") return false;
  if (hasEnabled && typeof b.enabled !== "boolean") return false;
  if (hasArchived && typeof b.archived !== "boolean") return false;
  if (hasUnfurlLinks && typeof b.unfurlLinks !== "boolean") return false;
  if (hasRunAs && b.runAs !== "owner" && b.runAs !== "scopeFloor" && b.runAs !== "scopeShared") return false;
  if (
    hasUnattendedGrants &&
    (!Array.isArray(b.unattendedGrants) || !b.unattendedGrants.every((grant) => typeof grant === "string"))
  )
    return false;
  if (hasSchedule && scheduleFromBody(b.schedule) === null) return false;
  return true;
}

function hasCronPatchFields(b: Record<string, unknown>): boolean {
  return (
    b.title !== undefined ||
    b.action !== undefined ||
    b.task !== undefined ||
    b.schedule !== undefined ||
    b.enabled !== undefined ||
    b.archived !== undefined ||
    b.unfurlLinks !== undefined ||
    b.runAs !== undefined ||
    b.unattendedGrants !== undefined
  );
}

const CRON_ERROR_STATUS: Record<string, number> = {
  bad_request: 400,
  recipient_not_found: 404,
  ambiguous_recipient: 409,
  channel_not_found: 404,
  ambiguous_channel: 409,
  group_not_found: 404,
  not_a_member: 403,
  identity_unverified: 403,
  unknown_destination: 400,
  members_unavailable: 400,
  cron_create_failed: 400,
  not_found: 404,
  forbidden: 403,
  unavailable: 404,
  cron_update_failed: 400,
};

async function createCron(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  if (capability) {
    const b = body as CapabilityCronBody;
    if (
      b.unattendedGrants !== undefined &&
      (!Array.isArray(b.unattendedGrants) || !b.unattendedGrants.every((grant) => typeof grant === "string"))
    ) {
      return sendJson(res, 400, {
        error: "bad_request",
        message: "unattendedGrants must be an array of recognized grant strings",
      });
    }
    const schedule = scheduleFromBody(b.schedule, defaultTimezoneFor(capability));
    const task = taskText(b);
    const text = exactText(b);
    if (!schedule || (task === undefined && text === undefined)) {
      return sendJson(res, 400, {
        error: "bad_request",
        message:
          "schedule.cron (5-field expression) or schedule.everyMs/firstFireAt, plus task (what to do) or text (exact text to send), required",
      });
    }
    const result = await ctx.deps.control.createCron(
      {
        schedule,
        ...(task !== undefined ? { action: task } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(typeof b.title === "string" ? { title: b.title } : {}),
        ...(typeof b.recipient === "string" ? { recipient: b.recipient } : {}),
        ...(typeof b.channel === "string" ? { channel: b.channel } : {}),
        ...(Array.isArray(b.participants)
          ? { participants: b.participants.filter((p): p is string => typeof p === "string") }
          : {}),
        ...(b.scope === "personal" ? { scope: "personal" as const } : {}),
        ...(typeof b.destinationKey === "string" ? { destinationKey: b.destinationKey } : {}),
        ...(b.runAs === "owner" || b.runAs === "scopeFloor" || b.runAs === "scopeShared" ? { runAs: b.runAs } : {}),
        ...(typeof b.unfurlLinks === "boolean" ? { unfurlLinks: b.unfurlLinks } : {}),
        ...(Array.isArray(b.unattendedGrants) ? { unattendedGrants: b.unattendedGrants } : {}),
      },
      capability,
    );
    if (!result.ok) {
      const candidates = result.candidates?.map((c) =>
        result.code === "ambiguous_recipient"
          ? { principalId: c.id, displayName: c.label }
          : { channelId: c.id, name: c.label },
      );
      return sendJson(res, CRON_ERROR_STATUS[result.code] ?? 400, {
        error: result.code,
        message: result.message,
        ...(candidates ? { candidates } : {}),
      });
    }
    return sendJson(res, 200, {
      cron: withoutFireLog(result.cron),
      ...(result.recipient ? { recipient: result.recipient } : {}),
      ...(result.channel ? { channel: result.channel } : {}),
      ...(result.group ? { group: result.group } : {}),
    });
  }
  if (!isCreateCron(body)) return sendJson(res, 400, { error: "bad_request", message: "expected a CreateCronInput" });
  if (body.runAs === "scopeShared")
    return sendJson(res, 400, {
      error: "bad_request",
      message:
        "scopeShared crons must be created through an agent capability (it validates the scope is membership-controlled)",
    });
  try {
    const cron = await app.createCron(body);
    return sendJson(res, 200, { cron: withoutFireLog(cron) });
  } catch (e) {
    return sendJson(res, 400, { error: "cron_create_failed", message: errMessage(e) });
  }
}

async function listCrons(ctx: ApiCtx): Promise<void> {
  const { res, app, url, capability } = ctx;
  if (capability) {
    const { crons, visible } = await ctx.deps.control.listCrons(capability);
    return sendJson(res, 200, { crons: crons.map(withoutFireLog), visible: visible.map(withoutFireLog) });
  }
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
  const { res, app, capability } = ctx;
  const id = ctx.params.id!;
  if (capability) {
    const r = await ctx.deps.control.setCronEnabled(id, false, capability);
    if (!r.ok) return sendJson(res, CRON_ERROR_STATUS[r.code] ?? 400, { error: r.code, message: r.message });
    return sendJson(res, 200, { ok: true });
  }
  if (!(await gateSourceCron(ctx, id))) return;
  await app.setCronEnabled(id, false);
  return sendJson(res, 200, { ok: true });
}

async function retargetCron(ctx: ApiCtx): Promise<void> {
  const { res, body, capability } = ctx;
  const id = ctx.params.id!;
  if (!capability)
    return sendJson(res, 403, { error: "forbidden", message: "retarget requires an agent capability token" });
  const dk = isObj(body) ? body.destinationKey : undefined;
  if (typeof dk !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "destinationKey (string) required" });
  const r = await ctx.deps.control.retargetCron(id, dk, capability);
  if (!r.ok) return sendJson(res, CRON_ERROR_STATUS[r.code] ?? 400, { error: r.code, message: r.message });
  return sendJson(res, 200, { cron: withoutFireLog(r.cron) });
}

async function runCronNow(ctx: ApiCtx): Promise<void> {
  const { res, deps, capability } = ctx;
  const id = ctx.params.id!;
  if (capability) {
    const r = await ctx.deps.control.runCron(id, capability);
    if (!r.ok) return sendJson(res, CRON_ERROR_STATUS[r.code] ?? 400, { error: r.code, message: r.message });
    return sendJson(res, 200, { ok: true });
  }
  const cron = await gateSourceCron(ctx, id);
  if (!cron) return;
  if (!deps.scheduler) return sendJson(res, 404, { error: "not_found", message: "scheduler not wired" });
  if (cron.archived || !cron.enabled)
    return sendJson(res, 400, {
      error: "bad_request",
      message: `cron ${id} is ${cron.archived ? "archived" : "paused"} — enable it before firing it on demand`,
    });
  void deps.scheduler.runNow(id).catch((e: unknown) => swallow(`manual fire of cron ${id}`, e));
  return sendJson(res, 200, { ok: true });
}

async function cronRuns(ctx: ApiCtx): Promise<void> {
  const { res, url, capability } = ctx;
  const id = ctx.params.id!;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (capability) {
    const r = await ctx.deps.control.getCronRuns(id, limit !== undefined ? { limit } : {}, capability);
    if (!r.ok) return sendJson(res, CRON_ERROR_STATUS[r.code] ?? 400, { error: r.code, message: r.message });
    return sendJson(res, 200, { cron: withoutFireLog(r.cron), runs: r.runs, total: r.total });
  }
  const cron = await gateSourceCron(ctx, id);
  if (!cron) return;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return sendJson(res, 400, { error: "bad_request", message: "limit must be a positive integer" });
  }
  const fireLog = cron.fireLog ?? [];
  const runs = limit !== undefined ? fireLog.slice(-limit) : fireLog;
  return sendJson(res, 200, { cron: withoutFireLog(cron), runs, total: fireLog.length });
}

const CRON_PATCH_BAD_REQUEST =
  "expected a cron patch: title (string), task (string), schedule, enabled (boolean), archived (boolean), unfurlLinks (boolean), runAs (owner/scopeFloor/scopeShared), and/or unattendedGrants (string[])";

async function cronById(ctx: ApiCtx): Promise<void> {
  const { res, app, pathname, method, body, capability } = ctx;
  const id = decodeURIComponent(pathname.slice("/v1/crons/".length));
  if (capability) {
    if (method === "GET") {
      const r = await ctx.deps.control.getCron(id, capability);
      return r.ok
        ? sendJson(res, 200, { cron: withoutFireLog(r.cron) })
        : sendJson(res, CRON_ERROR_STATUS[r.code] ?? 400, { error: r.code, message: r.message });
    }
    if (method === "DELETE") {
      const r = await ctx.deps.control.deleteCron(id, capability);
      return r.ok
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, CRON_ERROR_STATUS[r.code] ?? 400, { error: r.code, message: r.message });
    }
    if (!isCronPatch(body)) return sendJson(res, 400, { error: "bad_request", message: CRON_PATCH_BAD_REQUEST });
    if (!hasCronPatchFields(body)) {
      return sendJson(res, 400, { error: "bad_request", message: CRON_PATCH_NOTHING_TO_CHANGE });
    }
    const schedule =
      body.schedule !== undefined ? scheduleFromBody(body.schedule, defaultTimezoneFor(capability))! : undefined;
    const task = body.action ?? body.task;
    const r = await ctx.deps.control.patchCron(
      id,
      {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(task !== undefined ? { action: task } : {}),
        ...(schedule !== undefined ? { schedule } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.archived !== undefined ? { archived: body.archived } : {}),
        ...(body.unfurlLinks !== undefined ? { unfurlLinks: body.unfurlLinks } : {}),
        ...(body.runAs !== undefined ? { runAs: body.runAs } : {}),
        ...(body.unattendedGrants !== undefined ? { unattendedGrants: body.unattendedGrants } : {}),
      },
      capability,
    );
    return r.ok
      ? sendJson(res, 200, { cron: withoutFireLog(r.cron) })
      : sendJson(res, CRON_ERROR_STATUS[r.code] ?? 400, { error: r.code, message: r.message });
  }
  if (method === "GET") {
    const cron = await gateSourceCronRead(ctx, id);
    if (!cron) return;
    return sendJson(res, 200, { cron: withoutFireLog(cron) });
  }
  const cron = await gateSourceCron(ctx, id);
  if (!cron) return;
  if (method === "DELETE") {
    await app.deleteCron(id);
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
  if (body.runAs !== undefined)
    return sendJson(res, 403, {
      error: "forbidden",
      message: "changing a cron's mode requires an agent capability token",
    });
  const schedule = body.schedule !== undefined ? scheduleFromBody(body.schedule)! : undefined;
  const task = body.action ?? body.task;
  if (body.unfurlLinks !== undefined && !cron.destination) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "unfurlLinks can only be set on a cron with a delivery destination",
    });
  }
  const patch: CronPatch = {
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
    return sendJson(res, 200, { cron: updated ? withoutFireLog(updated) : null });
  } catch (e) {
    return sendJson(res, 400, { error: "cron_update_failed", message: errMessage(e) });
  }
}

async function triggerConsent(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  const id = ctx.params.id!;
  if (!capability)
    return sendJson(res, 403, { error: "forbidden", message: "consent requires an agent capability token" });
  const decision = isObj(body) ? body.decision : undefined;
  if (decision !== "accept" && decision !== "decline") {
    return sendJson(res, 400, { error: "bad_request", message: 'decision must be "accept" or "decline"' });
  }
  const cron = await app.getCron(id);
  const webhook = cron ? null : await app.getWebhook(id);
  const trigger = cron ?? webhook;
  if (!trigger) return sendJson(res, 404, { error: "not_found" });
  const decided = decideRecipientConsent(trigger.recipientConsent, capability.actorId, decision, Date.now());
  if (!decided.ok) {
    return decided.reason === "no_consent"
      ? sendJson(res, 400, { error: "bad_request", message: "this trigger has no recipient consent to decide on" })
      : sendJson(res, 403, { error: "forbidden", message: "only the delivery recipient can accept or decline this" });
  }
  if (cron) await app.setCronRecipientConsent(id, decided.consent);
  else await app.setWebhookRecipientConsent(id, decided.consent);
  return sendJson(res, 200, { ok: true, consent: decided.consent });
}

export const cronRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/triggers/:id/consent", auth: "either", handle: triggerConsent },
  { method: "POST", path: "/v1/crons", auth: "either", handle: createCron },
  { method: "GET", path: "/v1/crons", auth: "either", handle: listCrons },
  { method: "POST", path: "/v1/crons/:id/disable", auth: "either", handle: disableCron },
  { method: "POST", path: "/v1/crons/:id/destination", auth: "either", handle: retargetCron },
  { method: "POST", path: "/v1/crons/:id/run", auth: "either", handle: runCronNow },
  { method: "GET", path: "/v1/crons/:id/runs", auth: "either", handle: cronRuns },
  {
    match: (m, p) =>
      p.startsWith("/v1/crons/") &&
      !p.slice("/v1/crons/".length).includes("/") &&
      (m === "GET" || m === "PATCH" || m === "DELETE"),
    auth: "either",
    handle: cronById,
  },
];
