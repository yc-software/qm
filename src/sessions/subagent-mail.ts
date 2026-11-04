import { sessionTurnOrigin } from "../core/turn-origin.ts";
import { principalDestination } from "../reach/reach.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { deliveryCandidatesFor } from "../core/orchestrator/turn-helpers.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { Principal, Session, SpawnMeta } from "../types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { SessionMailbox, SessionMessage } from "./session-mailbox.ts";
import { xmlAttrEscape, xmlEscape } from "../util/message-tag.ts";
import { swallowAs } from "../util/errors.ts";
import {
  assertAudienceCompatible,
  isSubagentThreadRef,
  requiresDelegation,
  runStopped,
  snippet,
  storedContext,
} from "./session-syscalls.ts";

const MAIL_ERROR_CAP = 1_000;
const COMPLETION_WAKE =
  "A delegated task finished. Check internal messages with subagents wait (timeoutMs: 0), then report any new result or blocker relevant to the user's request. If it was already handled or no message is available, end without posting.";
const MESSAGE_WAKE =
  "A subagent sent you a message. Check internal messages with subagents wait (timeoutMs: 0) and decide whether it affects the user's request; report only what is relevant. If it does not, end without posting.";
const MESSAGE_DISPLAY = "Subagent sent a message";

export type SubagentMailKind = "final_answer" | "no_reply" | "awaiting_input" | "errored" | "refused";

export function renderSubagentMail(input: {
  title: string;
  sessionId: string;
  kind: SubagentMailKind;
  body: string;
}): string {
  const why: Record<SubagentMailKind, string> = {
    final_answer: "finished a turn and sent back its result",
    no_reply: "finished a turn without sending a reply",
    awaiting_input: "is blocked waiting for a human approval",
    errored: "failed",
    refused: "was refused",
  };
  return [
    `<wake reason="subagent" name="${xmlAttrEscape(input.title)}" sessionId="${input.sessionId}" kind="${input.kind}" at="${new Date().toISOString()}">`,
    `  <why>Your subagent session "${xmlEscape(input.title)}" ${why[input.kind]}.</why>`,
    `  <content>${xmlEscape(input.body)}</content>`,
    `  <instructions>If the person who asked for this work is waiting on it, relay what matters in your own words. Otherwise act on it internally without acknowledging it. Never repeat a result already reported or send a no-action-needed update. The subagent's full transcript is kept with it; use the subagents tool to read it or give it another task.</instructions>`,
    "</wake>",
  ].join("\n");
}

export interface SubagentMailDeps {
  signals?: Pick<RunSignalStore, "pending">;
  deliveries?: Pick<DeliveryStore, "enqueue">;
  delegationEnabled?: (actorId: string) => Promise<boolean>;
  mailbox: SessionMailbox;
  sessions: Pick<SessionStore, "get" | "getByThread" | "latestItemSeq" | "visibleItems">;
  runs: Pick<RunStore, "enqueue" | "inFlightForThread" | "getByDedupKey" | "withdraw"> & Partial<Pick<RunStore, "get">>;
  maxAttempts: number;
  prepareRequest?: (request: OrchestratorInput) => Promise<OrchestratorInput>;
}

type ParentMailDeps = Pick<
  SubagentMailDeps,
  "mailbox" | "runs" | "maxAttempts" | "prepareRequest" | "delegationEnabled"
>;

interface ParentSource {
  actor: Principal;
  conversation: Pick<OrchestratorInput["conversation"], "audience">;
  runId?: string;
  delegatingRunId?: string;
}

interface ParentWake {
  dedupKey: string;
  text: string;
  displayText: string;
}

type ParentMail = Pick<SessionMessage, "id" | "text" | "sourceEntrySeq" | "wake">;

const messageWake = (id: string): ParentWake => ({
  dedupKey: `subagent-followup:${id}`,
  text: MESSAGE_WAKE,
  displayText: MESSAGE_DISPLAY,
});

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
  const initiatingRun = source.delegatingRunId ? await deps.runs.get?.(source.delegatingRunId) : undefined;
  const initiatingContext = initiatingRun?.request ?? child.spawnMeta;
  if (!initiatingContext) throw new Error("the subagent has no verified runtime context yet");
  const currentContext = storedContext(parent);
  const originalParent = parent.threadRef === initiatingContext.conversation.threadRef;
  if (!originalParent && !currentContext) throw new Error("the current parent has no verified runtime context yet");
  const meta = originalParent
    ? initiatingContext
    : {
        ...currentContext!,
        actor: source.actor,
        origin: {
          kind: "automation" as const,
          ...(currentContext!.origin?.kind === "automation" && currentContext!.origin.destination
            ? { destination: currentContext!.origin.destination }
            : {}),
        },
        unattendedGrants: undefined,
      };
  const { openFingerprint: _openFingerprint, ...request }: OrchestratorInput & Pick<SpawnMeta, "openFingerprint"> = {
    ...meta,
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
  ] as const)
    delete request[key];
  if (!originalParent) request.addressed = false;
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
  if (!(await deps.mailbox.pending(parent.id)).some((message) => message.id === mailId)) {
    if (existing?.status === "pending") await deps.runs.withdraw(existing.id, { unstartedOnly: true });
    return "settled";
  }
  if (existing && (existing.status === "done" || existing.status === "failed")) return "settled";
  if ((await deps.runs.inFlightForThread(parent.threadRef)).length) return "busy";
  const surfaceTools =
    meta.surfaceTools === true ||
    requiresDelegation(prepared, (await deps.delegationEnabled?.(prepared.actor.id)) === true);
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
    audience: turn.prepared.conversation.audience,
    createdAt: Date.now(),
  });
  if (!wake || isSubagentThreadRef(parent.threadRef)) return "settled";
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
  if (
    !sender ||
    sender.parentSessionId !== parent.id ||
    !isSubagentThreadRef(sender.threadRef) ||
    isSubagentThreadRef(parent.threadRef)
  )
    return undefined;
  const turn = await parentTurn(deps, sender, parent, source, mail.text, MESSAGE_DISPLAY);
  const wake = {
    ...(source.runId ? { runId: source.runId } : {}),
    ...(source.delegatingRunId ? { delegatingRunId: source.delegatingRunId } : {}),
  };
  return mailParent(deps, sender, parent, turn, { ...mail, wake }, messageWake(mail.id));
}

