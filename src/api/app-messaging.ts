import { createCurrentScopeMembers } from "../resolution/scope-membership.ts";
import { cronSharingRevision, cronPublicationId, withCronAccess } from "../cron/cron-store.ts";
import { ambientTenant } from "../tenants/context.ts";
import { cronRef, encodeRef } from "../acl/resource-ref.ts";
import { refreshPrivateContext, inheritContextSources, privateSourceAllowed } from "../sessions/private-context.ts";
import { triggerPrivacy, assertPrivateTrigger } from "../triggers/trigger-store.ts";
import type { CreateTriggerInput } from "../triggers/trigger-store.ts";
import { loopAdministration } from "./loop-administration.ts";
import type { ScopeId } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import { personalScope, parseScopeId, scopeId } from "../types.ts";
import {
  samePerson,
  personIds,
  personKey,
  personKeys,
  samePersonInDirectory,
  samePersonMatcher,
} from "../directory/person.ts";
import type { Destination } from "../types.ts";
import type { SurfaceContextRequest, SurfaceContextResult } from "../reach/reach.ts";
import { reportFailureAs } from "../util/errors.ts";
import { declineUnreachableApproval } from "../core/approval-requester.ts";
import { tenantListeners } from "../tenants/cache.ts";
import { adminCronHistoryUrl } from "../util/admin-links.ts";
import { randomUUID } from "node:crypto";
import {
  reachEnqueue,
  withSlackUnfurlOption,
  withReact,
  withDelete,
  withEdit,
  withThread,
  type ReachResolution,
} from "../reach/reach.ts";
import { isVisible } from "../directory/visibility.ts";
import { signInMembers } from "../directory/sign-in-members.ts";
import { hasRevisionEvents, recordMessageRevisions } from "../slack/message-revisions.ts";
import { answerWebContextRequest } from "./web-context.ts";
import { availableRuntimeError, validateRuntimeChoice } from "./runtime-config.ts";
import { assertCronRuntime } from "../cron/runtime.ts";
import type { Cron } from "../triggers/types.ts";
import { linkedChanges, withSharing } from "./app-cron-share.ts";
import { validateUserSchedule } from "../cron/schedule.ts";
import { editableIn, SLACK } from "../surfaces/registry.ts";
import { trialBeforeSave } from "../cron/script.ts";

import type { App, AppDeps, CronEditor, ReachNowResult } from "./app-types.ts";
import { CONTEXT_REQUEST_EXPIRY_MS } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import type { AmbientHelpers } from "./app-ambient.ts";

export async function cronVisibility(deps: AppDeps, h: AppHelpers, principalId: string) {
  const viewerKeys = personKeys(await deps.directory.get(principalId).catch(() => null), principalId);
  const viewersOwn = (id: string): boolean => viewerKeys.has(personKey(id));
  const scopeNames = new Map<ScopeId, string | null>([[scopeId("org", orgIdOf()), null]]);
  if (deps.identity.isInternal(deps.identity.classify(principalId))) {
    for (const c of await deps.directory.listChannelsFor(principalId)) {
      scopeNames.set(scopeId("channel", c.channelId), c.name);
    }
  }
  for (const project of await h.projectsForViewer(principalId)) scopeNames.set(project.scopeId, project.name);
  const allowed = (ownerScopeId: ScopeId): boolean => {
    const { kind, ref } = parseScopeId(ownerScopeId);
    return kind !== "group" || deps.projects?.recognizes(ref) !== true || scopeNames.has(ownerScopeId);
  };
  return {
    viewersOwn,
    scopeNames,
    canSee: (c: Pick<Cron, "ownerScopeId" | "owner" | "destination">): boolean =>
      allowed(c.ownerScopeId) &&
      (viewersOwn(c.owner) ||
        scopeNames.has(c.ownerScopeId) ||
        (c.destination?.type === "principal" && viewersOwn(c.destination.target))),
  };
}

