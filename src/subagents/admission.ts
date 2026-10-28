import { sessionTurnOrigin } from "../core/turn-origin.ts";
import { pgTextSafe } from "../util/text.ts";
import { errMessage } from "../util/errors.ts";
import { randomUUID } from "node:crypto";
import { hashId } from "../util/crypto.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import type { Session, SpawnMeta } from "../types.ts";
import type { Run } from "../runs/run-store.ts";
import { turnSource } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import { xmlAttrEscape, xmlEscape } from "../util/message-tag.ts";
import { SUBAGENT_THREAD_PREFIX, isSubagentThreadRef } from "../sessions/thread-ref.ts";
import { assertAudienceCompatible } from "./audience.ts";
import { MAIL_WAKE_TEXT, UNINHERITED_REQUEST_KEYS } from "./mail.ts";
import { sessionTreeRoot, sessionTreeRunCount, stopSessionTree } from "./tree.ts";
import type { SessionOpenInput, SessionOpenResult, SessionWriteInput, SessionWriteResult } from "./types.ts";
import type { TurnContext } from "./turn-context.ts";

const SESSION_MESSAGE_DEPTH_CAP = 8;

function autoTitle(task: string): string {
  const line = task.trim().split("\n")[0] ?? "";
  return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}…`;
}

function renderSubagentTask(input: { title: string; parentTitle: string; task: string }): string {
  return [
    `<subagent-task session="${xmlAttrEscape(input.title)}">`,
    `You are the subagent session "${input.title}", spawned from the conversation "${input.parentTitle}". To message your parent use subagents send_message with target="parent"; use an exact sibling title or sessionId for peers, never filesystem paths. When your turn ends, your final message is delivered to your current parent session — make it the result, stated plainly. If subagents or background jobs you started are still running, say what is in flight and end your turn instead of waiting or polling; each one wakes you when it finishes. Your parent can change while you work; detached sessions have no automatic return. Use your judgment on details within the task's real limits; if an instruction seems to work against the goal, follow the goal and say so. Do not contact people, post to conversations, or change standing configuration unless the task says to. If you are blocked, end your turn saying exactly what you need.`,
    "",
    "<task>",
    input.task.trim(),
    "</task>",
    "</subagent-task>",
  ].join("\n");
}

function renderSubagentMessage(sender: { title: string; sessionId: string }, text: string): string {
  return [
    `<subagent-message from="${xmlAttrEscape(sender.title)}" fromSessionId="${sender.sessionId}">`,
    xmlEscape(text.trim()),
    "</subagent-message>",
  ].join("\n");
}

function childRunRequest(child: Session, meta: SpawnMeta, text: string, displayText: string): OrchestratorInput {
  return {
    ...(meta.scopeVersion ? { scopeVersion: meta.scopeVersion } : {}),
    ...(meta.sessionParticipantIds ? { sessionParticipantIds: meta.sessionParticipantIds } : {}),
    surface: meta.surface,
    ...(turnSource(meta) ? { source: turnSource(meta) } : {}),
    ...(meta.externalSlack ? { externalSlack: meta.externalSlack } : {}),
    ...(meta.deliveryTarget ? { deliveryTarget: meta.deliveryTarget } : {}),
    ...(meta.deliveryCandidates ? { deliveryCandidates: meta.deliveryCandidates } : {}),
    actor: meta.actor,
    conversation: { ...meta.conversation, threadRef: child.threadRef },
    origin: sessionTurnOrigin(meta.origin, text),
    ...(meta.unattendedGrants ? { unattendedGrants: [...meta.unattendedGrants] } : {}),
    text,
    displayText,
    envelopeWrapped: true,
    ...(meta.readOnly ? { readOnly: true } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.thinkingLevel ? { thinkingLevel: meta.thinkingLevel } : {}),
    ...(meta.fastMode !== undefined ? { fastMode: meta.fastMode } : {}),
    ...(meta.timezone ? { timezone: meta.timezone } : {}),
  };
}

