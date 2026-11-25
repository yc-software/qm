import { isDeepStrictEqual } from "node:util";
import type { Destination } from "../types.ts";
import type { Cron, CronFireLogEntry, CronSchedule, CronScript, Webhook } from "../triggers/types.ts";
import { cronScriptFrom, scriptTrialRefusal } from "../cron/script.ts";
import { selfReadAudience } from "../auth/self-read-audience.ts";
import type { CreateCronInput, CronPatch } from "../cron/cron-store.ts";
import type { CreateWebhookInput, WebhookPatch } from "../webhooks/webhook-store.ts";
import { asOrgAdmin, personOrOwningBot, type ActingClaims, type CapabilityClaims } from "../auth/capability-token.ts";
import {
  cronFireReadsNotes,
  describeRunNowRefusal,
  echoesCronContextMarkers,
  flattenFireNote,
  type Scheduler,
  type ScriptTrialCron,
} from "../cron/scheduler.ts";
import { DEFAULT_CRON_TIMEZONE } from "../cron/schedule.ts";
import { resolveCapabilityDestination } from "./capability-destination.ts";
import { withSlackUnfurlOption, principalDestination } from "../reach/reach.ts";
import { notifyOwnerOfCronEdit, type CronEditDetail } from "../triggers/edit-notice.ts";
import { errMessage } from "../util/errors.ts";
import { SoulUpdateDeniedError, SoulVersionConflictError } from "./app-types.ts";
import { AdminError } from "../admin/admin-service.ts";
import { DeployAccessError } from "../deploy/deploy-service.ts";
import {
  type ArtifactHome,
  type ArtifactType,
  isMultiMemberSkillScope,
  carriesPersonAuthority,
  resolveShareTarget,
  type ShareAccessResult,
  type ShareArtifactRequest,
  type ShareArtifactResult,
  SHARED_SKILL_REFUSAL,
  shareOffers,
} from "./artifact-share.ts";
import { actsAsScope, parseScopeId, scopeId, type Permission, type ScopeId } from "../types.ts";
import { administersCron, canAdministerCron, managesPersonaCron, ownsCron } from "./cron-administration.ts";
import { deliversToOwner, withSharing } from "./app-cron-share.ts";
import type { App, VisibleCron } from "./app.ts";
import { ambientTenant, type Tenant } from "../tenants/context.ts";
import { isOwnScopeBotWork, loadsScopeContext } from "../resolution/context-filter.ts";

export interface CronCreateRequest {
  runtime?: Cron["runtime"];
  schedule: CronSchedule;
  title?: string;
  action?: string;
  text?: string;
  recipient?: string;
  channel?: string;
  participants?: string[];
  scope?: "personal";
  destinationKey?: string;
  unfurlLinks?: boolean;
  session?: boolean;
  script?: CronScript;
  persona?: string | null;
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
        | "forbidden"
        | "cron_create_failed";
      message: string;
      candidates?: Array<{ id: string; label: string }>;
    };

export interface WebhookCreateRequest {
  title?: string;
  action: string;
  verification: Webhook["verification"];
  filters?: Webhook["filters"];
  destinationKey?: string;
}

export type WebhookCreateResult =
  | { ok: true; webhook: Webhook; url: string; secret?: string }
  | {
      ok: false;
      code: "bad_request" | "forbidden" | "unknown_destination" | "webhook_create_failed" | "approval_required";
      message: string;
    };

type SignOff = (step: { summary: string; key: string; shown?: unknown }) => Promise<boolean>;

const SIGN_OFF_PENDING = "this step waits on the approval card sent to the person";
const unsigned: SignOff = async () => false;

