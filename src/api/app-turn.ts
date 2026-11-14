import { externalSlackRequestAllowed } from "../resolution/external-slack.ts";
import { createPersonNames } from "../identity/person-names.ts";
import { turnModelRefusal } from "./runtime-config.ts";
import type { Run } from "../runs/run-store.ts";
import {
  USER_STOP,
  USER_STOP_ALL,
  isSubagentThreadRef,
  sessionTreeRuns,
  stopSessionRuns,
  stopSessionTree,
} from "../sessions/session-syscalls.ts";
import { isUserItem } from "../sessions/items.ts";
import type { Conversation, Principal, TurnOrigin, TurnRequest, TurnResult } from "../types.ts";
import { conversationWriteAccess } from "./conversation-write-access.ts";
import {
  liveTurnOf,
  mayMeetLiveTurn,
  routeIncoming,
  stopsLiveWork,
  type Incoming,
  type LiveTurn,
} from "../wake/route-incoming.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { replayableRequest } from "../core/orchestrator/turn-helpers.ts";
import { desktopClientForTurn, isPersonAuthored, isSessionTurn, spokenByPerson } from "../core/turn-origin.ts";
import { isTerminal, leaseLapsed } from "../runs/run-store.ts";
import type { SessionStateEvent } from "../runs/session-state-bus.ts";
import { turnRuntimePurpose } from "../core/turn-options.ts";
import { turnModelOptions } from "../agent/runtime-choice.ts";
import { personIds, samePerson } from "../directory/person.ts";
import { swallowAs } from "../util/errors.ts";
import { APPROVAL_DECISION_SIGNAL_TEXT, executesOnApprove } from "../core/orchestrator/approvals.ts";
import { sleep } from "../util/async.ts";

import type { App, AppDeps } from "./app-types.ts";
import { STALE_LEASE_GRACE_MS } from "./app-types.ts";

