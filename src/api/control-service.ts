import { unattendedGrantRefusal } from "../cron/authority.ts";
import { isDeepStrictEqual } from "node:util";
import type { Cron, CronFireLogEntry, CronSchedule, Destination, Webhook } from "../types.ts";
import type { CreateCronInput, CronPatch } from "../cron/cron-store.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import {
  cronFireReadsNotes,
  describeRunNowRefusal,
  echoesCronContextMarkers,
  flattenFireNote,
  type Scheduler,
} from "../cron/scheduler.ts";
import { DEFAULT_CRON_TIMEZONE } from "../cron/schedule.ts";
import { resolveCapabilityDestination } from "./capability-destination.ts";
import { withSlackUnfurlOption, type ReachResolution } from "../reach/reach.ts";
import { notifyOwnerOfCronEdit, type CronEditDetail } from "../triggers/edit-notice.ts";
import { errMessage } from "../util/errors.ts";
import { InstructionsUpdateDeniedError, InstructionsVersionConflictError } from "./app-types.ts";
import { InstructionsTooLargeError } from "../resolution/config-instructions.ts";
import { AdminError } from "../admin/admin-service.ts";
import type { AdminService } from "../admin/admin-service.ts";
import {
  livePersonCapability,
  resolveShareTarget,
  SHARED_SKILL_TRIGGER_REFUSAL,
  type ShareArtifactRequest,
  type ShareArtifactResult,
  isMultiMemberSkillScope,
} from "./artifact-share.ts";
import { actsAsScope, parseScopeId, type Permission } from "../types.ts";
import { cronRef, encodeRef } from "../acl/resource-ref.ts";
import type { App, VisibleCron } from "./app.ts";
import { fail, type ControlErr, type ControlOk, type ControlOp } from "./control-result.ts";
import { webhookMethods } from "./control-webhooks.ts";

export interface CronCreateRequest {
  runtime?: Cron["runtime"];
  schedule: CronSchedule;
  title?: string;
  action?: string;
  text?: string;
  recipient?: string;
  channel?: string;
  unfurlLinks?: boolean;
  unattendedGrants?: string[];
  session?: boolean;
  inbox?: boolean;
}

type ReachFailureCode =
  | "recipient_not_found"
  | "ambiguous_recipient"
  | "channel_not_found"
  | "ambiguous_channel"
  | "not_a_member"
  | "identity_unverified";

type ReachedTarget = Pick<Extract<ReachResolution, { ok: true }>, "recipient" | "channel">;

export type CronCreateResult =
  | ({ ok: true; cron: Cron } & ReachedTarget)
  | {
      ok: false;
      code: "bad_request" | ReachFailureCode | "forbidden" | "cron_create_failed";
      message: string;
      candidates?: Array<{ id: string; label: string }>;
    };

export interface WebhookCreateRequest {
  action: string;
  verification: Webhook["verification"];
  filters?: Webhook["filters"];
  destinationKey?: string;
}

export type WebhookCreateResult =
  | { ok: true; webhook: Webhook; url: string; secret?: string }
  | { ok: false; code: "bad_request" | "forbidden" | "unknown_destination" | "webhook_create_failed"; message: string };

export interface CronPatchRequest {
  runtime?: Cron["runtime"];
  title?: string;
  action?: string;
  text?: string;
  schedule?: CronSchedule;
  enabled?: boolean;
  archived?: boolean;
  unfurlLinks?: boolean;
  unattendedGrants?: string[];
  session?: boolean;
}

const CRON_PATCH_FIELDS = [
  "runtime",
  "title",
  "action",
  "text",
  "schedule",
  "enabled",
  "archived",
  "unfurlLinks",
  "unattendedGrants",
  "session",
] as const satisfies ReadonlyArray<keyof CronPatchRequest>;

export interface CronRunsRequest {
  limit?: number;
}

export interface CronRunsResult {
  cron: Cron;
  runs: CronFireLogEntry[];
  total: number;
}

const CRON_PATCH_NOTHING_TO_CHANGE =
  "nothing to change — pass title, task, schedule, enabled, archived, unfurlLinks, unattendedGrants, or session";

export const CRON_FIRE_NOTE_MAX_CHARS = 400;