export interface CronPatchRequest {
  runtime?: Cron["runtime"];
  title?: string;
  action?: string;
  text?: string;
  schedule?: CronSchedule;
  enabled?: boolean;
  archived?: boolean;
  unfurlLinks?: boolean;
  session?: boolean;
  script?: CronScript | null;
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
  "nothing to change — pass title, task, schedule, enabled, archived, unfurlLinks, session, or script";

export const CRON_FIRE_NOTE_MAX_CHARS = 400;

export type ControlOk<T> = { ok: true } & T;
export type ControlErr<C extends string> = { ok: false; code: C; message: string };

export interface ControlService {
  createCron(req: CronCreateRequest, claims: CapabilityClaims): Promise<CronCreateResult>;
  listCrons(claims: CapabilityClaims, tenant: Tenant): Promise<{ crons: Cron[]; visible: VisibleCron[] }>;
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
  noteCron(
    id: string,
    text: string,
    claims: CapabilityClaims,
  ): Promise<ControlOk<{ applied: boolean }> | ControlErr<"not_found" | "forbidden" | "bad_request">>;
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
  ): Promise<
    | ControlOk<{ fireKey: string }>
    | ControlErr<"not_found" | "forbidden" | "unavailable" | "bad_request" | "already_running">
  >;
  retargetCron(
    id: string,
    destinationKey: string,
    claims: CapabilityClaims,
  ): Promise<ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden" | "unknown_destination">>;
  createWebhook(
    req: WebhookCreateRequest,
    claims: CapabilityClaims,
    publicBase: string | undefined,
    signOff?: SignOff,
  ): Promise<WebhookCreateResult>;
  listWebhooks(claims: CapabilityClaims): Promise<Webhook[]>;
  disableWebhook(
    id: string,
    claims: CapabilityClaims,
  ): Promise<ControlOk<Record<never, never>> | ControlErr<"not_found" | "forbidden">>;
  updateWebhook(
    id: string,
    patch: WebhookPatch,
    claims: CapabilityClaims,
  ): Promise<ControlOk<{ webhook: Webhook }> | ControlErr<"not_found" | "forbidden" | "bad_request">>;
  readSoul(claims: CapabilityClaims): { effectiveSoul: string; soul: string | null; soulVersion: number };
  writeSoul(
    content: string,
    claims: CapabilityClaims,
    expectedVersion?: number,
  ): Promise<ControlOk<{ version: number }> | ControlErr<SoulWriteFailureCode>>;
  shareArtifact(req: ShareArtifactRequest, claims: CapabilityClaims, signOff?: SignOff): Promise<ShareArtifactResult>;
  shareAccess(type: ArtifactType, id: string, claims: CapabilityClaims, tenant: Tenant): Promise<ShareAccessResult>;
}

type SoulWriteFailureCode = "soul_update_denied" | "soul_version_conflict" | "soul_update_failed";

function soulWriteFailureCode(e: unknown): SoulWriteFailureCode {
  if (e instanceof SoulUpdateDeniedError) return "soul_update_denied";
  if (e instanceof SoulVersionConflictError) return "soul_version_conflict";
  return "soul_update_failed";
}

export { administersCron, canAdministerCron };

async function mayShare(
  app: App,
  home: ArtifactHome,
  cron: Cron | null,
  capability: CapabilityClaims,
): Promise<boolean> {
  if (!(await personOrOwningBot(capability, () => app.samePerson(home.createdBy, capability.actorId), cron)))
    return false;
  if (cron)
    return (
      (await ownsCron(app, cron, capability.actorId)) ||
      (!actsAsScope(cron.owner, cron.ownerScopeId) && (await managesPersonaCron(app, cron, capability.actorId))) ||
      asOrgAdmin(app, capability)
    );
  return (
    (await app.canManageArtifactHome(home.ownerScopeId, home.createdBy, capability.actorId)) ||
    asOrgAdmin(app, capability)
  );
}

export async function administersWebhook(
  app: Parameters<typeof canAdministerWebhook>[0] & Pick<App, "isOrgAdmin">,
  webhook: Webhook,
  actor: Pick<CapabilityClaims, "actorId" | "botActor">,
): Promise<boolean> {
  return (await canAdministerWebhook(app, webhook, actor)) || asOrgAdmin(app, actor);
}

export async function cronTaskRewrite(
  app: Pick<
    App,
    "samePerson" | "isCurrentSharedScopeMember" | "membershipControlsScope" | "managesScope" | "isOrgAdmin"
  >,
  cron: Cron,
  editorId: string,
): Promise<Pick<CronPatch, "owner" | "script">> {
  if (actsAsScope(cron.owner, cron.ownerScopeId) || (await ownsCron(app, cron, editorId))) return {};
  if (await asOrgAdmin(app, { actorId: editorId })) return {};
  return { owner: editorId, ...(cron.script ? { script: null } : {}) };
}

const WEBHOOK_OWNER_ONLY =
  "only the webhook's owner can edit it — its fires run as them. Create your own webhook to run a different task as yourself.";

export async function editWebhook(
  app: App,
  id: string,
  patch: WebhookPatch,
  editor: ActingClaims,
): Promise<ControlOk<{ webhook: Webhook }> | ControlErr<"not_found" | "forbidden" | "bad_request">> {
  const principalId = editor.actorId;
  if (patch.action === undefined && patch.title === undefined)
    return { ok: false, code: "bad_request", message: "expected a new task and/or title" };
  if (patch.action !== undefined && !patch.action.trim())
    return { ok: false, code: "bad_request", message: "task cannot be empty" };
  if (patch.title !== undefined && !patch.title.trim())
    return { ok: false, code: "bad_request", message: "title cannot be empty" };
  const webhook = await app.getWebhook(id);
  if (!webhook) return { ok: false, code: "not_found", message: `no webhook ${id}` };
  if (!(await administersWebhook(app, webhook, editor)))
    return { ok: false, code: "forbidden", message: "not your webhook" };
  if (!(await app.samePerson(webhook.owner, principalId)) && !(await asOrgAdmin(app, editor)))
    return { ok: false, code: "forbidden", message: WEBHOOK_OWNER_ONLY };
  const updated = await app.updateWebhook(id, patch);
  return updated ? { ok: true, webhook: updated } : { ok: false, code: "not_found", message: `no webhook ${id}` };
}

