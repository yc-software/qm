import { isDeepStrictEqual } from "node:util";
import type { Cron, CronFireLogEntry, CronSchedule, Destination, Principal } from "../types.ts";
import type { CreateCronInput, CronPatch } from "../cron/cron-store.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { Scheduler } from "../cron/scheduler.ts";
import { DEFAULT_CRON_TIMEZONE } from "../cron/schedule.ts";
import { resolveCapabilityDestination } from "./capability-destination.ts";
import { withSlackUnfurlOption, principalDestination } from "../reach/reach.ts";
import { consentRequiredRecipient } from "../triggers/trigger-store.ts";
import { sendConsentNotice } from "../triggers/consent-notice.ts";
import { notifyOwnerOfCronEdit, type CronEditDetail } from "../triggers/edit-notice.ts";
import { errMessage, swallow } from "../util/errors.ts";
import { AdminError } from "../admin/admin-service.ts";
import type { AdminService } from "../admin/admin-service.ts";
import {
  livePersonCapability,
  resolveShareTarget,
  SHARED_SKILL_TRIGGER_REFUSAL,
  type ShareArtifactRequest,
  type ShareArtifactResult,
} from "./artifact-share.ts";
import { isSharedScope, parseScopeId, type Permission, type ScopeId } from "../types.ts";
import type { App, VisibleCron } from "./app.ts";

export interface CronCreateRequest {
  schedule: CronSchedule;
  title?: string;
  action?: string;
  text?: string;
  recipient?: string;
  channel?: string;
  participants?: string[];
  scope?: "personal";
  destinationKey?: string;
  runAs?: "owner" | "scopeFloor" | "scopeShared";
  unfurlLinks?: boolean;
  unattendedGrants?: string[];
}

export type CronCreateResult =
  | {
      ok: true;
      cron: Cron;
      recipient?: { principalId: string; displayName: string };
      channel?: { channelId: string; name: string };
      group?: { groupId: string };
    }
  | {
      ok: false;
      code:
        | "bad_request"
        | "recipient_not_found"
        | "ambiguous_recipient"
        | "channel_not_found"
        | "ambiguous_channel"
        | "group_not_found"
        | "not_a_member"
        | "identity_unverified"
        | "unknown_destination"
        | "members_unavailable"
        | "forbidden"
        | "cron_create_failed";
      message: string;
      candidates?: Array<{ id: string; label: string }>;
    };

export interface CronPatchRequest {
  title?: string;
  action?: string;
  text?: string;
  schedule?: CronSchedule;
  enabled?: boolean;
  archived?: boolean;
  unfurlLinks?: boolean;
  runAs?: "owner" | "scopeFloor" | "scopeShared";
  unattendedGrants?: string[];
}

export interface CronRunsRequest {
  limit?: number;
}

export interface CronRunsResult {
  cron: Cron;
  runs: CronFireLogEntry[];
  total: number;
}

export const CRON_PATCH_NOTHING_TO_CHANGE =
  "nothing to change — pass title, task, schedule, enabled, archived, unfurlLinks, runAs, or unattendedGrants";

export type ControlOk<T> = { ok: true } & T;
export type ControlErr<C extends string> = { ok: false; code: C; message: string };