export async function openSubagent(ctx: TurnContext, input: SessionOpenInput): Promise<SessionOpenResult> {
  const { deps, binding, lock, cap, admissionKey, callerTitle, visibleTitle, currentCaller } = ctx;
  return (async () => {
    const threadRef = `${SUBAGENT_THREAD_PREFIX}${
      input.requestId ? hashId([binding.session.id, binding.request.runId ?? "", input.requestId], 40) : randomUUID()
    }`;
    // Count against the tree the child already sits in (a retried child may have been detached).
    const placed = (await deps.sessions.getByThread(threadRef)) ?? (await deps.sessions.get(binding.session.id));
    const root = placed ? await sessionTreeRoot(deps.sessions, placed) : binding.session;
    return lock.withLock(admissionKey(root), async (): Promise<SessionOpenResult> => {
      const caller = await currentCaller();
      assertAudienceCompatible(binding.request, caller);
      if (binding.request.privateSessionMessage) throw new Error("private session messages cannot delegate new work");
      const task = input.task?.trim();
      if (!task) return { ok: false, message: "open requires a task: the full instruction the subagent works from." };
      await deps.validateRuntime?.(input, binding.scopeId);
      const fingerprint = hashId([canonicalJson(input)], 40);
      const existing = await deps.sessions.getByThread(threadRef);
      const live = await sessionTreeRunCount(deps.sessions, deps.runs, root);
      if (existing?.spawnMeta?.openFingerprint && existing.spawnMeta.openFingerprint !== fingerprint)
        throw new Error("the requestId was already used for different work");
      const initialRun = await deps.runs.getByDedupKey(`subagent-open:${threadRef}`);
      if (existing && initialRun)
        return {
          ok: true,
          sessionId: existing.id,
          title: visibleTitle(existing),
          liveRunsRemaining: Math.max(0, cap - live),
        };
      if (live >= cap) {
        return {
          ok: false,
          message: `all ${cap} subagent run slots for this conversation are in use — wait for one to finish, read their sessions, or interrupt one you no longer need.`,
        };
      }
      const child = await deps.sessions.getOrCreateByThread(
        threadRef,
        binding.session.type,
        binding.scopeId,
        binding.session.channelName,
        binding.session.surface ?? binding.request.surface,
      );
      const title = existing ? visibleTitle(existing) : input.name?.trim() || autoTitle(task);
      const meta: SpawnMeta = {
        origin: caller.origin,
        ...(binding.request.surfaceTools ? { surfaceTools: true } : {}),
        ...(binding.request.deliveryCandidates ? { deliveryCandidates: binding.request.deliveryCandidates } : {}),
        ...(caller.unattendedGrants ? { unattendedGrants: [...caller.unattendedGrants] } : {}),
        openFingerprint: fingerprint,
        ...(turnSource(binding.request) ? { source: turnSource(binding.request) } : {}),
        ...(binding.request.externalSlack ? { externalSlack: binding.request.externalSlack } : {}),
        ...(binding.request.scopeVersion ? { scopeVersion: binding.request.scopeVersion } : {}),
        ...(binding.request.sessionParticipantIds
          ? { sessionParticipantIds: binding.request.sessionParticipantIds }
          : {}),
        surface: binding.request.surface ?? binding.session.surface ?? "web",
        conversation: binding.request.conversation,
        actor: binding.request.actor,
        ...(binding.request.deliveryTarget ? { deliveryTarget: binding.request.deliveryTarget } : {}),
        ...(binding.request.timezone ? { timezone: binding.request.timezone } : {}),
        ...(input.readOnly || binding.request.readOnly ? { readOnly: true } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
      };
      if (!existing?.spawnMeta) {
        await deps.sessions.setParentSession(child.id, binding.session.id);
        await deps.sessions.setSpawnMeta(child.id, meta);
      }
      for (const id of new Set([
        binding.request.actor.id,
        ...(binding.request.sessionParticipantIds ?? binding.request.conversation.audience.map((p) => p.id)),
      ]))
        await deps.sessions.addParticipant(child.id, id);
      await deps.sessions.updateTitle(child.id, title);
      const text = renderSubagentTask({ title, parentTitle: callerTitle, task });
      const request = {
        ...childRunRequest(child, meta, text, task),
        sessionSenderId: binding.session.id,
        ...(binding.request.runId ? { delegatingRunId: binding.request.runId } : {}),
      };
      await deps.runs.enqueue({
        sessionId: child.threadRef,
        dedupKey: `subagent-open:${threadRef}`,
        request: deps.prepareRequest ? await deps.prepareRequest(request) : request,
        maxAttempts: deps.maxAttempts,
      });
      return { ok: true, sessionId: child.id, title, liveRunsRemaining: Math.max(0, cap - live - 1) };
    });
  })().catch((error): SessionOpenResult => ({ ok: false, message: errMessage(error) }));
}

async function wakeIdleRecipient(
  { deps, binding, cap }: TurnContext,
  target: Session,
  root: Session,
  previous: Run | null,
  actorId: string,
  messageId: string,
): Promise<void> {
  const toParent = target.id === binding.session.parentSessionId;
  const edge = toParent || target.parentSessionId === binding.session.id;
  const depth = (binding.request.sessionMessageDepth ?? 0) + 1;
  if (
    !previous ||
    previous.result?.stopped ||
    previous.request.actor.id !== actorId ||
    (!edge && depth > SESSION_MESSAGE_DEPTH_CAP) ||
    (await deps.runs.inFlightForThread(target.threadRef)).length ||
    (await sessionTreeRunCount(deps.sessions, deps.runs, root)) >= cap
  )
    return;
  const wake: OrchestratorInput = { ...previous.request };
  for (const key of UNINHERITED_REQUEST_KEYS) delete wake[key];
  Object.assign(wake, {
    ...(edge ? {} : { privateSessionMessage: true, sessionMessageDepth: depth, readOnly: true }),
    sessionSenderId: binding.session.id,
    delegatingRunId: toParent ? previous.id : binding.request.runId,
    origin: sessionTurnOrigin(wake.origin, MAIL_WAKE_TEXT),
    text: MAIL_WAKE_TEXT,
    displayText: "New internal message",
    wakeCause: "child_done",
  });
  await deps.runs.enqueue({
    sessionId: target.threadRef,
    dedupKey: `session-message-wake:${messageId}`,
    request: deps.prepareRequest ? await deps.prepareRequest(wake) : wake,
    maxAttempts: deps.maxAttempts,
  });
}

export async function writeSession(ctx: TurnContext, input: SessionWriteInput): Promise<SessionWriteResult> {
  const {
    deps,
    binding,
    lock,
    cap,
    admissionKey,
    callerTitle,
    resolveTarget,
    peerRefusal,
    visibleTitle,
    currentCaller,
  } = ctx;
  return (async () => {
    const target = await resolveTarget(input.target);
    const root = target ? await sessionTreeRoot(deps.sessions, target) : binding.session;
    return lock.withLock(admissionKey(root), async (): Promise<SessionWriteResult> => {
      const caller = await currentCaller();
      assertAudienceCompatible(binding.request, caller);
      if (!target)
        return {
          ok: false,
          message: `no session matches "${input.target}" — use a sessionId from open, read, or list.`,
        };
      const refusal = input.peer ? peerRefusal(target) : null;
      if (refusal) return { ok: false, message: refusal };
      if (target.id === binding.session.id)
        return { ok: false, message: "a session cannot message itself — just continue your turn." };
      if (target.scopeId !== binding.scopeId)
        return {
          ok: false,
          message: "that session lives in a different context and cannot be reached from here.",
        };
      if (!(await deps.sessions.getForParticipant(target.id, binding.request.actor.id)))
        return { ok: false, message: "you are not a participant in that session." };
      if (deps.authorize && !(await deps.authorize(target, caller.actor.id)))
        return { ok: false, message: "you no longer have access to the target session" };
      const previous = await deps.runs.latestForThread(target.threadRef, { excludePrivateMessages: true });
      const meta = previous?.request ?? target.spawnMeta;
      if (!meta) return { ok: false, message: "the target has no verified runtime context yet" };
      const privateChild = isSubagentThreadRef(target.threadRef);
      const privateMessage = binding.request.privateSessionMessage === true || !privateChild;
      const messageDepth = (binding.request.sessionMessageDepth ?? 0) + 1;
      if (privateMessage && messageDepth > SESSION_MESSAGE_DEPTH_CAP)
        throw new Error("private session message reply limit reached");
      const prepared = childRunRequest(
        target,
        {
          ...meta,
          ...(target.parentSessionId
            ? {
                model: target.spawnMeta?.model,
                thinkingLevel: target.spawnMeta?.thinkingLevel,
                fastMode: target.spawnMeta?.fastMode,
              }
            : {}),
          surface: meta.surface ?? target.surface ?? "web",
          actor: caller.actor,
          origin: caller.origin,
          unattendedGrants: caller.unattendedGrants,
          readOnly: privateMessage || caller.readOnly || meta.readOnly || target.spawnMeta?.readOnly,
        },
        "",
        "",
      );
      const request = deps.prepareRequest ? await deps.prepareRequest(prepared) : prepared;
      assertAudienceCompatible(caller, request);
      const title = visibleTitle(target);
      if (input.interrupt) {
        if (privateMessage) return { ok: false, message: "ordinary sessions accept private messages, not interrupts" };
        if (caller.readOnly && !target.spawnMeta?.readOnly)
          return { ok: false, message: "a read-only session cannot interrupt a writable task" };
        const stopped = await stopSessionTree(deps, target, "by the parent agent");
        return stopped
          ? { ok: true, sessionId: target.id, title, delivered: "interrupted" }
          : { ok: false, message: `subagent "${title}" is not running — nothing to interrupt.` };
      }
      const text = input.text?.trim();
      if (!text)
        return {
          ok: false,
          message: input.followup
            ? "followup_task requires `task`: the full instruction the subagent works from."
            : "send_message requires `text` (or interrupt: true).",
        };
      if (text.length > 16_000) return { ok: false, message: "message exceeds 16000 characters" };
      const stamped = renderSubagentMessage({ title: callerTitle, sessionId: binding.session.id }, text);
      if (!input.followup) {
        const sourceEntrySeq = await deps.sessions.latestItemSeq(binding.session.id);
        const messageId = input.requestId
          ? hashId([binding.session.id, binding.request.runId ?? "", input.requestId], 40)
          : randomUUID();
        await deps.mailbox.send({
          id: messageId,
          recipientId: target.id,
          senderId: binding.session.id,
          actor: caller.actor,
          text: stamped,
          ...(sourceEntrySeq >= 0 ? { sourceEntrySeq } : {}),
          audience: caller.conversation.audience,
          createdAt: Date.now(),
        });
        await wakeIdleRecipient(ctx, target, root, previous, caller.actor.id, messageId);
        return { ok: true, sessionId: target.id, title, delivered: "queued_message" };
      }
      if (input.followup && binding.request.privateSessionMessage)
        return { ok: false, message: "private turns cannot assign follow-up work" };
      if (input.followup && !target.parentSessionId)
        return {
          ok: false,
          message: "follow-up tasks can only target an attached subagent; use a message for the root",
        };

      const dedupKey = input.requestId
        ? `subagent-followup:${hashId([binding.session.id, binding.request.runId ?? "", input.requestId], 40)}`
        : undefined;
      if (dedupKey) {
        const existing = await deps.runs.getByDedupKey(dedupKey);
        if (existing) {
          if (
            existing.sessionId !== target.threadRef ||
            (existing.request.text !== stamped && existing.request.text !== pgTextSafe(stamped))
          )
            return { ok: false, message: "the requestId was already used for different work" };
          return { ok: true, sessionId: target.id, title, delivered: "queued_turn" };
        }
      }
      request.origin = sessionTurnOrigin(request.origin, stamped);
      request.sessionSenderId = binding.session.id;
      request.delegatingRunId = binding.request.runId;
      if ((await sessionTreeRunCount(deps.sessions, deps.runs, root)) >= cap)
        return { ok: false, message: `all ${cap} session run slots are in use.` };
      await deps.runs.enqueue({
        sessionId: target.threadRef,
        dedupKey,
        request: {
          ...request,
          ...(privateMessage ? { privateSessionMessage: true as const, sessionMessageDepth: messageDepth } : {}),
          text: stamped,
          displayText: text,
        },
        maxAttempts: deps.maxAttempts,
      });
      return { ok: true, sessionId: target.id, title, delivered: "queued_turn" };
    });
  })().catch((error): SessionWriteResult => ({ ok: false, message: errMessage(error) }));
}
