import { randomUUID } from "node:crypto";
import type {
  Conversation,
  DeliveryProvenance,
  Destination,
  OutgoingAttachment,
  Principal,
  ScopeId,
  Session,
} from "../../types.ts";
import {
  openGroupViaSurface,
  reachEnqueue,
  resolveReachTarget,
  withReact,
  withEdit,
  withDelete,
  type ReachResolution,
} from "../../reach/reach.ts";
import { hasParentPathSegment, type SandboxHandle } from "../../sandbox/sandbox.ts";
import type {
  SurfaceToolDeps,
  SurfacePostResult,
  PostedFileMeta,
  SurfaceReactInput,
  SurfaceEditInput,
  SurfaceDeleteInput,
  SurfaceSearchResult,
} from "../../tools/primitives.ts";
import { collectBlob, type BlobTransferStore } from "../../persistence/blob-transfer.ts";
import { collectNamedOutbound, type ArtifactRegistration } from "../attachments.ts";
import { parseBotLedger, type BotPolicy } from "../../surface-cache/channel-policy-store.ts";
import { isoFromTs } from "../../util/message-tag.ts";
import { errMessage } from "../../util/errors.ts";
import { orgId } from "../../config.ts";
import { headLooksLikeText, replaceThreadSegment } from "./turn-helpers.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

const SURFACE_READ_DEFAULT = 100;
const SURFACE_READ_MAX = 200;
const SURFACE_SEARCH_DEFAULT = 10;
const SURFACE_SEARCH_MAX = 40;
const SURFACE_FILE_MAX_CHARS = 100_000;

export interface SpineState {
  surfaceOutboundCount: number;
  crossConversationPosts: number;
  staySilentReason: string | undefined;
  turnUserEntrySeq: number | undefined;
}

