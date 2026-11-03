import { externalSlackRequestAllowed } from "../resolution/external-slack.ts";
import { requestedRuntimeError, userRuntimeConfigBody, validateWebTurnModelOptions } from "./runtime-config.ts";
import type { Run } from "../runs/run-store.ts";
import { isSubagentThreadRef, sessionTreeRuns, stopSessionTree } from "../sessions/session-syscalls.ts";
import { isUserItem } from "../sessions/items.ts";
import type { Conversation, Principal, TurnRequest, TurnResult } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import { scopeId } from "../types.ts";
import { conversationWriteAccess } from "./conversation-write-access.ts";
import {
  liveTurnOf,
  mayMeetLiveTurn,
  routeIncoming,
  isHalt,
  type Incoming,
  type LiveTurn,
} from "../wake/route-incoming.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { replayableRequest } from "../core/orchestrator/turn-helpers.ts";
import {
  desktopClientForTurn,
  isPersonAuthored,
  isSessionTurn,
  resolveTurnOrigin,
  spokenByPerson,
} from "../core/turn-origin.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { isTerminal, leaseLapsed } from "../runs/run-store.ts";
import type { SessionStateEvent } from "../runs/session-state-bus.ts";
import { turnRuntimePurpose } from "../core/turn-options.ts";
import { turnModelOptions } from "../agent/runtime-choice.ts";
import { samePerson } from "../directory/person.ts";
import {
  defaultModel,
  modelServiceable,
  modelOfferedInWebui,
  modelUnavailableReason,
  resolveModel,
} from "../model/pi-models.ts";
import { selectableCatalog, selectableModelCatalog } from "../model/model-catalog.ts";
import { resolveRuntimeChoice } from "../agent/runtime-choice.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import { GENERIC_FAILURE_CLAUSE } from "../../plugins/chassis/src/failure-copy.ts";

import type { App, AppDeps } from "./app-types.ts";
import { STALE_LEASE_GRACE_MS } from "./app-types.ts";

const PARTICIPANT_REHYDRATE_TIMEOUT_MS = 5_000;
import type { AppHelpers } from "./app-helpers.ts";
import type { AmbientHelpers } from "./app-ambient.ts";

const USER_STOP = "by user";

const freshSteerTs = () => `${Date.now()}.${crypto.randomUUID().slice(0, 8)}`;

export function createTurnMethods(
  deps: AppDeps,
  h: AppHelpers,
  ambient: AmbientHelpers,
): Pick<
  App,
  | "turn"
  | "getApproval"
  | "subscribeSessionStates"
  | "subscribeLedgerEvents"
  | "listSessionApprovals"
  | "pendingApprovalForThread"
  | "getRun"
  | "getRunToolItems"
  | "subscribeRun"
  | "syncRunStream"
  | "activeRunForThread"
  | "withdrawRun"
  | "editQueuedRun"
  | "signalRun"
  | "replayOrphanedRunSignals"
