import type { Tenant } from "../tenants/context.ts";
import { isSessionTurn } from "../core/turn-origin.ts";
import type {
  Conversation,
  DeliveryProvenance,
  Destination,
  OutgoingAttachment,
  Principal,
  ScopeId,
  Session,
} from "../types.ts";
import {
  openGroupViaSurface,
  reachEnqueue,
  resolveReachTarget,
  withReact,
  withEdit,
  withDelete,
  type ReachResolution,
} from "../reach/reach.ts";
import { type SandboxHandle } from "../sandbox/sandbox.ts";
import type {
  SurfaceToolDeps,
  SurfacePostResult,
  PostedFileMeta,
  SurfaceReactInput,
  SurfaceEditInput,
  SurfaceDeleteInput,
  SurfaceSearchResult,
} from "../tools/primitives.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import {
  collectNamedOutbound,
  parseOutboundFiles,
  type OutboundFile,
  type OpenStoredFile,
  type ArtifactRegistration,
} from "../core/attachments.ts";
import { parseBotLedger, type BotPolicy, type ChannelPolicy } from "../surface-cache/channel-policy-store.ts";
import { isoFromTs } from "../util/message-tag.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { adminSessionUrl } from "../util/admin-links.ts";
import {
  completedSurfaceEnqueues,
  replaceThreadSegment,
  stripAckPrefix,
  turnPostKeys,
  type TurnPostKeys,
} from "../core/orchestrator/turn-helpers.ts";
import { replyEditNote } from "../delivery/run-result-delivery.ts";
import { editableIn, turnCapabilities } from "./registry.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { Item } from "../sessions/items.ts";
import type { OrchestratorDeps, OrchestratorInput } from "../core/orchestrator/types.ts";

const SURFACE_READ_MAX = 200;
const SURFACE_SEARCH_DEFAULT = 10;
const SURFACE_SEARCH_MAX = 40;

export interface SpineState {
  surfaceOutboundCount: number;
  crossConversationPosts: number;
  turnUserEntrySeq: number | undefined;
}

export interface SurfaceToolsContext {
  tenant: Tenant;
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: Principal;
  conversation: Conversation;
  session: Session;
  scopeId: ScopeId;
  strictReadOnly: boolean;
  defaultDestination: Destination | undefined;
  blobTransfer: BlobTransferStore;
  fileRegistration: ArtifactRegistration;
  openStored?: OpenStoredFile;
  provision: (sandboxId?: string) => Promise<SandboxHandle>;
  postProvenance: (deliveryKey: string) => DeliveryProvenance;
  postKeys: TurnPostKeys;
  spine: SpineState;
}

function postedFileMetas(attachments: readonly OutgoingAttachment[]): PostedFileMeta[] {
  return attachments.map((a) => ({
    name: a.name,
    mimetype: a.mimetype,
    sizeBytes: a.sizeBytes,
    ...(a.artifactId ? { artifactId: a.artifactId } : {}),
  }));
}

export function surfaceToolsActive(
  ctx: Pick<SurfaceToolsContext, "input" | "strictReadOnly" | "defaultDestination">,
): boolean {
  return !ctx.strictReadOnly && !!ctx.input.surfaceTools && !!ctx.defaultDestination;
}

export async function enqueueDirectReply(ctx: {
  deliveries: DeliveryStore;
  destination: Destination;
  text: string;
  key: string;
  postProvenance: (deliveryKey: string) => DeliveryProvenance;
  retracted?: readonly string[];
}): Promise<void> {
  const editNote = replyEditNote(ctx.retracted);
  await reachEnqueue({
    deliveries: ctx.deliveries,
    destination: editNote ? { ...ctx.destination, editNote } : ctx.destination,
    text: ctx.text,
    idempotencyKey: ctx.key,
    provenance: ctx.postProvenance(ctx.key),
  });
}