export interface SurfaceToolsContext {
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
  provision: () => Promise<SandboxHandle>;
  postProvenance: (deliveryKey: string) => DeliveryProvenance;
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

export function createSurfaceToolDeps(ctx: SurfaceToolsContext): SurfaceToolDeps | undefined {
  const {
    deps,
    input,
    actor,
    conversation,
    session,
    scopeId,
    strictReadOnly,
    defaultDestination,
    blobTransfer,
    fileRegistration,
    provision,
    postProvenance,
    spine,
  } = ctx;
  if (strictReadOnly || !(input.surfaceTools && defaultDestination && deps.deliveries)) return undefined;
  const deliveries = deps.deliveries;
  const currentDestination = defaultDestination;
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
    if (!deps.directory)
      return { ok: false, message: "I can't reach a named channel or teammate from here — no directory is available." };
    const r: ReachResolution = await resolveReachTarget(
      {
        resolveRecipient: (q) => deps.directory!.resolve(q),
        resolveChannel: (q) => deps.directory!.resolveChannel(q),
        channelMember: (c, p) => deps.directory!.channelMember(c, p),
        resolveGroup: (parts) => deps.directory!.resolveGroupByParticipants(parts),
        groupMember: (g, p) => deps.directory!.groupMember(g, p),
        directoryMember: (p) => deps.directory!.get(p),
        ...(deps.surfaceContext
          ? {
              openGroup: (parts: readonly string[]) =>
                openGroupViaSurface((query) => deps.surfaceContext!.pull("slack", query), parts),
              registerGroup: (g: string, parts: readonly string[]) => deps.directory!.upsertGroup(g, parts),
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
    return { ok: true, destination: r.destination };
  };
  const enqueue = async (
    destination: Destination,
    postText: string,
    attachments?: OutgoingAttachment[],
  ): Promise<SurfacePostResult> => {
    try {
      const idempotencyKey = `post:${session.id}:${randomUUID()}`;
      const delivery = await reachEnqueue({
        deliveries,
        destination,
        text: postText,
        ...(attachments?.length ? { attachments } : {}),
        idempotencyKey,
        provenance: postProvenance(idempotencyKey),
      });
      spine.surfaceOutboundCount += 1;
      if (input.runId) deps.turnStream?.markSurfacePosted(input.runId);
      return { ok: true, deliveryId: delivery.id };
    } catch (e) {
      return { ok: false, message: errMessage(e) };
    }
  };
  const buildDebugFooter = (): string | undefined => {
    if (!deps.surfaceDebugFooter || !deps.publicWebUrl) return undefined;
    const base = `${deps.publicWebUrl.replace(/\/$/, "")}/admin/history?scope=${encodeURIComponent(`org:${orgId()}`)}&session=${encodeURIComponent(session.id)}`;
    const contextUrl = spine.turnUserEntrySeq !== undefined ? `${base}&turn=${spine.turnUserEntrySeq}` : base;
    return `<${base}|session>   <${contextUrl}|context>`;
  };
  let coverageChecked = false;
  let coverageSince: string | undefined;
  const coverageForTurn = async (): Promise<string | undefined> => {
    if (coverageChecked) return coverageSince;
    coverageChecked = true;
    const container = currentDestination.target ?? conversation.channelRef ?? conversation.threadRef;
    if (!deps.surfaceCache || !container) return coverageSince;
    const st = await deps.surfaceCache.containerState(container).catch(() => null);
    coverageSince = st?.oldestTs ? isoFromTs(st.oldestTs) || undefined : undefined;
    return coverageSince;
  };
  const resolveFiles = async (
    files?: readonly string[],
  ): Promise<{ ok: true; attachments?: OutgoingAttachment[] } | { ok: false; message: string }> => {
    if (!files?.length) return { ok: true };
    const invalid = files.filter(hasParentPathSegment);
    if (invalid.length)
      return {
        ok: false,
        message: `couldn't attach: ${invalid.map((p) => `${p} (not found)`).join(", ")} — nothing was sent; fix the path(s) and retry`,
      };
    const handle = await provision();
    const r = await collectNamedOutbound(deps.sandbox, handle, files, blobTransfer, fileRegistration);
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
    post: async (postText, opts, files) => {
      let destination = currentDestination;
      if (opts?.ts && destination.type !== "principal") {
        destination = { ...destination, target: replaceThreadSegment(destination.target, opts.ts) };
      } else if (opts?.broadcast && destination.type !== "principal" && conversation.channelRef) {
        destination = { ...destination, target: conversation.channelRef };
      }
      const f = await resolveFiles(files);
      if (!f.ok) return { ok: false, message: f.message };
      const footer = buildDebugFooter();
      const run = input.runId ? await deps.runs?.get(input.runId) : null;
      const taskList = input.runId ? await deps.tasks?.list({ originRunId: input.runId }) : undefined;
      const editRef =
        !editRefConsumed && destination.target === currentDestination.target ? run?.deliveryState?.editRef : undefined;
      if (editRef) editRefConsumed = true;
      const projectedDestination = {
        ...destination,
        ...(editRef ? { editRef } : {}),
        ...(taskList?.length ? { taskList: taskList.map(({ id, title, status }) => ({ id, title, status })) } : {}),
        ...(footer ? { debugFooter: footer } : {}),
      };
      const sent = await enqueue(projectedDestination, postText, f.attachments);
      return sent.ok && f.attachments?.length ? { ...sent, attachments: postedFileMetas(f.attachments) } : sent;
    },
    reach: async (postText, target, files) => {
      if (spine.crossConversationPosts >= 5) return { ok: false, message: "outbound limit reached for this turn" };
      const selectors = [
        target.channel !== undefined,
        target.recipient !== undefined,
        target.participants !== undefined,
      ].filter(Boolean).length;
      if (selectors !== 1)
        return { ok: false, message: "reach needs exactly one of: channel, recipient, or participants." };
      const f = await resolveFiles(files);
      if (!f.ok) return { ok: false, message: f.message };
      const sending = postText.trim().length > 0 || (f.attachments?.length ?? 0) > 0;
      const d = await resolveDestination(target, { mayOpenGroup: sending });
      if (!d.ok) return { ok: false, message: d.message };
      const r0 = await enqueue(d.destination, postText, f.attachments);
      if (!r0.ok) return r0;
      const r = f.attachments?.length ? { ...r0, attachments: postedFileMetas(f.attachments) } : r0;
      spine.crossConversationPosts += 1;
      let label = `a group DM (${target.participants?.length ?? 0} people)`;
      if (target.channel !== undefined) label = `#${target.channel.replace(/^#/, "")}`;
      else if (target.recipient !== undefined) label = `a DM to ${target.recipient}`;
      return { ...r, matched: label };
    },
    react: async (input: SurfaceReactInput) => {
      const d = await resolveDestination({
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
        ...(input.participants !== undefined ? { participants: input.participants } : {}),
      });
      if (!d.ok) return { ok: false, message: d.message };
      if (d.destination.type === "principal")
        return { ok: false, message: "I can only react to a message in a channel, group DM, or this conversation." };
      return enqueue(withReact(d.destination, { messageTs: input.ts, emoji: input.emoji }), "");
    },
    edit: async (input: SurfaceEditInput) => {
      const d = await resolveDestination({
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
        ...(input.participants !== undefined ? { participants: input.participants } : {}),
      });
      if (!d.ok) return { ok: false, message: d.message };
      return enqueue(withEdit(d.destination, input.ref), input.text);
    },
    delete: async (input: SurfaceDeleteInput) => {
      const d = await resolveDestination({
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
        ...(input.participants !== undefined ? { participants: input.participants } : {}),
      });
      if (!d.ok) return { ok: false, message: d.message };
      return enqueue(withDelete(d.destination, { messageTs: input.ref }), "");
    },
    readThread: async (opts?: { limit?: number }) => {
      if (!deps.surfaceContext) return { ok: false, message: "the surface can't be read from this turn" };
      if (!currentDestination.target) return { ok: false, message: "this conversation has no thread to read" };
      const count = Math.max(1, Math.min(SURFACE_READ_MAX, opts?.limit ?? SURFACE_READ_DEFAULT));
      const result = await deps.surfaceContext.pull(input.surface ?? "unknown", {
        conversationTarget: currentDestination.target,
        viewer: actor.id,
        count,
      });
      if (!result) return { ok: false, message: "the surface didn't answer in time" };
      if (result.note && !result.messages?.length) return { ok: false, message: result.note };
      return { ok: true, messages: result.messages };
    },
    whatsNew: async (opts?: { since?: string }) => {
      if (!deps.surfaceContext) return { ok: false, message: "the surface can't be read from this turn" };
      const dest = currentDestination;
      if (!dest.target) return { ok: false, message: "this conversation has nothing to check" };
      const result = await deps.surfaceContext.pull(input.surface ?? "unknown", {
        conversationTarget: dest.target,
        viewer: actor.id,
        count: SURFACE_READ_MAX,
      });
      if (!result) return { ok: false, message: "the surface didn't answer in time" };
      if (result.note && !result.messages?.length) return { ok: false, message: result.note };
      const msgs = (result.messages ?? []) as Array<{ ts?: string; threadTs?: string; author?: string }>;
      const since = opts?.since;
      const newer = msgs.filter(
        (m) => typeof m?.ts === "string" && (since === undefined || m.ts > since) && m.author !== "you",
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
        ...(latest ? { latest } : {}),
        ...(coverage ? { coverageSince: coverage } : {}),
      };
    },
    search: async (query: string, opts?: { limit?: number; source?: "mirror" | "slack" }) => {
      const q = query.trim();
      const coverage = await coverageForTurn();
      const withCoverage = (r: SurfaceSearchResult): SurfaceSearchResult =>
        coverage ? { ...r, coverageSince: coverage } : r;
      if (!q) return withCoverage({ ok: true, hits: [], source: deps.surfaceSearch ? "cache" : "live" });
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
          count: SURFACE_READ_MAX,
          searchAll: q,
        });
        if (!result) return { ok: false, message: "the surface didn't answer in time" };
        if (result.note === "live-search-unconfigured") return { ok: false, message: "[live search isn't configured]" };
        if (result.note === "live-search-unconnected")
          return {
            ok: false,
            message:
              "[live search runs as the asking person's own Slack login, and this turn has no connected one — " +
              "if a person asked, point them at " +
              (deps.publicWebUrl
                ? `${deps.publicWebUrl.replace(/\/$/, "")}/connect/slack/self-connect`
                : "the web UI's Connectors page") +
              " to connect their Slack (signing in there identifies them; no link needs minting) " +
              "instead of concluding the message doesn't exist; " +
              "on an autonomous turn just say what you couldn't search]",
          };
        if (result.note && !result.messages?.length) return { ok: false, message: result.note };
        return withCoverage({ ok: true, hits: shapeHits(result.messages ?? [], true), source: "slack" });
      }
      const container = dest.target ?? conversation.channelRef ?? conversation.threadRef;
      if (deps.surfaceSearch) {
        const hits = await deps.surfaceSearch.search({
          surface: input.surface ?? "unknown",
          container,
          query: q,
          limit,
        });
        return withCoverage({ ok: true, hits, source: "cache" });
      }
      if (!deps.surfaceContext) return { ok: false, message: "search isn't available from this turn" };
      if (!dest.target) return { ok: false, message: "this conversation has nothing to search" };
      const result = await deps.surfaceContext.pull(input.surface ?? "unknown", {
        conversationTarget: dest.target,
        viewer: actor.id,
        count: SURFACE_READ_MAX,
        match: q,
      });
      if (!result) return { ok: false, message: "the surface didn't answer in time" };
      if (result.note && !result.messages?.length) return { ok: false, message: result.note };
      return withCoverage({ ok: true, hits: shapeHits(result.messages ?? []), source: "live" });
    },
    readMembers: async () => {
      const roster = (conversation.publishMembers ?? conversation.audience).filter((p) => p.type === "internal");
      if (!roster.length) return { ok: true, members: [] };
      return { ok: true, members: roster.map((p) => ({ displayName: p.displayName ?? p.id })) };
    },
    readFile: async (ref: string) => {
      const id = ref.trim();
      if (!/^[0-9a-f]{32}$/.test(id))
        return {
          ok: false,
          message: "that doesn't look like a file I can read — pass the reference shown next to the file in a thread.",
        };
      let blob;
      try {
        blob = await blobTransfer.open(id);
      } catch (e) {
        return { ok: false, message: errMessage(e) };
      }
      if (!blob) return { ok: false, message: "I can't find that file — it may have expired." };
      const bytes = await collectBlob(blob.stream);
      if (!headLooksLikeText(bytes.subarray(0, 8000)))
        return { ok: true, sizeBytes: blob.sizeBytes, contentType: "application/octet-stream" };
      const decoded = bytes.toString("utf8");
      const content =
        decoded.length > SURFACE_FILE_MAX_CHARS ? `${decoded.slice(0, SURFACE_FILE_MAX_CHARS)}…[truncated]` : decoded;
      return { ok: true, content, sizeBytes: blob.sizeBytes };
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
    setStandingOrder: async (orders: string, bots?: Record<string, BotPolicy>, ambientEnabled?: boolean | null) => {
      if (!deps.channelPolicy) return { ok: false, message: "standing orders aren't available on this turn" };
      if (conversation.kind === "dm" || !conversation.channelRef)
        return { ok: false, message: "standing orders are per-channel — you can only set one from inside a channel." };
      let parsedBots: Record<string, BotPolicy> | undefined;
      if (bots !== undefined) {
        const parsed = parseBotLedger(bots);
        if ("error" in parsed) return { ok: false, message: parsed.error };
        parsedBots = parsed.bots;
      }
      const p = await deps.channelPolicy.set(conversation.channelRef, orders, {
        setBy: actor.id,
        bots: parsedBots,
        sessionId: session.id,
        ambientEnabled,
      });
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: "surface.policy.set",
        resource: conversation.channelRef,
        scopeLabel: scopeId,
      });
      return {
        ok: true,
        orders,
        ...(p.bots && Object.keys(p.bots).length ? { bots: p.bots } : {}),
        ...(p.ambientEnabled !== undefined ? { ambientEnabled: p.ambientEnabled } : {}),
      };
    },
    staySilent: async (reason: string) => {
      spine.staySilentReason = reason;
      return { ok: true, message: "[staying silent]" };
    },
  };
}
