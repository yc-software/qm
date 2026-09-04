import type {
  DeliveryProvenance,
  Destination,
  Principal,
  RecipientConsent,
  ScopeId,
  TurnRequest,
  TurnResult,
} from "../types.ts";
import { parseScopeId } from "../types.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { IdempotencyStore } from "../idempotency/idempotency-store.ts";
import { turnModelOptions } from "../core/turn-options.ts";
import { principalDestination, reachEnqueue } from "../reach/reach.ts";
import { consentRequiredRecipient, recipientConsentSatisfied } from "./trigger-store.ts";
import { isVisible, type VisibilityDirectory } from "../directory/visibility.ts";
import { samePerson } from "../directory/person.ts";
import type { CurrentScopeMembers } from "../resolution/scope-membership.ts";

const MEMBERSHIP_SKIP_NOTE = "the acting person is no longer a member of this trigger's home scope — run skipped";
const UNKNOWN_HOME_SKIP_NOTE =
  "this trigger's home scope is missing from the directory snapshot (roster sync gap) and the acting person has no session there — run skipped";

export interface TriggerDeps {
  deliveries: DeliveryStore;
  idempotency: IdempotencyStore;
  identity: IdentityService;
  run: (req: TurnRequest) => Promise<TurnResult>;
  currentScopeMembers?: CurrentScopeMembers;
  directory?: VisibilityDirectory & {
    get(principalId: string): Promise<{ displayName: string } | null>;
    channelPrivacy?(channelId: string): Promise<boolean | undefined>;
    groupMembership?(groupId: string, principalId: string): Promise<boolean | undefined>;
  };
  sessions?: { listByParticipant(principalId: string): Promise<readonly { scopeId: ScopeId }[]> };
}

export interface TriggerSpec {
  owner: string;
  ownerScopeId: ScopeId;
  input: string;
  securityScreenData?: string;
  fireKey: string;
  surface: string;
  destination?: Destination;
  message?: string;
  threadRef?: string;
  runAs?: "owner" | "scopeFloor" | "scopeShared";
  unattendedGrants?: string[];
  members?: Principal[];
  recipientConsent?: RecipientConsent;
  recipientConsentRequired?: boolean;
  shadow?: boolean;
  thinkingLevel?: string;
  readOnly?: boolean;
  turnWallClockMs?: number;
  errorNotice?: (noteOrStatus: string) => string;
}

export interface TriggerOutcome {
  authzFailed: boolean;
  ran: boolean;
  status?: TurnResult["status"];
  note?: string;
  reply?: string;
  sessionId?: string;
}

function isTriggerFailure(outcome: TriggerOutcome): boolean {
  return outcome.ran && outcome.status !== undefined && outcome.status !== "ok" && outcome.status !== "silent";
}

const NO_UPDATE_SENTINEL = "[no-update]";
const SILENT_POLL_MARKERS = new Set([NO_UPDATE_SENTINEL, "no_reply", "[silent]"]);

const POLL_SURFACES = new Set(["cron", "webhook", "monitor"]);
export const isPollSurface = (surface: string): boolean => POLL_SURFACES.has(surface);

export function isSilentPollReply(reply: string): boolean {
  const finalLine = reply
    .trimEnd()
    .split(/\r?\n/)
    .findLast((line) => line.trim() !== "")
    ?.trim()
    .toLowerCase();
  return finalLine === undefined || SILENT_POLL_MARKERS.has(finalLine);
}

function deliveryProvenance(spec: TriggerSpec, threadRef: string, res?: TurnResult): DeliveryProvenance {
  return {
    trigger: spec.surface,
    surface: spec.surface,
    fireKey: spec.fireKey,
    sourceScopeId: spec.ownerScopeId,
    sourceThreadRef: threadRef,
    ...(res?.sessionId ? { sourceSessionId: res.sessionId } : {}),
    ...(res?.sourceUserSeq !== undefined ? { sourceUserSeq: res.sourceUserSeq } : {}),
    ...(res?.sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq: res.sourceAssistantEntrySeq } : {}),
  };
}

async function relayAttribution(deps: TriggerDeps, spec: TriggerSpec): Promise<string | undefined> {
  if (spec.message === undefined || !deps.directory) return undefined;
  const member = await deps.directory.get(spec.owner).catch(() => null);
  return member?.displayName;
}

async function participatesInScope(deps: TriggerDeps, actorId: string, scope: ScopeId): Promise<boolean> {
  const sessions = await deps.sessions?.listByParticipant(actorId).catch(() => []);
  return sessions?.some((s) => s.scopeId === scope) === true;
}

