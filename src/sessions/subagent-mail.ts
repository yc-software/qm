import { sessionTurnOrigin } from "../core/turn-origin.ts";
import { principalDestination } from "../reach/reach.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { deliveryCandidatesFor } from "../core/orchestrator/turn-helpers.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { Principal, Session, SpawnMeta, StopScope } from "../types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { SessionMailbox, SessionMessage } from "./session-mailbox.ts";
import { xmlAttrEscape, xmlEscape } from "../util/message-tag.ts";
import { swallowAs } from "../util/errors.ts";
import { claimThenBind } from "../tenants/claim.ts";
import { type Item, proseText } from "./items.ts";
import {
  ANCESTOR_STOP,
  assertAudienceCompatible,
  isSidebarSession,
  isSubagentThreadRef,
  PARENT_INTERRUPT,
  requiresDelegation,
  runStopped,
  sparesDescendants,
  storedContext,
  treeSessions,
} from "./session-syscalls.ts";
import { snippet } from "../util/text.ts";

const MAIL_ERROR_CAP = 1_000;
const COMPLETION_WAKE =
  "A delegated task finished. Check internal messages with subagents wait (timeoutMs: 0), then report any new result or blocker relevant to the user's request. If it was already handled or no message is available, end without posting.";
const MESSAGE_WAKE =
  "A subagent sent you a message. Check internal messages with subagents wait (timeoutMs: 0) and decide whether it affects the user's request; report only what is relevant. If it does not, end without posting.";
const MESSAGE_DISPLAY = "Subagent sent a message";
const PEER_WAKE =
  "Another conversation handed you a task. Read it with subagents wait (timeoutMs: 0), then do it, or decline it and tell the sender with sessions send_message and wake:false.";
const PEER_DISPLAY = "Another conversation handed over a task";
const RESULT_MAIL = "subagent-mail-";
const returnWakeKey = (runId: string) => `subagent-return:${runId}`;

export type SubagentMailKind =
  "final_answer" | "in_progress" | "no_reply" | "awaiting_input" | "errored" | "refused" | "stopped";

export function renderSubagentMail(input: {
  title: string;
  sessionId: string;
  kind: SubagentMailKind;
  body: string;
  stopScope?: StopScope;
  retired?: boolean;
}): string {
  const why: Record<SubagentMailKind, string> = {
    final_answer: "finished a turn and sent back its result",
    in_progress: "ended a turn while its own subagents are still working; its final result follows when they finish",
    no_reply: "finished a turn without sending a reply",
    awaiting_input: "is blocked waiting for a human approval",
    errored: "failed",
    refused: "was refused",
    stopped: "was stopped",
  };
  const stopReasons: Partial<Record<StopScope, string>> = {
    run: ` ${PARENT_INTERRUPT}`,
    ancestor: ` ${ANCESTOR_STOP}`,
  };
  const stopReason = (input.stopScope && stopReasons[input.stopScope]) ?? "";
  return [
    `<wake reason="subagent" name="${xmlAttrEscape(input.title)}" sessionId="${input.sessionId}" kind="${input.kind}" at="${new Date().toISOString()}">`,
    `  <why>Your subagent session "${xmlEscape(input.title)}" ${why[input.kind]}${xmlEscape(stopReason)}.</why>`,
    `  <content>${xmlEscape(input.body)}</content>`,
    `  <instructions>If the person who asked for this work is waiting on it, relay what matters in your own words. Otherwise act on it internally without acknowledging it. Never repeat a result already reported or send a no-action-needed update. The subagent's full transcript is kept with it; ${input.retired ? "it has retired, so read it with the subagents tool and open a fresh subagent for new work" : "use the subagents tool to read it or give it another task"}.</instructions>`,
    "</wake>",
  ].join("\n");
}

export interface SubagentMailDeps {
  signals?: Pick<RunSignalStore, "pending">;
  deliveries?: Pick<DeliveryStore, "enqueue">;
  mailbox: SessionMailbox;
  sessions: Pick<
    SessionStore,
    "get" | "getByThread" | "latestItemSeq" | "visibleItems" | "childrenOf" | "setSpawnMeta"
  >;
  runs: Pick<RunStore, "enqueue" | "inFlightForThread" | "getByDedupKey" | "withdraw"> & Partial<Pick<RunStore, "get">>;
  maxAttempts: number;
  prepareRequest?: (request: OrchestratorInput) => Promise<OrchestratorInput>;
}

