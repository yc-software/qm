import { surfaceHas } from "../surfaces/surface.ts";
import { externalSlackAdmitted } from "../resolution/external-slack.ts";
import { availableRuntimeError, runtimeConfigBody, userRuntimeConfigBody } from "./runtime-config.ts";
import { type Run, isTerminal } from "../runs/run-store.ts";
import { isSubagentThreadRef } from "../sessions/thread-ref.ts";
import { stopSessionTree } from "../subagents/tree.ts";
import {
  type Conversation,
  type Principal,
  type ScopeId,
  type TurnRequest,
  type TurnResult,
  turnSource,
  scopeId,
} from "../types.ts";
import { rosterAdmits } from "../resolution/scope-membership.ts";
import { isHalt, routeWake, type Wake } from "../wake/wake.ts";
import { desktopClientForTurn, isSessionTurn } from "../core/turn-origin.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { turnModelOptions, turnRuntimePurpose, validateWebTurnModelOptions } from "../core/turn-options.ts";
import { isProjectGroupRef, projectIdFromGroupRef } from "../projects/project-store.ts";
import { samePerson } from "../directory/person.ts";
import { defaultModel, modelServiceable, modelUnavailableReason, resolveModel } from "../model/pi-models.ts";
import { selectableCatalog, selectableModelCatalog } from "../model/model-catalog.ts";
import { resolveRuntimeChoiceDurable } from "../harness/runtime-choice.ts";
import { swallow } from "../util/errors.ts";
import { pgTextSafe } from "../util/text.ts";
import { GENERIC_FAILURE_CLAUSE } from "../../plugins/chassis/src/failure-copy.ts";

import type { AppDeps } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import { tenant } from "../tenant.ts";

export const USER_STOP = "by user";

export function attributedSteerText(
  steerer: { id: string; displayName?: string | undefined },
  runOwnerId: string | null,
  text: string,
): string {
  if (runOwnerId !== null && samePerson(steerer.id, runOwnerId)) return text;
  return `${steerer.displayName?.trim() || steerer.id}: ${text}`;
}

interface TurnAdmission {
  actor: Principal;
  targetScope: ScopeId;
  conversationRef: string | undefined;
  projectGroup: boolean;
  projectId: string | null;
  projectAudience?: Principal[];
  projectName?: string;
  projectVersion?: string;
  sessionParticipantIds?: string[];
}

type TurnIntent = Awaited<ReturnType<typeof turnIntent>>;
type TurnInput = ReturnType<typeof turnInput>;

export async function stopRunTree(deps: AppDeps, run: Run): Promise<boolean> {
  if (!deps.signals) return false;
  const signals = deps.signals;
  const stop = async () => {
    const session = await deps.sessions.getByThread(run.sessionId);
    if (session) return stopSessionTree({ sessions: deps.sessions, runs: deps.runs, signals }, session, USER_STOP);
    await signals.send(run.id, { kind: "abort", reason: USER_STOP });
    await deps.runs.cancelTurn(run.id);
    return true;
  };
  return deps.advisoryLock.withLock("session-tree-admission", stop);
}

