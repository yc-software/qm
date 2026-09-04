import type { ScopeId } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import { parseScopeId, scopeId } from "../types.ts";
import { personKey, personKeys, samePersonInDirectory, samePersonMatcher } from "../directory/person.ts";
import type { Destination, SurfaceContextRequest, SurfaceContextResult } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { createMemoryMap } from "../persistence/durable-map.ts";
import { randomUUID } from "node:crypto";
import {
  reachEnqueue,
  withSlackUnfurlOption,
  withReact,
  withDelete,
  withThread,
  type ReachResolution,
} from "../reach/reach.ts";
import { isVisible } from "../directory/visibility.ts";
import { answerWebContextRequest } from "./web-context.ts";
import { validateUserSchedule } from "../cron/schedule.ts";

import type { App, AppDeps, ReachNowResult } from "./app-types.ts";
import { CONTEXT_REQUEST_EXPIRY_MS } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import type { AmbientHelpers } from "./app-ambient.ts";

export function createMessagingMethods(
  deps: AppDeps,
  h: AppHelpers,
  ambient: AmbientHelpers,
): Pick<
  App,
  | "createCron"
  | "getCron"
  | "getCronRuns"
  | "listCrons"
  | "listCronsForViewer"
  | "updateCron"
  | "deleteCron"
  | "setCronEnabled"
  | "setCronDestination"
  | "setCronRecipientConsent"
  | "createWebhook"
  | "getWebhook"
  | "listWebhooks"
  | "setWebhookEnabled"
  | "setWebhookRecipientConsent"
  | "pendingDeliveries"
  | "enqueueDelivery"
  | "ingestSurfaceEvents"
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
  | "ackDeliveryByKey"
  | "setRunDeliveryState"
  | "upsertDirectory"
  | "upsertChannels"
  | "upsertGroups"
  | "setDirectoryWorkspaceUrl"
  | "directoryMeta"
  | "channelMember"
  | "channelVisibleTo"
  | "resolveRecipient"
  | "resolveChannel"
  | "directoryMembers"
  | "directoryChannels"
  | "directoryMember"
  | "samePerson"
  | "personMatcher"
  | "cronAdminUrl"
  | "channelName"
  | "ambientJudge"
  | "recordPrincipalDelivery"
  | "reachNow"
  | "resolveReachTarget"