type ParentMailDeps = Pick<SubagentMailDeps, "mailbox" | "runs" | "maxAttempts" | "prepareRequest">;

interface ParentSource {
  actor: Principal;
  botActor?: boolean;
  conversation: Pick<OrchestratorInput["conversation"], "audience">;
  runId?: string;
  delegatingRunId?: string;
  peerDepth?: number;
}

interface ParentWake {
  dedupKey: string;
  text: string;
  displayText: string;
}

type ParentMail = Pick<
  SessionMessage,
  "id" | "text" | "sourceEntrySeq" | "wake" | "senderRunId" | "delegatingRunId" | "resultOf" | "peerDepth"
>;

const messageWake = (id: string, peer = false): ParentWake => ({
  dedupKey: `subagent-followup:${id}`,
  text: peer ? PEER_WAKE : MESSAGE_WAKE,
  displayText: peer ? PEER_DISPLAY : MESSAGE_DISPLAY,
});

export const isPeerMessage = (sender: Session, recipient: Session): boolean =>
  sender.id !== recipient.id &&
  sender.scopeId === recipient.scopeId &&
  isSidebarSession(sender) &&
  isSidebarSession(recipient);

async function delegatingRun(
  runs: ParentMailDeps["runs"],
  child: Session,
  runId: string | undefined,
): Promise<Run | undefined> {
  const seen = new Set<string>();
  for (let id = runId; id && !seen.has(id);) {
    seen.add(id);
    const run = await runs.get?.(id);
    if (!run || run.sessionId !== child.threadRef) return run ?? undefined;
    id = run.request.delegatingRunId;
  }
  return undefined;
}

export async function pendingWork(
  deps: Pick<SubagentMailDeps, "sessions" | "runs" | "signals" | "mailbox">,
  session: Session,
): Promise<number> {
  const stopped = async (runId: string | undefined) =>
    !!deps.signals && !!deps.runs.get && !!(await runStopped({ get: deps.runs.get }, deps.signals, runId));
  const waiting = new Set<string>();
  for (const descendant of (await treeSessions(deps.sessions, session)).slice(1)) {
    if (descendant.scopeId !== session.scopeId) continue;
    for (const run of await deps.runs.inFlightForThread(descendant.threadRef))
      if (!run.request.privateSessionMessage && !(await stopped(run.id))) waiting.add(descendant.threadRef);
  }
  for (const message of await deps.mailbox.pending(session.id)) {
    const sender = await deps.sessions.get(message.senderId);
    if (!sender || sender.parentSessionId !== session.id || waiting.has(sender.threadRef)) continue;
    const resultRunId = message.resultOf;
    const key = message.wake ? messageWake(message.id).dedupKey : resultRunId && returnWakeKey(resultRunId);
    if (!key) continue;
    const existing = await deps.runs.getByDedupKey(key);
    const coming = existing
      ? existing.status === "pending" || existing.status === "running"
      : !(await stopped(resultRunId ?? message.senderRunId ?? message.delegatingRunId));
    if (coming) waiting.add(sender.threadRef);
  }
  return waiting.size;
}