export function createMessagingMethods(
  deps: AppDeps,
  h: AppHelpers,
  ambient: AmbientHelpers,
): Pick<
  App,
  | "createCron"
  | "publishPrivateCron"
  | "getCron"
  | "listCrons"
  | "listCronsForViewer"
  | "updateCron"
  | "deleteCron"
  | "setCronEnabled"
  | "setCronFireNote"
  | "listCronFires"
  | "cronFiresByThreadRefs"
  | "latestCronFireForThread"
  | "setCronDestination"
  | "setCronRuntime"
  | "createWebhook"
  | "getWebhook"
  | "listWebhooks"
  | "listWebhookEvents"
  | "setWebhookEnabled"
  | "updateWebhook"
  | "pendingDeliveries"
  | "enqueueDelivery"
  | "ingestSurfaceEvents"
  | "surfaceMirrored"
  | "chatSurfaces"
  | "searchSurface"
  | "readSurfaceMessages"
  | "activeSurfaceThreads"
  | "listSurfaceContainers"
  | "getChannelPolicy"
  | "setChannelPolicy"
  | "judgeAmbientContainer"
  | "createContextRequest"
  | "onContextRequestCreated"
  | "getContextRequest"
  | "deleteContextRequest"
  | "pendingContextRequests"
  | "fulfillContextRequest"
  | "ackDelivery"
  | "failDelivery"
  | "ackDeliveryByKey"
  | "setRunDeliveryState"
  | "upsertDirectory"
  | "upsertChannels"
  | "upsertGroups"
  | "registerGroupRoster"
  | "setDirectoryWorkspace"
  | "directoryMeta"
  | "channelMember"
  | "channelVisibleTo"
  | "resolveRecipient"
  | "resolveChannel"
  | "directoryMembers"
  | "directoryChannels"
  | "directoryChannelsFor"
  | "directoryMember"
  | "loopAdministration"
  | "samePerson"
  | "personMatcher"
  | "cronAdminUrl"
  | "channelName"
  | "ambientJudge"
  | "preparePrincipalDelivery"
  | "recordPrincipalDelivery"
  | "reachNow"
  | "resolveReachTarget"