export async function admitTurn(deps: AppDeps, h: AppHelpers, req: TurnRequest): Promise<TurnResult | TurnAdmission> {
  if (!(await externalSlackAdmitted(req, deps.externalSlackPolicies, deps.sessions)))
    return {
      status: "refused",
      reason: "External Slack requests require their current authenticated source context.",
    };
  await deps.refreshModels?.();
  await deps.identity.refresh();
  const actor: Principal = deps.identity.resolve(req.actor);
  if (!deps.identity.isInternal(actor)) {
    return {
      status: "refused",
      refusalKind: "internal_only",
      reason: "internal-only: non-internal principals cannot interact",
    };
  }
  let projectAudience: Principal[] | undefined;
  let projectName: string | undefined;
  let projectVersion: string | undefined;
  let sessionParticipantIds: string[] | undefined;
  const conversationRef = req.conversation.channelRef;
  const projectGroup = req.conversation.kind === "group" && !!conversationRef && isProjectGroupRef(conversationRef);
  const projectId = projectGroup ? projectIdFromGroupRef(conversationRef) : null;

  if (projectGroup) {
    if (!projectId) return { status: "refused", reason: "you're not a member of that context" };
    const project = await deps.projects?.get(projectId);
    if (
      !project ||
      project.orgId !== tenant().orgId ||
      !deps.identity.isInternal(deps.identity.classify(project.ownerId))
    ) {
      return { status: "refused", reason: "you're not a member of that context" };
    }
    const roster = (await deps.projects?.members(conversationRef)) ?? [];
    const activeMemberIds = roster.filter((memberId) => deps.identity.isInternal(deps.identity.classify(memberId)));
    if (!rosterAdmits(activeMemberIds, actor.id, scopeId("group", conversationRef)))
      return { status: "refused", reason: "you're not a member of that context" };
    projectAudience = await Promise.all(
      activeMemberIds.map(async (memberId) => {
        if (memberId === actor.id) return actor;
        const principal = deps.identity.classify(memberId);
        const member = await deps.directory.get(memberId).catch(() => null);
        return member?.displayName ? { ...principal, displayName: member.displayName } : principal;
      }),
    );
    projectName = project.name;
    projectVersion = String(project.updatedAt);
    sessionParticipantIds = [...activeMemberIds];
  } else if (surfaceHas(req.surface, "memberGate") && req.conversation.kind !== "dm") {
    if (!conversationRef || !(await h.mayUseSharedScope(req.conversation.kind, conversationRef, actor))) {
      return { status: "refused", reason: "you're not a member of that context" };
    }
  }

  if (req.surface === "webhook" && req.origin.kind === "automation" && !sessionParticipantIds) {
    sessionParticipantIds = [actor.id];
  }

  const targetScope = conversationScope(req.conversation, actor.id);
  if (isSubagentThreadRef(req.conversation.threadRef)) {
    const target = await deps.sessions.getByThread(req.conversation.threadRef);
    if (
      !target?.spawnMeta ||
      target.scopeId !== targetScope ||
      !(await deps.sessions.getForParticipant(target.id, actor.id)) ||
      !(await h.principalCanWriteScope(actor.id, target.scopeId))
    )
      return { status: "refused", reason: "you cannot continue that subagent session" };
  }
  return {
    actor,
    targetScope,
    conversationRef,
    projectGroup,
    projectId,
    ...(projectAudience ? { projectAudience } : {}),
    ...(projectName !== undefined ? { projectName } : {}),
    ...(projectVersion !== undefined ? { projectVersion } : {}),
    ...(sessionParticipantIds ? { sessionParticipantIds } : {}),
  };
}

export async function warmRuntimeCatalog(deps: AppDeps, targetScope: ScopeId) {
  const orgRuntimeScope = tenant().orgScope;
  const [storedOrgRuntime, storedTurnRuntime] = await Promise.all([
    deps.config.getRuntimeSelectionDurable(orgRuntimeScope),
    targetScope === orgRuntimeScope ? null : deps.config.getRuntimeSelectionDurable(targetScope),
  ]);
  const needsOpenRouterCatalog = [storedOrgRuntime?.modelId, storedTurnRuntime?.modelId].some(
    (modelId) => modelId && !resolveModel(modelId),
  );
  if (needsOpenRouterCatalog && deps.modelCredentials && (await deps.modelCredentials.availability()).openrouter) {
    await selectableModelCatalog(deps.modelCredentialFetch);
  }
  return storedOrgRuntime;
}

export async function withCurrentProjectRoster<T>(
  deps: AppDeps,
  adm: TurnAdmission,
  fn: () => Promise<T>,
): Promise<T | null> {
  const { projectId, conversationRef, projectVersion } = adm;
  if (!projectId || !deps.projects) return fn();
  if (!conversationRef || !projectVersion) return null;
  return (await deps.projects.withVersion(conversationRef, projectVersion, fn)) ?? null;
}