async function parentTurn(
  deps: ParentMailDeps,
  child: Session,
  parent: Session,
  source: ParentSource,
  text: string,
  displayText: string,
) {
  if (parent.threadRef.startsWith("swarm:")) throw new Error("subagent returns cannot enter swarm workers");
  if (parent.scopeId !== child.scopeId) throw new Error("parent and child contexts no longer match");
  const peer = source.peerDepth !== undefined;
  const initiatingRun = peer ? undefined : await delegatingRun(deps.runs, child, source.delegatingRunId);
  const initiatingContext = initiatingRun?.request ?? child.spawnMeta;
  if (!peer && !initiatingContext) throw new Error("the subagent has no verified runtime context yet");
  const currentContext = storedContext(parent);
  const originalParent = !peer && parent.threadRef === initiatingContext!.conversation.threadRef;
  if (!originalParent && !currentContext) throw new Error("the current parent has no verified runtime context yet");
  const meta = originalParent
    ? initiatingContext!
    : {
        ...currentContext!,
        actor: source.actor,
        origin: {
          kind: "automation" as const,
          ...(currentContext!.origin?.kind === "automation" && currentContext!.origin.destination
            ? { destination: currentContext!.origin.destination }
            : {}),
        },
      };
  const { openFingerprint: _openFingerprint, ...request }: OrchestratorInput & Pick<SpawnMeta, "openFingerprint"> = {
    ...meta,
    ...(meta.botActor || source.botActor || child.spawnMeta?.botActor ? { botActor: true } : {}),
    sessionSenderId: child.id,
    conversation: {
      ...meta.conversation,
      ...(currentContext
        ? { audience: currentContext.conversation.audience, publishMembers: currentContext.conversation.publishMembers }
        : {}),
      threadRef: parent.threadRef,
    },
    origin: sessionTurnOrigin(meta.origin, text),
    text,
    displayText,
    envelopeWrapped: true,
  };
  for (const key of [
    "runId",
    "attempt",
    "runLeaseToken",
    "runStartedAt",
    "finalAttempt",
    "cancel",
    "shutdown",
    "modelAccount",
    "privateSessionMessage",
    "sessionMessageDepth",
    "delegatingRunId",
    "swarm",
    "approval",
    "proactiveOpener",
    "redeliveryKey",
    "attachments",
    "inboundNotes",
    "priorTurns",
    "overheard",
    "detectContext",
    "detectOpener",
    "conversationHeader",
    "cronScript",
    "infrequentCron",
    "personaId",
  ] as const)
    delete request[key];
  if (!originalParent) request.addressed = false;
  if (peer) request.sessionMessageDepth = source.peerDepth;
  const prepared = deps.prepareRequest ? await deps.prepareRequest(request) : request;
  assertAudienceCompatible(source, prepared);
  return { meta, prepared, ...(originalParent && initiatingRun ? { delegatingRunId: initiatingRun.id } : {}) };
}

async function wakeParent(
  deps: ParentMailDeps,
  parent: Session,
  turn: Awaited<ReturnType<typeof parentTurn>>,
  mailId: string,
  wake: ParentWake,
): Promise<"woken" | "busy" | "settled"> {
  const { meta, prepared } = turn;
  const existing = await deps.runs.getByDedupKey(wake.dedupKey);
  if (!(await deps.mailbox.unread(parent.id, mailId))) {
    if (existing?.status === "pending") await deps.runs.withdraw(existing.id, { unstartedOnly: true });
    return "settled";
  }
  if (existing && (existing.status === "done" || existing.status === "failed")) return "settled";
  if ((await deps.runs.inFlightForThread(parent.threadRef)).length) return "busy";
  const surfaceTools = meta.surfaceTools === true || requiresDelegation(prepared);
  await deps.runs.enqueue({
    sessionId: parent.threadRef,
    dedupKey: wake.dedupKey,
    request: {
      ...prepared,
      ...(surfaceTools ? { surfaceTools } : {}),
      ...(turn.delegatingRunId ? { delegatingRunId: turn.delegatingRunId } : {}),
      origin: sessionTurnOrigin(prepared.origin, wake.text),
      text: wake.text,
      displayText: wake.displayText,
    },
    maxAttempts: deps.maxAttempts,
  });
  return "woken";
}

async function mailParent(
  deps: ParentMailDeps,
  child: Session,
  parent: Session,
  turn: Awaited<ReturnType<typeof parentTurn>>,
  mail: ParentMail,
  wake: ParentWake | undefined,
): Promise<"woken" | "busy" | "settled"> {
  await deps.mailbox.send({
    ...mail,
    recipientId: parent.id,
    senderId: child.id,
    actor: turn.prepared.actor,
    ...(turn.prepared.botActor ? { botActor: true } : {}),
    audience: turn.prepared.conversation.audience,
    createdAt: Date.now(),
  });
  if (!wake) return "settled";
  return wakeParent(deps, parent, turn, mail.id, wake);
}

