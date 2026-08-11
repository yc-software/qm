import type { Conversation, Principal, TurnRequest, TurnResult } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import { scopeId } from "../types.ts";
import { isHalt, routeWake, type Wake } from "../wake/wake.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import { isTerminal, leaseLapsed } from "../runs/run-store.ts";
import { turnModelOptions, validateWebTurnModelOptions, webTurnRuntimeModelRefusal } from "../core/turn-options.ts";
import { isProjectGroupRef, projectIdFromGroupRef } from "../projects/project-store.ts";
import {
  defaultModelForHarness,
  isHarnessId,
  modelProviderAvailabilityFor,
  modelServiceable,
} from "../model/pi-models.ts";
import { selectableCatalogForHarness, selectableModelCatalog } from "../model/model-catalog.ts";
import { resolveRuntimeChoiceDurable } from "../harness/harness-router.ts";
import { errMessage } from "../util/errors.ts";

import type { App, AppDeps } from "./app-types.ts";
import { STALE_LEASE_GRACE_MS } from "./app-types.ts";
import { unscreenedNotice } from "../security/security-posture.ts";
import type { AppHelpers } from "./app-helpers.ts";
import type { AmbientHelpers } from "./app-ambient.ts";

export function createTurnMethods(
  deps: AppDeps,
  h: AppHelpers,
  ambient: AmbientHelpers,
): Pick<
  App,
  | "turn"
  | "getApproval"
  | "subscribeSessionStates"
  | "listSessionApprovals"
  | "pendingApprovalForThread"
  | "getRun"
  | "activeRunForThread"
  | "signalRun"
  | "replayOrphanedRunSignals"