export async function replayRecordedSurfaceAnswer(ctx: {
  deps: Pick<OrchestratorDeps, "deliveries">;
  input: Pick<OrchestratorInput, "addressed" | "runId">;
  session: Pick<Session, "id" | "threadRef">;
  defaultDestination: Destination | undefined;
  surfaceName: string;
  turnItems: readonly Item[];
  userSeq: number;
  text: string;
  postProvenance: (deliveryKey: string) => DeliveryProvenance;
}): Promise<void> {
  const { deps, input, defaultDestination } = ctx;
  const posted = completedSurfaceEnqueues(ctx.turnItems, ctx.userSeq, ctx.surfaceName);
  if (!input.addressed || posted > 0 || !defaultDestination || !input.runId) return;
  const keys = turnPostKeys(input.runId);
  const directKey = keys.key(defaultDestination, posted);
  const fallbackKey = keys.key(defaultDestination, posted + 1);
  if ((await deps.deliveries.existingKeys([directKey, fallbackKey])).size) return;
  const ack = (await deps.deliveries.listBySourceSession(ctx.session.id, ctx.session.threadRef)).find(
    (d) => d.idempotencyKey === keys.ackKey,
  )?.text;
  const text = stripAckPrefix(ctx.text, ack).trim();
  if (!text) return;
  await enqueueDirectReply({
    deliveries: deps.deliveries,
    destination: defaultDestination,
    text,
    key: directKey,
    postProvenance: ctx.postProvenance,
  });
}