export async function wakeOwnParent(
  deps: ParentMailDeps & { sessions: Pick<SessionStore, "get"> },
  senderId: string,
  parent: Session,
  source: ParentSource,
  mail: Pick<SessionMessage, "id" | "text" | "sourceEntrySeq">,
): Promise<"woken" | "busy" | "settled" | undefined> {
  const sender = await deps.sessions.get(senderId);
  if (!sender || sender.parentSessionId !== parent.id || !isSubagentThreadRef(sender.threadRef)) return undefined;
  const turn = await parentTurn(deps, sender, parent, source, mail.text, MESSAGE_DISPLAY);
  const marked: ParentMail = {
    ...mail,
    wake: true,
    ...(source.runId ? { senderRunId: source.runId } : {}),
    ...(source.delegatingRunId ? { delegatingRunId: source.delegatingRunId } : {}),
  };
  return mailParent(deps, sender, parent, turn, marked, messageWake(mail.id));
}

export async function wakePeer(
  deps: ParentMailDeps,
  sender: Session,
  recipient: Session,
  source: ParentSource & { peerDepth: number },
  mail: Pick<SessionMessage, "id" | "text" | "sourceEntrySeq">,
): Promise<"woken" | "busy" | "settled" | undefined> {
  if (!isPeerMessage(sender, recipient)) return undefined;
  const turn = await parentTurn(deps, sender, recipient, source, mail.text, PEER_DISPLAY);
  const marked: ParentMail = {
    ...mail,
    wake: true,
    peerDepth: source.peerDepth,
    ...(source.runId ? { senderRunId: source.runId } : {}),
  };
  return mailParent(deps, sender, recipient, turn, marked, messageWake(mail.id, true));
}

type UnreadMailDeps = ParentMailDeps & {
  sessions: Pick<SessionStore, "get" | "getByThread">;
  signals: Pick<RunSignalStore, "pending">;
  advisoryLock: AdvisoryLock;
};

export async function wakeForUnreadMail(
  deps: UnreadMailDeps,
  run: Run,
): Promise<"woken" | "busy" | "settled" | undefined> {
  if (run.result?.stopped && !sparesDescendants(run.result.stopScope)) return undefined;
  const parent = await deps.sessions.getByThread(run.sessionId);
  return parent ? wakeParentForMail(deps, parent) : undefined;
}

export async function sweepUnreadMailWakes(deps: UnreadMailDeps): Promise<void> {
  await claimThenBind(deps.mailbox.claimWakeTenants, async () => {
    for (let page = await deps.mailbox.awaitingWake(); page.length;) {
      for (const recipientId of new Set(page.map((message) => message.recipientId))) {
        const parent = await deps.sessions.get(recipientId);
        if (parent && !(await deps.runs.inFlightForThread(parent.threadRef)).length)
          await wakeParentForMail(deps, parent).catch(swallowAs("sessions: recover unread mail wake", undefined));
      }
      page = await deps.mailbox.awaitingWake(page.at(-1)?.id);
    }
  });
}

async function wakeParentForMail(
  deps: UnreadMailDeps,
  parent: Session,
): Promise<"woken" | "busy" | "settled" | undefined> {
  if (!deps.runs.get) return undefined;
  const runs = { get: deps.runs.get };
  for (const message of await deps.mailbox.wakesFor(parent.id)) {
    const child = await deps.sessions.get(message.senderId);
    const peer = !!child && isPeerMessage(child, parent);
    const wake = messageWake(message.id, peer);
    const existing = await deps.runs.getByDedupKey(wake.dedupKey);
    const outcome =
      existing?.status === "done" ||
      existing?.status === "failed" ||
      !child ||
      (!peer && (child.parentSessionId !== parent.id || !isSubagentThreadRef(child.threadRef)))
        ? "settled"
        : await deps.advisoryLock.withLock("session-tree-admission", async () => {
            if (await runStopped(runs, deps.signals, message.senderRunId ?? message.delegatingRunId)) return "settled";
            const source = {
              actor: message.actor,
              ...(message.botActor ? { botActor: true } : {}),
              conversation: { audience: message.audience },
              ...(message.delegatingRunId ? { delegatingRunId: message.delegatingRunId } : {}),
              ...(peer ? { peerDepth: message.peerDepth ?? 1 } : {}),
            };
            const turn = await parentTurn(deps, child, parent, source, message.text, wake.displayText).catch(
              swallowAs("sessions: unread mail wake", undefined),
            );
            return turn ? wakeParent(deps, parent, turn, message.id, wake) : "settled";
          });
    if (outcome !== "settled") return outcome;
    await deps.mailbox.settle(parent.id, message.id);
  }
  return undefined;
}