export async function turnIntent(deps: AppDeps, req: TurnRequest, actor: Principal) {
  const approvedRequest = req.approval ? (await deps.approvals?.get(req.approval.requestId))?.request : undefined;
  const sameApprovedMessage =
    approvedRequest?.text === req.text &&
    approvedRequest.actor.externalId === req.actor.externalId &&
    approvedRequest.conversation.threadRef === req.conversation.threadRef;
  let privateRequest = req.privateSessionMessage ? req : undefined;
  if (approvedRequest?.privateSessionMessage) privateRequest = approvedRequest;
  const origin = (privateRequest ?? req).origin;
  const sessionTurn =
    (req.spawned && isSessionTurn(req)) || (sameApprovedMessage && approvedRequest && isSessionTurn(approvedRequest));

  const modelAccount =
    !req.externalSlack && deps.userModelCredentials && origin.kind === "human" && !sessionTurn
      ? await deps.config.getModelAccountDurable(actor.id)
      : "company";
  const individualAuth = modelAccount !== "company";
  const runtimePurpose = turnRuntimePurpose(req, isSubagentThreadRef(req.conversation.threadRef));
  return {
    approvedRequest,
    sameApprovedMessage,
    privateRequest,
    origin,
    sessionTurn,
    modelAccount,
    individualAuth,
    runtimePurpose,
  };
}

export async function refuseUnservedRuntime(
  deps: AppDeps,
  h: AppHelpers,
  req: TurnRequest,
  adm: TurnAdmission,
  intent: TurnIntent,
  storedOrgRuntime: Awaited<ReturnType<typeof warmRuntimeCatalog>>,
): Promise<TurnResult | null> {
  const { actor, targetScope } = adm;
  const { individualAuth, runtimePurpose } = intent;
  const orgRuntimeScope = tenant().orgScope;
  if (req.origin.kind === "automation" && req.model) {
    const choices = await runtimeConfigBody({ deps }, targetScope, undefined, runtimePurpose, {
      modelId: req.model,
      ...(req.thinkingLevel ? { effortLevel: req.thinkingLevel } : {}),
      ...(typeof req.fastMode === "boolean" ? { fastMode: req.fastMode } : {}),
    });
    const error = await availableRuntimeError(
      { deps },
      targetScope,
      { modelId: req.model ?? choices.effective.modelId, effortLevel: req.thinkingLevel, fastMode: req.fastMode },
      runtimePurpose,
    );
    if (error) return { status: "refused", reason: error };
  }
  if (surfaceHas(req.surface, "transcript")) {
    const threadRef = req.conversation.threadRef;
    const existing = await deps.sessions.getByThread(threadRef);
    if (existing) {
      if (existing.scopeId !== targetScope) {
        return { status: "refused", reason: "that conversation lives in a different context" };
      }
      if (!(await h.mayWriteSession(actor.id, existing)))
        return { status: "refused", reason: "you can't continue that conversation from the web" };
    } else if (threadRef.startsWith("web:") && !threadRef.startsWith(`web:${actor.id}:`)) {
      return { status: "refused", reason: "you can only start a new conversation on your own thread" };
    }
    const runtimeFallback = deps.runtimeFallback ?? { modelId: defaultModel() };
    if (individualAuth && req.model) {
      const available = await userRuntimeConfigBody({ deps }, targetScope, actor.id);
      if (!available.models.includes(req.model))
        return { status: "refused", reason: "Your connected AI account cannot serve this model." };
      const invalidModelOption = validateWebTurnModelOptions(req, available.models);
      if (invalidModelOption) return { status: "refused", reason: invalidModelOption };
    }
    if (!individualAuth) {
      const providers = deps.modelCredentials ? await deps.modelCredentials.availability() : deps.providerKeys;
      let orgRuntime;
      let runtime;
      try {
        const orgModel = storedOrgRuntime?.modelId ?? runtimeFallback.modelId;
        orgRuntime = modelUnavailableReason(orgModel)
          ? { modelId: orgModel }
          : await resolveRuntimeChoiceDurable(deps.config, orgRuntimeScope, orgRuntimeScope, runtimeFallback);
        runtime = await resolveRuntimeChoiceDurable(
          deps.config,
          orgRuntimeScope,
          targetScope,
          runtimeFallback,
          {
            ...(req.model ? { modelId: req.model } : {}),
            ...(req.thinkingLevel ? { effortLevel: req.thinkingLevel } : {}),
            ...(typeof req.fastMode === "boolean" ? { fastMode: req.fastMode } : {}),
          },
          undefined,
          runtimePurpose,
        );
      } catch (error) {
        swallow("turn: runtime resolution", error);
        return { status: "refused", reason: `I couldn't set up that runtime choice — ${GENERIC_FAILURE_CLAUSE}` };
      }
      if (providers && !modelServiceable(runtime.modelId, providers)) {
        return {
          status: "refused",
          reason: "that model isn't available on this deployment (its provider isn't configured)",
        };
      }
      const configuredWebuiModels = await deps.config.settingDurable("webuiModels", orgRuntimeScope);
      let enabledWebuiModels: string[] | null = null;
      if (configuredWebuiModels != null) {
        enabledWebuiModels = configuredWebuiModels.length
          ? [...new Set([...configuredWebuiModels, orgRuntime.modelId])]
          : [];
      } else if (providers?.openrouter) {
        enabledWebuiModels = [
          ...new Set([
            ...selectableCatalog(await selectableModelCatalog(deps.modelCredentialFetch)).map((model) => model.id),
            orgRuntime.modelId,
          ]),
        ];
      }
      const invalidModelOption = validateWebTurnModelOptions(req, enabledWebuiModels, providers);
      if (invalidModelOption) return { status: "refused", reason: invalidModelOption };
    }
  }
  return null;
}