> {
  const { adminBase, projectsForViewer, resolveReachTargetFor } = h;
  const { judgeAmbientContainer, ambientSelf } = ambient;
  const contextRequests = deps.contextRequests ?? createMemoryMap<SurfaceContextRequest>();
  const contextRequestListeners = new Set<(request: SurfaceContextRequest) => void>();
  const contextRequestTokens = new Map<string, string>();
  const emailAuthMembers = deps.emailAuthMembers ?? [];
  const mergedDirectoryMembers = async () => {
    const stored = await deps.directory.list();
    const seen = new Set(stored.map((member) => personKey(member.principalId)));
    return [...stored, ...emailAuthMembers.filter((member) => !seen.has(personKey(member.principalId)))];
  };

  return {
    async createCron(input) {
      validateUserSchedule(input.schedule);
      if (input.runAs === "scopeShared") {
        if (input.ownerScopeId.startsWith("personal:"))
          throw new Error("scopeShared requires a shared (channel/group) scope, not a personal one");
        if (!input.members?.length) throw new Error("scopeShared requires a member snapshot");
      }
      if ((await deps.crons.list()).filter((cron) => cron.owner === input.owner).length >= 100) {
        throw new Error("cron limit reached for this owner (100)");
      }
      const cron = await deps.crons.create(input);
      deps.auditLog.record({
        at: Date.now(),
        principalId: cron.createdBy,
        action: "cron_create",
        resource: cron.id,
        scopeLabel: cron.ownerScopeId,
      });
      return cron;
    },
    getCron(id) {
      return deps.crons.get(id);
    },
    getCronRuns(id, limit) {
      return deps.crons.getRuns(id, limit);
    },
    listCrons() {
      return deps.crons.list();
    },
    async listCronsForViewer(principalId) {
      const all = await deps.crons.list();
      const viewerKeys = personKeys(await deps.directory.get(principalId).catch(() => null), principalId);
      const viewersOwn = (id: string): boolean => viewerKeys.has(personKey(id));
      const scopeNames = new Map<ScopeId, string | null>([[scopeId("org", orgIdOf()), null]]);
      if (deps.identity.isInternal(deps.identity.classify(principalId))) {
        for (const c of await deps.directory.listChannelsFor(principalId)) {
          scopeNames.set(scopeId("channel", c.channelId), c.name);
        }
      }
      for (const project of await projectsForViewer(principalId)) scopeNames.set(project.scopeId, project.name);
      const allowed = (ownerScopeId: ScopeId): boolean => {
        const { kind, ref } = parseScopeId(ownerScopeId);
        return kind !== "group" || deps.projects?.recognizes(ref) !== true || scopeNames.has(ownerScopeId);
      };
      const owned = all.filter((c) => viewersOwn(c.owner) && allowed(c.ownerScopeId));
      const visible = all
        .filter((c) => !viewersOwn(c.owner))
        .filter((c) => allowed(c.ownerScopeId))
        .filter(
          (c) =>
            scopeNames.has(c.ownerScopeId) ||
            c.members?.some((m) => viewersOwn(m.id)) === true ||
            (c.destination?.type === "principal" && viewersOwn(c.destination.target)),
        )
        .map((c) => {
          const name = scopeNames.get(c.ownerScopeId);
          return name ? { ...c, scopeName: name } : c;
        });
      return { owned, visible };
    },
    async updateCron(id, patch) {
      const before = await deps.crons.get(id);
      if (!before) return null;
      if (patch.schedule) validateUserSchedule(patch.schedule);
      if (patch.runAs === "scopeShared") {
        if (before.ownerScopeId.startsWith("personal:"))
          throw new Error("scopeShared requires a shared (channel/group) scope, not a personal one");
        const members = patch.members ?? before.members;
        if (!members?.length) throw new Error("scopeShared requires a member snapshot");
      }
      const grantsReaffirmed = patch.unattendedGrants !== undefined;
      const guardedPatch =
        (before.unattendedGrants?.length ?? 0) > 0 && !grantsReaffirmed ? { ...patch, unattendedGrants: [] } : patch;
      const updated = await deps.crons.update(id, guardedPatch);
      deps.auditLog.record({
        at: Date.now(),
        principalId: before.owner,
        action: "cron_update",
        resource: id,
        scopeLabel: before.ownerScopeId,
      });
      return updated;
    },
    async deleteCron(id) {
      const before = await deps.crons.get(id);
      await deps.crons.delete(id);
      if (before)
        deps.auditLog.record({
          at: Date.now(),
          principalId: before.owner,
          action: "cron_delete",
          resource: id,
          scopeLabel: before.ownerScopeId,
        });
    },
    setCronEnabled(id, enabled) {
      return deps.crons.setEnabled(id, enabled);
    },
    async setCronDestination(id, destination) {
      const before = await deps.crons.get(id);
      if (!before) return null;
      await deps.crons.setDestination(id, destination);
      deps.auditLog.record({
        at: Date.now(),
        principalId: before.owner,
        action: "cron_retarget",
        resource: id,
        scopeLabel: before.ownerScopeId,
      });
      return deps.crons.get(id);
    },
    setCronRecipientConsent(id, recipientConsent) {
      return deps.crons.setRecipientConsent(id, recipientConsent);
    },
    async createWebhook(input) {
      const webhook = await deps.webhooks.create(input);
      deps.auditLog.record({
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
    listWebhooks() {
      return deps.webhooks.list();
    },
    setWebhookEnabled(id, enabled) {
      return deps.webhooks.setEnabled(id, enabled);
    },
    setWebhookRecipientConsent(id, recipientConsent) {
      return deps.webhooks.setRecipientConsent(id, recipientConsent);
    },
    pendingDeliveries(type, claimMs) {
      return claimMs && claimMs > 0 ? deps.deliveries.claimPending(type, claimMs) : deps.deliveries.pending(type);
    },
    async enqueueDelivery(input) {
      await deps.deliveries.enqueue(input);
    },
    async ingestSurfaceEvents(events, surface = "slack", self) {
      if (!deps.surfaceCache || !events.length) return { upserted: 0 };
      if (self && (self.name || self.mentionId)) ambientSelf.set(`${orgIdOf()}:${surface}`, self);
      const out = await deps.surfaceCache.ingest(events);
      for (const container of new Set(events.filter((e) => !e.self).map((e) => e.container))) {
        void judgeAmbientContainer(surface, container).catch((e) =>
          console.error("[ambient] judge failed:", errMessage(e)),
        );
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
      for (const l of contextRequestListeners) l(viewerToken ? { ...request, query } : request);
      return request;
    },
    onContextRequestCreated(listener) {
      contextRequestListeners.add(listener);
      return () => contextRequestListeners.delete(listener);
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
      if (!(await deps.directory.replace(members, syncedAt))) return;
      const present = members.filter((m) => m.type === "internal").map((m) => m.principalId);
      const presentSet = new Set(present);
      const removed = previous.map((m) => m.principalId).filter((id) => !presentSet.has(id));
      const outcome = await deps.identity.recordDirectorySync(removed, present);
      const orgScope = scopeId("org", orgIdOf());
      for (const id of outcome.deactivated) {
        deps.auditLog.record({
          at: Date.now(),
          principalId: id,
          action: "principal.deactivate",
          resource: "directory-sync",
          scopeLabel: orgScope,
        });
      }
      for (const id of outcome.reactivated) {
        deps.auditLog.record({
          at: Date.now(),
          principalId: id,
          action: "principal.reactivate",
          resource: "directory-sync",
          scopeLabel: orgScope,
        });
      }
    },
    async upsertChannels(channels, channelMembers, syncedAt, channelRosterIds, revocations) {
      await deps.directory.replaceChannels(channels, channelMembers, syncedAt, channelRosterIds, revocations);
      await h.syncLinkedProjectRosters();
    },
    async upsertGroups(groupMembers, syncedAt, groupIds, groupRosterIds) {
      await deps.directory.replaceGroups(groupMembers, syncedAt, groupIds, groupRosterIds);
    },
    async setDirectoryWorkspaceUrl(url) {
      await deps.directory.setWorkspaceUrl(url);
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
    async resolveRecipient(query) {
      const stored = await deps.directory.resolve(query);
      if (stored.kind !== "none") return stored;
      const key = personKey(query);
      const member = emailAuthMembers.find(
        (candidate) => personKey(candidate.principalId) === key || personKey(candidate.displayName) === key,
      );
      return member ? { kind: "one", member } : { kind: "none" };
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
    async directoryMember(principalId) {
      return (
        (await deps.directory.get(principalId)) ??
        emailAuthMembers.find((member) => personKey(member.principalId) === personKey(principalId)) ??
        null
      );
    },
    samePerson(a, b) {
      return samePersonInDirectory(deps.directory, a, b);
    },
    personMatcher(actorId) {
      return samePersonMatcher(deps.directory, actorId);
    },
    cronAdminUrl(cron) {
      return adminBase
        ? `${adminBase}/admin/history?scope=${encodeURIComponent(cron.ownerScopeId)}&origin=cron&cron=${encodeURIComponent(cron.id)}`
        : undefined;
    },
    async channelName(channelId) {
      const chan = (await deps.directory.listChannels()).find((c) => c.channelId === channelId);
      return chan ? `#${chan.name.replace(/^#/, "")}` : undefined;
    },
    ...(deps.ambientJudge ? { ambientJudge: deps.ambientJudge } : {}),
    async recordPrincipalDelivery(deliveryId, recipientThreadRef) {
      const delivery = await deps.deliveries.get(deliveryId);
      if (!delivery || delivery.destination.type !== "principal") return;
      const recipientId = delivery.destination.target;
      const recipientScope = scopeId("personal", recipientId);
      const session = await deps.sessions.getOrCreateByThread(recipientThreadRef, "dm", recipientScope);
      await deps.deliveries.recordRecipientThread(delivery.id, recipientThreadRef, Date.now());
      await deps.sessions.addParticipant(session.id, recipientId);
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
      if (input.delete && !hasNamedTarget) {
        const dest = input.currentDestination;
        if (!dest?.target)
          return {
            ok: false,
            status: 400,
            error: "no_conversation",
            message: "this conversation has no message surface to delete from — name a channel or its participants",
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
          { mayOpenGroup: !input.react && !input.delete },
        );
        if (!r.ok) return r;
        baseDestination = r.destination;
        if (r.recipient) extra.recipient = r.recipient;
        if (r.channel) extra.channel = r.channel;
        if (r.group) extra.group = r.group;
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
      const delivery = await reachEnqueue({
        deliveries: deps.deliveries,
        destination: withDelete(
          withReact(withSlackUnfurlOption(baseDestination, input.unfurlLinks), input.react),
          input.delete,
        ),
        text: input.text ?? "",
        idempotencyKey: `reach:${randomUUID()}`,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(!input.react && !input.delete && sender?.displayName ? { attributeAs: sender.displayName } : {}),
      });
      deps.auditLog.record({
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