export interface ControlService {
  createCron(req: CronCreateRequest, claims: CapabilityClaims): Promise<CronCreateResult>;
  listCrons(claims: CapabilityClaims): Promise<{ crons: Cron[]; visible: VisibleCron[] }>;
  getCron(id: string, claims: CapabilityClaims): ControlOp<{ cron: Cron }>;
  getCronRuns(id: string, req: CronRunsRequest, claims: CapabilityClaims): ControlOp<CronRunsResult, "bad_request">;
  patchCron(
    id: string,
    req: CronPatchRequest,
    claims: CapabilityClaims,
  ): ControlOp<{ cron: Cron }, "bad_request" | "cron_update_failed">;
  noteCron(id: string, text: string, claims: CapabilityClaims): ControlOp<{ applied: boolean }, "bad_request">;
  deleteCron(id: string, claims: CapabilityClaims): ControlOp<Record<never, never>>;
  setCronEnabled(id: string, enabled: boolean, claims: CapabilityClaims): ControlOp<{ cron: Cron }>;
  runCron(
    id: string,
    claims: CapabilityClaims,
  ): ControlOp<{ fireKey: string }, "unavailable" | "bad_request" | "already_running">;
  createWebhook(
    req: WebhookCreateRequest,
    claims: CapabilityClaims,
    publicBase: string | undefined,
  ): Promise<WebhookCreateResult>;
  listWebhooks(claims: CapabilityClaims): Promise<Webhook[]>;
  disableWebhook(id: string, claims: CapabilityClaims): ControlOp<Record<never, never>>;
  updateWebhook(
    id: string,
    patch: { action: string },
    claims: CapabilityClaims,
  ): ControlOp<{ webhook: Webhook }, "bad_request">;
  readInstructions(claims: CapabilityClaims): {
    effectiveInstructions: string;
    instructions: string | null;
    instructionsVersion: number;
  };
  writeInstructions(
    content: string,
    claims: CapabilityClaims,
    expectedVersion?: number,
  ): Promise<
    | ControlOk<{ version: number }>
    | ControlErr<
        | "instructions_update_denied"
        | "instructions_version_conflict"
        | "payload_too_large"
        | "instructions_update_failed"
      >
  >;
  shareArtifact(req: ShareArtifactRequest, claims: CapabilityClaims): Promise<ShareArtifactResult>;
}

async function ownsCron(
  app: Pick<App, "samePerson" | "isCurrentSharedScopeMember" | "membershipControlsScope" | "managesScope">,
  cron: Cron,
  actorId: string,
  isActor?: (id: string) => Promise<boolean>,
): Promise<boolean> {
  if (actsAsScope(cron.owner, cron.ownerScopeId)) return app.isCurrentSharedScopeMember(actorId, cron.ownerScopeId);
  if (!(await (isActor ? isActor(cron.owner) : app.samePerson(cron.owner, actorId)))) return false;
  return !(await app.membershipControlsScope(cron.ownerScopeId)) || app.managesScope(actorId, cron.ownerScopeId);
}

export async function canAdministerCron(
  app: Pick<
    App,
    "samePerson" | "isCurrentSharedScopeMember" | "artifactGrantPermission" | "membershipControlsScope" | "managesScope"
  >,
  cron: Cron,
  actorId: string,
  isActor?: (id: string) => Promise<boolean>,
): Promise<boolean> {
  if (await ownsCron(app, cron, actorId, isActor)) return true;
  if (actsAsScope(cron.owner, cron.ownerScopeId) || cron.ownerScopeId.startsWith("personal:")) return false;
  return (await app.artifactGrantPermission(cron.ownerScopeId, encodeRef(cronRef(cron.id)), actorId)) === "write";
}

function withDefaultTimezone(schedule: CronSchedule, cap: { timezone?: unknown }): CronSchedule {
  if (schedule.cron === undefined || schedule.timezone !== undefined) return schedule;
  const tz = typeof cap.timezone === "string" && cap.timezone.trim() ? cap.timezone : DEFAULT_CRON_TIMEZONE;
  return { ...schedule, timezone: tz };
}

function liveSessionRef(
  capability: Pick<CapabilityClaims, "threadRef" | "triggered" | "scopeId">,
  cronScopeId: string,
): string | undefined {
  return capability.triggered || capability.scopeId !== cronScopeId ? undefined : capability.threadRef;
}

function cronPatchChanges(before: Cron, patch: CronPatch): boolean {
  return (Object.entries(patch) as Array<[keyof CronPatch, unknown]>).some(
    ([key, value]) => !isDeepStrictEqual(before[key as keyof Cron], value),
  );
}