async function actorMayReadScope(
  deps: TriggerDeps,
  actorId: string,
  kind: string | null,
  ref: string,
  scope: ScopeId,
  snapshotGap: boolean,
): Promise<{ ok: boolean; note?: string }> {
  if (!ref) return { ok: false, note: MEMBERSHIP_SKIP_NOTE };
  if (kind === "personal") return samePerson(actorId, ref) ? { ok: true } : { ok: false, note: MEMBERSHIP_SKIP_NOTE };
  if (!deps.directory)
    return kind !== "group" && kind !== "channel" ? { ok: true } : { ok: false, note: MEMBERSHIP_SKIP_NOTE };
  if (kind === "group") {
    if (await isVisible(deps.directory, actorId, { kind: "group", groupId: ref })) return { ok: true };
    if (snapshotGap) {
      if (await participatesInScope(deps, actorId, scope)) return { ok: true };
      return { ok: false, note: UNKNOWN_HOME_SKIP_NOTE };
    }
    const known = await deps.directory.groupMembership?.(ref, actorId).catch(() => undefined);
    if (known === undefined && (await participatesInScope(deps, actorId, scope))) return { ok: true };
    return { ok: false, note: MEMBERSHIP_SKIP_NOTE };
  }
  if (kind !== "channel") return { ok: true };
  const isPrivate = await deps.directory.channelPrivacy?.(ref);
  if (isPrivate === undefined) {
    if (await participatesInScope(deps, actorId, scope)) return { ok: true };
    return { ok: false, note: UNKNOWN_HOME_SKIP_NOTE };
  }
  if (await isVisible(deps.directory, actorId, { kind: "channel", channelId: ref, isPrivate })) return { ok: true };
  return { ok: false, note: MEMBERSHIP_SKIP_NOTE };
}

export async function destinationVisible(
  deps: TriggerDeps,
  actorId: string,
  destination: Destination,
): Promise<boolean> {
  if (!deps.directory) return true;
  const id = destination.target.split(":")[0]!;
  if (destination.type === "slack") {
    const audience = destination.audienceScopeId ? parseScopeId(destination.audienceScopeId) : undefined;
    if (audience?.kind === "personal") return isVisible(deps.directory, actorId, { kind: "dm", ownerId: audience.ref });
    if (audience?.kind === "group") return isVisible(deps.directory, actorId, { kind: "group", groupId: id });
    return isVisible(deps.directory, actorId, { kind: "channel", channelId: id });
  }
  if (destination.type === "group") return isVisible(deps.directory, actorId, { kind: "group", groupId: id });
  return true;
}