> {
  const {
    withAdminLink,
    awaitRun,
    approvalRecordIsCurrent,
    approvalResumable,
    approvalVisibleToViewer,
    pendingApprovalForSession,
    pendingApprovalResultForThread,
    viewerMayUseRun,
    sessionForViewer,
    replayOrphanedRunSignals,
    steerRun,
  } = h;
  const { shouldRouteToSpine, markTriggerHandled, addressedWakeText } = ambient;
  async function viewerSteerRequest(run: Run, viewer: string, text: string): Promise<TurnRequest> {
    const displayName = (await deps.directory.get(viewer).catch(swallowAs("signal: steer author display name", null)))
      ?.displayName;
    const { surface, scopeVersion, deliveryTarget, deliveryCandidates, slackSource, externalSlack, conversation } =
      replayableRequest(run.request);
    return {
      surface,
      ...(scopeVersion ? { scopeVersion } : {}),
      ...(deliveryTarget ? { deliveryTarget } : {}),
      ...(deliveryCandidates ? { deliveryCandidates } : {}),
      ...(slackSource ? { slackSource } : {}),
      ...(externalSlack ? { externalSlack } : {}),
      actor: { externalId: viewer, ...(displayName ? { displayName } : {}) },
      conversation,
      text,
      origin: { kind: "human" },
    };
  }
  async function liveTurnsFor(
    threadRef: string,
    ambientRef: string | undefined,
    halting: boolean,
  ): Promise<Array<{ run?: Run; turn: LiveTurn }>> {
    const live: Array<{ run?: Run; turn: LiveTurn }> = [];
    const own = await deps.runs.activeForThread(threadRef);
    if (own && !isTerminal(own.status)) live.push({ run: own, turn: liveTurnOf(own) });
    if (ambientRef && (await deps.sessions.getByThread(ambientRef))) {
      const worker = await deps.runs.activeForThread(ambientRef);
      if (worker && !isTerminal(worker.status)) live.push({ run: worker, turn: liveTurnOf(worker, true) });
    }
    if (live.length || !halting) return live;
    const root = await deps.sessions.getByThread(threadRef);
    const descendants = root ? await sessionTreeRuns(deps.sessions, deps.runs, root) : [];
    if (descendants.length)
      live.push({ turn: { kind: "descendants", actorIds: descendants.map((run) => run.request.actor.id) } });
    return live;
  }
  async function stopThreadTree(threadRef: string, run?: Run): Promise<boolean> {
    if (!deps.signals) return false;
    const signals = deps.signals;
    const stop = async () => {
      const session = await deps.sessions.getByThread(threadRef);
      if (session) return stopSessionTree({ sessions: deps.sessions, runs: deps.runs, signals }, session, USER_STOP);
      if (!run) return false;
      await signals.send(run.id, { kind: "abort", reason: USER_STOP });
      if (run.status === "pending") await deps.runs.withdraw(run.id);
      return true;
    };
    return deps.advisoryLock.withLock("session-tree-admission", stop);
  }
  const stopRunTree = (run: Run) => stopThreadTree(run.sessionId, run);
  const methods: ReturnType<typeof createTurnMethods> = {
    async turn(req: TurnRequest, replay?: { signalDedupKey: string }): Promise<TurnResult> {
      const historicalSlack = Object.keys(deps.externalSlackPolicies ?? {}).length
        ? (await deps.sessions.getByThread(req.conversation.threadRef))?.surface === "slack"
        : false;
      if (!externalSlackRequestAllowed(req, deps.externalSlackPolicies, historicalSlack))
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
      const access = await conversationWriteAccess(deps, h, req, actor);
      if (!access.ok) return { status: "refused", reason: access.reason };
      const project = access.project;
      const conversationRef = req.conversation.channelRef;
      let sessionParticipantIds = project ? [...project.memberIds] : undefined;

      if (req.surface === "webhook" && req.triggered && !sessionParticipantIds) {
        sessionParticipantIds = [actor.id];
      }

      const orgRuntimeScope = scopeId("org", orgIdOf());
      const turnRuntimeScope =
        req.conversation.kind === "dm"
          ? scopeId("personal", actor.id)
          : scopeId(req.conversation.kind, req.conversation.channelRef ?? req.conversation.threadRef);
      const [storedOrgRuntime, storedTurnRuntime] = await Promise.all([
        deps.config.getRuntimeSelectionDurable(orgRuntimeScope),
        turnRuntimeScope === orgRuntimeScope ? null : deps.config.getRuntimeSelectionDurable(turnRuntimeScope),
      ]);
      const needsOpenRouterCatalog = [storedOrgRuntime?.modelId, storedTurnRuntime?.modelId].some(
        (modelId) => modelId && !resolveModel(modelId),
      );
      if (needsOpenRouterCatalog && deps.modelCredentials && (await deps.modelCredentials.availability()).openrouter) {
        await selectableModelCatalog(deps.modelCredentialFetch);
      }

      async function withCurrentProjectRoster<T>(fn: () => Promise<T>): Promise<T | null> {
        if (!project || !deps.projects) return fn();
        if (!conversationRef) return null;
        return (await deps.projects.withVersion(conversationRef, project.version, fn)) ?? null;
      }

      const approvedRequest = req.approval ? (await deps.approvals?.get(req.approval.requestId))?.request : undefined;
      const sameApprovedMessage =
        approvedRequest?.text === req.text &&
        approvedRequest.actor.externalId === req.actor.externalId &&
        approvedRequest.conversation.threadRef === req.conversation.threadRef;
      let privateRequest = req.privateSessionMessage ? req : undefined;
      if (approvedRequest?.privateSessionMessage) privateRequest = approvedRequest;
      const origin = resolveTurnOrigin(privateRequest ?? req);
      const sessionTurn =
        (req.spawned && isSessionTurn(req)) ||
        (sameApprovedMessage && approvedRequest && isSessionTurn(approvedRequest));

      const modelAccount =
        !req.externalSlack && deps.userModelCredentials && origin.kind === "human" && !sessionTurn
          ? await deps.config.getModelAccountDurable(actor.id)
          : "company";
      const individualAuth = modelAccount !== "company";
      const runtimePurpose = turnRuntimePurpose(req, isSubagentThreadRef(req.conversation.threadRef));
      if (req.triggered && req.model) {
        const error = await requestedRuntimeError(
          { deps },
          conversationScope(req.conversation, actor.id),
          {
            modelId: req.model,
            ...(req.thinkingLevel ? { effortLevel: req.thinkingLevel } : {}),
            ...(typeof req.fastMode === "boolean" ? { fastMode: req.fastMode } : {}),
          },
          runtimePurpose,
        );
        if (error) return { status: "refused", reason: error };
      }
      let requestedModel = req.model;
      if (req.surface === "web") {
        const org = scopeId("org", orgIdOf());
        const targetScope = conversationScope(req.conversation, actor.id);
        const runtimeFallback = deps.runtimeFallback ?? { modelId: defaultModel() };
        if (individualAuth && req.model) {
          const available = await userRuntimeConfigBody({ deps }, targetScope, actor.id);
          const model = req.model;
          if (!available.models.includes(model))
            return { status: "refused", reason: "Your connected AI account cannot serve this model." };
          const invalidModelOption = validateWebTurnModelOptions({ ...req, model }, available.models);
          if (invalidModelOption) return { status: "refused", reason: invalidModelOption };
          requestedModel = model;
        }
        if (!individualAuth) {
          const configuredKeys = deps.providerKeys ??
            deps.modelProviders ?? { anthropic: false, openai: false, openrouter: false };
          const managedKeys = deps.modelCredentials ? await deps.modelCredentials.availability() : configuredKeys;
          let orgRuntime;
          let runtime;
          try {
            const orgModel =
              storedOrgRuntime?.modelId ?? (await deps.config.getBaseModelOwnDurable(org)) ?? runtimeFallback.modelId;
            orgRuntime = modelUnavailableReason(orgModel)
              ? { modelId: orgModel }
              : await resolveRuntimeChoice(deps.config, org, org, runtimeFallback);
            runtime = await resolveRuntimeChoice(
              deps.config,
              org,
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
          let providers = deps.modelProviders;
          if (deps.modelCredentials) {
            providers = managedKeys;
          } else if (deps.providerKeys) {
            providers = configuredKeys;
          }
          if (providers && !modelServiceable(runtime.modelId, providers)) {
            return {
              status: "refused",
              reason: "that model isn't available on this deployment (its provider isn't configured)",
            };
          }
          const configuredWebuiModels = await deps.config.getWebuiModelsDurable(org);
          let enabledWebuiModels: string[] | null = null;
          if (configuredWebuiModels != null) {
            enabledWebuiModels = configuredWebuiModels.length
              ? [...new Set([...configuredWebuiModels, orgRuntime.modelId])]
              : [];
          } else if (providers?.openrouter) {
            enabledWebuiModels = [
              ...new Set([
                ...selectableCatalog(await selectableModelCatalog(deps.modelCredentialFetch))
                  .filter((model) => modelOfferedInWebui(model.id))
                  .map((model) => model.id),
                orgRuntime.modelId,
              ]),
            ];
          }
          const invalidModelOption = validateWebTurnModelOptions(req, enabledWebuiModels, providers);
          if (invalidModelOption) return { status: "refused", reason: invalidModelOption };
        }
      }

      const rawAudience = req.conversation.audience ?? [req.actor];
      const audience: Principal[] =
        project?.audience ??
        rawAudience.map((a) => {
          const p = deps.identity.classify(a.externalId, a.isExternalGuest);
          if (p.id === actor.id) return actor;
          return a.displayName ? { ...p, displayName: a.displayName } : p;
        });
      if (!audience.some((p) => p.id === actor.id)) audience.push(actor);

      const publishMembers =
        project?.audience ??
        req.conversation.publishMembers?.map((a) => deps.identity.classify(a.externalId, a.isExternalGuest));

      const conversation: Conversation = {
        kind: req.conversation.kind,
        threadRef: req.conversation.threadRef,
        ...(req.conversation.channelRef ? { channelRef: req.conversation.channelRef } : {}),
        ...(project?.name || req.conversation.channelName
          ? { channelName: project?.name ?? req.conversation.channelName }
          : {}),
        audience,
        ...(req.conversation.isPrivate !== undefined ? { isPrivate: req.conversation.isPrivate } : {}),
        ...(req.conversation.isMpim !== undefined ? { isMpim: req.conversation.isMpim } : {}),
        ...(publishMembers ? { publishMembers } : {}),
      };

      const input = {
        surface: req.surface,
        ...(req.slackSource ? { slackSource: req.slackSource } : {}),
        ...(req.externalSlack ? { externalSlack: req.externalSlack } : {}),
        ...(req.spawned && req.sessionSenderId ? { sessionSenderId: req.sessionSenderId } : {}),
        ...(req.spawned && req.delegatingRunId ? { delegatingRunId: req.delegatingRunId } : {}),
        ...(sameApprovedMessage && approvedRequest?.sessionSenderId
          ? { sessionSenderId: approvedRequest.sessionSenderId }
          : {}),
        ...(sameApprovedMessage && approvedRequest?.delegatingRunId
          ? { delegatingRunId: approvedRequest.delegatingRunId }
          : {}),
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
        ...((!individualAuth || req.surface === "web") && requestedModel ? { model: requestedModel } : {}),
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
        ...(project ? { scopeVersion: project.version } : {}),
      };

      if (project && req.approval) {
        const [approval, approvalSession] = await Promise.all([
          deps.approvals?.get(req.approval.requestId),
          deps.sessions.getByThread(conversation.threadRef),
        ]);
        if (!approvalSession || (await approvalResumable(approvalSession, actor.id, approval)) !== "ok") {
          return { status: "refused", reason: "approval isn't visible in your project tenure" };
        }
      }
      const sealedByApproval = async (): Promise<TurnResult | undefined> => {
        const blocked = await pendingApprovalResultForThread(conversation.threadRef, actor.id, { alwaysBlock: true });
        if (blocked) {
          const record = req.approval ? await deps.approvals?.get(req.approval.requestId) : undefined;
          const blockedSession = blocked.sessionId ? await deps.sessions.get(blocked.sessionId) : null;
          let cause: Awaited<ReturnType<typeof approvalResumable>> | "no_session" | "nonblocking" = blockedSession
            ? await approvalResumable(blockedSession, actor.id, record)
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
        return undefined;
      };
      let request = input;

      const redeliveryKey = req.approval ? undefined : req.redeliveryKey;
      if (redeliveryKey && deps.signals) {
        const prior = await deps.runs.getByDedupKey(redeliveryKey);
        if (prior) {
          if (prior.request.conversation.threadRef !== conversation.threadRef)
            console.error(
              `[turn] redelivery ${redeliveryKey} names ${conversation.threadRef} but its run lives in ${prior.request.conversation.threadRef}`,
            );
          return { status: "silent" };
        }
        if (await deps.signals.runForDedupeKey(redeliveryKey)) return { status: "silent" };
      }
      let dedupKey: string | undefined = redeliveryKey;
      if (req.idempotencyKey) {
        dedupKey = project ? `${req.idempotencyKey}:project-${project.version}` : req.idempotencyKey;
        if (req.approval) dedupKey = `${dedupKey}:approval:${req.approval.requestId}:${req.approval.approved}`;
      }

      if (replay) dedupKey = replay.signalDedupKey;

      if (origin.kind === "human" && !isSessionTurn(input) && !req.approval) deps.reaperPoke?.();

      const spineRouted = !req.externalSlack && !req.approval && shouldRouteToSpine(request as OrchestratorInput);
      const steeredBefore = dedupKey && !replay ? await deps.signals?.runForDedupeKey(dedupKey) : undefined;
      if (steeredBefore) return { status: "queued", runId: steeredBefore, steered: true };
      const queuedBefore = req.idempotencyKey && dedupKey && !replay ? await deps.runs.getByDedupKey(dedupKey) : null;
      const incoming: Incoming = {
        origin: origin.kind,
        person: spokenByPerson(origin),
        text: req.text,
        ...(req.gatewayContext?.botHandle ? { selfHandle: req.gatewayContext.botHandle } : {}),
        hasFiles: Boolean(req.attachments?.length),
        actorId: actor.id,
        modelAccount,
        ...(dedupKey ? { dedupKey } : {}),
        routed: Boolean(req.approval || req.spawned || replay),
      };
      if (deps.signals && !queuedBefore && mayMeetLiveTurn(incoming)) {
        const ambientRef =
          spineRouted && origin.kind === "human" && origin.messageTs
            ? `${req.surface}:${conversation.channelRef ?? conversation.threadRef}:ambient:${origin.messageTs}`
            : undefined;
        const candidates = await liveTurnsFor(
          conversation.threadRef,
          ambientRef,
          isHalt(incoming.text, incoming.selfHandle),
        );
        if (redeliveryKey && candidates.some(({ run }) => run?.dedupKey === redeliveryKey)) return { status: "silent" };
        const prefs = { midTurn: req.midTurn ?? "steer" } as const;
        const routes = candidates.map((candidate) => ({
          ...candidate,
          route: routeIncoming(incoming, candidate.turn, prefs),
        }));
        const live = routes.find(({ route }) => route.kind !== "turn") ?? routes[0];
        const route = live?.route ?? routeIncoming(incoming, null, prefs);
        if (route.kind === "abort") {
          const stopped = await withCurrentProjectRoster(async () => {
            const own = candidates.find(({ run }) => run?.sessionId === conversation.threadRef)?.run;
            let any = await stopThreadTree(conversation.threadRef, own);
            for (const { run } of routes.filter((r) => r.route.kind === "abort"))
              if (run && run.sessionId !== conversation.threadRef) any = (await stopRunTree(run)) || any;
            return any;
          });
          if (stopped === null)
            return { status: "refused", reason: "project membership changed; retry from the current project" };
          if (!stopped) console.error(`[turn] stop in ${conversation.threadRef} found no live work to stop`);
          return { status: "silent", steered: true, stopped };
        }
        if (route.kind === "drop") return { status: "refused", reason: "empty message" };
        if (live?.run && route.kind !== "turn") {
          const sealed = await sealedByApproval();
          if (sealed) return sealed;
          const target = live.run;
          const steerTs =
            (origin.kind === "human" ? (origin.messageTs ?? origin.entryTs) : undefined) ??
            (origin.kind === "ambient" ? origin.entryTs : undefined) ??
            freshSteerTs();
          let replayRunId: string | undefined;
          const routedRunId = await withCurrentProjectRoster(async () => {
            if (route.kind === "steer") {
              const steered = await steerRun(target, {
                kind: "steer",
                ...(req.text ? { text: req.text } : {}),
                ts: steerTs,
                request: req,
                ...((redeliveryKey ?? dedupKey) ? { dedupeKey: redeliveryKey ?? dedupKey } : {}),
              });
              replayRunId = steered.replayRunId;
            }
            return target.id;
          });
          if (!routedRunId)
            return { status: "refused", reason: "project membership changed; retry from the current project" };
          if (replayRunId) return req.async ? { status: "queued", runId: replayRunId } : awaitRun(replayRunId);
          if (!req.async) return awaitRun(routedRunId);
          const joined = live.turn.kind === "run" && live.turn.handlesThisMessage;
          return {
            status: "queued",
            runId: routedRunId,
            ...(joined ? {} : { steered: true as const }),
            ...(route.kind === "steer" ? { steerTs } : {}),
          };
        }
      }
      const sealed = await sealedByApproval();
      if (sealed) return sealed;
      if (spineRouted) {
        request = { ...input, surfaceTools: true };
        if (origin.kind !== "ambient")
          request = {
            ...request,
            text: await addressedWakeText(input as OrchestratorInput),
            displayText: input.text,
            envelopeWrapped: true,
          };
      }

      const enqueue = () =>
        deps.runs.enqueue({
          sessionId: conversation.threadRef,
          request,
          maxAttempts: deps.maxAttempts,
          ...(dedupKey ? { dedupKey } : {}),
        });
      const enqueued = await withCurrentProjectRoster(enqueue);
      if (!enqueued) return { status: "refused", reason: "project membership changed; retry from the current project" };
      const { run, deduped } = enqueued;
      if (deduped && redeliveryKey && run.dedupKey === redeliveryKey) return { status: "silent" };
      if (spineRouted && !deduped) markTriggerHandled(input as OrchestratorInput);
      if (spineRouted) deps.engaged?.engage(conversation.threadRef);
      if (deduped && run.result && isTerminal(run.status)) return withAdminLink(run.result);
      if (req.async) return { status: "queued", runId: run.id };
      return awaitRun(run.id);
    },

    subscribeSessionStates(cb, opts) {
      if (!deps.sessionStateBus) return () => {};
      const lookupParticipants = async (threadRef: string): Promise<string[]> => {
        const session = await deps.sessions.getByThread(threadRef);
        return session ? deps.sessions.participantsOf(session.id) : [];
      };
      const rehydrate = async (event: SessionStateEvent): Promise<SessionStateEvent> => {
        if (!event.participantsShed) return event;
        const { participantsShed: _shed, ...bare } = event;
        const participants = await Promise.race([
          lookupParticipants(event.threadRef),
          sleep(PARTICIPANT_REHYDRATE_TIMEOUT_MS, { unref: true }).then(() => null),
        ]).catch(swallowAs("session-state: rehydrate participants", null));
        return participants?.length ? { ...bare, participants } : bare;
      };
      let tail: Promise<void> = Promise.resolve();
      const queue = (step: () => void | Promise<void>): void => {
        tail = tail.then(step).catch(swallowAs("session-state: subscriber", undefined));
      };
      const onResync = opts?.onResync;
      return deps.sessionStateBus.subscribe(
        (event) => queue(async () => cb(await rehydrate(event))),
        onResync ? { onResync: () => queue(onResync) } : undefined,
      );
    },

    subscribeLedgerEvents(cb, opts) {
      return deps.ledgerEventBus?.subscribe(cb, opts) ?? (() => {});
    },

    async getApproval(requestId, viewer) {
      const record = await deps.approvals?.get(requestId);
      if (!record || !(await approvalRecordIsCurrent(record))) return null;
      if (viewer) {
        const session = await deps.sessions.get(record.sessionId);
        if (!session || !(await approvalVisibleToViewer(session, viewer, record))) return null;
      }
      return { requestId, ...record };
    },

    async listSessionApprovals(sessionId, viewer) {
      if (!(await sessionForViewer(sessionId, viewer))) return [];
      return pendingApprovalForSession(sessionId, { blockingOnly: false, viewer });
    },

    pendingApprovalForThread(threadRef, viewer) {
      return pendingApprovalResultForThread(threadRef, viewer);
    },

    subscribeRun(runId, listener, onResync) {
      return (
        deps.runStreamEvents?.subscribe(
          (event) => {
            if (event.runId === runId) listener(event);
          },
          { onResync },
        ) ?? (() => {})
      );
    },

    syncRunStream(runId, offset, reasoning) {
      deps.runStreamEvents?.emit({ runId, kind: "sync", offset, reasoning });
    },

    async getRun(runId, viewer) {
      const run = await deps.runs.get(runId);
      if (!run) return null;
      if (viewer && !(await viewerMayUseRun(run, viewer))) return null;
      const partial = deps.turnStream?.snapshot(runId);
      const goal = deps.turnStream?.goal(runId);
      const runtime = deps.turnStream?.runtime(runId) ?? run.result?.runtime;
      const firstBlock = deps.turnStream?.firstBlock(runId);
      const surfacePosted = deps.turnStream?.surfacePosted(runId) ?? false;
      const alive = run.status === "running" && !leaseLapsed(run, Date.now());
      const replying = deps.turnStream?.replying(runId) ?? false;
      const replyComplete = deps.turnStream?.isReplyDone(runId) ?? false;
      const activity = await deps.runActivity?.list(runId);
      const reasoning = deps.turnStream?.reasoning(runId) ?? [];
      const stale =
        run.status === "pending" ? run.attempts > 0 : !alive && leaseLapsed(run, Date.now() - STALE_LEASE_GRACE_MS);
      return {
        desktopClientId: desktopClientForTurn({ ...run.request, attempt: run.attempts }),
        status: run.status,
        attempt: run.attempts,
        result: run.result ? await withAdminLink(run.result) : run.result,
        ...(run.request.surface === "web" &&
        !run.request.approval &&
        !run.request.envelopeWrapped &&
        !(run.request.proactiveOpener && !run.request.text.trim()) &&
        isPersonAuthored(resolveTurnOrigin(run.request).kind)
          ? {
              input: {
                runId: run.id,
                seq: run.turnUserSeq,
                text: run.request.displayText ?? run.request.text ?? "",
                createdAt: run.createdAt,
                ...(run.request.attachments?.length
                  ? {
                      attachments: run.request.attachments.map(({ name, mimetype, sizeBytes }) => ({
                        name,
                        mimetype,
                        sizeBytes,
                      })),
                    }
                  : {}),
              },
            }
          : {}),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        ...(goal ? { goal } : {}),
        ...(runtime ? { runtime } : {}),
        ...(partial ? { partial, partialStartOffset: deps.turnStream!.startOffset(runId) } : {}),
        ...(firstBlock
          ? { firstBlock: firstBlock.text, ...(firstBlock.closed ? { firstBlockClosed: true } : {}) }
          : {}),
        ...(surfacePosted ? { surfacePosted: true } : {}),
        ...(alive ? { alive: true } : {}),
        ...(stale ? { stale: true } : {}),
        ...(replying ? { replying: true } : {}),
        ...(replyComplete ? { replyComplete: true } : {}),
        ...(activity && activity.length ? { activity } : {}),
        ...(reasoning.length ? { reasoning } : {}),
      };
    },

    async getRunToolItems(runId, viewer, afterSeq) {
      const run = await deps.runs.get(runId);
      if (!run || run.turnUserSeq === null) return [];
      if (viewer && !(await viewerMayUseRun(run, viewer))) return [];
      const session = await deps.sessions.getByThread(run.sessionId);
      if (!session) return [];
      const items = await deps.sessions.getItems(session.id, {
        sinceSeq: Math.max(run.turnUserSeq, (afterSeq ?? -1) + 1),
      });
      const nextRun = items.findIndex((item) => isUserItem(item) && item.turnId !== null && item.turnId !== runId);
      return items
        .slice(0, nextRun < 0 ? undefined : nextRun)
        .filter((item) => item.kind === "ToolCall" || item.kind === "ToolResult");
    },

    async activeRunForThread(threadRef, viewer) {
      const inFlight = await deps.runs.inFlightForThread(threadRef);
      const visible: typeof inFlight = [];
      for (const run of inFlight) if (!viewer || (await viewerMayUseRun(run, viewer))) visible.push(run);
      const live = visible[0];
      if (!live) return null;
      const queued = visible
        .slice(1)
        .filter((run) => isPersonAuthored(resolveTurnOrigin(run.request).kind))
        .map((run) => ({
          runId: run.id,
          text: run.request.displayText ?? run.request.text ?? "",
          ...(run.request.attachments?.length ? { hasAttachments: true } : {}),
        }));
      return { runId: live.id, ...(queued.length ? { queued } : {}) };
    },

    async editQueuedRun(runId, text, expectedText, viewer) {
      const run = await deps.runs.get(runId);
      if (!run || (viewer && (!samePerson(run.request.actor.id, viewer) || !(await viewerMayUseRun(run, viewer)))))
        return { edited: false, reason: "not_found" };
      if (
        run.request.surface !== "web" ||
        run.request.envelopeWrapped ||
        !isPersonAuthored(resolveTurnOrigin(run.request).kind)
      )
        return { edited: false, reason: "not_editable" };
      if (!text.trim() && !run.request.attachments?.length) return { edited: false, reason: "empty_text" };
      return (await deps.runs.editPendingText(runId, text, expectedText))
        ? { edited: true }
        : { edited: false, reason: "changed_or_started" };
    },

    async withdrawRun(runId, viewer) {
      const run = await deps.runs.get(runId);
      if (!run) return { withdrawn: false, reason: "not_found" };
      if (viewer && !(await viewerMayUseRun(run, viewer))) return { withdrawn: false, reason: "not_found" };
      return (await deps.runs.withdraw(runId)) ? { withdrawn: true } : { withdrawn: false, reason: "started" };
    },

    async signalRun(runId, signal, viewer) {
      if (!deps.signals) return { accepted: false, reason: "signals_unavailable" };
      const run = await deps.runs.get(runId);
      if (!run) return { accepted: false, reason: "not_found" };
      if (viewer && !(await viewerMayUseRun(run, viewer))) return { accepted: false, reason: "not_found" };
      if (
        signal.kind === "steer" &&
        run.request.surface === "web" &&
        /^web:.+:inbox$/.test(run.request.conversation.threadRef) &&
        !signal.request
      )
        return { accepted: false, reason: "conversation_mismatch" };
      const queuedKey = signal.queuedRunId
        ? `queued-steer:${run.request.conversation.threadRef}:${signal.queuedRunId}`
        : undefined;
      if (queuedKey && (await deps.signals.runForDedupeKey(queuedKey))) return { accepted: true };
      if (isTerminal(run.status)) return { accepted: false, reason: "terminal" };
      if (signal.kind === "abort") {
        const accepted = await stopRunTree(run);
        return accepted ? { accepted: true } : { accepted: false, reason: "terminal" };
      }
      if (signal.kind === "client_result") {
        if (viewer && !samePerson(run.request.actor.id, viewer)) return { accepted: false, reason: "not_found" };
        if (!run.request.clientTools?.length && !run.request.desktopClientId)
          return { accepted: false, reason: "no_client_tools" };
        const sent = await deps.signals.send(runId, {
          kind: "client_result",
          callId: signal.callId,
          result: signal.result,
          dedupeKey: `client:${runId}:${signal.callId}`,
        });
        return sent ? { accepted: true } : { accepted: false, reason: "duplicate" };
      }
      if (signal.queuedRunId) {
        const queued = await deps.runs.get(signal.queuedRunId);
        if (!queued || (viewer && !(await viewerMayUseRun(queued, viewer))))
          return { accepted: false, reason: "not_found" };
        if (
          signal.kind !== "steer" ||
          !signal.request ||
          queued.request.conversation.threadRef !== run.request.conversation.threadRef
        )
          return { accepted: false, reason: "conversation_mismatch" };
        if (queued.id === run.id || queued.status !== "pending") return { accepted: false, reason: "queued_started" };
        const text = queued.request.displayText ?? queued.request.text;
        signal = {
          ...signal,
          text,
          ts: queuedKey,
          dedupeKey: queuedKey,
          request: { ...signal.request, text, attachments: queued.request.attachments, idempotencyKey: queuedKey },
        };
      }
      if (signal.request && signal.request.conversation.threadRef !== run.request.conversation.threadRef) {
        return { accepted: false, reason: "conversation_mismatch" };
      }
      const principal = viewer ?? signal.request?.actor.externalId ?? run.request.actor.id;
      const route = routeIncoming(
        {
          origin: "human",
          person: true,
          text: signal.text ?? "",
          hasFiles: Boolean(signal.request?.attachments?.length),
          actorId: principal,
          modelAccount: await deps.config.getModelAccountDurable(principal),
          routed: false,
        },
        liveTurnOf(run),
        { midTurn: "steer" },
      );
      if (route.kind === "abort") {
        if (signal.queuedRunId) await deps.runs.withdraw(signal.queuedRunId);
        return (await stopRunTree(run)) ? { accepted: true } : { accepted: false, reason: "terminal" };
      }
      if (route.kind === "drop") return { accepted: false, reason: "text_required" };
      if (route.kind === "turn") {
        const request =
          signal.request ?? (viewer ? await viewerSteerRequest(run, viewer, signal.text ?? "") : undefined);
        if (signal.queuedRunId || !request) return { accepted: false, reason: "not_steerable", why: route.reason };
        const own = await methods.turn({
          ...request,
          text: signal.text ?? "",
          ...(signal.ts ? { idempotencyKey: `signal-turn:${runId}:${signal.ts}` } : {}),
          midTurn: "queue",
          async: true,
        });
        return own.runId
          ? { accepted: true, queuedRunId: own.runId }
          : { accepted: false, reason: own.reason ?? own.status };
      }
      const outbound = {
        ...signal,
        ts: signal.ts ?? freshSteerTs(),
        ...(!signal.request && viewer && !samePerson(viewer, run.request.actor.id)
          ? { request: await viewerSteerRequest(run, viewer, signal.text ?? "") }
          : {}),
      };
      const steered = await steerRun(run, outbound, signal.queuedRunId);
      if (!steered.sent && signal.queuedRunId) {
        if (await deps.signals.runForDedupeKey(queuedKey!)) return { accepted: true };
        const queued = await deps.runs.get(signal.queuedRunId);
        return { accepted: false, reason: queued?.status === "pending" ? "queued_changed" : "queued_started" };
      }
      if (!steered.terminal) return { accepted: true };
      if (steered.drained && !steered.replayRunId) return { accepted: false, reason: "terminal" };
      return { accepted: false, reason: "terminal", replayed: true };
    },

    replayOrphanedRunSignals(runId) {
      return replayOrphanedRunSignals(runId).then(() => undefined);
    },
  };
  return methods;
}