export interface CronEditor {
  actorId: string;
  timezone?: string;
  sessionRef?: string;
}

function patchFromCronPatchRequest(
  before: Cron,
  req: CronPatchRequest,
  editor: CronEditor,
): CronPatch | ControlErr<"bad_request"> {
  if (!CRON_PATCH_FIELDS.some((field) => req[field] !== undefined))
    return fail("bad_request", CRON_PATCH_NOTHING_TO_CHANGE);
  if (req.unfurlLinks !== undefined && !before.destination)
    return fail("bad_request", "unfurlLinks can only be set on a cron with a delivery destination");
  const sessionRef = req.session ? editor.sessionRef : undefined;
  if (req.session && !sessionRef)
    return fail("bad_request", "session:true needs a live conversation in the cron's own scope to tie it to");
  return {
    ...(req.session !== undefined && sessionRef !== before.sessionRef ? { sessionRef: sessionRef ?? null } : {}),
    ...(req.runtime !== undefined ? { runtime: req.runtime } : {}),
    ...(req.title !== undefined ? { title: req.title } : {}),
    ...(req.action !== undefined ? { action: req.action } : {}),
    ...(req.text !== undefined ? { message: req.text } : {}),
    ...(req.schedule !== undefined ? { schedule: withDefaultTimezone(req.schedule, editor) } : {}),
    ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
    ...(req.archived !== undefined ? { archived: req.archived } : {}),
    ...(req.unfurlLinks !== undefined && before.destination
      ? { destination: withSlackUnfurlOption(before.destination, req.unfurlLinks) }
      : {}),
  };
}

/** Applies a cron edit for whoever is allowed to make it: builds the patch, skips no-ops, writes, and tells the owner. */
export async function applyCronPatch(
  app: App,
  before: Cron,
  req: CronPatchRequest,
  editor: CronEditor,
  unattendedGrants?: () => Promise<ControlErr<"forbidden" | "bad_request"> | null>,
): Promise<ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden" | "bad_request" | "cron_update_failed">> {
  const patch = patchFromCronPatchRequest(before, req, editor);
  if ("ok" in patch) return patch;
  if (req.unattendedGrants !== undefined) patch.unattendedGrants = req.unattendedGrants;
  else if ((before.unattendedGrants?.length ?? 0) > 0) patch.unattendedGrants = before.unattendedGrants;
  if (!cronPatchChanges(before, patch)) return { ok: true, cron: before };
  const refused = (patch.unattendedGrants?.length ?? 0) > 0 ? await unattendedGrants?.() : null;
  if (refused) return refused;
  try {
    const cron = await app.updateCron(before.id, patch);
    if (!cron) return fail("not_found", `no cron ${before.id}`);
    await notifyOwnerOfCronEdit(app, {
      cron,
      editorId: editor.actorId,
      changeSummary: cronEditSummary(req),
      ...(req.schedule !== undefined ? { detail: { schedule: withDefaultTimezone(req.schedule, editor) } } : {}),
    });
    return { ok: true, cron };
  } catch (e) {
    return fail("cron_update_failed", errMessage(e));
  }
}

function cronEditSummary(req: CronPatchRequest): string[] {
  return [
    ...(req.runtime !== undefined ? ["runtime"] : []),
    ...(req.title !== undefined ? ["title"] : []),
    ...(req.action !== undefined || req.text !== undefined ? ["task"] : []),
    ...(req.schedule !== undefined ? ["schedule"] : []),
    ...(req.enabled !== undefined ? [`enabled=${req.enabled}`] : []),
    ...(req.archived !== undefined ? [`archived=${req.archived}`] : []),
    ...(req.unfurlLinks !== undefined ? [`unfurlLinks=${req.unfurlLinks}`] : []),
    ...(req.session !== undefined ? [req.session ? "tied to a session" : "untied from its session"] : []),
  ];
}

export const UNATTENDED_ADMIN_GRANTS = [
  "admin.sessions.read",
  "admin.audit.read",
  "admin.egress.read",
  "admin.files.read",
  "admin.spend.read",
  "admin.crons.read",
] as const;

function invalidUnattendedGrants(grants: string[] | undefined): ControlErr<"bad_request"> | null {
  if (grants === undefined || grants.every((grant) => (UNATTENDED_ADMIN_GRANTS as readonly string[]).includes(grant)))
    return null;
  return fail("bad_request", "unknown unattended grant");
}