export async function canAdministerWebhook(
  app: Pick<App, "membershipControlsScope" | "managesScope" | "samePerson">,
  webhook: Pick<Webhook, "ownerScopeId" | "owner" | "botActor">,
  actor: Pick<CapabilityClaims, "actorId" | "botActor">,
  isActor?: (id: string) => Promise<boolean>,
): Promise<boolean> {
  const owns = () => (isActor ? isActor(webhook.owner) : app.samePerson(webhook.owner, actor.actorId));
  if (!(await personOrOwningBot(actor, owns, webhook))) return false;
  if (await app.membershipControlsScope(webhook.ownerScopeId))
    return app.managesScope(actor.actorId, webhook.ownerScopeId);
  return owns();
}

function withDefaultTimezone(schedule: CronSchedule, cap: CapabilityClaims): CronSchedule {
  if (schedule.cron === undefined || schedule.timezone !== undefined) return schedule;
  const tz = typeof cap.timezone === "string" && cap.timezone.trim() ? cap.timezone : DEFAULT_CRON_TIMEZONE;
  return { ...schedule, timezone: tz };
}

function hasCronPatchField(req: CronPatchRequest): boolean {
  return (
    req.runtime !== undefined ||
    req.title !== undefined ||
    req.action !== undefined ||
    req.text !== undefined ||
    req.schedule !== undefined ||
    req.enabled !== undefined ||
    req.archived !== undefined ||
    req.unfurlLinks !== undefined ||
    req.session !== undefined ||
    req.script !== undefined
  );
}

async function personaHome(app: App, actorId: string, ref: string): Promise<ScopeId | ControlErr<"forbidden">> {
  const listed = await app.personas?.list(actorId);
  if (listed?.status !== "ok")
    return {
      ok: false,
      code: "forbidden",
      message:
        listed?.status === "disabled"
          ? "personas are not enabled for you, so a persona can't own this cron"
          : `couldn't look up your personas (${listed?.status ?? "personas unavailable"})`,
    };
  const named = listed.value.filter((p) => p.name.trim().toLowerCase() === ref.trim().toLowerCase());
  const persona = listed.value.find((p) => p.id === ref) ?? (named.length === 1 ? named[0] : undefined);
  if (!persona)
    return {
      ok: false,
      code: "forbidden",
      message: named.length
        ? `more than one of your personas is named "${ref}" — pass one id: ${named.map((p) => p.id).join(", ")}`
        : `you have no access to a persona "${ref}"`,
    };
  const home = scopeId("persona", persona.id);
  if (await app.managesScope(actorId, home)) return home;
  return {
    ok: false,
    code: "forbidden",
    message: `only owners and write holders of the persona ${persona.name} can give it a cron — an owner can grant write on its page`,
  };
}

function conversationSessionRef(
  capability: Pick<CapabilityClaims, "threadRef" | "origin" | "scopeId">,
  cronScopeId: string,
): string | undefined {
  const background = capability.origin !== undefined && capability.origin !== "conversation";
  return background || capability.scopeId !== cronScopeId ? undefined : capability.threadRef;
}

function cronPatchChanges(before: Cron, patch: CronPatch): boolean {
  return (Object.entries(patch) as Array<[keyof CronPatch, unknown]>).some(
    ([key, value]) => !isDeepStrictEqual(before[key as keyof Cron], value),
  );
}

function patchFromCronPatchRequest(
  before: Cron,
  req: CronPatchRequest,
  capability: CapabilityClaims,
): CronPatch | ControlErr<"bad_request"> {
  if (!hasCronPatchField(req)) {
    return {
      ok: false,
      code: "bad_request",
      message: CRON_PATCH_NOTHING_TO_CHANGE,
    };
  }
  if (req.unfurlLinks !== undefined && !before.destination) {
    return {
      ok: false,
      code: "bad_request",
      message: "unfurlLinks can only be set on a cron with a delivery destination",
    };
  }
  const sessionRef = req.session ? conversationSessionRef(capability, before.ownerScopeId) : undefined;
  if (req.session && !sessionRef) {
    return {
      ok: false,
      code: "bad_request",
      message: "session:true needs a live conversation in the cron's own scope to tie it to",
    };
  }
  return {
    ...(req.session !== undefined && sessionRef !== before.sessionRef ? { sessionRef: sessionRef ?? null } : {}),
    ...(req.runtime !== undefined ? { runtime: req.runtime } : {}),
    ...(req.title !== undefined ? { title: req.title } : {}),
    ...(req.action !== undefined ? { action: req.action } : {}),
    ...(req.text !== undefined ? { message: req.text } : {}),
    ...(req.schedule !== undefined ? { schedule: withDefaultTimezone(req.schedule, capability) } : {}),
    ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
    ...(req.archived !== undefined ? { archived: req.archived } : {}),
    ...(req.unfurlLinks !== undefined && before.destination
      ? { destination: withSlackUnfurlOption(before.destination, req.unfurlLinks) }
      : {}),
  };
}