export interface ControlService {
  createCron(req: CronCreateRequest, claims: CapabilityClaims): Promise<CronCreateResult>;
  listCrons(claims: CapabilityClaims): Promise<{ crons: Cron[]; visible: VisibleCron[] }>;
  getCron(
    id: string,
    claims: CapabilityClaims,
  ): Promise<ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden">>;
  getCronRuns(
    id: string,
    req: CronRunsRequest,
    claims: CapabilityClaims,
  ): Promise<ControlOk<CronRunsResult> | ControlErr<"not_found" | "forbidden" | "bad_request">>;
  patchCron(
    id: string,
    req: CronPatchRequest,
    claims: CapabilityClaims,
  ): Promise<ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden" | "bad_request" | "cron_update_failed">>;
  deleteCron(
    id: string,
    claims: CapabilityClaims,
  ): Promise<ControlOk<Record<never, never>> | ControlErr<"not_found" | "forbidden">>;
  setCronEnabled(
    id: string,
    enabled: boolean,
    claims: CapabilityClaims,
  ): Promise<ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden">>;
  runCron(
    id: string,
    claims: CapabilityClaims,
  ): Promise<ControlOk<Record<never, never>> | ControlErr<"not_found" | "forbidden" | "unavailable" | "bad_request">>;
  retargetCron(
    id: string,
    destinationKey: string,
    claims: CapabilityClaims,
  ): Promise<ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden" | "unknown_destination">>;
  readSoul(claims: CapabilityClaims): { effectiveSoul: string; soul: string | null; soulVersion: number };
  writeSoul(
    content: string,
    claims: CapabilityClaims,
  ): Promise<ControlOk<{ version: number }> | ControlErr<"soul_update_denied">>;
  shareArtifact(req: ShareArtifactRequest, claims: CapabilityClaims): Promise<ShareArtifactResult>;
}

export async function canAdministerCron(
  app: Pick<App, "membershipControlsScope" | "managesScope" | "samePerson">,
  cron: Cron,
  actorId: string,
  callerScopeId?: ScopeId,
  isActor?: (id: string) => Promise<boolean>,
): Promise<boolean> {
  if (await app.membershipControlsScope(cron.ownerScopeId)) return app.managesScope(actorId, cron.ownerScopeId);
  const team = cron.runAs === "scopeFloor" || cron.runAs === "scopeShared";
  if (!team && (await (isActor ? isActor(cron.owner) : app.samePerson(cron.owner, actorId)))) return true;
  if (team && cron.ownerScopeId === callerScopeId) return true;
  return app.managesScope(actorId, cron.ownerScopeId);
}

function withDefaultTimezone(schedule: CronSchedule, cap: CapabilityClaims): CronSchedule {
  if (schedule.cron === undefined || schedule.timezone !== undefined) return schedule;
  const tz = typeof cap.timezone === "string" && cap.timezone.trim() ? cap.timezone : DEFAULT_CRON_TIMEZONE;
  return { ...schedule, timezone: tz };
}

function scopeIsMembershipControlled(scope: string, cap: { scopeId: string; privateScope?: boolean }): boolean {
  return cap.privateScope === true && cap.scopeId === scope;
}

function hasCronPatchField(req: CronPatchRequest): boolean {
  return (
    req.title !== undefined ||
    req.action !== undefined ||
    req.text !== undefined ||
    req.schedule !== undefined ||
    req.enabled !== undefined ||
    req.archived !== undefined ||
    req.unfurlLinks !== undefined ||
    req.runAs !== undefined ||
    req.unattendedGrants !== undefined
  );
}

function cronPatchChanges(before: Cron, patch: CronPatch): boolean {
  return (Object.entries(patch) as Array<[keyof CronPatch, unknown]>).some(
    ([key, value]) => !isDeepStrictEqual(before[key as keyof Cron], value),
  );
}