export function turnConversation(deps: AppDeps, req: TurnRequest, adm: TurnAdmission): Conversation {
  const { actor, projectAudience, projectName } = adm;
  const rawAudience = req.conversation.audience ?? [req.actor];
  const audience: Principal[] =
    projectAudience ??
    rawAudience.map((a) => {
      const p = deps.identity.classify(a.externalId, a.isExternalGuest);
      if (p.id === actor.id) return actor;
      return a.displayName ? { ...p, displayName: a.displayName } : p;
    });
  if (!audience.some((p) => p.id === actor.id)) audience.push(actor);

  const publishMembers =
    projectAudience ??
    req.conversation.publishMembers?.map((a) => deps.identity.classify(a.externalId, a.isExternalGuest));

  const conversation: Conversation = {
    kind: req.conversation.kind,
    threadRef: req.conversation.threadRef,
    ...(req.conversation.channelRef ? { channelRef: req.conversation.channelRef } : {}),
    ...(projectName || req.conversation.channelName
      ? { channelName: projectName ?? req.conversation.channelName }
      : {}),
    audience,
    ...(req.conversation.isPrivate !== undefined ? { isPrivate: req.conversation.isPrivate } : {}),
    ...(req.conversation.isMpim !== undefined ? { isMpim: req.conversation.isMpim } : {}),
    ...(publishMembers ? { publishMembers } : {}),
  };
  return conversation;
}