export async function deliverSubagentMail(deps: SubagentMailDeps, run: Run, quiet = false): Promise<boolean> {
  if (!isSubagentThreadRef(run.sessionId) || run.request.privateSessionMessage) return true;
  const stopped =
    deps.signals && deps.runs.get
      ? await runStopped({ get: deps.runs.get }, deps.signals, run.id)
      : run.result?.stopped && "self";
  const child = await deps.sessions.getByThread(run.sessionId);
  if (!child?.parentSessionId || !child.spawnMeta) return true;
  const parent = await deps.sessions.get(child.parentSessionId);
  if (!parent) return true;
  const title = child.title?.trim() || child.id;
  const result = run.result;
  const failed = run.status === "failed" || result?.status === "failed";
  const ending = failed ? "failed" : "completed";
  const wake = {
    dedupKey: returnWakeKey(run.id),
    text: COMPLETION_WAKE,
    displayText: `Delegated task ${result?.stopped ? "stopped" : ending}`,
  };
  const turn = await parentTurn(deps, child, parent, run.request, wake.text, wake.displayText);
  const { meta, prepared } = turn;
  const outputSeq = result?.sourceAssistantEntrySeq ?? run.turnUserSeq ?? result?.sourceUserSeq;
  const quotes = result?.stopped === true || failed;
  const readers = [...new Set([prepared.actor.id, ...prepared.conversation.audience.map((person) => person.id)])];
  const turnStart = run.turnUserSeq ?? result?.sourceUserSeq;
  const firstSeq = Math.min(outputSeq ?? Infinity, (quotes ? turnStart : undefined) ?? Infinity);
  const views: Item[][] = [];
  const seen: Set<number>[] = [];
  if (Number.isFinite(firstSeq))
    for (const id of readers) {
      const items = await deps.sessions.visibleItems(child.id, id, { sinceSeq: firstSeq });
      const seqs = new Set(items.map((item) => item.seq));
      if (outputSeq !== undefined && outputSeq !== null && !seqs.has(outputSeq))
        throw new Error("the current parent audience cannot read this child result");
      views.push(items);
      seen.push(seqs);
    }
  const shared = (seq: number): boolean => seen.every((seqs) => seqs.has(seq));
  const resultId = `${RESULT_MAIL}${run.id}`;
  const resent = await deps.mailbox.unread(parent.id, resultId);
  const waiting = result?.stopped || failed || resent ? 0 : await pendingWork(deps, child);
  const { kind, body } = mailOf(run, failed, quotes ? turnText(views[0] ?? [], shared, run) : undefined, waiting);
  const retired =
    (kind === "final_answer" || kind === "no_reply") &&
    !child.spawnMeta.persistent &&
    !(await deps.signals?.pending(run.id))?.some(({ signal }) => signal.kind === "steer") &&
    !(await deps.runs.inFlightForThread(child.threadRef)).length &&
    !(await deps.mailbox.pending(child.id)).length;
  const text = renderSubagentMail({
    title,
    sessionId: child.id,
    kind,
    retired,
    body:
      body.length > 16_000 ? `${body.slice(0, 16_000)}\n[truncated; read the child session for the full result]` : body,
    ...(result?.stopped && result.stopScope ? { stopScope: result.stopScope } : {}),
  });
  if (result?.attachments?.length && deps.deliveries && !result.stopped) {
    const delivery = deliveryCandidatesFor(meta, parent.scopeId);
    const candidate = delivery.candidates.find((item) => item.key === delivery.defaultKey);
    const destination =
      candidate ??
      (meta.origin?.kind === "automation" ? meta.origin.destination : undefined) ??
      principalDestination(meta.actor.id, meta.actor.id);
    await deps.deliveries.enqueue({
      destination,
      text: "",
      attachments: result.attachments,
      idempotencyKey: `subagent-files:${run.id}`,
      provenance: {
        trigger: "subagent",
        surface: meta.surface ?? "unknown",
        fireKey: `subagent-files:${run.id}`,
        sourceScopeId: child.scopeId,
        sourceThreadRef: child.threadRef,
        sourceSessionId: child.id,
      },
    });
  }
  const mail = {
    id: kind === "in_progress" ? `subagent-progress-${run.id}` : resultId,
    text,
    ...(kind === "in_progress" ? {} : { resultOf: run.id }),
    ...(outputSeq !== undefined && outputSeq !== null ? { sourceEntrySeq: outputSeq } : {}),
  };
  const wakes =
    !quiet &&
    kind !== "in_progress" &&
    (!stopped ||
      (stopped === "self" && result?.stopped === true && ["tree", "session"].includes(result.stopScope ?? "tree")));
  const outcome = await mailParent(deps, child, parent, turn, mail, wakes ? wake : undefined);
  if (retired) await deps.sessions.setSpawnMeta(child.id, { ...child.spawnMeta, retired: true });
  return outcome === "settled";
}