export async function resolveRunAsChange(
  app: Pick<App, "samePerson">,
  before: Cron,
  reqRunAs: "owner" | "scopeFloor" | "scopeShared" | undefined,
  capability: { actorId: string; scopeId: string; members?: Principal[]; privateScope?: boolean },
): Promise<{ ok: true; patch: Pick<CronPatch, "runAs" | "members"> } | ControlErr<"bad_request" | "forbidden">> {
  const current = before.runAs ?? "owner";
  if (reqRunAs === undefined || reqRunAs === current) return { ok: true, patch: {} };
  if (!(await app.samePerson(capability.actorId, before.owner))) {
    return {
      ok: false,
      code: "forbidden",
      message: "only the cron's owner can change its mode (owner / scopeFloor / scopeShared)",
    };
  }
  if (reqRunAs === "owner") return { ok: true, patch: { runAs: "owner" } };
  if (before.ownerScopeId.startsWith("personal:")) {
    return {
      ok: false,
      code: "bad_request",
      message: "a team mode needs a shared scope — this cron is personal (only you can use or edit it)",
    };
  }
  if (!(capability.members && capability.members.length > 0)) {
    return {
      ok: false,
      code: "bad_request",
      message: "switching to a team mode needs this conversation's member list — do it from the cron's channel",
    };
  }
  if (reqRunAs === "scopeShared" && !scopeIsMembershipControlled(before.ownerScopeId, capability)) {
    return {
      ok: false,
      code: "bad_request",
      message: "scopeShared needs a private channel or group DM — change the mode from inside the cron's scope",
    };
  }
  return { ok: true, patch: { runAs: reqRunAs, members: capability.members } };
}

async function patchFromCronPatchRequest(
  app: Pick<App, "samePerson">,
  before: Cron,
  req: CronPatchRequest,
  capability: CapabilityClaims,
): Promise<CronPatch | ControlErr<"bad_request" | "forbidden">> {
  if (!hasCronPatchField(req)) {
    return {
      ok: false,
      code: "bad_request",
      message: CRON_PATCH_NOTHING_TO_CHANGE,
    };
  }
  const mode = await resolveRunAsChange(app, before, req.runAs, capability);
  if (!mode.ok) return mode;
  const changesMode = mode.patch.runAs !== undefined;
  if (req.unfurlLinks !== undefined && !before.destination) {
    return {
      ok: false,
      code: "bad_request",
      message: "unfurlLinks can only be set on a cron with a delivery destination",
    };
  }
  return {
    ...(req.title !== undefined ? { title: req.title } : {}),
    ...(req.action !== undefined ? { action: req.action } : {}),
    ...(req.text !== undefined ? { message: req.text } : {}),
    ...(req.schedule !== undefined ? { schedule: withDefaultTimezone(req.schedule, capability) } : {}),
    ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
    ...(req.archived !== undefined ? { archived: req.archived } : {}),
    ...(req.unfurlLinks !== undefined && before.destination
      ? { destination: withSlackUnfurlOption(before.destination, req.unfurlLinks) }
      : {}),
    ...(!changesMode &&
    (before.runAs === "scopeFloor" || before.runAs === "scopeShared") &&
    capability.members &&
    capability.members.length > 0
      ? { members: capability.members }
      : {}),
    ...mode.patch,
  };
}

const UNATTENDED_GRANTS = new Set(["admin.sessions.read"]);

function validateUnattendedGrants(grants: string[]): string | null {
  if (!grants.every((grant) => UNATTENDED_GRANTS.has(grant))) return "unknown unattended grant";
  return null;
}

async function unattendedGrantRefusal(
  app: App,
  admin: AdminService | undefined,
  cron: Pick<Cron, "owner" | "ownerScopeId" | "runAs">,
  capability: CapabilityClaims,
): Promise<string | null> {
  if (capability.liveActor !== true) return "unattended grants require a live turn started by the cron owner";
  if (!(await app.samePerson(cron.owner, capability.actorId))) return "only the cron owner may set unattended grants";
  if (!cron.ownerScopeId.startsWith("personal:") || (cron.runAs !== undefined && cron.runAs !== "owner"))
    return "unattended grants require a personal-scope cron that runs as its owner";
  const status = await admin?.adminStatusOf({ id: capability.actorId, type: "internal" }).catch(() => undefined);
  if (!status?.isAdmin) return "unattended grants require the cron owner to be a current org admin";
  return null;
}