const PARTICIPANT_REHYDRATE_TIMEOUT_MS = 5_000;
import type { AppHelpers } from "./app-helpers.ts";
import type { AmbientHelpers } from "./app-ambient.ts";

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
  | "steerRun"
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
    const { surface, scopeVersion, deliveryTarget, deliveryCandidates, surfaceOrigin, conversation } =
      replayableRequest(run.request);
    return {
      surface,
      ...(scopeVersion ? { scopeVersion } : {}),
      ...(deliveryTarget ? { deliveryTarget } : {}),
      ...(deliveryCandidates ? { deliveryCandidates } : {}),
      ...(surfaceOrigin ? { surfaceOrigin } : {}),
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
  async function stopThread(
    threadRef: string,
    run: Run | undefined,
    tree: boolean,
    botRunsOnly = false,
  ): Promise<boolean> {
    if (!deps.signals) return false;
    const stopDeps = { sessions: deps.sessions, runs: deps.runs, signals: deps.signals };
    const scope = tree ? undefined : "session";
    const reason = tree ? USER_STOP_ALL : USER_STOP;
    const stop = async () => {
      const session = await deps.sessions.getByThread(threadRef);
      if (session && tree) {
        const stopped = await stopSessionTree(stopDeps, session, reason, botRunsOnly);
        await deps.settleTreeWakes?.(session, botRunsOnly);
        return stopped;
      }
      if (session) return (await stopSessionRuns(stopDeps, session, { reason, scope, botRunsOnly })).length > 0;
      if (!run || run.status === "done" || run.status === "failed" || (botRunsOnly && !run.request.botActor))
        return false;
      await stopDeps.signals.send(run.id, { kind: "abort", reason, ...(scope ? { scope } : {}) });
      if (run.status === "pending") await deps.runs.withdraw(run.id);
      return true;
    };
    return deps.advisoryLock.withLock("session-tree-admission", stop);
  }
  const stopRun = (run: Run, tree: boolean, botRunsOnly = false) => stopThread(run.sessionId, run, tree, botRunsOnly);
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
      const personNames = createPersonNames({ users: deps.users });
      const withStoredNames = async (people: Principal[]): Promise<Principal[]> => {
        const names = await personNames.storedNames(people.filter((p) => !p.displayName?.trim()).map((p) => p.id));
        return people.map((p) => (names.has(p.id) ? { ...p, displayName: names.get(p.id)! } : p));
      };
      const [actor] = (await withStoredNames([deps.identity.resolve(req.actor)])) as [Principal];
      if (req.actor.isBot && personIds(req.actor.externalId).length > 1)
        return {
          status: "refused",
          reason:
            "a bot can't act as a person; an org admin must delete the principal link that joins this bot to someone (docs/principal-links.md)",
        };
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

      if (req.surface === "webhook" && req.origin?.kind === "automation" && !sessionParticipantIds) {
        sessionParticipantIds = [actor.id];
      }

      async function withCurrentProjectRoster<T>(fn: () => Promise<T>): Promise<T | null> {
        if (!project || !deps.projects) return fn();
        if (!conversationRef) return null;
        return (await deps.projects.withVersion(conversationRef, project.version, fn)) ?? null;
      }

      async function routeApprovalIntoLiveRun(
        request: TurnRequest,
        decision: NonNullable<TurnRequest["approval"]>,
        actorId: string,
        threadRef: string,
      ): Promise<TurnResult | null> {
        const [record, session, live] = await Promise.all([
          deps.approvals?.get(decision.requestId),
          deps.sessions.getByThread(threadRef),
          deps.runs.activeForThread(threadRef),
        ]);
        if (!record?.call || !session || (decision.approved && (decision.scope ?? "once") !== "once")) return null;
        if (record.sessionId !== session.id || (await approvalResumable(session, actorId, record)) !== "ok")
          return null;
        if (!live || live.status !== "running" || leaseLapsed(live, Date.now())) return null;
        if (
          !samePerson(live.request.actor.id, actorId) ||
          isSessionTurn(live.request) ||
          !(isPersonAuthored(live.request.origin.kind) || spokenByPerson(live.request.origin))
        )
          return null;
        const dedupeKey = `approval:${decision.requestId}:${record.createdAt ?? 0}:${decision.approved}:${live.id}`;
        const routedRunId = await withCurrentProjectRoster(async () => {
          await deps.signals!.send(live.id, {
            kind: "steer",
            text: APPROVAL_DECISION_SIGNAL_TEXT,
            ts: dedupeKey,
            request: { ...request, approval: decision },
            dedupeKey,
          });
          return live.id;
        });
        if (!routedRunId)
          return { status: "refused", reason: "project membership changed; retry from the current project" };
        const after = await deps.runs.get(live.id);
        if (after && !isTerminal(after.status)) return { status: "queued", runId: live.id, steered: true };
        const own = (await replayOrphanedRunSignals(live.id)).find((d) => d.signal.dedupeKey === dedupeKey);
        return own?.replayRunId
          ? { status: "queued", runId: own.replayRunId }
          : { status: "queued", runId: live.id, steered: true };
      }

      const approvedRequest = req.approval ? (await deps.approvals?.get(req.approval.requestId))?.request : undefined;
      const sameApprovedMessage =
        approvedRequest?.text === req.text &&
        approvedRequest.actor.externalId === req.actor.externalId &&
        approvedRequest.conversation.threadRef === req.conversation.threadRef;
      let privateRequest = req.privateSessionMessage ? req : undefined;
      if (approvedRequest?.privateSessionMessage) privateRequest = approvedRequest;
      const storedApproval = privateRequest && privateRequest === approvedRequest ? privateRequest : undefined;
      const origin: TurnOrigin = storedApproval?.origin ?? req.origin ?? { kind: "direct" };
      const sessionTurn =
        (req.spawned && isSessionTurn(req)) ||
        (sameApprovedMessage && approvedRequest && isSessionTurn(approvedRequest));

      const modelAccount =
        req.surfaceOrigin?.audience !== "external" &&
        deps.userModelCredentials &&
        origin.kind === "human" &&
        !sessionTurn
          ? await deps.config.getModelAccountDurable(actor.id)
          : "company";
      const individualAuth = modelAccount !== "company";
      const automated = req.origin?.kind === "automation";
      const runtimePurpose = turnRuntimePurpose(
        { surface: req.surface, triggered: automated, infrequentCron: req.infrequentCron },
        isSubagentThreadRef(req.conversation.threadRef),
      );
      const modelRefusal = await turnModelRefusal(deps, req, actor.id, individualAuth, runtimePurpose);
      if (modelRefusal) return { status: "refused", reason: modelRefusal };

      const rawAudience = req.conversation.audience ?? [req.actor];
      const audience: Principal[] =
        project?.audience ??
        (await withStoredNames(
          rawAudience.map((a) => {
            const p = deps.identity.classify(a.externalId, a.isExternalGuest);
            if (p.id === actor.id) return actor;
            return a.displayName ? { ...p, displayName: a.displayName } : p;
          }),
        ));
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
        ...(req.surfaceOrigin ? { surfaceOrigin: req.surfaceOrigin } : {}),
        ...(req.spawned && req.sessionSenderId ? { sessionSenderId: req.sessionSenderId } : {}),
        ...(req.spawned && req.delegatingRunId ? { delegatingRunId: req.delegatingRunId } : {}),
        ...(sameApprovedMessage && approvedRequest?.sessionSenderId
          ? { sessionSenderId: approvedRequest.sessionSenderId }
          : {}),
        ...(sameApprovedMessage && approvedRequest?.delegatingRunId
          ? { delegatingRunId: approvedRequest.delegatingRunId }
          : {}),
        ...(req.deliveryTarget ? { deliveryTarget: req.deliveryTarget } : {}),
        ...(req.deliveryWebhook ? { deliveryWebhook: req.deliveryWebhook } : {}),
        ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}),
        ...(req.deliveryCandidates?.length ? { deliveryCandidates: req.deliveryCandidates } : {}),
        actor,
        conversation,
        origin,
        modelAccount: origin.kind === "human" ? modelAccount : ("company" as const),
        text: req.text,
        ...(req.gatewayContext ? { gatewayContext: req.gatewayContext } : {}),
        ...(req.proactiveOpener ? { proactiveOpener: true } : {}),
        ...(req.conversationHeader ? { conversationHeader: req.conversationHeader } : {}),
        ...(req.priorTurns?.length ? { priorTurns: req.priorTurns } : {}),
        ...(req.overheard?.length ? { overheard: req.overheard } : {}),
        ...(req.detectContext ? { detectContext: req.detectContext } : {}),
        ...(req.detectOpener ? { detectOpener: req.detectOpener } : {}),
        ...(req.attachments?.length ? { attachments: req.attachments } : {}),
        ...(req.inboundNotes?.length ? { inboundNotes: req.inboundNotes } : {}),
        ...((!individualAuth || req.surface === "web") && req.model ? { model: req.model } : {}),
        ...turnModelOptions({ ...req, triggered: automated }),
        ...(req.readOnly ? { readOnly: true } : {}),
        ...(privateRequest
          ? {
              privateSessionMessage: true as const,
              sessionMessageDepth: privateRequest.sessionMessageDepth,
              readOnly: true,
            }
          : {}),
        ...(req.skipMemory ? { skipMemory: true } : {}),
        ...(req.memoryNotebookOnly ? { memoryNotebookOnly: true } : {}),
        ...(req.cronScript && origin.kind === "automation" ? { cronScript: req.cronScript } : {}),
        ...(req.infrequentCron && origin.kind === "automation" ? { infrequentCron: true } : {}),
        ...(req.personaId && origin.kind === "automation" && req.surface === "cron"
          ? { personaId: req.personaId }
          : {}),
        ...(req.botActor ? { botActor: true } : {}),
        ...(req.noApprover ? { noApprover: true } : {}),
        ...(req.surfaceTools ? { surfaceTools: true } : {}),
        ...(req.clientTools?.length ? { clientTools: req.clientTools } : {}),
        desktopClientId: desktopClientForTurn({ ...req, origin }),
        ...(req.clientSurface ? { clientSurface: req.clientSurface } : {}),
        ...(req.envelopeWrapped ? { envelopeWrapped: true } : {}),
        ...(req.liveReplies ? { liveReplies: true } : {}),
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
          return { status: "refused", reason: "approval isn't visible to you in this project" };
        }
      }
      const sealedByApproval = async (): Promise<TurnResult | undefined> => {
        const approval = req.approval;
        if (!approval) return undefined;
        const blocked = await pendingApprovalResultForThread(conversation.threadRef, actor.id, { alwaysBlock: true });
        if (!blocked) return undefined;
        const record = await deps.approvals?.get(approval.requestId);
        const blockedSession = blocked.sessionId ? await deps.sessions.get(blocked.sessionId) : null;
        let cause: Awaited<ReturnType<typeof approvalResumable>> | "no_session" | "nonblocking" = blockedSession
          ? await approvalResumable(blockedSession, actor.id, record)
          : "no_session";
        if (cause === "ok" && record?.blocksInput === false) cause = "nonblocking";
        if (cause === "ok") return undefined;
        h.recordAudit({
          at: Date.now(),
          principalId: actor.id,
          action: `command_approval.${approval.approved ? "approve" : "deny"}`,
          resource: approval.requestId,
          scopeLabel: blockedSession?.scopeId ?? conversation.threadRef,
          status: "refused",
          detail: JSON.stringify({ approvalOutcome: "sealed_thread", cause }),
        });
        return blocked;
      };
      let request = input;

      if (req.approval && deps.signals && !isSubagentThreadRef(conversation.threadRef)) {
        const routed = await routeApprovalIntoLiveRun(req, req.approval, actor.id, conversation.threadRef);
        if (routed) return routed;
      }

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

      const spineRouted =
        req.surfaceOrigin?.audience !== "external" && !req.approval && shouldRouteToSpine(request as OrchestratorInput);
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
        ...(req.botActor ? { bot: true } : {}),
      };
      if (deps.signals && !queuedBefore && mayMeetLiveTurn(incoming)) {
        const ambientRef =
          spineRouted && origin.kind === "human" && origin.messageTs
            ? `${req.surface}:${conversation.channelRef ?? conversation.threadRef}:ambient:${origin.messageTs}`
            : undefined;
        const candidates = await liveTurnsFor(conversation.threadRef, ambientRef, stopsLiveWork(incoming, true));
        if (redeliveryKey && candidates.some(({ run }) => run?.dedupKey === redeliveryKey)) return { status: "silent" };
        const prefs = req.midTurn ? { midTurn: req.midTurn } : {};
        const routes = candidates.map((candidate) => ({
          ...candidate,
          route: routeIncoming(incoming, candidate.turn, prefs),
        }));
        const live = routes.find(({ route }) => route.kind !== "turn") ?? routes[0];
        const route = live?.route ?? routeIncoming(incoming, null, prefs);
        if (route.kind === "abort") {
          const stopped = await withCurrentProjectRoster(async () => {
            const own = candidates.find(({ run }) => run?.sessionId === conversation.threadRef)?.run;
            let any = await stopThread(conversation.threadRef, own, true, incoming.bot);
            for (const { run } of routes.filter((r) => r.route.kind === "abort"))
              if (run && run.sessionId !== conversation.threadRef)
                any = (await stopRun(run, true, incoming.bot)) || any;
            return any;
          });
          if (stopped === null)
            return { status: "refused", reason: "project membership changed; retry from the current project" };
          if (!stopped)
            console.error(
              `[turn] stop in ${conversation.threadRef} found no live ${incoming.bot ? "bot " : ""}work to stop`,
            );
          return { status: "silent", steered: true, stopped };
        }
        if (route.kind === "drop") return { status: "refused", reason: "empty message" };
        if (route.kind === "turn" && route.reason === "bot-turn" && prefs.midTurn === "steer" && live?.run) {
          const botTurn = live.run;
          await withCurrentProjectRoster(() => stopRun(botTurn, false, true));
        }
        if (live?.run && route.kind !== "turn") {
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
                request: { ...req, origin },
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
      if (spineRouted) deps.engaged?.engage({ tenantId: run.tenantId, threadRef: conversation.threadRef });
      const terminalResult = deduped && isTerminal(run.status) ? run.result : null;
      if (req.async && !terminalResult) return { status: "queued", runId: run.id };
      const result = terminalResult ? await withAdminLink(terminalResult) : await awaitRun(run.id);
      return req.origin?.kind === "automation" && req.origin.destination?.type === "webhook"
        ? { ...result, runId: run.id }
        : result;
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
        ({ tenantId: _tenant, ...event }) => queue(async () => cb(await rehydrate(event))),
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
      const { call: _call, ...view } = record;
      return { requestId, ...view, ...executesOnApprove(record) };
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
        deps.runStreamEvents?.subscribe((event) => (event.runId === runId ? listener(event) : undefined), {
          onResync,
        }) ?? (() => {})
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
      const plannedRequeue = run.lastStop?.kind === "parked" || run.lastStop?.kind === "shutdown";
      const stale =
        run.status === "pending"
          ? run.attempts > 0 && !plannedRequeue
          : !alive && leaseLapsed(run, Date.now() - STALE_LEASE_GRACE_MS);
      return {
        desktopClientId: desktopClientForTurn({ ...run.request, attempt: run.attempts }),
        status: run.status,
        attempt: run.attempts,
        result: run.result ? await withAdminLink(run.result) : run.result,
        ...(run.request.surface === "web" &&
        !run.request.approval &&
        !run.request.envelopeWrapped &&
        !(run.request.proactiveOpener && !run.request.text.trim()) &&
        isPersonAuthored(run.request.origin.kind)
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
        .filter((run) => isPersonAuthored(run.request.origin.kind))
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
      if (run.request.surface !== "web" || run.request.envelopeWrapped || !isPersonAuthored(run.request.origin.kind))
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
      if (signal.kind === "abort" && (signal.tree || !isTerminal(run.status)))
        return (await stopRun(run, signal.tree === true))
          ? { accepted: true }
          : { accepted: false, reason: "terminal" };
      if (isTerminal(run.status)) return { accepted: false, reason: "terminal" };
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
        return (await stopRun(run, true)) ? { accepted: true } : { accepted: false, reason: "terminal" };
      }
      if (route.kind === "drop") return { accepted: false, reason: "text_required" };
      if (route.kind === "turn") {
        const request =
          signal.request ?? (viewer ? await viewerSteerRequest(run, viewer, signal.text ?? "") : undefined);
        if (route.reason === "bot-turn" && (signal.queuedRunId || request)) {
          await stopRun(run, false, true);
          if (signal.queuedRunId) return { accepted: false, reason: "queued_started" };
        }
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

    steerRun(run, signal) {
      return steerRun(run, signal);
    },
  };
  return methods;
}