export async function wakeForUnreadMail(
  deps: ParentMailDeps & {
    sessions: Pick<SessionStore, "get" | "getByThread">;
    signals: Pick<RunSignalStore, "pending">;
    advisoryLock: AdvisoryLock;
  },
  run: Run,
): Promise<"woken" | "busy" | "settled" | undefined> {
  if (isSubagentThreadRef(run.sessionId) || run.result?.stopped || !deps.runs.get) return undefined;
  const parent = await deps.sessions.getByThread(run.sessionId);
  if (!parent || parent.parentSessionId) return undefined;
  const runs = { get: deps.runs.get };
  for (const message of await deps.mailbox.pending(parent.id)) {
    const marker = message.wake;
    if (!marker) continue;
    const wake = messageWake(message.id);
    const existing = await deps.runs.getByDedupKey(wake.dedupKey);
    const child = await deps.sessions.get(message.senderId);
    const outcome =
      existing?.status === "done" ||
      existing?.status === "failed" ||
      !child ||
      child.parentSessionId !== parent.id ||
      !isSubagentThreadRef(child.threadRef)
        ? "settled"
        : await deps.advisoryLock
            .withLock("session-tree-admission", async () => {
              if (await runStopped(runs, deps.signals, marker.runId ?? marker.delegatingRunId)) return "settled";
              const source = {
                actor: message.actor,
                conversation: { audience: message.audience },
                ...(marker.delegatingRunId ? { delegatingRunId: marker.delegatingRunId } : {}),
              };
              return wakeParent(
                deps,
                parent,
                await parentTurn(deps, child, parent, source, message.text, MESSAGE_DISPLAY),
                message.id,
                wake,
              );
            })
            .catch(swallowAs("sessions: unread mail wake", "settled" as const));
    if (outcome !== "settled") return outcome;
    await deps.mailbox.settle(parent.id, message.id);
  }
  return undefined;
}

export async function deliverSubagentMail(deps: SubagentMailDeps, run: Run): Promise<boolean> {
  if (!isSubagentThreadRef(run.sessionId) || run.request.privateSessionMessage) return true;
  const stopped = run.result?.stopped
    ? "self"
    : deps.signals && deps.runs.get && (await runStopped({ get: deps.runs.get }, deps.signals, run.id));
  if (stopped === "self") return true;
  const child = await deps.sessions.getByThread(run.sessionId);
  if (!child?.parentSessionId || !child.spawnMeta) return true;
  const parent = await deps.sessions.get(child.parentSessionId);
  if (!parent) return true;
  const title = child.title?.trim() || child.id;
  const result = run.result;
  let kind: SubagentMailKind;
  let body: string;
  if (run.status === "failed" || result?.status === "failed") {
    kind = "errored";
    body = snippet(result?.reason ?? "the turn failed", MAIL_ERROR_CAP);
  } else if (result?.pendingApprovals?.length || result?.status === "pending_approval") {
    kind = "awaiting_input";
    body = snippet(
      result.pendingApprovals?.map((a) => a.command).join("; ") ?? "a command needs human approval",
      MAIL_ERROR_CAP,
    );
  } else if (result?.status === "refused") {
    kind = "refused";
    body = snippet(result.reason ?? "the turn was refused", MAIL_ERROR_CAP);
  } else if (result?.status === "ok" && (result.reply?.trim() || result.attachments?.length)) {
    kind = "final_answer";
    body = result.reply?.trim() || `Produced ${result.attachments!.map((file) => file.name).join(", ")}.`;
  } else {
    kind = "no_reply";
    body = "completed without sending a reply.";
  }
  const text = renderSubagentMail({
    title,
    sessionId: child.id,
    kind,
    body:
      body.length > 16_000 ? `${body.slice(0, 16_000)}\n[truncated; read the child session for the full result]` : body,
  });
  const turn = await parentTurn(
    deps,
    child,
    parent,
    run.request,
    text,
    `[subagent ${title}: ${kind.replace("_", " ")}]`,
  );
  const { meta, prepared } = turn;
  const outputSeq = run.result?.sourceAssistantEntrySeq ?? run.turnUserSeq ?? run.result?.sourceUserSeq;
  if (outputSeq !== undefined && outputSeq !== null) {
    for (const id of new Set([prepared.actor.id, ...prepared.conversation.audience.map((person) => person.id)])) {
      const visible = await deps.sessions.visibleItems(child.id, id);
      if (!visible.some((item) => item.seq === outputSeq))
        throw new Error("the current parent audience cannot read this child result");
    }
  }
  if (result?.attachments?.length && deps.deliveries) {
    const delivery = deliveryCandidatesFor(meta.surface, meta.deliveryTarget, meta.deliveryCandidates, parent.scopeId);
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
    id: `subagent-mail-${run.id}`,
    text,
    ...(outputSeq !== undefined && outputSeq !== null ? { sourceEntrySeq: outputSeq } : {}),
  };
  const wake = {
    dedupKey: `subagent-return:${run.id}`,
    text: COMPLETION_WAKE,
    displayText: "Delegated task completed",
  };
  return (await mailParent(deps, child, parent, turn, mail, stopped ? undefined : wake)) === "settled";
}