export async function runTrigger(deps: TriggerDeps, spec: TriggerSpec): Promise<TriggerOutcome> {
  await deps.identity.refresh();
  const isScopeFloor = spec.runAs === "scopeFloor";
  const isScopeShared = spec.runAs === "scopeShared";
  const currentMembers = await deps.currentScopeMembers?.(spec.ownerScopeId);
  const members = currentMembers ?? spec.members ?? [];
  let actorId = spec.owner;
  if (isScopeFloor) {
    const internalMembers = members.filter(
      (m) => m.type === "internal" && deps.identity.classify(m.id).type === "internal",
    );
    if (internalMembers.length === 0) {
      return { authzFailed: true, ran: false, note: "scopeFloor cron has no internal members left" };
    }
    if (!internalMembers.some((m) => samePerson(m.id, spec.owner))) actorId = internalMembers[0]!.id;
  } else {
    const owner = deps.identity.classify(spec.owner);
    if (owner.type !== "internal") {
      return { authzFailed: true, ran: false, note: "owner is no longer an internal principal" };
    }
    if (isScopeShared && currentMembers && !currentMembers.some((member) => samePerson(member.id, spec.owner))) {
      return { authzFailed: true, ran: false, note: "scopeShared owner is no longer a current scope member" };
    }
  }

  const audience =
    (isScopeFloor || isScopeShared) && members.length
      ? members.map((m) => ({ externalId: m.id, ...(m.teamIds ? { teamIds: m.teamIds } : {}) }))
      : undefined;
  const { kind: ownerKind, ref: ownerRef } = parseScopeId(spec.ownerScopeId);
  const threadRef = spec.threadRef ?? spec.fireKey;
  let conversation: TurnRequest["conversation"] = { kind: "dm", threadRef };
  if (ownerKind === "channel") {
    conversation = { kind: "channel", channelRef: ownerRef, threadRef, ...(audience ? { audience } : {}) };
  } else if (ownerKind === "group") {
    conversation = { kind: "group", channelRef: ownerRef, threadRef, ...(audience ? { audience } : {}) };
  }

  let homeAccess: { ok: boolean; note?: string };
  if (currentMembers !== undefined) {
    homeAccess = currentMembers.some((member) => samePerson(member.id, actorId))
      ? { ok: true }
      : { ok: false, note: MEMBERSHIP_SKIP_NOTE };
  } else if (!deps.directory) {
    homeAccess = { ok: true };
  } else {
    homeAccess = await actorMayReadScope(
      deps,
      actorId,
      ownerKind,
      ownerRef,
      spec.ownerScopeId,
      deps.currentScopeMembers !== undefined,
    );
  }
  const destinationIsHome = spec.destination?.audienceScopeId === spec.ownerScopeId;
  const deliverable = spec.destination
    ? (destinationIsHome && homeAccess.ok) || (await destinationVisible(deps, actorId, spec.destination))
    : true;
  const notVisibleNote = "destination is no longer visible to the cron owner — delivery skipped";
  const requiredRecipient = consentRequiredRecipient({
    owner: spec.owner,
    standing: spec.recipientConsentRequired === true,
    destination: spec.destination,
  });
  const consented = recipientConsentSatisfied(spec, requiredRecipient);
  const consentNote =
    spec.recipientConsent?.status === "declined"
      ? "recipient turned this delivery off — skipped"
      : "awaiting the recipient's consent — delivery skipped";
  const liveDelivery = spec.surface === "monitor" && Boolean(spec.destination) && consented && deliverable;

  let status: TurnResult["status"] | undefined;
  let note: string | undefined;
  let reply: string | undefined;
  let sessionId: string | undefined;
  const ownerSkipNotice = async () => {
    await deps.deliveries.enqueue({
      destination: principalDestination(spec.owner, spec.owner),
      text: `Scheduled delivery skipped: ${consentNote}`,
      idempotencyKey: `${spec.fireKey}:err`,
      provenance: deliveryProvenance(spec, threadRef),
      ...(spec.shadow ? { shadow: true } : {}),
    });
  };
  const ran = await deps.idempotency.once(spec.fireKey, async () => {
    if (spec.message !== undefined) {
      status = "ok";
      if (!spec.destination) return;
      if (!consented) {
        status = "refused";
        note = consentNote;
        await ownerSkipNotice();
        return;
      }
      if (!deliverable) {
        status = "refused";
        note = notVisibleNote;
        return;
      }
      const attributeAs = await relayAttribution(deps, spec);
      await reachEnqueue({
        deliveries: deps.deliveries,
        destination: spec.destination,
        text: spec.message,
        idempotencyKey: spec.fireKey,
        provenance: deliveryProvenance(spec, threadRef),
        ...(attributeAs ? { attributeAs } : {}),
        ...(spec.shadow ? { shadow: true } : {}),
      });
      return;
    }
    if (!homeAccess.ok) {
      note = homeAccess.note ?? MEMBERSHIP_SKIP_NOTE;
      return;
    }
    const res = await deps.run({
      surface: spec.surface,
      actor: { externalId: actorId },
      conversation,
      text: spec.input,
      ...(spec.securityScreenData !== undefined ? { securityScreenData: spec.securityScreenData } : {}),
      triggered: true,
      ...(!isScopeFloor && !isScopeShared && spec.unattendedGrants ? { unattendedGrants: spec.unattendedGrants } : {}),
      ...turnModelOptions({ triggered: true, ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}) }),
      ...(spec.readOnly ? { readOnly: true } : {}),
      ...(typeof spec.turnWallClockMs === "number" ? { turnWallClockMs: spec.turnWallClockMs } : {}),
      ...(spec.destination ? { triggerDestination: spec.destination } : {}),
      ...(liveDelivery ? { surfaceTools: true, addressed: true } : {}),
      ...(isScopeShared ? { ownerKeychainUnion: true } : {}),
      idempotencyKey: spec.fireKey,
    });
    status = res.status;
    reply = res.reply;
    sessionId = res.sessionId;
    if (res.status === "silent") return;
    if (res.status === "pending_approval") {
      note = "hit a require_approval command — failed closed (no human at fire/event time)";
      console.warn(`[trigger] ${spec.surface} ${spec.fireKey} ${note}`);
      return;
    }
    if (res.status === "ok" && (res.reply || res.attachments?.length)) {
      if (!spec.destination) return;
      if (liveDelivery) return;
      if (!consented) {
        status = "refused";
        note = consentNote;
        await ownerSkipNotice();
        return;
      }
      if (!deliverable) {
        status = "refused";
        note = notVisibleNote;
        return;
      }
      await reachEnqueue({
        deliveries: deps.deliveries,
        destination: spec.destination,
        text: res.reply ?? "",
        ...(res.attachments?.length ? { attachments: res.attachments } : {}),
        idempotencyKey: spec.fireKey,
        provenance: deliveryProvenance(spec, threadRef, res),
        ...(spec.shadow ? { shadow: true } : {}),
      });
      return;
    }
    if (res.status === "ok") note = "produced no reply";
    else note = res.reason ? `${res.status}: ${res.reason}` : res.status;
  });

  const outcome: TriggerOutcome = {
    authzFailed: false,
    ran,
    ...(status ? { status } : {}),
    ...(note ? { note } : {}),
    ...(reply !== undefined ? { reply } : {}),
    ...(sessionId ? { sessionId } : {}),
  };

  if (spec.errorNotice && spec.destination && consented && deliverable && isTriggerFailure(outcome)) {
    await deps.deliveries.enqueue({
      destination: spec.destination,
      text: spec.errorNotice(note ?? status!),
      idempotencyKey: `${spec.fireKey}:err`,
      provenance: deliveryProvenance(spec, threadRef),
      ...(spec.shadow ? { shadow: true } : {}),
    });
  }

  return outcome;
}