export async function returnSubagentRun(
  deps: SubagentMailDeps & { runs: Pick<RunStore, "markReturned" | "deferReturn"> },
  run: Run,
  quiet = false,
): Promise<void> {
  try {
    if (await deliverSubagentMail(deps, run, quiet)) await deps.runs.markReturned(run.id);
  } catch (error) {
    await deps.runs.deferReturn(run.id, 60_000);
    throw error;
  }
}

export async function settleTreeWakes(
  deps: SubagentMailDeps & {
    sessions: Pick<SessionStore, "childrenOf">;
    runs: Pick<RunStore, "pendingReturns" | "markReturned" | "deferReturn">;
  },
  root: Session,
  botRunsOnly = false,
): Promise<void> {
  const tree = (await treeSessions(deps.sessions, root)).filter((session) => session.scopeId === root.scopeId);
  for (const message of await deps.mailbox.wakesFor(...tree.map((session) => session.id)))
    if (!botRunsOnly || message.botActor) await deps.mailbox.settle(message.recipientId, message.id);
  const threadRefs = tree.map((session) => session.threadRef);
  for (const run of await deps.runs.pendingReturns(Number.MAX_SAFE_INTEGER, "", threadRefs))
    if (!botRunsOnly || run.request.botActor)
      await returnSubagentRun(deps, run, true).catch(swallowAs("sessions: settle tree return", undefined));
}

function turnText(items: readonly Item[], shared: (seq: number) => boolean, run: Run): string | undefined {
  const since = run.turnUserSeq ?? run.result?.sourceUserSeq;
  if (since === undefined || since === null) return undefined;
  const turnId = run.id.toLowerCase();
  for (const item of items.toReversed()) {
    if (item.seq < since) return undefined;
    if (!shared(item.seq) || item.turnId !== turnId) continue;
    if (item.kind !== "AgentMessage" || item.variant === "files_delivered") continue;
    const text = proseText(item)?.trim();
    if (text) return text;
  }
  return undefined;
}

export function mailOf(
  run: Run,
  failed: boolean,
  said: string | undefined,
  waiting: number,
): { kind: SubagentMailKind; body: string } {
  const result = run.result;
  if (result?.stopped) return { kind: "stopped", body: said ?? "It stopped before saying anything." };
  if (failed) {
    const reason = snippet(result?.reason ?? "the turn failed", MAIL_ERROR_CAP);
    return { kind: "errored", body: said ? `${reason}\n\nLast output before the failure:\n${said}` : reason };
  }
  if (result?.pendingApprovals?.length || result?.status === "pending_approval")
    return {
      kind: "awaiting_input",
      body: snippet(
        result.pendingApprovals?.map((a) => a.command).join("; ") ?? "a command needs human approval",
        MAIL_ERROR_CAP,
      ),
    };
  if (result?.status === "refused")
    return { kind: "refused", body: snippet(result.reason ?? "the turn was refused", MAIL_ERROR_CAP) };
  const files = result?.attachments?.map((file) => file.name) ?? [];
  const reply = result?.reply?.trim() || (files.length ? `Produced ${files.join(", ")}.` : "");
  if (waiting) {
    const note = `Still waiting on ${waiting} subagent${waiting === 1 ? "" : "s"}.`;
    return { kind: "in_progress", body: reply ? `${reply}\n\n${note}` : note };
  }
  if (result?.status === "ok" && reply) return { kind: "final_answer", body: reply };
  return { kind: "no_reply", body: "completed without sending a reply." };
}