export function createControlService(app: App, scheduler?: Scheduler, admin?: AdminService): ControlService {
  const notifyEdit = (
    cron: Cron,
    cap: CapabilityClaims,
    changeSummary: string[],
    editFingerprint: string,
    detail?: CronEditDetail,
  ): Promise<void> =>
    notifyOwnerOfCronEdit(app, {
      cron,
      editorId: cap.actorId,
      changeSummary,
      editFingerprint,
      ...(detail ? { detail } : {}),
    });
  return {
    async createCron(req, capability): Promise<CronCreateResult> {
      if (req.unattendedGrants !== undefined) {
        const invalid = validateUnattendedGrants(req.unattendedGrants);
        if (invalid) return { ok: false, code: "bad_request", message: invalid };
      }
      if (req.action === undefined && req.text === undefined) {
        return { ok: false, code: "bad_request", message: "task (what to do) or text (exact text to send) required" };
      }
      const hasParticipants = Array.isArray(req.participants);
      const wantsGroup = hasParticipants && req.participants!.length > 0;
      const wantsPersonal = req.scope === "personal";
      if (
        [req.recipient !== undefined, req.channel !== undefined, wantsGroup, wantsPersonal].filter(Boolean).length > 1
      ) {
        return {
          ok: false,
          code: "bad_request",
          message:
            'specify at most one of scope:"personal", recipient (a teammate), channel, or participants (a group DM)',
        };
      }
      if (wantsPersonal && req.destinationKey !== undefined) {
        return {
          ok: false,
          code: "bad_request",
          message: 'scope:"personal" runs at your own scope — it can\'t also take a destinationKey',
        };
      }
      if (wantsPersonal && (req.runAs === "scopeFloor" || req.runAs === "scopeShared")) {
        return {
          ok: false,
          code: "bad_request",
          message: "a personal cron is private to you — it can't run as a shared team cron (scopeFloor/scopeShared)",
        };
      }

      let destination: Destination | undefined;
      let ownerScopeId = capability.scopeId;
      let resolvedRecipient: { principalId: string; displayName: string } | undefined;
      let resolvedChannel: { channelId: string; name: string } | undefined;
      let resolvedGroup: { groupId: string } | undefined;

      if (wantsPersonal) {
        destination = principalDestination(capability.actorId, capability.actorId);
        ownerScopeId = destination.audienceScopeId ?? ownerScopeId;
      } else if (req.recipient !== undefined || req.channel !== undefined || hasParticipants) {
        const r = await app.resolveReachTarget(
          {
            ...(req.recipient !== undefined ? { recipient: req.recipient } : {}),
            ...(req.channel !== undefined ? { channel: req.channel } : {}),
            ...(hasParticipants ? { participants: req.participants } : {}),
          },
          capability.actorId,
        );
        if (!r.ok) {
          let code:
            | "bad_request"
            | "recipient_not_found"
            | "ambiguous_recipient"
            | "channel_not_found"
            | "ambiguous_channel"
            | "group_not_found"
            | "not_a_member"
            | "identity_unverified" = "bad_request";
          const RESOLVER_CODES = new Set(["recipient_not_found", "ambiguous_recipient", "group_not_found"]);
          if (RESOLVER_CODES.has(r.error)) {
            code = r.error as typeof code;
          } else if (r.status === 404) {
            if (req.recipient !== undefined) code = "recipient_not_found";
            else code = wantsGroup ? "group_not_found" : "channel_not_found";
          } else if (r.status === 409) {
            code = req.recipient !== undefined ? "ambiguous_recipient" : "ambiguous_channel";
          } else if (r.status === 403) {
            code = r.error === "identity_unverified" ? "identity_unverified" : "not_a_member";
          }
          return {
            ok: false,
            code,
            message:
              r.error === "not_a_member" && req.channel !== undefined
                ? "I can only schedule posts to a private channel you're in"
                : r.message,
            ...(r.candidates
              ? {
                  candidates: r.candidates.map((c) => ({
                    id: c.principalId ?? c.channelId ?? "",
                    label: c.displayName ?? c.name ?? "",
                  })),
                }
              : {}),
          };
        }
        destination = r.destination;
        if (r.recipient) resolvedRecipient = r.recipient;
        if (r.channel) {
          resolvedChannel = r.channel;
          ownerScopeId = r.destination.audienceScopeId ?? ownerScopeId;
        }
        if (r.group) {
          resolvedGroup = r.group;
          ownerScopeId = r.destination.audienceScopeId ?? ownerScopeId;
        }
      } else {
        const resolved = resolveCapabilityDestination(capability, req.destinationKey);
        if (!resolved.ok) {
          return {
            ok: false,
            code: "unknown_destination",
            message: "destinationKey is not one of the destinations available for this conversation",
          };
        }
        destination = resolved.destination;
      }

      const haveMembers = !!(capability.members && capability.members.length > 0);
      const eligibleForShared =
        !ownerScopeId.startsWith("personal:") && scopeIsMembershipControlled(ownerScopeId, capability);
      let runAs: "owner" | "scopeFloor" | "scopeShared" = "owner";
      if (req.runAs === "scopeFloor") runAs = "scopeFloor";
      else if (req.runAs === "scopeShared") runAs = "scopeShared";
      if ((runAs === "scopeFloor" || runAs === "scopeShared") && !haveMembers) {
        return {
          ok: false,
          code: "members_unavailable",
          message:
            "a team cron needs this conversation's member list, which isn't available here — create it as a personal cron instead",
        };
      }
      if (runAs === "scopeShared" && !eligibleForShared) {
        return {
          ok: false,
          code: "bad_request",
          message:
            "scopeShared needs a private channel or group DM you're in — not a public channel, a DM, or a different named channel",
        };
      }
      if (req.unattendedGrants !== undefined) {
        const refusal = await unattendedGrantRefusal(
          app,
          admin,
          { owner: capability.actorId, ownerScopeId, runAs },
          capability,
        );
        if (refusal) {
          const code = refusal.includes("personal-scope") ? "bad_request" : "forbidden";
          return { ok: false, code, message: refusal };
        }
      }

      if (req.unfurlLinks !== undefined && !destination) {
        return {
          ok: false,
          code: "bad_request",
          message: "unfurlLinks can only be set on a cron with a delivery destination",
        };
      }
      if (destination) destination = withSlackUnfurlOption(destination, req.unfurlLinks);

      const standing = req.schedule.cron !== undefined || req.schedule.everyMs !== undefined;
      const consentRecipient = consentRequiredRecipient({ owner: capability.actorId, standing, destination });

      const input: CreateCronInput = {
        schedule: withDefaultTimezone(req.schedule, capability),
        ...(req.action !== undefined ? { action: req.action } : {}),
        ...(req.text !== undefined ? { message: req.text } : {}),
        owner: capability.actorId,
        createdBy: capability.actorId,
        ownerScopeId,
        ...(typeof req.title === "string" ? { title: req.title } : {}),
        ...(destination ? { destination } : {}),
        ...(consentRecipient
          ? { recipientConsent: { recipientId: consentRecipient, status: "pending" as const } }
          : {}),
        ...(runAs === "scopeFloor" || runAs === "scopeShared" ? { runAs, members: capability.members } : {}),
        ...(req.unattendedGrants !== undefined ? { unattendedGrants: req.unattendedGrants } : {}),
      };
      try {
        const cron = await app.createCron(input);
        if (consentRecipient) {
          const ownerMember = await app.directoryMember(capability.actorId);
          await sendConsentNotice((i) => app.enqueueDelivery(i), {
            triggerId: cron.id,
            recipientId: consentRecipient,
            ownerId: capability.actorId,
            ...(ownerMember?.displayName ? { ownerName: ownerMember.displayName } : {}),
            what:
              typeof req.title === "string" ? `a scheduled message ("${req.title}")` : "a recurring scheduled message",
          });
        }
        return {
          ok: true,
          cron,
          ...(resolvedRecipient ? { recipient: resolvedRecipient } : {}),
          ...(resolvedChannel ? { channel: resolvedChannel } : {}),
          ...(resolvedGroup ? { group: resolvedGroup } : {}),
        };
      } catch (e) {
        return { ok: false, code: "cron_create_failed", message: errMessage(e) };
      }
    },

    async listCrons(capability) {
      const { visible } = await app.listCronsForViewer(capability.actorId);
      const all = await app.listCrons();
      const isActor = await app.personMatcher(capability.actorId);
      const admits = await Promise.all(
        all.map((c) => canAdministerCron(app, c, capability.actorId, capability.scopeId, isActor)),
      );
      const administered = all.filter((_, i) => admits[i]);
      const ids = new Set(administered.map((c) => c.id));
      return { crons: administered, visible: visible.filter((c) => !ids.has(c.id)) };
    },

    async getCron(id, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (await canAdministerCron(app, cron, capability.actorId, capability.scopeId)) return { ok: true, cron };
      const { visible } = await app.listCronsForViewer(capability.actorId);
      if (visible.some((c) => c.id === id)) return { ok: true, cron };
      return { ok: false, code: "forbidden", message: "not your cron" };
    },

    async getCronRuns(id, req, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await canAdministerCron(app, cron, capability.actorId, capability.scopeId)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      if (req.limit !== undefined && (!Number.isInteger(req.limit) || req.limit < 1)) {
        return { ok: false, code: "bad_request", message: "limit must be a positive integer" };
      }
      const fireLog = cron.fireLog ?? [];
      const runs = req.limit !== undefined ? fireLog.slice(-req.limit) : fireLog;
      return { ok: true, cron, runs, total: fireLog.length };
    },

    async patchCron(id, req, capability) {
      const before = await app.getCron(id);
      if (!before) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await canAdministerCron(app, before, capability.actorId, capability.scopeId)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      if (req.unattendedGrants !== undefined) {
        const invalid = validateUnattendedGrants(req.unattendedGrants);
        if (invalid) return { ok: false, code: "bad_request", message: invalid };
      }
      const patch = await patchFromCronPatchRequest(app, before, req, capability);
      if ("ok" in patch) return patch;
      if (req.unattendedGrants !== undefined) patch.unattendedGrants = req.unattendedGrants;
      else if ((before.unattendedGrants?.length ?? 0) > 0) patch.unattendedGrants = before.unattendedGrants;
      if (!cronPatchChanges(before, patch)) return { ok: true, cron: before };
      if ((before.unattendedGrants?.length ?? 0) > 0 || req.unattendedGrants !== undefined) {
        const refusal = await unattendedGrantRefusal(
          app,
          admin,
          {
            owner: before.owner,
            ownerScopeId: before.ownerScopeId,
            runAs: req.runAs ?? before.runAs,
          },
          capability,
        );
        if (refusal) {
          const code = refusal.includes("personal-scope") ? "bad_request" : "forbidden";
          return { ok: false, code, message: refusal };
        }
      }
      try {
        const cron = await app.updateCron(id, patch);
        if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
        const changeSummary: string[] = [];
        if (req.title !== undefined) changeSummary.push("title");
        if (req.action !== undefined || req.text !== undefined) changeSummary.push("task");
        if (req.schedule !== undefined) changeSummary.push("schedule");
        if (req.enabled !== undefined) changeSummary.push(`enabled=${req.enabled}`);
        if (req.archived !== undefined) changeSummary.push(`archived=${req.archived}`);
        if (req.unfurlLinks !== undefined) changeSummary.push(`unfurlLinks=${req.unfurlLinks}`);
        if (patch.runAs !== undefined) changeSummary.push(`mode=${patch.runAs}`);
        const detail: CronEditDetail =
          req.schedule !== undefined ? { schedule: withDefaultTimezone(req.schedule, capability) } : {};
        await notifyEdit(cron, capability, changeSummary, JSON.stringify(patch), detail);
        return { ok: true, cron };
      } catch (e) {
        return { ok: false, code: "cron_update_failed", message: errMessage(e) };
      }
    },

    async deleteCron(id, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await canAdministerCron(app, cron, capability.actorId, capability.scopeId)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      await app.deleteCron(id);
      await notifyEdit(cron, capability, ["deleted"], "deleted");
      return { ok: true };
    },

    async setCronEnabled(id, enabled, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await canAdministerCron(app, cron, capability.actorId, capability.scopeId)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      if (enabled && (cron.unattendedGrants?.length ?? 0) > 0) {
        const refusal = await unattendedGrantRefusal(app, admin, cron, capability);
        if (refusal) return { ok: false, code: "forbidden", message: refusal };
      }
      await app.setCronEnabled(id, enabled);
      await notifyEdit(cron, capability, [`enabled=${enabled}`], `enabled=${enabled}`);
      const after = await app.getCron(id);
      return { ok: true, cron: after ?? cron };
    },

    async runCron(id, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await canAdministerCron(app, cron, capability.actorId, capability.scopeId)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      if ((cron.unattendedGrants?.length ?? 0) > 0) {
        const refusal = await unattendedGrantRefusal(app, admin, cron, capability);
        if (refusal) return { ok: false, code: "forbidden", message: refusal };
      }
      if (!scheduler)
        return {
          ok: false,
          code: "unavailable",
          message: "the scheduler isn't running here, so a cron can't be fired on demand",
        };
      if (cron.archived || !cron.enabled)
        return {
          ok: false,
          code: "bad_request",
          message: `cron ${id} is ${cron.archived ? "archived" : "paused"} — enable it before firing it on demand`,
        };
      void scheduler.runNow(id).catch((e: unknown) => swallow(`manual fire of cron ${id}`, e));
      return { ok: true };
    },

    async retargetCron(id, destinationKey, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await canAdministerCron(app, cron, capability.actorId, capability.scopeId)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      if ((cron.unattendedGrants?.length ?? 0) > 0) {
        const refusal = await unattendedGrantRefusal(app, admin, cron, capability);
        if (refusal) return { ok: false, code: "forbidden", message: refusal };
      }
      const resolved = resolveCapabilityDestination(capability, destinationKey);
      if (!resolved.ok) {
        return {
          ok: false,
          code: "unknown_destination",
          message: "destinationKey is not one of the destinations available for this conversation",
        };
      }
      const updated = await app.setCronDestination(id, resolved.destination);
      const destLabel = capability.destinations?.find((d) => d.key === destinationKey)?.label;
      await notifyEdit(
        cron,
        capability,
        ["destination"],
        `destination:${resolved.destination?.target ?? ""}`,
        destLabel ? { destinationLabel: destLabel } : undefined,
      );
      return { ok: true, cron: updated ?? cron };
    },

    readSoul(capability) {
      const { effectiveSoul, soul, soulVersion } = app.getSoul(capability.scopeId);
      return { effectiveSoul, soul, soulVersion };
    },

    async writeSoul(content, capability) {
      try {
        const version = await app.updateSoul(capability.scopeId, content, capability.actorId, {
          allowSharedScope: true,
        });
        return { ok: true, version };
      } catch (e) {
        return { ok: false, code: "soul_update_denied", message: errMessage(e) };
      }
    },

    async shareArtifact(req, capability): Promise<ShareArtifactResult> {
      const permission: Permission = req.permission === "write" ? "write" : "read";
      const home = await app.getArtifactHome(req.type, req.id);
      if (!home) return { ok: false, code: "not_found", message: `no ${req.type} "${req.id}"` };

      const target = await resolveArtifactTarget(app, req);
      if (target.kind === "invalid") return { ok: false, code: "bad_request", message: target.message };
      if (target.kind === "none")
        return { ok: false, code: "recipient_not_found", message: `no teammate matches "${String(req.recipient)}"` };
      if (target.kind === "ambiguous")
        return {
          ok: false,
          code: "ambiguous_recipient",
          message: "more than one teammate matches",
          candidates: target.candidates,
        };
      const toScope = target.scope;
      const toKind = parseScopeId(toScope).kind;

      const isOrg = toKind === "org";
      const orgSkillCede = isOrg && req.type === "skill";

      if (!orgSkillCede && !(await app.canManageArtifactHome(home.ownerScopeId, home.createdBy, capability.actorId))) {
        return {
          ok: false,
          code: "forbidden",
          message: `only the ${req.type}'s owner (or a member of its shared home) can share or move it`,
        };
      }
      if (
        (toKind === "channel" || toKind === "group" || toKind === "team") &&
        !(await app.belongsToScope(capability.actorId, toScope))
      ) {
        return {
          ok: false,
          code: "forbidden",
          message: `you can't ${req.move ? "move" : "share"} into ${target.label} — you're not a member of that context`,
        };
      }

      try {
        if (orgSkillCede) {
          const promoted = await app.promoteSkill(home.id, toScope, capability.actorId, capability.liveActor === true);
          return {
            ok: true,
            verb: "promote",
            type: req.type,
            id: promoted.id,
            target: { scope: toScope, label: target.label },
            permission,
          };
        }

        if (req.move) {
          const deployPersonTransfer = req.type === "deploy" && toKind === "personal" && capability.liveActor === true;
          if (!deployPersonTransfer && !(await app.belongsToScope(capability.actorId, toScope))) {
            return {
              ok: false,
              code: "forbidden",
              message: `you can only move a ${req.type} into a context you belong to — to give it to a teammate, share it (a grant) instead`,
            };
          }
          if (
            req.type === "skill" &&
            !livePersonCapability(capability) &&
            (isSharedScope(home.ownerScopeId) || isSharedScope(toScope))
          ) {
            return { ok: false, code: "forbidden", message: SHARED_SKILL_TRIGGER_REFUSAL };
          }
          await app.moveArtifactHome(req.type, home.id, toScope, capability.actorId);
          return {
            ok: true,
            verb: "move",
            type: req.type,
            id: home.id,
            target: { scope: toScope, label: target.label },
            permission,
          };
        }

        await app.grant({
          ownerScopeId: home.ownerScopeId,
          ref: home.grantRef,
          granteeScopeId: toScope,
          permission,
          grantedBy: capability.actorId,
        });
        return {
          ok: true,
          verb: "share",
          type: req.type,
          id: home.id,
          target: { scope: toScope, label: target.label },
          permission,
        };
      } catch (e) {
        if (e instanceof AdminError) {
          return { ok: false, code: "forbidden", message: errMessage(e) };
        }
        return { ok: false, code: "share_failed", message: errMessage(e) };
      }
    },
  };
}

type ArtifactTarget =
  | { kind: "ok"; scope: ScopeId; label: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: Array<{ id: string; label: string }> }
  | { kind: "invalid"; message: string };

async function resolveArtifactTarget(app: App, req: ShareArtifactRequest): Promise<ArtifactTarget> {
  const r = await resolveShareTarget(
    app,
    { scope: req.scope, recipient: req.recipient },
    {
      invalidScope: (scope) => `invalid scope "${scope}" — use "org" or a scope id like personal:<id> or channel:<id>`,
      targetRequired: 'a target is required: pass `toScope` ("org", a scope id, or a teammate\'s name)',
    },
  );
  return r.kind === "ambiguous"
    ? { kind: "ambiguous", candidates: r.candidates.map((c) => ({ id: c.principalId, label: c.displayName })) }
    : r;
}