> {
  const {
    withAdminLink,
    drive,
    approvalRecordIsCurrent,
    approvalVisibleToViewer,
    pendingApprovalForSession,
    pendingApprovalResultForThread,
    mayUseSharedScope,
    viewerMayUseRun,
    sessionsForViewer,
    replayOrphanedRunSignals,
  } = h;
  const { shouldRouteToSpine, markTriggerHandled, addressedWakeText } = ambient;
  return {
    async turn(req: TurnRequest): Promise<TurnResult> {
      await deps.identity.refresh();
      const actor: Principal = deps.identity.resolve(req.actor);
      let projectAudience: Principal[] | undefined;
      let projectName: string | undefined;
      let projectVersion: string | undefined;
      let sessionParticipantIds: string[] | undefined;
      const conversationRef = req.conversation.channelRef;
      const projectGroup = req.conversation.kind === "group" && !!conversationRef && isProjectGroupRef(conversationRef);
      const projectId = projectGroup ? projectIdFromGroupRef(conversationRef) : null;

      if (projectGroup) {
        if (!deps.identity.isInternal(actor)) {
          return { status: "refused", reason: "you're not a member of that context" };
        }
        if (!projectId) return { status: "refused", reason: "you're not a member of that context" };
        const project = await deps.projects?.get(projectId);
        if (
          !project ||
          project.orgId !== orgIdOf() ||
          !deps.identity.isInternal(deps.identity.classify(project.ownerId))
        ) {
          return { status: "refused", reason: "you're not a member of that context" };
        }
        const activeMemberIds = project.memberIds.filter((memberId) =>
          deps.identity.isInternal(deps.identity.classify(memberId)),
        );
        if (!activeMemberIds.includes(actor.id))
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
      } else if (req.surface === "web" && req.conversation.kind !== "dm") {
        if (!conversationRef || !(await mayUseSharedScope(req.conversation.kind, conversationRef, actor))) {
          return { status: "refused", reason: "you're not a member of that context" };
        }
      }

      async function withCurrentProjectRoster<T>(fn: () => Promise<T>): Promise<T | null> {
        if (!projectId || !deps.projects) return fn();
        if (!conversationRef || !projectVersion) return null;
        return (await deps.projects.withVersion(conversationRef, projectVersion, fn)) ?? null;
      }

      if (req.surface === "web") {
        const threadRef = req.conversation.threadRef;
        const existing = await deps.sessions.getByThread(threadRef);
        if (existing) {
          const claimed =
            req.conversation.kind === "dm"
              ? scopeId("personal", actor.id)
              : scopeId(req.conversation.kind, req.conversation.channelRef ?? threadRef);
          if (existing.scopeId !== claimed) {
            return { status: "refused", reason: "that conversation lives in a different context" };
          }
        } else if (threadRef.startsWith("web:") && !threadRef.startsWith(`web:${actor.id}:`)) {
          return { status: "refused", reason: "you can only start a new conversation on your own thread" };
        }
        const org = scopeId("org", orgIdOf());
        const targetScope =
          req.conversation.kind === "dm"
            ? scopeId("personal", actor.id)
            : scopeId(req.conversation.kind, req.conversation.channelRef ?? threadRef);
        const fallbackHarness = isHarnessId(deps.harnessId) ? deps.harnessId : "pi";
        const runtimeFallback = deps.runtimeFallback ?? {
          harnessId: fallbackHarness,
          modelId: defaultModelForHarness(fallbackHarness),
        };
        let orgRuntime;
        let configuredRuntime;
        let runtime;
        try {
          orgRuntime = await resolveRuntimeChoiceDurable(deps.config, org, org, runtimeFallback);
          configuredRuntime =
            targetScope === org
              ? orgRuntime
              : await resolveRuntimeChoiceDurable(deps.config, org, targetScope, runtimeFallback);
          runtime =
            req.harness || req.model
              ? await resolveRuntimeChoiceDurable(deps.config, org, targetScope, runtimeFallback, {
                  ...(req.harness && isHarnessId(req.harness) ? { harnessId: req.harness } : {}),
                  ...(req.model ? { modelId: req.model } : {}),
                })
              : configuredRuntime;
        } catch (error) {
          return { status: "refused", reason: errMessage(error) };
        }
        if (req.harness && !isHarnessId(req.harness)) {
          return { status: "refused", reason: `runtime ${req.harness} is not approved` };
        }
        const configuredKeys = deps.providerKeys ??
          deps.modelProviders ?? { anthropic: false, openai: false, openrouter: false };
        let providers = deps.modelProviders;
        if (deps.modelCredentials) {
          providers = modelProviderAvailabilityFor(
            runtime.harnessId,
            configuredKeys,
            await deps.modelCredentials.availability(),
          );
        } else if (deps.providerKeys) {
          providers = modelProviderAvailabilityFor(runtime.harnessId, configuredKeys);
        }
        if (providers && !modelServiceable(runtime.modelId, providers)) {
          return {
            status: "refused",
            reason: "that model isn't available on this deployment (its provider isn't configured)",
          };
        }
        const configuredWebuiModels = await deps.config.getWebuiModelsDurable(org);
        let enabledWebuiModels: string[] | null = null;
        if (configuredWebuiModels?.length) {
          enabledWebuiModels = [...new Set([...configuredWebuiModels, orgRuntime.modelId])];
        } else if (providers?.openrouter) {
          enabledWebuiModels = [
            ...new Set([
              ...selectableCatalogForHarness(
                await selectableModelCatalog(deps.modelCredentialFetch),
                runtime.harnessId,
              ).map((model) => model.id),
              ...(orgRuntime.harnessId === runtime.harnessId ? [orgRuntime.modelId] : []),
            ]),
          ];
        }
        const invalidModelOption =
          validateWebTurnModelOptions(req, enabledWebuiModels, providers) ??
          webTurnRuntimeModelRefusal(runtime.modelId, orgRuntime.modelId, configuredWebuiModels);
        if (invalidModelOption) return { status: "refused", reason: invalidModelOption };
      }

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

      const origin = resolveTurnOrigin(req);

      const input = {
        surface: req.surface,
        ...(req.deliveryTarget ? { deliveryTarget: req.deliveryTarget } : {}),
        ...(req.deliveryCandidates?.length ? { deliveryCandidates: req.deliveryCandidates } : {}),
        actor,
        conversation,
        origin,
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
        ...(req.harness ? { harness: req.harness } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...turnModelOptions(req),
        ...(req.readOnly ? { readOnly: true } : {}),
        ...(req.skipMemory ? { skipMemory: true } : {}),
        ...(req.surfaceTools ? { surfaceTools: true } : {}),
        ...(req.envelopeWrapped ? { envelopeWrapped: true } : {}),
        ...(typeof req.displayText === "string" && req.displayText ? { displayText: req.displayText } : {}),
        ...(req.addressed || origin.kind === "human" ? { addressed: true } : {}),
        ...(typeof req.turnWallClockMs === "number" ? { turnWallClockMs: req.turnWallClockMs } : {}),
        ...(typeof req.timezone === "string" && req.timezone ? { timezone: req.timezone } : {}),
        ...(typeof req.intakePreambleMs === "number" ? { intakePreambleMs: req.intakePreambleMs } : {}),
        ...(typeof req.clientSentAt === "number" ? { clientSentAt: req.clientSentAt } : {}),
        ...(req.approval ? { approval: req.approval } : {}),
        ...(sessionParticipantIds ? { sessionParticipantIds } : {}),
        ...(projectVersion ? { scopeVersion: projectVersion } : {}),
      };

      if (projectGroup && req.approval) {
        const [approval, approvalSession] = await Promise.all([
          deps.approvals?.get(req.approval.requestId),
          deps.sessions.getByThread(conversation.threadRef),
        ]);
        if (
          !approval ||
          approval.sessionId !== approvalSession?.id ||
          !approvalSession ||
          !(await approvalRecordIsCurrent(approval, approvalSession)) ||
          !(await approvalVisibleToViewer(approvalSession, actor.id, approval))
        ) {
          return { status: "refused", reason: "approval isn't visible in your project tenure" };
        }
      }
      const blocked = await pendingApprovalResultForThread(conversation.threadRef, projectGroup ? actor.id : undefined);
      let request = input;
      if (blocked) {
        const pendingList = blocked.pendingApprovals ?? [];
        const matches = (id?: string): boolean => !!id && pendingList.some((p) => p.requestId === id);
        if (!matches(req.approval?.requestId)) return blocked;
      }

      let dedupKey: string | undefined;
      if (req.idempotencyKey) {
        dedupKey =
          projectVersion === undefined ? req.idempotencyKey : `${req.idempotencyKey}:project-${projectVersion}`;
      }

      if (origin.kind === "human" && !req.approval) deps.reaperPoke?.();

      if (
        req.surface !== "web" &&
        deps.signals &&
        (origin.kind === "human" || origin.kind === "ambient") &&
        !req.approval &&
        !req.spawned &&
        !req.idempotencyKey
      ) {
        const live = await deps.runs.activeForThread(conversation.threadRef);
        const liveOriginKind = live ? resolveTurnOrigin(live.request).kind : undefined;
        const personIntoAutomation =
          liveOriginKind === "automation" &&
          (origin.kind === "human" || (origin.kind === "ambient" && origin.live === true)) &&
          !(origin.kind === "human" && isHalt(req.text));
        if (live && !isTerminal(live.status) && !personIntoAutomation) {
          const steerText =
            origin.kind === "ambient" ? `${actor.displayName?.trim() || actor.id}: ${req.text}` : req.text;
          let injectedText = steerText;
          if (origin.kind === "ambient") {
            const session = await deps.sessions.getByThread(conversation.threadRef);
            const decision = await deps.orchestrator.screenSecuritySteer({
              payload: steerText,
              actor,
              conversation,
              ...(session ? { sessionId: session.id } : {}),
            });
            if (decision === "block")
              return req.async ? { status: "queued", runId: live.id, steered: true } : drive(live.id);
            if (decision === "unscreened") injectedText = `${unscreenedNotice("mid-turn message")}\n${steerText}`;
          }
          const wake: Wake = {
            situation: origin.kind === "ambient" ? "ambientUpdate" : "addressed",
            ts: String(req.clientSentAt ?? Date.now()),
            text: injectedText,
            halt: origin.kind === "human" && isHalt(req.text),
          };
          const route = routeWake(wake, true, resolveTurnOrigin(live.request).kind === "ambient");
          if (route.kind === "steer" || route.kind === "drop") {
            const steerTs = origin.kind === "human" ? (origin.messageTs ?? origin.entryTs) : origin.entryTs;
            const routedRunId = await withCurrentProjectRoster(async () => {
              if (route.kind === "steer")
                await deps.signals!.send(live.id, {
                  kind: route.signal,
                  ...(route.text ? { text: route.text } : {}),
                  ...(steerTs ? { ts: steerTs } : {}),
                  ...(route.signal === "steer" ? { request: req } : {}),
                });
              return live.id;
            });
            if (!routedRunId)
              return { status: "refused", reason: "project membership changed; retry from the current project" };
            if (route.kind === "steer") {
              const after = await deps.runs.get(live.id);
              if (!after || isTerminal(after.status)) {
                const own = (await replayOrphanedRunSignals(live.id)).find(
                  (d) => d.signal.text === route.text && d.signal.ts === steerTs,
                );
                if (own?.replayRunId)
                  return req.async ? { status: "queued", runId: own.replayRunId } : drive(own.replayRunId);
              }
            }
            return req.async ? { status: "queued", runId: routedRunId, steered: true } : drive(routedRunId);
          }
        }
      }

      const spineRouted = !req.approval && shouldRouteToSpine(request as OrchestratorInput);
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

      if (spineRouted && origin.kind === "human" && !req.spawned && !req.idempotencyKey && origin.messageTs) {
        const container = conversation.channelRef ?? conversation.threadRef;
        const ambientRef = `${req.surface}:${container}:ambient:${origin.messageTs}`;
        const ambientSession = await deps.sessions.getByThread(ambientRef);
        if (ambientSession) {
          const liveAmbient = await deps.runs.activeForThread(ambientRef);
          if (liveAmbient && !isTerminal(liveAmbient.status)) {
            const routedRunId = await withCurrentProjectRoster(async () => {
              if (deps.signals)
                await deps.signals.send(liveAmbient.id, {
                  kind: "steer",
                  text: req.text,
                  ts: origin.messageTs,
                  request: req,
                });
              return liveAmbient.id;
            });
            if (!routedRunId)
              return { status: "refused", reason: "project membership changed; retry from the current project" };
            const after = await deps.runs.get(liveAmbient.id);
            if (!after || isTerminal(after.status)) {
              const own = (await replayOrphanedRunSignals(liveAmbient.id)).find(
                (d) => d.signal.text === req.text && d.signal.ts === origin.messageTs,
              );
              if (own?.replayRunId)
                return req.async ? { status: "queued", runId: own.replayRunId } : drive(own.replayRunId);
            }
            // Deliberately NOT flagged `steered`. Unlike the mid-turn branch above, this run's owner
            // is the UNPROMPTED ambient handler, which stays silent on a refusal or failure
            // (bystander restraint) and whose recovery copy is suppressed for the same reason. The
            // addressed caller is the only one that would ever report that, so standing it down
            // would trade a duplicate reply for silence on a message someone actually addressed.
            return req.async ? { status: "queued", runId: routedRunId } : drive(routedRunId);
          }
        }
      }

      const known = await deps.sessions.getByThread(conversation.threadRef);
      const participants = known ? await deps.sessions.participantsOf(known.id) : [];
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
      if (!deduped) {
        deps.sessionStateBus?.emit({
          threadRef: conversation.threadRef,
          ...(known ? { sessionId: known.id } : {}),
          state: "working",
          at: Date.now(),
          participants: participants.length ? participants : [req.actor.externalId],
        });
      }
      if (spineRouted && !deduped) markTriggerHandled(input as OrchestratorInput);
      if (spineRouted) deps.engaged?.engage(conversation.threadRef);
      if (deduped && run.result && isTerminal(run.status)) return withAdminLink(run.result);
      if (req.async) return { status: "queued", runId: run.id };
      return drive(run.id);
    },

    subscribeSessionStates(cb) {
      return deps.sessionStateBus?.subscribe(cb) ?? (() => {});
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
      const mine = await sessionsForViewer(viewer);
      if (!mine.some((s) => s.id === sessionId)) return [];
      return pendingApprovalForSession(sessionId, { blockingOnly: false, viewer });
    },

    pendingApprovalForThread(threadRef, viewer) {
      return pendingApprovalResultForThread(threadRef, viewer);
    },

    async getRun(runId, viewer) {
      const run = await deps.runs.get(runId);
      if (!run) return null;
      if (viewer && !(await viewerMayUseRun(run, viewer))) return null;
      const partial = deps.turnStream?.snapshot(runId);
      const firstBlock = deps.turnStream?.firstBlock(runId);
      const surfacePosted = deps.turnStream?.surfacePosted(runId) ?? false;
      const alive = deps.turnStream?.alive(runId) ?? false;
      const replying = deps.turnStream?.replying(runId) ?? false;
      const replyComplete = deps.turnStream?.isReplyDone(runId) ?? false;
      const activity = await deps.runActivity?.list(runId);
      const tasks = await deps.tasks?.list({ originRunId: runId });
      const stale =
        run.status === "pending" ? run.attempts > 0 : !alive && leaseLapsed(run, Date.now() - STALE_LEASE_GRACE_MS);
      return {
        status: run.status,
        result: run.result ? await withAdminLink(run.result) : run.result,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        ...(partial ? { partial } : {}),
        ...(firstBlock
          ? { firstBlock: firstBlock.text, ...(firstBlock.closed ? { firstBlockClosed: true } : {}) }
          : {}),
        ...(surfacePosted ? { surfacePosted: true } : {}),
        ...(alive ? { alive: true } : {}),
        ...(stale ? { stale: true } : {}),
        ...(replying ? { replying: true } : {}),
        ...(replyComplete ? { replyComplete: true } : {}),
        ...(tasks?.length ? { tasks: tasks.map(({ id, title, status }) => ({ id, title, status })) } : {}),
        ...(activity && activity.length ? { activity } : {}),
      };
    },

    async activeRunForThread(threadRef, viewer) {
      const run = await deps.runs.activeForThread(threadRef);
      return run && (!viewer || (await viewerMayUseRun(run, viewer))) ? { runId: run.id } : null;
    },

    async signalRun(runId, signal, viewer) {
      if (!deps.signals) return { accepted: false, reason: "signals_unavailable" };
      const run = await deps.runs.get(runId);
      if (!run) return { accepted: false, reason: "not_found" };
      if (viewer && !(await viewerMayUseRun(run, viewer))) return { accepted: false, reason: "not_found" };
      if (isTerminal(run.status)) return { accepted: false, reason: "terminal" };
      if (signal.kind === "steer" && !signal.text?.trim()) {
        return { accepted: false, reason: "text_required" };
      }
      await deps.signals.send(runId, signal);
      const after = await deps.runs.get(runId);
      if (!after || isTerminal(after.status)) {
        await replayOrphanedRunSignals(runId);
        if (signal.kind !== "steer") return { accepted: false, reason: "terminal" };
        // The steer was stored before the run went terminal, so its text is replayed as
        // a fresh turn (by this drain, the onTerminal hook, or the orphan sweeper —
        // whoever drains first). Tell the caller so it attaches to the fresh run
        // instead of treating the message as lost.
        return { accepted: false, reason: "terminal", replayed: true };
      }
      return { accepted: true };
    },

    replayOrphanedRunSignals(runId) {
      return replayOrphanedRunSignals(runId).then(() => undefined);
    },
  };
}