function reachFailureCode(
  r: Extract<ReachResolution, { ok: false }>,
  req: CronCreateRequest,
): "bad_request" | ReachFailureCode {
  if (r.error === "recipient_not_found" || r.error === "ambiguous_recipient") return r.error;
  if (r.status === 404) return req.recipient !== undefined ? "recipient_not_found" : "channel_not_found";
  if (r.status === 409) return req.recipient !== undefined ? "ambiguous_recipient" : "ambiguous_channel";
  if (r.status === 403) return r.error === "identity_unverified" ? "identity_unverified" : "not_a_member";
  return "bad_request";
}

function cronGuards(app: App, admin?: AdminService) {
  const notifyEdit = (cron: Cron, cap: CapabilityClaims, changeSummary: string[], detail?: CronEditDetail) =>
    notifyOwnerOfCronEdit(app, { cron, editorId: cap.actorId, changeSummary, ...(detail ? { detail } : {}) });

  const administeredCron = async (
    id: string,
    capability: CapabilityClaims,
  ): Promise<ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden">> => {
    const cron = await app.getCron(id);
    if (!cron) return fail("not_found", `no cron ${id}`);
    if (!(await canAdministerCron(app, cron, capability.actorId))) return fail("forbidden", "not your cron");
    return { ok: true, cron };
  };

  const unattendedRefusal = async (
    cron: Pick<Cron, "owner" | "ownerScopeId" | "destination" | "unattendedGrants">,
    capability: CapabilityClaims,
  ): Promise<ControlErr<"forbidden"> | null> => {
    if (!cron.unattendedGrants?.length) return null;
    const refusal = await unattendedGrantRefusal(app, admin, cron, capability);
    return refusal && fail("forbidden", refusal.message);
  };
  return { notifyEdit, administeredCron, unattendedRefusal };
}

function cronCreateMethods(app: App, admin?: AdminService): Pick<ControlService, "createCron"> {
  return {
    async createCron(req, capability): Promise<CronCreateResult> {
      const invalidGrants = invalidUnattendedGrants(req.unattendedGrants);
      if (invalidGrants) return invalidGrants;
      if (req.action === undefined && req.text === undefined)
        return fail("bad_request", "task (what to do) or text (exact text to send) required");
      if (req.inbox && req.action === undefined)
        return fail("bad_request", "an inbox cron needs a task, not exact text");
      if (req.recipient !== undefined && req.channel !== undefined)
        return fail("bad_request", "specify at most one of recipient (a teammate) or channel");

      let destination: Destination | undefined;
      let ownerScopeId = capability.scopeId;
      let reached: ReachedTarget = {};

      if (req.recipient !== undefined || req.channel !== undefined) {
        const r = await app.resolveReachTarget(
          {
            ...(req.recipient !== undefined ? { recipient: req.recipient } : {}),
            ...(req.channel !== undefined ? { channel: req.channel } : {}),
          },
          capability.actorId,
        );
        if (!r.ok)
          return {
            ...fail(
              reachFailureCode(r, req),
              r.error === "not_a_member" && req.channel !== undefined
                ? "I can only schedule posts to a private channel you're in"
                : r.message,
            ),
            ...(r.candidates
              ? {
                  candidates: r.candidates.map((c) => ({
                    id: c.principalId ?? c.channelId ?? "",
                    label: c.displayName ?? c.name ?? "",
                  })),
                }
              : {}),
          };
        destination = r.destination;
        reached = {
          ...(r.recipient ? { recipient: r.recipient } : {}),
          ...(r.channel ? { channel: r.channel } : {}),
        };
        if (r.channel) ownerScopeId = r.destination.audienceScopeId ?? ownerScopeId;
      } else {
        const resolved = resolveCapabilityDestination(capability, undefined);
        if (resolved.ok) destination = resolved.destination;
      }

      if (req.unattendedGrants?.length) {
        const refusal = await unattendedGrantRefusal(
          app,
          admin,
          { owner: capability.actorId, ownerScopeId, ...(destination ? { destination } : {}) },
          capability,
        );
        if (refusal) return { ok: false, ...refusal };
      }

      if (req.unfurlLinks !== undefined && !destination)
        return fail("bad_request", "unfurlLinks can only be set on a cron with a delivery destination");
      if (destination) destination = withSlackUnfurlOption(destination, req.unfurlLinks);

      const input: CreateCronInput = {
        schedule: withDefaultTimezone(req.schedule, capability),
        ...(req.runtime !== undefined ? { runtime: req.runtime } : {}),
        ...(req.action !== undefined ? { action: req.action } : {}),
        ...(req.text !== undefined ? { message: req.text } : {}),
        owner: capability.actorId,
        createdBy: capability.actorId,
        ownerScopeId,
        ...(typeof req.title === "string" ? { title: req.title } : {}),
        ...(destination ? { destination } : {}),
        ...(req.unattendedGrants !== undefined ? { unattendedGrants: req.unattendedGrants } : {}),
        ...(req.inbox ? { inbox: {} } : {}),
      };
      const sessionRef = req.session === false ? undefined : liveSessionRef(capability, ownerScopeId);
      if (sessionRef) input.sessionRef = sessionRef;
      try {
        return { ok: true, cron: await app.createCron(input), ...reached };
      } catch (e) {
        return fail("cron_create_failed", errMessage(e));
      }
    },
  };
}