export function turnInput(req: TurnRequest, adm: TurnAdmission, intent: TurnIntent, conversation: Conversation) {
  const { actor, sessionParticipantIds, projectVersion } = adm;
  const { approvedRequest, sameApprovedMessage, privateRequest, origin, modelAccount, individualAuth } = intent;
  const input = {
    surface: req.surface,
    ...(turnSource(req) ? { source: turnSource(req) } : {}),
    ...(req.externalSlack ? { externalSlack: req.externalSlack } : {}),
    ...(req.spawned && req.sessionSenderId ? { sessionSenderId: req.sessionSenderId } : {}),
    ...(req.spawned && req.delegatingRunId ? { delegatingRunId: req.delegatingRunId } : {}),
    ...(sameApprovedMessage && approvedRequest?.sessionSenderId
      ? { sessionSenderId: approvedRequest.sessionSenderId }
      : {}),
    ...(sameApprovedMessage && approvedRequest?.delegatingRunId
      ? { delegatingRunId: approvedRequest.delegatingRunId }
      : {}),
    ...(sameApprovedMessage && approvedRequest?.swarm ? { swarm: true as const } : {}),
    ...(req.deliveryTarget ? { deliveryTarget: req.deliveryTarget } : {}),
    ...(req.deliveryCandidates?.length ? { deliveryCandidates: req.deliveryCandidates } : {}),
    actor,
    conversation,
    origin,
    modelAccount: origin.kind === "human" ? modelAccount : ("company" as const),
    text: req.text,
    ...(req.gatewayContext ? { gatewayContext: req.gatewayContext } : {}),
    ...(req.proactiveOpener ? { proactiveOpener: true } : {}),
    ...(req.analyticsSuppressed || (sameApprovedMessage && approvedRequest?.analyticsSuppressed)
      ? { analyticsSuppressed: true }
      : {}),
    ...(req.conversationHeader ? { conversationHeader: req.conversationHeader } : {}),
    ...(req.priorTurns?.length ? { priorTurns: req.priorTurns } : {}),
    ...(req.overheard?.length ? { overheard: req.overheard } : {}),
    ...(req.detectContext ? { detectContext: req.detectContext } : {}),
    ...(req.detectOpener ? { detectOpener: req.detectOpener } : {}),
    ...(req.attachments?.length ? { attachments: req.attachments } : {}),
    ...(req.inboundNotes?.length ? { inboundNotes: req.inboundNotes } : {}),
    ...((!individualAuth || surfaceHas(req.surface, "pickModel")) && req.model ? { model: req.model } : {}),
    ...turnModelOptions(req),
    ...(req.readOnly ? { readOnly: true } : {}),
    ...(privateRequest
      ? {
          privateSessionMessage: true as const,
          sessionMessageDepth: privateRequest.sessionMessageDepth,
          readOnly: true,
        }
      : {}),
    ...(req.skipMemory ? { skipMemory: true } : {}),
    ...(req.unattendedGrants?.length ? { unattendedGrants: req.unattendedGrants } : {}),
    ...(req.botActor ? { botActor: true } : {}),
    ...(req.surfaceTools ? { surfaceTools: true } : {}),
    ...(req.clientTools?.length ? { clientTools: req.clientTools } : {}),
    desktopClientId: desktopClientForTurn({ ...req, origin }),
    ...(req.envelopeWrapped ? { envelopeWrapped: true } : {}),
    ...(typeof req.displayText === "string" && req.displayText ? { displayText: req.displayText } : {}),
    ...(req.addressed || origin.kind === "human" ? { addressed: true } : {}),
    ...(typeof req.turnWallClockMs === "number" ? { turnWallClockMs: req.turnWallClockMs } : {}),
    ...(typeof req.timezone === "string" && req.timezone ? { timezone: req.timezone } : {}),
    ...(req.approval ? { approval: req.approval } : {}),
    ...(sessionParticipantIds ? { sessionParticipantIds } : {}),
    ...(projectVersion ? { scopeVersion: projectVersion } : {}),
  };
  return input;
}