export function createSurfaceToolDeps(ctx: SurfaceToolsContext): SurfaceToolDeps | undefined {
  const {
    tenant,
    deps,
    input,
    actor,
    conversation,
    session,
    scopeId,
    defaultDestination,
    blobTransfer,
    fileRegistration,
    provision,
    postProvenance,
    postKeys,
    spine,
  } = ctx;
  if (!surfaceToolsActive(ctx) || !defaultDestination) return undefined;
  const currentDestination = defaultDestination;
  const textOnly = (d: Destination) => turnCapabilities(deps.surfaces.get(d.type), input)?.textOnly === true;
  const editable = (d: Destination) => editableIn(deps.surfaces, d.type, input);
  const homeSurface = deps.surfaces.get(currentDestination.type);
  const mirroredHome = homeSurface?.capabilities.mirrored ? homeSurface : undefined;
  const rateLimitRecipient =
    input.origin?.kind === "human" &&
    !isSessionTurn(input) &&
    homeSurface?.capabilities.nativeActor &&
    currentDestination.target
      ? { rateLimitRecipient: { target: currentDestination.target, user: actor.id } }
      : {};
  let editRefConsumed = false;
  const resolveDestination = async (
    target?: {
      channel?: string;
      recipient?: string;
      participants?: readonly string[];
    },
    opts?: { mayOpenGroup?: boolean },
  ): Promise<{ ok: true; destination: Destination } | { ok: false; message: string }> => {
    if (
      !target ||
      (target.channel === undefined && target.recipient === undefined && target.participants === undefined)
    ) {
      return { ok: true, destination: currentDestination };
    }
    if (
      target.channel !== undefined &&
      conversation.channelRef &&
      (target.channel === conversation.channelRef ||
        target.channel.replace(/^#/, "").toLowerCase() === conversation.channelName?.toLowerCase())
    ) {
      return { ok: true, destination: { ...currentDestination, target: conversation.channelRef } };
    }
    const r: ReachResolution = await resolveReachTarget(
      {
        resolveRecipient: (q) => deps.directory.resolve(q),
        resolveChannel: (q) => deps.directory.resolveChannel(q),
        channelMember: (c, p) => deps.directory.channelMember(c, p),
        resolveGroup: (parts) => deps.directory.resolveGroupByParticipants(parts),
        groupMember: (g, p) => deps.directory.groupMember(g, p),
        directoryMember: (p) => deps.directory.get(p),
        ...(deps.surfaceContext
          ? {
              openGroup: (parts: readonly string[]) =>
                openGroupViaSurface((query) => deps.surfaceContext!.pull("slack", query), parts),
              registerGroup: (g: string, parts: readonly string[]) => deps.directory.upsertGroup(g, parts),
            }
          : {}),
      },
      {
        ...(target.channel !== undefined ? { channel: target.channel } : {}),
        ...(target.recipient !== undefined ? { recipient: target.recipient } : {}),
        ...(target.participants !== undefined ? { participants: target.participants } : {}),
      },
      actor.id,
      { mayOpenGroup: opts?.mayOpenGroup === true },
    );
    if (!r.ok) return { ok: false, message: r.message };
    const persona = currentDestination.persona;
    return { ok: true, destination: persona ? { ...r.destination, persona } : r.destination };
  };
  const enqueue = async (
    destination: Destination,
    postText: string,
    seq: number,
    attachments?: OutgoingAttachment[],
  ): Promise<SurfacePostResult> => {
    try {
      const idempotencyKey = postKeys.key(destination, seq);
      const delivery = await reachEnqueue({
        deliveries: deps.deliveries,
        destination,
        text: postText,
        ...(attachments?.length ? { attachments } : {}),
        idempotencyKey,
        provenance: postProvenance(idempotencyKey),
      });
      spine.surfaceOutboundCount += 1;
      if (input.runId) deps.turnStream.markSurfacePosted(input.runId);
      return { ok: true, deliveryId: delivery.id };
    } catch (e) {
      return { ok: false, message: errMessage(e) };
    }
  };
  const buildDebugFooter = (): string | undefined => {
    if (!deps.surfaceDebugFooter || !deps.publicWebUrl) return undefined;
    const base = adminSessionUrl(deps.publicWebUrl, session.id);
    const contextUrl = spine.turnUserEntrySeq !== undefined ? `${base}?turn=${spine.turnUserEntrySeq}` : base;
    return `<${base}|session>   <${contextUrl}|context>`;
  };
  let coverageChecked = false;
  let coverageSince: string | undefined;
  const coverageForTurn = async (): Promise<string | undefined> => {
    if (coverageChecked) return coverageSince;
    coverageChecked = true;
    const container = currentDestination.target ?? conversation.channelRef ?? conversation.threadRef;
    if (!deps.surfaceCache || !container) return coverageSince;
    const st = await (
      mirroredHome
        ? deps.surfaceCache.containerState(mirroredHome.containerOf(container), { surface: mirroredHome.kind })
        : deps.surfaceCache.containerState(container)
    ).catch(swallowAs("surface cache: container coverage", null));
    coverageSince = st?.oldestTs ? isoFromTs(st.oldestTs) || undefined : undefined;
    return coverageSince;
  };
  const resolveFiles = async (
    files?: readonly OutboundFile[],
    sandboxId?: string,
  ): Promise<{ ok: true; attachments?: OutgoingAttachment[] } | { ok: false; message: string }> => {
    if (!files?.length) return { ok: true };
    const parsed = parseOutboundFiles(files);
    if (!parsed.ok) return parsed;
    const r = await collectNamedOutbound(
      deps.sandbox,
      () => provision(sandboxId),
      files,
      blobTransfer,
      fileRegistration,
      [],
      ctx.openStored,
    );
    const bad = [
      ...r.missing.map((p) => `${p} (not found)`),
      ...r.empty.map((p) => `${p} (empty)`),
      ...r.oversized.map((p) => `${p} (too large)`),
    ];
    if (bad.length)
      return { ok: false, message: `couldn't attach: ${bad.join(", ")} — nothing was sent; fix the path(s) and retry` };
    return { ok: true, attachments: r.attachments };
  };
  return {
    post: async (postText, opts, files, sandboxId) => {
      const seq = postKeys.take();
      let destination = currentDestination;
      if (opts?.ts && destination.type !== "principal") {
        const surface = deps.surfaces.get(destination.type);
        destination = {
          ...destination,
          target: surface?.threadTarget
            ? await surface.threadTarget(destination.target, opts.ts)
            : replaceThreadSegment(destination.target, opts.ts),
        };
      } else if (opts?.broadcast && destination.type !== "principal" && conversation.channelRef) {
        destination = { ...destination, target: conversation.channelRef };
      }
      if (files?.length && textOnly(destination))
        return { ok: false, message: "This conversation takes text messages only; nothing was sent." };
      const f = await resolveFiles(files, sandboxId);
      if (!f.ok) return { ok: false, message: f.message };
      const footer = buildDebugFooter();
      const run = input.runId ? await deps.runs?.get(input.runId) : null;
      const editRef =
        !editRefConsumed && destination.target === currentDestination.target ? run?.deliveryState?.editRef : undefined;
      if (editRef) editRefConsumed = true;
      const projectedDestination = {
        ...destination,
        ...(editRef ? { editRef } : {}),
        ...(footer ? { debugFooter: footer } : {}),
      };
      const sent = await enqueue(projectedDestination, postText, seq, f.attachments);
      return sent.ok && f.attachments?.length ? { ...sent, attachments: postedFileMetas(f.attachments) } : sent;
    },
    reach: async (postText, target, files, sandboxId) => {
      const seq = postKeys.take();
      if (spine.crossConversationPosts >= 5) return { ok: false, message: "outbound limit reached for this turn" };
      const selectors = [
        target.channel !== undefined,
        target.recipient !== undefined,
        target.participants !== undefined,
      ].filter(Boolean).length;
      if (selectors !== 1)
        return { ok: false, message: "reach needs exactly one of: channel, recipient, or participants." };
      const f = await resolveFiles(files, sandboxId);
      if (!f.ok) return { ok: false, message: f.message };
      const sending = postText.trim().length > 0 || (f.attachments?.length ?? 0) > 0;
      const d = await resolveDestination(target, { mayOpenGroup: sending });
      if (!d.ok) return { ok: false, message: d.message };
      const r0 = await enqueue(d.destination, postText, seq, f.attachments);
      if (!r0.ok) return r0;
      const r = f.attachments?.length ? { ...r0, attachments: postedFileMetas(f.attachments) } : r0;
      spine.crossConversationPosts += 1;
      let label = `a group DM (${target.participants?.length ?? 0} people)`;
      if (target.channel !== undefined) label = `#${target.channel.replace(/^#/, "")}`;
      else if (target.recipient !== undefined) label = `a DM to ${target.recipient}`;
      return { ...r, matched: label };
    },
    react: async (input: SurfaceReactInput) => {
      const seq = postKeys.take();
      const d = await resolveDestination({
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
        ...(input.participants !== undefined ? { participants: input.participants } : {}),
      });
      if (!d.ok) return { ok: false, message: d.message };
      if (d.destination.type === "principal")
        return { ok: false, message: "I can only react to a message in a channel, group DM, or this conversation." };
      if (textOnly(d.destination)) return { ok: false, message: "Reactions aren't supported in this conversation." };
      return enqueue(withReact(d.destination, { messageTs: input.ts, emoji: input.emoji }), "", seq);
    },
    edit: async (input: SurfaceEditInput) => {
      const seq = postKeys.take();
      const d = await resolveDestination({
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
        ...(input.participants !== undefined ? { participants: input.participants } : {}),
      });
      if (!d.ok) return { ok: false, message: d.message };
      if (!editable(d.destination))
        return { ok: false, message: "I can only edit a Slack message in a channel, group DM, or this conversation." };
      return enqueue(withEdit(d.destination, input.ref), input.text, seq);
    },
    delete: async (input: SurfaceDeleteInput) => {
      const seq = postKeys.take();
      const d = await resolveDestination({
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
        ...(input.participants !== undefined ? { participants: input.participants } : {}),
      });
      if (!d.ok) return { ok: false, message: d.message };
      if (textOnly(d.destination)) return { ok: false, message: "Messages in this conversation can't be deleted." };
      return enqueue(withDelete(d.destination, { messageTs: input.ref }), "", seq);
    },
    readThread: async (opts?: { limit?: number }) => {
      if (!deps.surfaceContext) return { ok: false, message: "the surface can't be read from this turn" };
      if (!currentDestination.target) return { ok: false, message: "this conversation has no thread to read" };
      const result = await deps.surfaceContext.pull(input.surface ?? "unknown", {
        conversationTarget: currentDestination.target,
        viewer: actor.id,
        ...rateLimitRecipient,
        ...(opts?.limit !== undefined ? { count: Math.max(1, Math.min(SURFACE_READ_MAX, opts.limit)) } : {}),
      });
      if (!result) return { ok: false, message: "the surface didn't answer in time" };
      if (result.note && !result.messages?.length) return { ok: false, message: result.note };
      return { ok: true, messages: result.messages, ...(result.note ? { message: result.note } : {}) };
    },
    whatsNew: async (opts?: { since?: string }) => {
      if (!deps.surfaceContext) return { ok: false, message: "the surface can't be read from this turn" };
      const dest = currentDestination;
      if (!dest.target) return { ok: false, message: "this conversation has nothing to check" };
      const result = await deps.surfaceContext.pull(input.surface ?? "unknown", {
        conversationTarget: dest.target,
        viewer: actor.id,
        ...rateLimitRecipient,
        count: SURFACE_READ_MAX,
      });
      if (!result) return { ok: false, message: "the surface didn't answer in time" };
      if (result.note && !result.messages?.length) return { ok: false, message: result.note };
      const msgs = (result.messages ?? []) as Array<{ ts?: string; threadTs?: string }>;
      const since = opts?.since;
      const self = new Set(result.selfTs);
      const newer = msgs.filter(
        (m) => typeof m?.ts === "string" && (since === undefined || m.ts > since) && !self.has(m.ts),
      );
      const isDm = conversation.kind === "dm";
      const hereRoot = dest.target.slice(dest.target.lastIndexOf(":") + 1);
      const otherRoots = new Set<string>();
      let hereNew = 0;
      for (const m of newer) {
        if (isDm || m.threadTs === hereRoot || m.ts === hereRoot) hereNew++;
        else if (m.threadTs) otherRoots.add(m.threadTs);
      }
      const latest = msgs.reduce<string | undefined>(
        (acc, m) => (typeof m?.ts === "string" && (!acc || m.ts > acc) ? m.ts : acc),
        undefined,
      );
      const coverage = await coverageForTurn();
      return {
        ok: true,
        hereNew,
        activeSubConversations: otherRoots.size,
        ...(result.note ? { message: result.note } : {}),
        ...(latest ? { latest } : {}),
        ...(coverage ? { coverageSince: coverage } : {}),
      };
    },
    search: async (query: string, opts?: { limit?: number; source?: "mirror" | "slack" }) => {
      const q = query.trim();
      const coverage = await coverageForTurn();
      const withCoverage = (r: SurfaceSearchResult): SurfaceSearchResult =>
        coverage ? { ...r, coverageSince: coverage } : r;
      if (!q) return withCoverage({ ok: true, hits: [], source: "cache" });
      const limit = Math.max(1, Math.min(SURFACE_SEARCH_MAX, opts?.limit ?? SURFACE_SEARCH_DEFAULT));
      const dest = currentDestination;
      const shapeHits = (messages: unknown[], prefiltered = false) =>
        (messages as Array<{ ts?: string; time?: string; author?: string; text?: string }>)
          .filter((m) => typeof m?.text === "string" && (prefiltered || m.text.toLowerCase().includes(q.toLowerCase())))
          .slice(-limit)
          .map((m) => ({
            ...(m.ts ? { ref: m.ts } : {}),
            ...(m.author ? { author: m.author } : {}),
            ...(m.time ? { when: m.time } : {}),
            snippet: String(m.text).slice(0, 200),
          }));
      if (opts?.source === "slack") {
        if (!deps.surfaceContext?.searchLive)
          return { ok: false, message: "live search isn't available from this turn" };
        if (!dest.target) return { ok: false, message: "this conversation has nothing to search" };
        const result = await deps.surfaceContext.searchLive(input.surface ?? "unknown", {
          conversationTarget: dest.target,
          viewer: actor.id,
          ...rateLimitRecipient,
          count: SURFACE_READ_MAX,
          searchAll: q,
        });
        if (!result) return { ok: false, message: "the surface didn't answer in time" };
        if (result.liveSearch === "unconfigured") return { ok: false, message: "[live search isn't configured]" };
        if (result.liveSearch === "unconnected")
          return {
            ok: false,
            message:
              "[live search runs as the asking person's own Slack login, and this turn has no connected one. " +
              "Reading this conversation's history needs no personal login, so read it before concluding anything is missing; " +
              "only if the message is elsewhere, and a person asked, point them at " +
              (deps.publicWebUrl
                ? `${deps.publicWebUrl.replace(/\/$/, "")}/connect/slack/self-connect`
                : "the web UI's Connectors page") +
              " to connect their Slack (signing in there identifies them; no link needs minting) " +
              "instead of concluding the message doesn't exist; " +
              "on an autonomous turn just say what you couldn't search]",
          };
        if (result.note && !result.messages?.length) return { ok: false, message: result.note };
        return withCoverage({
          ok: true,
          hits: shapeHits(result.messages ?? [], true),
          source: "slack",
          ...(result.note ? { message: result.note } : {}),
        });
      }
      const container = dest.target ?? conversation.channelRef ?? conversation.threadRef;
      if (deps.surfaceCache && mirroredHome && container) {
        const hits = await deps.surfaceCache.search(q, {
          surface: mirroredHome.kind,
          container: mirroredHome.containerOf(container),
          limit,
        });
        return withCoverage({
          ok: true,
          hits: hits.map((hit) => ({
            ref: hit.ts,
            ...(hit.authorName ? { author: hit.authorName } : {}),
            when: isoFromTs(hit.ts),
            snippet: hit.text.slice(0, 200),
          })),
          source: "cache",
          message: `Search covers stored ${mirroredHome.label} events only; older or missed messages may be absent.`,
        });
      }
      if (opts?.source === "mirror") {
        return { ok: false, message: "Stored Slack message search is unavailable; no live search was performed." };
      }
      if (!deps.surfaceContext) return { ok: false, message: "search isn't available from this turn" };
      if (!dest.target) return { ok: false, message: "this conversation has nothing to search" };
      const result = await deps.surfaceContext.pull(input.surface ?? "unknown", {
        conversationTarget: dest.target,
        viewer: actor.id,
        ...rateLimitRecipient,
        count: SURFACE_READ_MAX,
        match: q,
      });
      if (!result) return { ok: false, message: "the surface didn't answer in time" };
      if (result.note && !result.messages?.length) return { ok: false, message: result.note };
      return withCoverage({
        ok: true,
        hits: shapeHits(result.messages ?? []),
        source: "live",
        ...(result.note ? { message: result.note } : {}),
      });
    },
    getStandingOrder: async () => {
      if (!deps.channelPolicy) return { ok: false, message: "standing orders aren't available on this turn" };
      if (conversation.kind === "dm" || !conversation.channelRef)
        return { ok: false, message: "standing orders are per-channel — there isn't one for a DM." };
      const p = await deps.channelPolicy.get(conversation.channelRef);
      return {
        ok: true,
        orders: p?.orders ?? "",
        ...(p?.bots && Object.keys(p.bots).length ? { bots: p.bots } : {}),
        ...(p?.ambientEnabled !== undefined ? { ambientEnabled: p.ambientEnabled } : {}),
      };
    },
    setStandingOrder: async (
      orders: string | undefined,
      bots?: Record<string, BotPolicy>,
      ambientEnabled?: boolean | null,
      expectedOrders?: string,
    ) => {
      if (!deps.channelPolicy) return { ok: false, message: "standing orders aren't available on this turn" };
      if (conversation.kind === "dm" || !conversation.channelRef)
        return { ok: false, message: "standing orders are per-channel — you can only set one from inside a channel." };
      if (input.botActor) return { ok: false, message: "a Slack bot's turn cannot change this channel's guidance" };
      let parsedBots: Record<string, BotPolicy> | undefined;
      if (bots !== undefined) {
        const parsed = parseBotLedger(bots);
        if ("error" in parsed) return { ok: false, message: parsed.error };
        parsedBots = parsed.bots;
      }
      let p: ChannelPolicy;
      try {
        p = await deps.channelPolicy.set(conversation.channelRef, orders, {
          setBy: actor.id,
          bots: parsedBots,
          sessionId: session.id,
          ambientEnabled,
          expectedOrders,
        });
      } catch (error) {
        return { ok: false, message: errMessage(error) };
      }
      deps.auditLog.record(tenant, {
        at: Date.now(),
        principalId: actor.id,
        action: "surface.policy.set",
        resource: conversation.channelRef,
        scopeLabel: scopeId,
      });
      return {
        ok: true,
        orders: p.orders,
        ...(p.bots && Object.keys(p.bots).length ? { bots: p.bots } : {}),
        ...(p.ambientEnabled !== undefined ? { ambientEnabled: p.ambientEnabled } : {}),
      };
    },
  };
}