function cronMethods(
  app: App,
  scheduler: Scheduler | undefined,
  admin: AdminService | undefined,
  { notifyEdit, administeredCron, unattendedRefusal }: ReturnType<typeof cronGuards>,
): Pick<
  ControlService,
  "listCrons" | "getCron" | "getCronRuns" | "patchCron" | "noteCron" | "deleteCron" | "setCronEnabled" | "runCron"
> {
  return {
    async listCrons(capability) {
      const { visible } = await app.listCronsForViewer(capability.actorId);
      const all = await app.listCrons();
      const isActor = await app.personMatcher(capability.actorId);
      const admits = await Promise.all(all.map((c) => canAdministerCron(app, c, capability.actorId, isActor)));
      const administered = all.filter((_, i) => admits[i]);
      const ids = new Set(administered.map((c) => c.id));
      return { crons: administered, visible: visible.filter((c) => !ids.has(c.id)) };
    },

    async getCron(id, capability) {
      const cron = await app.getCron(id);
      if (!cron) return fail("not_found", `no cron ${id}`);
      if (await canAdministerCron(app, cron, capability.actorId)) return { ok: true, cron };
      const { visible } = await app.listCronsForViewer(capability.actorId);
      return visible.some((c) => c.id === id) ? { ok: true, cron } : fail("forbidden", "not your cron");
    },

    async getCronRuns(id, req, capability) {
      const found = await administeredCron(id, capability);
      if (!found.ok) return found;
      if (req.limit !== undefined && (!Number.isInteger(req.limit) || req.limit < 1))
        return fail("bad_request", "limit must be a positive integer");
      const { runs, total } = await app.listCronFires(id, req.limit !== undefined ? { limit: req.limit } : {});
      return { ok: true, cron: found.cron, runs, total };
    },

    async patchCron(id, req, capability) {
      const found = await administeredCron(id, capability);
      if (!found.ok) return found;
      const before = found.cron;
      const invalidGrants = invalidUnattendedGrants(req.unattendedGrants);
      if (invalidGrants) return invalidGrants;
      const editor: CronEditor = {
        actorId: capability.actorId,
        ...(typeof capability.timezone === "string" ? { timezone: capability.timezone } : {}),
        ...(liveSessionRef(capability, before.ownerScopeId) !== undefined
          ? { sessionRef: liveSessionRef(capability, before.ownerScopeId)! }
          : {}),
      };
      return applyCronPatch(app, before, req, editor, async () => {
        const refusal = await unattendedGrantRefusal(app, admin, before, capability);
        return refusal ? { ok: false, ...refusal } : null;
      });
    },

    async noteCron(id, text, capability) {
      const flattened = flattenFireNote(text);
      if (!flattened) return fail("bad_request", "the note is empty — say what the next fire should know");
      const length = [...flattened].length;
      if (length > CRON_FIRE_NOTE_MAX_CHARS)
        return fail(
          "bad_request",
          `the note is ${length} chars — the cap is ${CRON_FIRE_NOTE_MAX_CHARS}. Trim it to the outcome plus what the next fire must know; publish longer state to this conversation's Files via the available Files API, verify success, and put the file ID in the note for GET /v1/files/:id/content. If publication is unavailable, report it and retain needed local state on a scoped computer.`,
        );
      if (echoesCronContextMarkers(flattened))
        return fail(
          "bad_request",
          "the note can't include the cron runtime context markers — write a plain report instead",
        );
      const found = await administeredCron(id, capability);
      if (!found.ok) return found;
      const { cron } = found;
      if (cron.archived)
        return fail("bad_request", `cron ${id} is archived — its fires won't run, so a note would never be read`);
      if (!cronFireReadsNotes(cron))
        return fail(
          "bad_request",
          `cron ${id}'s fires don't read shift-change notes (it is one-shot, or runs a raw !run/!scratch task) — publish durable handoff state to this conversation's Files via the available Files API and verify success. Keep the published file ID in the consuming workflow for GET /v1/files/:id/content; these fires cannot recover it from a note. If publication is unavailable, report it and retain needed local state on a scoped computer.`,
        );
      const ownFire = capability.threadRef?.startsWith(`cron:${id}:fire:`) === true;
      const refusal = ownFire ? null : await unattendedRefusal(cron, capability);
      if (refusal) return refusal;
      const fireEntry = ownFire ? await app.latestCronFireForThread(id, capability.threadRef!) : undefined;
      const outcome = await app.setCronFireNote(id, {
        text: flattened,
        at: fireEntry?.firedAt ?? Date.now(),
        ...(ownFire ? {} : { by: capability.actorId }),
      });
      if (outcome === "missing") return fail("not_found", `no cron ${id}`);
      if (outcome === "applied" && !ownFire) await notifyEdit(cron, capability, ["note"]);
      return { ok: true, applied: outcome === "applied" };
    },

    async deleteCron(id, capability) {
      const found = await administeredCron(id, capability);
      if (!found.ok) return found;
      await app.deleteCron(id);
      await notifyEdit(found.cron, capability, ["deleted"]);
      return { ok: true };
    },

    async setCronEnabled(id, enabled, capability) {
      const found = await administeredCron(id, capability);
      if (!found.ok) return found;
      const { cron } = found;
      const refusal = enabled ? await unattendedRefusal(cron, capability) : null;
      if (refusal) return refusal;
      if (cron.enabled === enabled) return found;
      await app.setCronEnabled(id, enabled);
      await notifyEdit(cron, capability, [`enabled=${enabled}`]);
      return { ok: true, cron: (await app.getCron(id)) ?? cron };
    },

    async runCron(id, capability) {
      const found = await administeredCron(id, capability);
      if (!found.ok) return found;
      const { cron } = found;
      const refusal = await unattendedRefusal(cron, capability);
      if (refusal) return refusal;
      if (!scheduler)
        return fail("unavailable", "the scheduler isn't running here, so a cron can't be fired on demand");
      if (cron.archived || !cron.enabled)
        return fail(
          "bad_request",
          `cron ${id} is ${cron.archived ? "archived" : "paused"} — enable it before firing it on demand`,
        );
      const result = await scheduler.runNow(id);
      if (!result.started) {
        const refusal = describeRunNowRefusal(id, result)!;
        return fail(refusal.error, refusal.message);
      }
      return { ok: true, fireKey: result.fireKey };
    },
  };
}