export async function refuseSealedThread(
  deps: AppDeps,
  h: AppHelpers,
  req: TurnRequest,
  adm: TurnAdmission,
  conversation: Conversation,
): Promise<TurnResult | null> {
  const { actor, projectGroup } = adm;
  if (projectGroup && req.approval) {
    const [approval, approvalSession] = await Promise.all([
      deps.approvals?.get(req.approval.requestId),
      deps.sessions.getByThread(conversation.threadRef),
    ]);
    if (!approvalSession || (await h.approvalResumable(approvalSession, actor.id, approval)) !== "ok") {
      return { status: "refused", reason: "approval isn't visible in your project tenure" };
    }
  }
  const blocked = await h.pendingApprovalResultForThread(conversation.threadRef, actor.id, { alwaysBlock: true });
  if (blocked) {
    const record = req.approval ? await deps.approvals?.get(req.approval.requestId) : undefined;
    const blockedSession = blocked.sessionId ? await deps.sessions.get(blocked.sessionId) : null;
    let cause: Awaited<ReturnType<typeof h.approvalResumable>> | "no_session" | "nonblocking" = blockedSession
      ? await h.approvalResumable(blockedSession, actor.id, record)
      : "no_session";
    if (cause === "ok" && record?.blocksInput === false) cause = "nonblocking";
    if (cause !== "ok") {
      if (req.approval) {
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.id,
          action: `command_approval.${req.approval.approved ? "approve" : "deny"}`,
          resource: req.approval.requestId,
          scopeLabel: blockedSession?.scopeId ?? conversation.threadRef,
          status: "refused",
          detail: JSON.stringify({ approvalOutcome: "sealed_thread", cause }),
        });
      }
      return blocked;
    }
  }
  return null;
}

export async function alreadyDelivered(
  deps: AppDeps,
  redeliveryKey: string | undefined,
  threadRef: string,
): Promise<boolean> {
  if (redeliveryKey && deps.signals) {
    const prior = await deps.runs.getByDedupKey(redeliveryKey);
    if (prior) {
      if (prior.request.conversation.threadRef !== threadRef)
        console.error(
          `[turn] redelivery ${redeliveryKey} names ${threadRef} but its run lives in ${prior.request.conversation.threadRef}`,
        );
      return true;
    }
    if (await deps.signals.hasDedupeKey(redeliveryKey)) return true;
  }
  return false;
}

export async function steerLiveRun(
  deps: AppDeps,
  h: AppHelpers,
  req: TurnRequest,
  adm: TurnAdmission,
  origin: TurnIntent["origin"],
  conversation: Conversation,
  input: TurnInput,
  redeliveryKey: string | undefined,
): Promise<TurnResult | null> {
  const { actor } = adm;

  if (
    !surfaceHas(req.surface, "transcript") &&
    deps.signals &&
    (origin.kind === "human" || origin.kind === "ambient") &&
    !req.approval &&
    !req.spawned &&
    !req.idempotencyKey
  ) {
    const live = await deps.runs.activeForThread(conversation.threadRef);
    const liveOriginKind = live ? live.request.origin.kind : undefined;
    const personIntoAutomation =
      liveOriginKind === "automation" &&
      (origin.kind === "human" || (origin.kind === "ambient" && origin.live === true)) &&
      !(origin.kind === "human" && isHalt(req.text));
    if (live && redeliveryKey && live.dedupKey === redeliveryKey) return { status: "silent" };
    const sameAccount =
      live?.request.modelAccount !== undefined &&
      live.request.modelAccount === input.modelAccount &&
      (input.modelAccount === "company" || live.request.actor.id === actor.id);
    const cancel = origin.kind === "human" && isHalt(req.text);
    if (live && !isTerminal(live.status) && !personIntoAutomation && (cancel || sameAccount)) {
      const targetRun = live;
      const steerText = attributedSteerText(
        actor,
        origin.kind === "ambient" ? null : targetRun.request.actor.id,
        req.text,
      );
      if (origin.kind === "ambient") {
        const session = await deps.sessions.getByThread(conversation.threadRef);
        deps.orchestrator.observeSecuritySteer({
          payload: steerText,
          actor,
          conversation,
          ...(session ? { sessionId: session.id } : {}),
        });
      }
      const fileNames = (req.attachments ?? []).map((a) =>
        a.sourceId
          ? `${a.name} (fetch via surface-file, ts ${origin.kind === "human" ? (origin.messageTs ?? origin.entryTs) : origin.entryTs})`
          : a.name,
      );
      const wake: Wake = {
        situation: origin.kind === "ambient" ? "ambientUpdate" : "addressed",
        ts: String(Date.now()),
        text: steerText,
        halt: origin.kind === "human" && isHalt(req.text),
        ...(fileNames.length ? { fileNames } : {}),
      };
      const route = routeWake(wake, true, targetRun.request.origin.kind === "ambient");
      if (route.kind === "steer" || route.kind === "drop") {
        const steerTs = origin.kind === "human" ? (origin.messageTs ?? origin.entryTs) : origin.entryTs;
        let redelivered = false;
        const routedRunId = await withCurrentProjectRoster(deps, adm, async () => {
          if (route.kind === "steer" && route.signal === "abort") {
            await stopRunTree(deps, targetRun);
          } else if (route.kind === "steer")
            redelivered = !(await deps.signals!.send(targetRun.id, {
              kind: route.signal,
              ...(route.text ? { text: route.text } : {}),
              ...(steerTs ? { ts: steerTs } : {}),
              ...(route.signal === "steer" ? { request: req } : {}),
              ...(redeliveryKey ? { dedupeKey: redeliveryKey } : {}),
            }));
          return targetRun.id;
        });
        if (!routedRunId)
          return { status: "refused", reason: "project membership changed; retry from the current project" };
        if (redelivered)
          return req.async ? { status: "queued", runId: routedRunId, steered: true } : h.drive(routedRunId);
        if (route.kind === "steer") {
          const after = await deps.runs.get(targetRun.id);
          if (!after || isTerminal(after.status)) {
            const own = (await h.replayOrphanedRunSignals(targetRun.id)).find(
              (d) =>
                (d.signal.text === route.text ||
                  (route.text !== undefined && d.signal.text === pgTextSafe(route.text))) &&
                d.signal.ts === steerTs,
            );
            if (own?.replayRunId)
              return req.async ? { status: "queued", runId: own.replayRunId } : h.drive(own.replayRunId);
          }
        }
        return req.async ? { status: "queued", runId: routedRunId, steered: true } : h.drive(routedRunId);
      }
    }
  }
  return null;
}