export function createControlService(app: App, scheduler?: Scheduler): ControlService {
  const notifyEdit = (
    cron: Cron,
    cap: CapabilityClaims,
    changeSummary: string[],
    detail?: CronEditDetail,
  ): Promise<void> =>
    notifyOwnerOfCronEdit(app, {
      cron,
      editorId: cap.actorId,
      changeSummary,
      ...(detail ? { detail } : {}),
    });
  const trialIn =
    (cron: ScriptTrialCron, capability: CapabilityClaims) =>
    async (script: CronScript): Promise<string | undefined> => {
      if (!scheduler) return "the scheduler isn't running here, so a cron's script can't be tried";
      const run = await scheduler.trialScript(cron, script);
      if (run.status === "silent" && run.scriptVerdict) return undefined;
      const { inOwnPrivate, roomScope } = selfReadAudience(capability, capability.actorId);
      return scriptTrialRefusal(
        run.reason ?? run.status,
        inOwnPrivate || roomScope === cron.ownerScopeId ? run.reply : undefined,
      );
    };
  return {
    async createCron(req, capability): Promise<CronCreateResult> {
      if (req.action === undefined && req.text === undefined) {
        return { ok: false, code: "bad_request", message: "task (what to do) or text (exact text to send) required" };
      }
      const script = req.script ? cronScriptFrom(req.script, req) : undefined;
      if (typeof script === "string") return { ok: false, code: "bad_request", message: script };
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

      if (req.unfurlLinks !== undefined && !destination) {
        return {
          ok: false,
          code: "bad_request",
          message: "unfurlLinks can only be set on a cron with a delivery destination",
        };
      }
      if (destination) destination = withSlackUnfurlOption(destination, req.unfurlLinks);
      if (typeof req.persona === "string") {
        if (!req.persona.trim())
          return { ok: false, code: "bad_request", message: "persona must be a non-empty name/id or null" };
        const home = await personaHome(app, capability.actorId, req.persona);
        if (typeof home === "object") return home;
        ownerScopeId = home;
        destination ??= principalDestination(capability.actorId, capability.actorId);
      } else if (
        req.persona === undefined &&
        !wantsPersonal &&
        !resolvedRecipient &&
        parseScopeId(destination?.audienceScopeId ?? ownerScopeId).kind === "personal" &&
        capability.destination?.persona?.id
      ) {
        const home = scopeId("persona", capability.destination.persona.id);
        if (await app.managesScope(capability.actorId, home)) {
          ownerScopeId = home;
          destination ??= principalDestination(capability.actorId, capability.actorId);
        }
      }

      const input: CreateCronInput = {
        schedule: withDefaultTimezone(req.schedule, capability),
        ...(req.runtime !== undefined ? { runtime: req.runtime } : {}),
        ...(req.action !== undefined ? { action: req.action } : {}),
        ...(req.text !== undefined ? { message: req.text } : {}),
        owner: capability.actorId,
        createdBy: capability.actorId,
        ownerScopeId,
        ...(capability.botActor ? { botActor: true } : {}),
        ...(typeof req.title === "string" ? { title: req.title } : {}),
        ...(destination ? { destination } : {}),
        ...(script ? { script } : {}),
      };
      const sessionRef = req.session === false ? undefined : conversationSessionRef(capability, ownerScopeId);
      if (sessionRef) input.sessionRef = sessionRef;
      try {
        const cron = await app.createCron(input, trialIn(input, capability));
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

    async listCrons(capability, tenant) {
      const { visible } = await app.listCronsForViewer(capability.actorId);
      const all = await app.listCrons();
      const admits = await app.cronAdministration(tenant, capability, all);
      const administered = all.filter((_, i) => admits[i]).map(withSharing(all));
      const ids = new Set(administered.map((c) => c.id));
      return { crons: administered, visible: visible.filter((c) => !ids.has(c.id)) };
    },

    async getCron(id, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (await administersCron(app, cron, capability)) return { ok: true, cron: await app.cronSharing(cron) };
      const { visible } = await app.listCronsForViewer(capability.actorId);
      if (visible.some((c) => c.id === id)) return { ok: true, cron };
      return { ok: false, code: "forbidden", message: "not your cron" };
    },

    async getCronRuns(id, req, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await administersCron(app, cron, capability)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      if (req.limit !== undefined && (!Number.isSafeInteger(req.limit) || req.limit < 1)) {
        return { ok: false, code: "bad_request", message: "limit must be a positive integer" };
      }
      const { runs, total } = await app.listCronFires(id, req.limit !== undefined ? { limit: req.limit } : {});
      return { ok: true, cron, runs, total };
    },

    async patchCron(id, req, capability) {
      const before = await app.getCron(id);
      if (!before) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await administersCron(app, before, capability)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      const patch = patchFromCronPatchRequest(before, req, capability);
      if ("ok" in patch) return patch;
      const owner = await ownsCron(app, before, capability.actorId);
      const adminOverOwner = !owner && (await asOrgAdmin(app, capability));
      if (req.script !== undefined && !owner && !adminOverOwner)
        return { ok: false, code: "forbidden", message: "only the cron's owner can change its script" };
      if (req.script) {
        const script = cronScriptFrom(req.script, before, req);
        if (typeof script === "string") return { ok: false, code: "bad_request", message: script };
        patch.script = script;
      } else if (before.script && (req.script === null || req.text !== undefined)) patch.script = null;
      const rewritesTask = req.action !== undefined || req.text !== undefined;
      if (rewritesTask || patch.script) Object.assign(patch, await cronTaskRewrite(app, before, capability.actorId));
      if (!cronPatchChanges(before, patch)) return { ok: true, cron: before };
      try {
        const cron = await app.updateCron(id, patch, capability, trialIn({ ...before, ...patch }, capability));
        if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
        const changeSummary: string[] = [];
        if (req.runtime !== undefined) changeSummary.push("runtime");
        if (req.title !== undefined) changeSummary.push("title");
        if (req.action !== undefined || req.text !== undefined) changeSummary.push("task");
        if (patch.owner !== undefined) changeSummary.push("owner");
        if (req.schedule !== undefined) changeSummary.push("schedule");
        if (req.enabled !== undefined) changeSummary.push(`enabled=${req.enabled}`);
        if (req.archived !== undefined) changeSummary.push(`archived=${req.archived}`);
        if (req.unfurlLinks !== undefined) changeSummary.push(`unfurlLinks=${req.unfurlLinks}`);
        if (patch.script !== undefined) changeSummary.push("script");
        if (req.session !== undefined)
          changeSummary.push(req.session ? "tied to a session" : "untied from its session");
        const detail: CronEditDetail =
          req.schedule !== undefined ? { schedule: withDefaultTimezone(req.schedule, capability) } : {};
        await notifyEdit({ ...cron, owner: before.owner }, capability, changeSummary, detail);
        return { ok: true, cron };
      } catch (e) {
        return { ok: false, code: "cron_update_failed", message: errMessage(e) };
      }
    },

    async noteCron(id, text, capability) {
      const flattened = flattenFireNote(text);
      if (!flattened)
        return { ok: false, code: "bad_request", message: "the note is empty — say what the next fire should know" };
      const length = [...flattened].length;
      if (length > CRON_FIRE_NOTE_MAX_CHARS) {
        return {
          ok: false,
          code: "bad_request",
          message: `the note is ${length} chars — the cap is ${CRON_FIRE_NOTE_MAX_CHARS}. Trim it to the outcome plus what the next fire must know; publish longer state to this conversation's Files with the upload helper listed in GET /v1/apis, verify success, and put the file ID in the note for GET /v1/files/:id/content. If publication is unavailable, report it and retain needed local state on a scoped computer.`,
        };
      }
      if (echoesCronContextMarkers(flattened)) {
        return {
          ok: false,
          code: "bad_request",
          message: "the note can't include the cron runtime context markers — write a plain report instead",
        };
      }
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await administersCron(app, cron, capability)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      if (cron.archived) {
        return {
          ok: false,
          code: "bad_request",
          message: `cron ${id} is archived — its fires won't run, so a note would never be read`,
        };
      }
      if (!cronFireReadsNotes(cron)) {
        return {
          ok: false,
          code: "bad_request",
          message: `cron ${id}'s fires don't read shift-change notes (it is loop-backed, one-shot, or runs a raw !run/!scratch task) — publish durable handoff state to this conversation's Files with the upload helper listed in GET /v1/apis and verify success. Keep the published file ID in the consuming workflow for GET /v1/files/:id/content; these fires cannot recover it from a note. If publication is unavailable, report it and retain needed local state on a scoped computer.`,
        };
      }
      const ownFire = capability.threadRef?.startsWith(`cron:${id}:fire:`) === true;
      const fireEntry = ownFire ? await app.latestCronFireForThread(id, capability.threadRef!) : undefined;
      const outcome = await app.setCronFireNote(
        id,
        {
          text: flattened,
          at: fireEntry?.firedAt ?? Date.now(),
          ...(ownFire ? {} : { by: capability.actorId }),
        },
        capability,
      );
      if (outcome === "missing") return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (outcome === "applied" && !ownFire) await notifyEdit(cron, capability, ["note"]);
      return { ok: true, applied: outcome === "applied" };
    },

    async deleteCron(id, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await administersCron(app, cron, capability)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      await app.deleteCron(id, capability);
      await notifyEdit(cron, capability, ["deleted"]);
      return { ok: true };
    },

    async setCronEnabled(id, enabled, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await administersCron(app, cron, capability)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      if (cron.enabled === enabled) return { ok: true, cron };
      await app.setCronEnabled(id, enabled);
      await notifyEdit(cron, capability, [`enabled=${enabled}`]);
      const after = await app.getCron(id);
      return { ok: true, cron: after ?? cron };
    },

    async runCron(id, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await administersCron(app, cron, capability)))
        return { ok: false, code: "forbidden", message: "not your cron" };
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
      const result = await scheduler.runNow(id);
      if (!result.started) {
        const refusal = describeRunNowRefusal(id, result)!;
        return { ok: false, code: refusal.error, message: refusal.message };
      }
      return { ok: true, fireKey: result.fireKey };
    },

    async retargetCron(id, destinationKey, capability) {
      const cron = await app.getCron(id);
      if (!cron) return { ok: false, code: "not_found", message: `no cron ${id}` };
      if (!(await administersCron(app, cron, capability)))
        return { ok: false, code: "forbidden", message: "not your cron" };
      const resolved = resolveCapabilityDestination(capability, destinationKey);
      if (!resolved.ok) {
        return {
          ok: false,
          code: "unknown_destination",
          message: "destinationKey is not one of the destinations available for this conversation",
        };
      }
      if (isDeepStrictEqual(cron.destination, resolved.destination)) return { ok: true, cron };
      const updated = await app.setCronDestination(id, resolved.destination, capability);
      const destLabel = capability.destinations?.find((d) => d.key === destinationKey)?.label;
      await notifyEdit(cron, capability, ["destination"], destLabel ? { destinationLabel: destLabel } : undefined);
      return { ok: true, cron: updated ?? cron };
    },

    async createWebhook(req, capability, publicBase, signOff = unsigned): Promise<WebhookCreateResult> {
      if (!carriesPersonAuthority(capability))
        return { ok: false, code: "forbidden", message: "registering a webhook needs its owner's own authority" };
      const resolved = resolveCapabilityDestination(capability, req.destinationKey);
      if (!resolved.ok) {
        return {
          ok: false,
          code: "unknown_destination",
          message: "destinationKey is not one of the destinations available for this conversation",
        };
      }
      const shown = { ...req, verification: { ...req.verification, secret: "***" } };
      if (
        !(await signOff({ summary: `Register webhook "${req.title}"`, key: `webhook:${JSON.stringify(req)}`, shown }))
      )
        return { ok: false, code: "approval_required", message: SIGN_OFF_PENDING };
      const input: CreateWebhookInput = {
        ...(req.title !== undefined ? { title: req.title } : {}),
        action: req.action,
        verification: req.verification,
        owner: capability.actorId,
        createdBy: capability.actorId,
        ownerScopeId: capability.scopeId,
        ...(req.filters?.length ? { filters: req.filters } : {}),
        ...(resolved.destination ? { destination: resolved.destination } : {}),
      };
      try {
        const webhook = await app.createWebhook(input);
        const incomingPath = `/v1/webhooks/incoming/${webhook.id}`;
        const base = publicBase ? publicBase.replace(/\/$/, "") : "";
        return {
          ok: true,
          webhook,
          url: base ? `${base}${incomingPath}` : incomingPath,
          ...(webhook.verification.secret ? { secret: webhook.verification.secret } : {}),
        };
      } catch (e) {
        return { ok: false, code: "webhook_create_failed", message: errMessage(e) };
      }
    },

    async listWebhooks(capability) {
      const all = await app.listWebhooks();
      const isActor = await app.personMatcher(capability.actorId);
      const allowed = await Promise.all(all.map((webhook) => canAdministerWebhook(app, webhook, capability, isActor)));
      return all.filter((_webhook, index) => allowed[index]);
    },

    async disableWebhook(id, capability) {
      const webhook = await app.getWebhook(id);
      if (!webhook) return { ok: false, code: "not_found", message: `no webhook ${id}` };
      if (!(await administersWebhook(app, webhook, capability)))
        return { ok: false, code: "forbidden", message: "not your webhook" };
      await app.setWebhookEnabled(id, false);
      return { ok: true };
    },

    async updateWebhook(id, patch, capability) {
      return editWebhook(app, id, patch, capability);
    },

    readSoul(capability) {
      const { effectiveSoul, soul, soulVersion } = app.getSoul(capability.scopeId, {
        actorId: capability.actorId,
        ownScopeBotWork: isOwnScopeBotWork(capability),
      });
      return { effectiveSoul, soul, soulVersion };
    },

    async writeSoul(content, capability, expectedVersion) {
      try {
        const version = await app.updateSoul(capability.scopeId, content, capability.actorId, {
          allowSharedScope: capability.botActor !== true,
          botActor: capability.botActor === true,
          expectedVersion,
          sessionId: capability.sessionId,
        });
        return { ok: true, version };
      } catch (e) {
        return {
          ok: false,
          code: soulWriteFailureCode(e),
          message: errMessage(e),
        };
      }
    },

    async shareAccess(type, id, capability, tenant): Promise<ShareAccessResult> {
      const home = await app.getArtifactHome(type, id);
      if (!home) return { ok: false, code: "not_found", message: `no ${type} "${id}"` };
      const cron = type === "cron" ? await app.getCron(home.id) : null;
      if (!(await mayShare(app, home, cron, capability)))
        return {
          ok: false,
          code: "forbidden",
          message: `only the ${type}'s owner can see and change who it is shared with`,
        };
      return {
        ok: true,
        type,
        id: home.id,
        owner: home.ownerScopeId,
        offers: shareOffers(type, home),
        access: [
          ...(type === "deploy"
            ? await app.appGrantees(home.id)
            : await app.grantees(tenant, home.ownerScopeId, home.grantRef)),
          ...(cron ? await app.cronCopies(cron.id) : []).map((c) => ({
            scope: scopeId("personal", c.owner),
            permission: "read" as const,
            status: c.status,
          })),
        ],
      };
    },

    async shareArtifact(req, capability, signOff = unsigned): Promise<ShareArtifactResult> {
      const personAuthority = carriesPersonAuthority(capability);
      if (req.type === "deploy" && !personAuthority)
        return { ok: false, code: "forbidden", message: "changing who can reach an app needs its owner's authority" };
      const permission: Permission = req.permission === "write" ? "write" : "read";
      const remove = req.permission === "none";
      const notify = { notify: req.notify };
      const home = await app.getArtifactHome(req.type, req.id);
      if (!home)
        return {
          ok: false,
          code: "not_found",
          message:
            req.type === "file"
              ? `no Files record "${req.id}"; put the file in Files first with the helper from GET /v1/files/upload-client, then share its ID`
              : `no ${req.type} "${req.id}"`,
        };
      const sourceWithheld =
        req.type === "skill" ? capability.botActor === true : req.type === "file" && isOwnScopeBotWork(capability);
      if (!loadsScopeContext(capability.actorId, home.ownerScopeId, sourceWithheld))
        return {
          ok: false,
          code: "forbidden",
          message: "a Slack bot's work cannot share or move a person's own files or skills",
        };

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
      if (!loadsScopeContext(capability.actorId, toScope, capability.botActor === true))
        return {
          ok: false,
          code: "forbidden",
          message: "a Slack bot's work cannot share or move anything into a person's own library",
        };
      const toKind = parseScopeId(toScope).kind;

      const isOrg = toKind === "org";
      const orgSkillCede = isOrg && req.type === "skill" && !remove;

      const cron = req.type === "cron" ? await app.getCron(home.id) : null;
      const copyTo =
        cron && deliversToOwner(cron) && toKind === "personal" && permission === "read" && !req.move
          ? parseScopeId(toScope).ref
          : undefined;
      if (!remove && permission === "write" && !shareOffers(req.type, home).manage)
        return {
          ok: false,
          code: "bad_request",
          message: "a personal cron runs with your whole keychain, so it can't be shared for editing",
        };
      const ceding = orgSkillCede && personAuthority && (await app.isOrgAdmin(capability.actorId));
      if (orgSkillCede ? !ceding : !(await mayShare(app, home, cron, capability))) {
        const who = {
          cron: "only the cron's owner can share it",
          deploy: "only the owner can change who can reach this app",
          skill: orgSkillCede ? "only an org admin can promote a skill org-wide" : undefined,
        }[req.type as string];
        return {
          ok: false,
          code: "forbidden",
          message: who ?? `only the ${req.type}'s owner (or a member of its shared home) can share or move it`,
        };
      }
      if (
        !remove &&
        (toKind === "channel" || toKind === "group" || toKind === "team" || toKind === "persona") &&
        !(await app.belongsToScope(capability.actorId, toScope))
      ) {
        return {
          ok: false,
          code: "forbidden",
          message:
            toKind === "persona"
              ? `you can't ${req.move ? "move" : "share"} into ${target.label} — you need write or owner access on that persona`
              : `you can't ${req.move ? "move" : "share"} into ${target.label} — you're not a member of that context`,
        };
      }
      const summary = `${req.move ? "Move" : "Share"} ${req.type} ${req.id} to ${target.label}`;
      const needsCard = (req.type === "deploy" && !remove) || orgSkillCede;
      if (needsCard && !(await signOff({ summary, key: `share:${JSON.stringify(req)}` })))
        return { ok: false, code: "approval_required", message: SIGN_OFF_PENDING };

      const tenant = ambientTenant();
      const shared = { type: req.type, id: home.id, target: { scope: toScope, label: target.label }, permission };
      try {
        if (copyTo && remove) await app.unshareCron(home.id, copyTo);
        if (copyTo && !remove) {
          const homeTarget = parseScopeId(cron!.destination?.audienceScopeId ?? cron!.ownerScopeId);
          if (homeTarget.kind === "personal" && (await app.samePerson(copyTo, homeTarget.ref)))
            return {
              ok: false,
              code: "bad_request",
              message: (await app.samePerson(copyTo, capability.actorId))
                ? "that cron is already yours"
                : "that cron already posts to their DM",
            };
          const { copy, existed, note } = await app.shareCron(tenant, home.id, copyTo, capability.actorId);
          return {
            ok: true,
            verb: "share",
            type: req.type,
            id: home.id,
            target: { scope: toScope, label: target.label },
            permission,
            copy: { id: copy.id, enabled: copy.enabled, existed, ...(note ? { note } : {}) },
          };
        }
        if (orgSkillCede) {
          const promoted = await app.promoteSkill(home.id, toScope, capability.actorId, personAuthority);
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
          const deployPersonTransfer = req.type === "deploy" && toKind === "personal" && personAuthority;
          if (toKind === "persona" && req.type !== "skill" && req.type !== "file") {
            return {
              ok: false,
              code: "forbidden",
              message: `a persona holds skills, files and notes; a ${req.type} can't move into one`,
            };
          }
          if (!deployPersonTransfer && !(await app.belongsToScope(capability.actorId, toScope))) {
            return {
              ok: false,
              code: "forbidden",
              message: `you can only move a ${req.type} into a context you belong to — to give it to a teammate, share it (a grant) instead`,
            };
          }
          if (
            req.type === "skill" &&
            !personAuthority &&
            (isMultiMemberSkillScope(home.ownerScopeId) || isMultiMemberSkillScope(toScope))
          ) {
            return { ok: false, code: "forbidden", message: SHARED_SKILL_REFUSAL };
          }
          await app.moveArtifactHome(req.type, home.id, toScope, capability.actorId);
          return { ok: true, verb: "move", ...shared };
        }

        const verb = remove ? "unshare" : "share";
        const invite =
          req.type === "deploy" && req.email !== undefined && permission === "read" && !remove
            ? await app.inviteToApp(
                home.id,
                req.email,
                { createdBy: capability.actorId, botActor: capability.botActor },
                notify,
              )
            : undefined;
        if (invite) return { ok: true, verb, ...shared, invitation: invite.invitation };
        if (remove) await app.revokeGrant(tenant, home.ownerScopeId, home.grantRef, toScope, capability.actorId);
        else
          await app.grant(
            tenant,
            {
              ownerScopeId: home.ownerScopeId,
              ref: home.grantRef,
              granteeScopeId: toScope,
              permission,
              grantedBy: capability.actorId,
            },
            notify,
          );
        return { ok: true, verb, ...shared };
      } catch (e) {
        if (e instanceof AdminError || (e instanceof DeployAccessError && e.code === "forbidden")) {
          return { ok: false, code: "forbidden", message: errMessage(e) };
        }
        if (e instanceof DeployAccessError) return { ok: false, code: e.code, message: errMessage(e) };
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
    { scope: req.scope, recipient: req.recipient, email: req.email },
    {
      allowEmail: req.type === "deploy" && !req.move,
      invalidScope: (scope) => `invalid scope "${scope}" — use "org" or a scope id like personal:<id> or channel:<id>`,
      targetRequired: 'a target is required: pass `toScope` ("org", a scope id, or a teammate\'s name)',
    },
  );
  return r.kind === "ambiguous"
    ? { kind: "ambiguous", candidates: r.candidates.map((c) => ({ id: c.principalId, label: c.displayName })) }
    : r;
}