> {
  const { adminBase, resolveReachTargetFor } = h;
  const { judgeAmbientContainer, ambientSelf } = ambient;
  const contextRequests = deps.contextRequests;
  const sharedMembers = createCurrentScopeMembers(
    { managedGroups: deps.managedGroups ?? deps.projects, directory: deps.directory, identity: deps.identity },
    true,
  );
  const contextRequestListeners = tenantListeners<[SurfaceContextRequest]>("context request");
  const contextRequestTokens = new Map<string, string>();
  const identityMembers = () =>
    signInMembers({
      identity: deps.identity,
      sessions: deps.sessions,
      ...(deps.users ? { users: deps.users } : {}),
      ...(deps.emailAuthMembers ? { emailAuthMembers: deps.emailAuthMembers } : {}),
    });
  const mergedDirectoryMembers = async () => {
    const [stored, viaEmail] = await Promise.all([deps.directory.list(), identityMembers()]);
    const seen = new Set(stored.map((member) => personKey(member.principalId)));
    return [...stored, ...viaEmail.filter((member) => !seen.has(personKey(member.principalId)))];
  };

  const validateRuntime = async (cron: Pick<Cron, "runtime" | "ownerScopeId" | "loopId" | "action" | "message">) => {
    assertCronRuntime(cron);
    if (!cron.runtime) return;
    const error =
      validateRuntimeChoice(cron.runtime) ??
      (await availableRuntimeError({ deps }, cron.ownerScopeId, cron.runtime, "cron"));
    if (error) throw new Error(error);
  };

  const auditCron = (action: string, cron: Pick<Cron, "id" | "ownerScopeId">, by: CronEditor) =>
    h.recordAudit({
      at: Date.now(),
      principalId: by.actorId,
      action,
      resource: cron.id,
      scopeLabel: cron.ownerScopeId,
      ...(by.runId || by.botActor
        ? { detail: JSON.stringify({ runId: by.runId, botActor: by.botActor || undefined }) }
        : {}),
    });

  const triggerInput = async <T extends CreateTriggerInput>(input: T): Promise<T> => {
    const context = input.context;
    if (!context) {
      assertPrivateTrigger(input);
      return input;
    }
    await refreshPrivateContext(deps.sessions, context);
    const next = { ...input, ...triggerPrivacy(input, context) };
    if (
      next.personalOnly &&
      (!privateSourceAllowed(context, input.ownerScopeId) ||
        input.ownerScopeId !== personalScope(context.actorId) ||
        !samePerson(input.owner, context.actorId))
    )
      throw new Error("Private scheduled outputs must belong to the current person.");
    assertPrivateTrigger(next);
    return next;
  };

  const cronPrivacy = async (
    before: Cron,
    by: CronEditor,
    patch: Partial<Pick<Cron, "owner" | "destination" | "personalOnly" | "sourceProvenance">> = {},
  ) => {
    await refreshPrivateContext(deps.sessions, by);
    if (before.loopId && (by.personalOnly || before.personalOnly))
      throw new Error("Use loop controls to change a private loop schedule.");
    if ((await inheritContextSources(deps.sessions, by, [before])).has(before.id))
      throw new Error("This scheduled output is private to its owner.");
    const desired = await triggerInput({ ...before, ...patch, context: by });
    if (desired.personalOnly || desired.sourceProvenance) {
      const copies = (await deps.crons.copiesOf(before.id)).filter((copy) => !copy.forkedAt);
      const related = [desired, ...copies];
      const grants = await deps.acl.find(ambientTenant(), {
        resources: related.map((cron) => ({ ownerScopeId: cron.ownerScopeId, ref: encodeRef(cronRef(cron.id)) })),
      });
      if (desired.personalOnly && (copies.length || grants.length))
        throw new Error("Private context cannot update a shared schedule. Create a personal schedule instead.");
      if (!desired.personalOnly && desired.sourceProvenance) {
        const targets = await deps.sessions.getMany({
          ids: [],
          threadRefs: [
            ...new Set(related.flatMap((cron) => (cron.destination?.type === "web" ? [cron.destination.target] : []))),
          ],
        });
        const webScopes = new Map(targets.map((session) => [session.threadRef, session.scopeId]));
        for (const cron of related) {
          const audiences = new Set([
            cron.ownerScopeId,
            ...grants
              .filter((grant) => grant.ownerScopeId === cron.ownerScopeId && grant.ref === encodeRef(cronRef(cron.id)))
              .map((grant) => grant.granteeScopeId),
          ]);
          const destination = cron.destination;
          if (destination) {
            if (destination.audienceScopeId) audiences.add(destination.audienceScopeId);
            let actual = destination.audienceScopeId;
            if (destination.type === "principal") actual = personalScope(destination.target);
            else if (destination.type === "web") actual = webScopes.get(destination.target);
            else if (destination.type === "slack") actual = scopeId("channel", destination.target);
            if (!actual) throw new Error("Schedule destination context cannot be verified.");
            audiences.add(actual);
          }
          audiences.delete(personalScope(by.actorId));
          const output = { ...cron, ...triggerPrivacy(cron, desired) };
          for (const audience of audiences) {
            if (!deps.discloseArtifact) throw new Error("Schedule source authorization is unavailable.");
            await deps.discloseArtifact(output, audience, by.actorId);
          }
        }
      }
    }
    return {
      ...triggerPrivacy(before, desired),
      ...(desired.personalOnly && before.sharedFrom ? { sharedFrom: null, forkedAt: Date.now() } : {}),
    };
  };

  const preparePrincipalDelivery = async (deliveryId: string, recipientThreadRef: string) => {
    const delivery = await deps.deliveries.get(deliveryId);
    if (!delivery || delivery.destination.type !== "principal") return null;
    const recipientId = delivery.destination.target;
    const recipientScope = scopeId("personal", recipientId);
    const session = await deps.sessions.getOrCreateByThread(
      recipientThreadRef,
      "dm",
      recipientScope,
      undefined,
      "slack",
    );
    if (delivery.provenance?.contextProvenance)
      await deps.sessions.recordContextProvenance(session.id, recipientScope, delivery.provenance.contextProvenance);
    await deps.sessions.addParticipant(session.id, recipientId);
    return delivery;
  };

  return {
    async publishPrivateCron(id, revision, target, by) {
      return withCronAccess(deps.crons, deps.advisoryLock, id, async () => {
        const context = await refreshPrivateContext(deps.sessions, by);
        const selected = await deps.crons.get(id);
        if (
          !selected?.personalOnly ||
          !privateSourceAllowed(context, selected.ownerScopeId) ||
          !samePerson(selected.owner, context.actorId)
        )
          throw new Error("Only the private schedule's owner can publish it from personal context.");
        const kind = parseScopeId(target).kind;
        if (
          kind !== "group" ||
          !(deps.managedGroups ?? deps.projects)?.recognizes(parseScopeId(target).ref) ||
          !(await h.principalCanAccessCurrentScope(context.actorId, target))
        )
          throw new Error("Choose a Team or workbook context you currently belong to for this schedule.");
        const existing = await deps.crons.get(cronPublicationId(id, revision, target));
        if (existing) {
          if (
            existing.ownerScopeId !== target ||
            existing.personalOnly ||
            existing.createdBy !== selected.createdBy ||
            !existing.sourceProvenance
          )
            throw new Error("The saved schedule publication has incompatible access.");
          return deps.crons.publishPrivate(id, revision, target, existing.sourceProvenance);
        }
        if (cronSharingRevision(selected) !== revision)
          throw new Error("The selected private schedule changed after approval.");
        if (!deps.discloseArtifact) throw new Error("Schedule source authorization is unavailable.");
        const sourceProvenance = await deps.discloseArtifact(selected, target, context.actorId);
        if (!sourceProvenance) throw new Error("The selected private schedule has no source provenance.");
        await validateRuntime({ ...selected, ownerScopeId: target });
        const members = await sharedMembers(target);
        if (!members?.length) throw new Error("The shared schedule's current audience is unavailable.");
        const sharedThread = `web:${selected.owner}:${cronPublicationId(id, revision, target)}`;
        const sharedSession = await deps.sessions.getOrCreateByThread(sharedThread, kind, target, undefined, "web");
        if (sharedSession.scopeId !== target || sharedSession.personalOnly)
          throw new Error("The shared schedule conversation has incompatible access.");
        await deps.sessions.recordContextProvenance(sharedSession.id, target, sourceProvenance);
        await Promise.all(members.map((member) => deps.sessions.addParticipant(sharedSession.id, member.id)));
        const published = await deps.crons.publishPrivate(id, revision, target, sourceProvenance);
        auditCron("cron_publish", published, by);
        return published;
      });
    },
    async createCron(input, trial) {
      input = await triggerInput(input);
      await validateRuntime(input);
      validateUserSchedule(input.schedule);
      await trialBeforeSave(input.script, input.schedule, trial);
      input = await triggerInput(input);
      const cron = await deps.crons.create(input);
      auditCron("cron_create", cron, { actorId: cron.createdBy, botActor: cron.botActor });
      return cron;
    },
    getCron(id) {
      return deps.crons.get(id);
    },
    listCronFires(id, opts) {
      return deps.crons.listFires(id, opts);
    },
    cronFiresByThreadRefs(threadRefs) {
      return deps.crons.firesByThreadRefs(threadRefs);
    },
    latestCronFireForThread(id, threadRef) {
      return deps.crons.latestFireForThread(id, threadRef);
    },
    listCrons(ids) {
      return deps.crons.list(ids);
    },
    async listCronsForViewer(principalId) {
      const context = typeof principalId === "string" ? { actorId: principalId } : principalId;
      principalId = context.actorId;
      const all = await deps.crons.list();
      const { viewersOwn, scopeNames, canSee } = await cronVisibility(deps, h, principalId);
      const sharing = withSharing(all);
      const owned = all.filter((c) => viewersOwn(c.owner) && canSee(c)).map(sharing);
      const visible = all
        .filter((c) => !viewersOwn(c.owner))
        .filter(canSee)
        .map((c) => {
          const name = scopeNames.get(c.ownerScopeId);
          return sharing(name ? { ...c, scopeName: name } : c);
        });
      const blocked = await inheritContextSources(deps.sessions, context, [...owned, ...visible]);
      return { owned: owned.filter((c) => !blocked.has(c.id)), visible: visible.filter((c) => !blocked.has(c.id)) };
    },
    async updateCron(id, patch, by, trial) {
      return withCronAccess(deps.crons, deps.advisoryLock, id, async () => {
        const before = await deps.crons.get(id);
        if (!before) return null;
        await cronPrivacy(before, by, patch);
        if (patch.runtime !== undefined) await validateRuntime({ ...before, ...patch });
        if (patch.schedule) validateUserSchedule(patch.schedule);
        await trialBeforeSave(patch.script, patch.schedule, trial);
        const privacy = await cronPrivacy(before, by, patch);
        const linked = linkedChanges(before, patch);
        const edited = Object.keys(linked).length > 0;
        const forks = edited && before.sharedFrom !== undefined && before.forkedAt === undefined;
        const own = {
          ...patch,
          ...privacy,
          ...(forks ? { forkedAt: Date.now() } : {}),
        };
        const updated = edited
          ? ((await deps.crons.updateLinked(id, own, { ...linked, ...privacy }))[0] ?? null)
          : await deps.crons.update(id, own);
        auditCron("cron_update", before, by);
        return updated;
      });
    },
    async deleteCron(id, by) {
      await withCronAccess(deps.crons, deps.advisoryLock, id, async () => {
        const before = await deps.crons.get(id);
        await deps.crons.delete(id);
        if (before) auditCron("cron_delete", before, by);
      });
    },
    async setCronEnabled(id, enabled, by) {
      return withCronAccess(deps.crons, deps.advisoryLock, id, async () => {
        const before = await deps.crons.get(id);
        if (!before) return;
        if (by) await deps.crons.update(id, await cronPrivacy(before, by));
        await deps.crons.setEnabled(id, enabled);
      });
    },
    async setCronFireNote(id, note, by) {
      return withCronAccess(deps.crons, deps.advisoryLock, id, async () => {
        const before = await deps.crons.get(id);
        if (!before) return "missing";
        const privacy = await cronPrivacy(before, by);
        await deps.crons.update(id, privacy);
        const outcome = await deps.crons.setFireNote(id, note);
        if (outcome === "applied") auditCron("cron_note", before, by);
        return outcome;
      });
    },
    async setCronRuntime(id, runtime, by) {
      return withCronAccess(deps.crons, deps.advisoryLock, id, async () => {
        const before = await deps.crons.get(id);
        if (!before) return null;
        await validateRuntime({ ...before, runtime });
        const privacy = by ? await cronPrivacy(before, by) : {};
        return deps.crons.update(id, { runtime, ...privacy });
      });
    },
    async setCronDestination(id, destination, by) {
      return withCronAccess(deps.crons, deps.advisoryLock, id, async () => {
        const before = await deps.crons.get(id);
        if (!before) return null;
        const privacy = await cronPrivacy(before, by, { destination });
        await deps.crons.setDestination(id, destination, privacy);
        auditCron("cron_retarget", before, by);
        return deps.crons.get(id);
      });
    },
    async createWebhook(input) {
      input = await triggerInput(input);
      const webhook = await deps.webhooks.create(input);
      h.recordAudit({
        at: Date.now(),
        principalId: webhook.createdBy,
        action: "webhook_create",
        resource: webhook.id,
        scopeLabel: webhook.ownerScopeId,
      });
      return webhook;
    },
    getWebhook(id) {
      return deps.webhooks.get(id);
    },
    async listWebhookEvents(id, viewer) {
      const events = await deps.webhooks.listEvents(id);
      return Promise.all(
        events.map(async (event) => {
          const session = await deps.sessions.getByThread(`webhook:${id}:${event.deliveryId}`);
          const visible = session && (await h.sessionForViewer(session.id, viewer));
          return { ...event, ...(visible ? { sessionId: session.id } : {}) };
        }),
      );
    },
    listWebhooks() {
      return deps.webhooks.list();
    },
    async setWebhookEnabled(id, enabled, by) {
      return deps.advisoryLock.withLock(`webhook-access:${id}`, async () => {
        const before = await deps.webhooks.get(id);
        if (!before) return;
        if (by) {
          await refreshPrivateContext(deps.sessions, by);
          if ((await inheritContextSources(deps.sessions, by, [before])).has(id))
            throw new Error("This webhook is private to its owner.");
          const desired = await triggerInput({ ...before, context: by });
          await deps.webhooks.update(id, { action: before.action, ...triggerPrivacy(before, desired) });
        }
        await deps.webhooks.setEnabled(id, enabled);
      });
    },
    async updateWebhook(id, patch, by) {
      return deps.advisoryLock.withLock(`webhook-access:${id}`, async () => {
        const before = await deps.webhooks.get(id);
        if (!before) return null;
        if (!by) return deps.webhooks.update(id, patch);
        await refreshPrivateContext(deps.sessions, by);
        if ((await inheritContextSources(deps.sessions, by, [before])).has(id))
          throw new Error("This webhook is private to its owner.");
        const desired = await triggerInput({ ...before, ...patch, context: by });
        return deps.webhooks.update(id, { ...patch, ...triggerPrivacy(before, desired) });
      });
    },
    pendingDeliveries(type, claimMs) {
      return claimMs && claimMs > 0 ? deps.deliveries.claimPending(type, claimMs) : deps.deliveries.pending(type);
    },
    async enqueueDelivery(input) {
      await deps.deliveries.enqueue(input);
    },
    surfaceMirrored(kind) {
      return deps.surfaces.get(kind)?.capabilities.mirrored === true;
    },
    chatSurfaces() {
      return deps.surfaces.list().map(({ kind, label, mark }) => ({ kind, label, ...(mark ? { mark } : {}) }));
    },
    async ingestSurfaceEvents(events, surface = "slack", self) {
      if (!deps.surfaceCache || !events.length) return { upserted: 0 };
      if (self && (self.name || self.mentionId)) ambientSelf.set(`${orgIdOf()}:${surface}`, self);
      const out = await deps.surfaceCache.ingest(events);
      if (surface === "slack" && hasRevisionEvents(events)) {
        void recordMessageRevisions(deps.sessions, deps.runs, events).catch(
          reportFailureAs("revisions: surface revision record", undefined),
        );
      }
      for (const container of new Set(events.filter((e) => !e.self).map((e) => e.container))) {
        void judgeAmbientContainer(surface, container).catch(reportFailureAs("ambient: judge", undefined));
      }
      return out;
    },
    async searchSurface(queryText, opts) {
      if (!deps.surfaceCache) return [];
      return deps.surfaceCache.search(queryText, opts);
    },
    async readSurfaceMessages(container, opts) {
      if (!deps.surfaceCache) return [];
      return deps.surfaceCache.readMessages(container, opts);
    },
    async activeSurfaceThreads(opts) {
      if (!deps.surfaceCache) return [];
      return deps.surfaceCache.activeThreads(opts);
    },
    async listSurfaceContainers(opts) {
      if (!deps.surfaceCache) return [];
      return deps.surfaceCache.listContainers(opts);
    },
    async getChannelPolicy(container) {
      if (!deps.channelPolicy) return null;
      return deps.channelPolicy.get(container);
    },
    async setChannelPolicy(container, orders, setBy, bots, sessionId, ambientEnabled) {
      if (!deps.channelPolicy) return null;
      return deps.channelPolicy.set(container, orders, { setBy, bots, sessionId, ambientEnabled });
    },
    judgeAmbientContainer(surface, container, opts) {
      return judgeAmbientContainer(surface, container, opts);
    },
    async createContextRequest(source, query) {
      const { viewerToken, ...storedQuery } = query;
      const request: SurfaceContextRequest = {
        id: randomUUID(),
        source,
        createdAt: Date.now(),
        status: "pending",
        query: storedQuery,
      };
      await contextRequests.put(request.id, request);
      if (viewerToken) contextRequestTokens.set(request.id, viewerToken);
      if (source === "web") {
        const outcome: { result?: SurfaceContextResult; error?: string } = await answerWebContextRequest(
          deps.sessions,
          query,
        ).catch(() => ({ error: "the web conversation couldn't be read" }));
        await contextRequests.merge(
          request.id,
          outcome.error !== undefined
            ? { status: "failed", error: outcome.error }
            : { status: "done", result: outcome.result ?? { messages: [] } },
        );
        return request;
      }
      contextRequestListeners.emit(viewerToken ? { ...request, query } : request);
      return request;
    },
    onContextRequestCreated(listener) {
      return contextRequestListeners.add(listener);
    },
    getContextRequest(id) {
      return contextRequests.get(id);
    },
    async deleteContextRequest(id) {
      contextRequestTokens.delete(id);
      return contextRequests.delete(id);
    },
    async pendingContextRequests(source) {
      const all = await contextRequests.all();
      const now = Date.now();
      const stale = all.filter((r) => r.status === "pending" && now - r.createdAt > CONTEXT_REQUEST_EXPIRY_MS);
      await Promise.all(stale.map((r) => (contextRequestTokens.delete(r.id), contextRequests.delete(r.id))));
      return all
        .filter((r) => r.source === source && r.status === "pending" && now - r.createdAt <= CONTEXT_REQUEST_EXPIRY_MS)
        .map((r) => {
          const token = contextRequestTokens.get(r.id);
          return token ? { ...r, query: { ...r.query, viewerToken: token } } : r;
        });
    },
    async fulfillContextRequest(id, outcome) {
      contextRequestTokens.delete(id);
      const merged = await contextRequests.merge(
        id,
        outcome.error !== undefined
          ? { status: "failed", error: outcome.error }
          : { status: "done", result: outcome.result ?? { messages: [] } },
      );
      return merged != null;
    },
    async ackDelivery(id, slackApiMs) {
      await deps.deliveries.ack(id, Date.now(), slackApiMs);
    },
    async failDelivery(id, reason) {
      const approvalId = (await deps.deliveries.get(id))?.destination.commandApprovalId;
      if (approvalId && deps.approvals)
        await declineUnreachableApproval({ approvals: deps.approvals, sessions: deps.sessions }, approvalId, reason);
      return deps.deliveries.fail(id, reason, Date.now());
    },
    async ackDeliveryByKey(idempotencyKey) {
      await deps.deliveries.ackByKey(idempotencyKey, Date.now());
    },
    async setRunDeliveryState(runId, state) {
      const found = await deps.runs.setDeliveryState(runId, null, state);
      if (found && state.editRef) await deps.deliveries.setEditRefByKey(`run:${runId}`, state.editRef);
      return found;
    },

    async upsertDirectory(members, syncedAt) {
      const previous = await deps.directory.list();
      if (!(await deps.directory.replace(members, syncedAt))) return false;
      const internal = members.filter((m) => m.type === "internal");
      const split = deps.admin
        ? await deps.admin.users.applyDirectoryBots(members).catch(reportFailureAs("users: directory bots", 0))
        : 0;
      if (split) await deps.identity.refresh(true);
      const present = internal.map((m) => m.principalId);
      const presentSet = new Set(present);
      const removed = previous.map((m) => m.principalId).filter((id) => !presentSet.has(id));
      const outcome = await deps.identity.recordDirectorySync(removed, present);
      const orgScope = scopeId("org", orgIdOf());
      for (const id of outcome.deactivated) {
        h.recordAudit({
          at: Date.now(),
          principalId: id,
          action: "principal.deactivate",
          resource: "directory-sync",
          scopeLabel: orgScope,
        });
      }
      for (const id of outcome.reactivated) {
        h.recordAudit({
          at: Date.now(),
          principalId: id,
          action: "principal.reactivate",
          resource: "directory-sync",
          scopeLabel: orgScope,
        });
      }
      return true;
    },
    async upsertChannels(channels, channelMembers, syncedAt, channelRosterIds, revocations, partial) {
      const applied = await deps.directory.replaceChannels(
        channels,
        channelMembers,
        syncedAt,
        channelRosterIds,
        revocations,
        partial,
      );
      await h.syncLinkedProjectRosters();
      return applied;
    },
    async upsertGroups(groupMembers, syncedAt, groupIds, groupRosterIds) {
      return deps.directory.replaceGroups(groupMembers, syncedAt, groupIds, groupRosterIds);
    },
    registerGroupRoster(groupId, principalIds) {
      return deps.directory.upsertGroup(groupId, principalIds, SLACK);
    },
    async setDirectoryWorkspace(meta) {
      await deps.directory.setWorkspace(meta);
    },
    directoryMeta() {
      return deps.directory.meta();
    },
    channelMember(channelId, principalId) {
      return deps.directory.channelMember(channelId, principalId);
    },
    channelVisibleTo(actorId, channelId, isPrivate) {
      return isVisible(deps.directory, actorId, {
        kind: "channel",
        channelId,
        ...(isPrivate !== undefined ? { isPrivate } : {}),
      });
    },
    resolveRecipient(query) {
      return deps.directory.resolve(query);
    },
    resolveChannel(query) {
      return deps.directory.resolveChannel(query);
    },
    directoryMembers() {
      return mergedDirectoryMembers();
    },
    directoryChannels() {
      return deps.directory.listChannels();
    },
    directoryChannelsFor(principalId) {
      return deps.directory.listChannelsFor(principalId);
    },
    async directoryMember(principalId) {
      const direct = await deps.directory.get(principalId);
      if (direct) return direct;
      await deps.identity.refresh();
      for (const alias of personIds(principalId).filter((id) => id !== principalId)) {
        const member = await deps.directory.get(alias);
        if (member) return member;
      }
      return (
        (await identityMembers()).find((member) => personKey(member.principalId) === personKey(principalId)) ?? null
      );
    },
    loopAdministration: (actor, loops) => loopAdministration(deps, actor, loops),
    samePerson(a, b) {
      return samePersonInDirectory(deps.directory, a, b);
    },
    personMatcher(actorId) {
      return samePersonMatcher(deps.directory, actorId);
    },
    cronAdminUrl(cron) {
      return adminBase ? adminCronHistoryUrl(adminBase, cron.ownerScopeId, cron.id) : undefined;
    },
    async channelName(channelId) {
      const chan = (await deps.directory.listChannels()).find((c) => c.channelId === channelId);
      return chan ? `#${chan.name.replace(/^#/, "")}` : undefined;
    },
    ...(deps.ambientJudge ? { ambientJudge: deps.ambientJudge } : {}),
    async preparePrincipalDelivery(deliveryId, recipientThreadRef) {
      await preparePrincipalDelivery(deliveryId, recipientThreadRef);
    },
    async recordPrincipalDelivery(deliveryId, recipientThreadRef) {
      const delivery = await preparePrincipalDelivery(deliveryId, recipientThreadRef);
      if (delivery) await deps.deliveries.recordRecipientThread(delivery.id, recipientThreadRef, Date.now());
    },

    async reachNow(input): Promise<ReachNowResult> {
      const hasNamedTarget =
        input.recipient !== undefined || input.channel !== undefined || input.participants !== undefined;
      let baseDestination: Destination;
      const extra: {
        recipient?: { principalId: string; displayName: string };
        channel?: { channelId: string; name: string };
        group?: { groupId: string };
      } = {};
      if ((input.delete || input.edit) && !hasNamedTarget) {
        const dest = input.currentDestination;
        if (!dest?.target)
          return {
            ok: false,
            status: 400,
            error: "no_conversation",
            message: `this conversation has no message surface to ${input.edit ? "edit in" : "delete from"} — name a channel or its participants`,
          };
        baseDestination = dest;
      } else {
        const r: ReachResolution = await resolveReachTargetFor(
          {
            ...(input.recipient !== undefined ? { recipient: input.recipient } : {}),
            ...(input.channel !== undefined ? { channel: input.channel } : {}),
            ...(input.participants !== undefined ? { participants: input.participants } : {}),
          },
          input.senderId,
          { mayOpenGroup: !input.react && !input.delete && !input.edit },
        );
        if (!r.ok) return r;
        baseDestination = r.destination;
        if (r.recipient) extra.recipient = r.recipient;
        if (r.channel) extra.channel = r.channel;
        if (r.group) extra.group = r.group;
      }
      if (input.edit && !editableIn(deps.surfaces, baseDestination.type, input.turn ?? {})) {
        return {
          ok: false,
          status: 400,
          error: "bad_request",
          message:
            "edit rewrites a message in this chat conversation, or a Slack message in a named channel or group DM",
        };
      }
      if (input.threadTs) {
        if (
          baseDestination.type !== "slack" &&
          baseDestination.type !== "group" &&
          baseDestination.type !== "principal"
        ) {
          return {
            ok: false,
            status: 400,
            error: "bad_request",
            message: "threadTs requires a Slack channel, group DM, or person DM",
          };
        }
        baseDestination = withThread(baseDestination, input.threadTs);
      }
      const sender = await deps.directory.get(input.senderId).catch(() => null);
      const persona = input.currentDestination?.persona;
      if (persona && !input.react && !input.delete) baseDestination = { ...baseDestination, persona };
      const delivery = await reachEnqueue({
        deliveries: deps.deliveries,
        destination: withEdit(
          withDelete(withReact(withSlackUnfurlOption(baseDestination, input.unfurlLinks), input.react), input.delete),
          input.edit?.messageTs,
        ),
        text: input.text ?? "",
        idempotencyKey: `reach:${randomUUID()}`,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(!input.react && !input.delete && sender?.displayName ? { attributeAs: sender.displayName } : {}),
      });
      h.recordAudit({
        at: Date.now(),
        principalId: input.senderId,
        action: "reach_now",
        resource: delivery.id,
        scopeLabel: input.senderScope,
      });
      return { ok: true, delivery, ...extra };
    },

    resolveReachTarget(target, authorityId, opts) {
      return resolveReachTargetFor(target, authorityId, opts);
    },
  };
}