export async function steerAmbientRun(
  deps: AppDeps,
  h: AppHelpers,
  req: TurnRequest,
  adm: TurnAdmission,
  origin: TurnIntent["origin"],
  conversation: Conversation,
  input: TurnInput,
  redeliveryKey: string | undefined,
): Promise<TurnResult | null> {
  if (origin.kind === "human" && !req.spawned && !req.idempotencyKey && origin.messageTs) {
    const container = conversation.channelRef ?? conversation.threadRef;
    const ambientRef = `${req.surface}:${container}:ambient:${origin.messageTs}`;
    const ambientSession = await deps.sessions.getByThread(ambientRef);
    if (ambientSession) {
      const liveAmbient = await deps.runs.activeForThread(ambientRef);
      if (
        liveAmbient &&
        !isTerminal(liveAmbient.status) &&
        input.modelAccount === "company" &&
        liveAmbient.request.modelAccount === "company"
      ) {
        const routedRunId = await withCurrentProjectRoster(deps, adm, async () => {
          if (deps.signals)
            await deps.signals.send(liveAmbient.id, {
              kind: "steer",
              text: req.text,
              ts: origin.messageTs,
              request: req,
              ...(redeliveryKey ? { dedupeKey: redeliveryKey } : {}),
            });
          return liveAmbient.id;
        });
        if (!routedRunId)
          return { status: "refused", reason: "project membership changed; retry from the current project" };
        const after = await deps.runs.get(liveAmbient.id);
        if (!after || isTerminal(after.status)) {
          const own = (await h.replayOrphanedRunSignals(liveAmbient.id)).find(
            (d) =>
              (d.signal.text === req.text || d.signal.text === pgTextSafe(req.text)) &&
              d.signal.ts === origin.messageTs,
          );
          if (own?.replayRunId)
            return req.async ? { status: "queued", runId: own.replayRunId } : h.drive(own.replayRunId);
        }
        return req.async ? { status: "queued", runId: routedRunId } : h.drive(routedRunId);
      }
    }
  }
  return null;
}