function instructionMethods(app: App): Pick<ControlService, "readInstructions" | "writeInstructions"> {
  return {
    readInstructions(capability) {
      const { effectiveInstructions, instructions, instructionsVersion } = app.getInstructions(capability.scopeId);
      return { effectiveInstructions, instructions, instructionsVersion };
    },

    async writeInstructions(content, capability, expectedVersion) {
      try {
        const version = await app.updateInstructions(capability.scopeId, content, capability.actorId, {
          allowSharedScope: true,
          expectedVersion,
        });
        return { ok: true, version };
      } catch (e) {
        if (e instanceof InstructionsUpdateDeniedError) return fail("instructions_update_denied", errMessage(e));
        if (e instanceof InstructionsVersionConflictError) return fail("instructions_version_conflict", errMessage(e));
        if (e instanceof InstructionsTooLargeError) return fail("payload_too_large", e.message);
        return fail("instructions_update_failed", errMessage(e));
      }
    },
  };
}

function shareMethods(app: App): Pick<ControlService, "shareArtifact"> {
  return {
    async shareArtifact(req, capability): Promise<ShareArtifactResult> {
      const permission: Permission = req.permission === "write" ? "write" : "read";
      const home = await app.getArtifactHome(req.type, req.id);
      if (!home)
        return fail(
          "not_found",
          req.type === "file"
            ? `no Files record "${req.id}"; put the file in Files first using POST /v1/files/uploads, then share its ID`
            : `no ${req.type} "${req.id}"`,
        );

      const target = await resolveShareTarget(
        app,
        { scope: req.scope, recipient: req.recipient, email: req.email },
        {
          allowEmail: req.type === "deploy" && !req.move,
          invalidScope: (scope) =>
            `invalid scope "${scope}" — use "org" or a scope id like personal:<id> or channel:<id>`,
          targetRequired: 'a target is required: pass `toScope` ("org", a scope id, or a teammate\'s name)',
        },
      );
      if (target.kind === "invalid") return fail("bad_request", target.message);
      if (target.kind === "none") return fail("recipient_not_found", `no teammate matches "${String(req.recipient)}"`);
      if (target.kind === "ambiguous")
        return {
          ...fail("ambiguous_recipient", "more than one teammate matches"),
          candidates: target.candidates.map((c) => ({ id: c.principalId, label: c.displayName })),
        };
      const toScope = target.scope;
      const toKind = parseScopeId(toScope).kind;
      const done = (
        verb: "share" | "move" | "promote",
        id: string,
        extra: Pick<ShareArtifactResult & { ok: true }, "invitation"> = {},
      ): ShareArtifactResult => ({
        ok: true,
        verb,
        ...extra,
        type: req.type,
        id,
        target: { scope: toScope, label: target.label },
        permission,
      });

      const orgSkillCede = toKind === "org" && req.type === "skill";
      const cron = req.type === "cron" ? await app.getCron(home.id) : null;
      if (cron && permission === "write" && cron.ownerScopeId.startsWith("personal:"))
        return fail("bad_request", "a personal cron runs with your whole keychain, so it can't be shared for editing");
      if (
        !orgSkillCede &&
        !(cron
          ? await ownsCron(app, cron, capability.actorId)
          : await app.canManageArtifactHome(home.ownerScopeId, home.createdBy, capability.actorId))
      )
        return fail(
          "forbidden",
          cron
            ? "only the cron's owner can share it"
            : `only the ${req.type}'s owner (or a member of its shared home) can share or move it`,
        );
      if (
        (toKind === "channel" || toKind === "group" || toKind === "team") &&
        !(await app.belongsToScope(capability.actorId, toScope))
      )
        return fail(
          "forbidden",
          `you can't ${req.move ? "move" : "share"} into ${target.label} — you're not a member of that context`,
        );

      try {
        if (orgSkillCede) {
          const promoted = await app.promoteSkill(home.id, toScope, capability.actorId, capability.liveActor === true);
          return done("promote", promoted.id);
        }

        if (req.move) {
          const deployPersonTransfer = req.type === "deploy" && toKind === "personal" && capability.liveActor === true;
          if (!deployPersonTransfer && !(await app.belongsToScope(capability.actorId, toScope)))
            return fail(
              "forbidden",
              `you can only move a ${req.type} into a context you belong to — to give it to a teammate, share it (a grant) instead`,
            );
          if (
            req.type === "skill" &&
            !livePersonCapability(capability) &&
            (isMultiMemberSkillScope(home.ownerScopeId) || isMultiMemberSkillScope(toScope))
          )
            return fail("forbidden", SHARED_SKILL_TRIGGER_REFUSAL);
          await app.moveArtifactHome(req.type, home.id, toScope, capability.actorId);
          return done("move", home.id);
        }

        const invite =
          req.type === "deploy" && req.email !== undefined && permission === "read"
            ? await app.inviteToDeployment(home.id, req.email, capability.actorId)
            : undefined;
        if (!invite)
          await app.grant({
            ownerScopeId: home.ownerScopeId,
            ref: home.grantRef,
            granteeScopeId: toScope,
            permission,
            grantedBy: capability.actorId,
          });
        return done("share", home.id, invite ? { invitation: invite.invitation } : {});
      } catch (e) {
        return fail(e instanceof AdminError ? "forbidden" : "share_failed", errMessage(e));
      }
    },
  };
}

export function createControlService(app: App, scheduler?: Scheduler, admin?: AdminService): ControlService {
  return {
    ...cronCreateMethods(app, admin),
    ...cronMethods(app, scheduler, admin, cronGuards(app, admin)),
    ...webhookMethods(app),
    ...instructionMethods(app),
    ...shareMethods(app),
  };
}
