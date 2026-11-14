import { isAgentReply, type Item, proseText } from "./items.ts";
import { isSessionTurn, sessionTurnOrigin } from "../core/turn-origin.ts";
import type { SessionMailbox, SessionMessage } from "./session-mailbox.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { sleep } from "../util/async.ts";
import { pgTextSafe, snippet } from "../util/text.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { errMessage } from "../util/errors.ts";
import { randomUUID } from "node:crypto";
import { hashId } from "../util/crypto.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import type { CoreSearch } from "../search/core-search.ts";
import type {
  ChildIsolation,
  ChildIsolationMode,
  Principal,
  ScopeId,
  Session,
  SpawnMeta,
  StopScope,
  TurnOrigin,
} from "../types.ts";
import { childIsolation } from "./child-isolation.ts";
import { sessionVisibleTo } from "./session-rows.ts";
import { openRuntime, parentRuntime } from "./subagent-runtime.ts";
import type { RuntimeChoice } from "../agent/agent.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import { replayableRequest } from "../core/orchestrator/turn-helpers.ts";
import type { RunSignal, RunSignalStore } from "../runs/run-signal-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { SwarmService } from "../swarms/swarm-service.ts";
import type { Tenant } from "../tenants/context.ts";
import { xmlAttrEscape, xmlEscape } from "../util/message-tag.ts";
import { isPeerMessage, wakeOwnParent, wakePeer } from "./subagent-mail.ts";
import {
  liveSubagentsNote,
  openChildren,
  runState,
  sessionActivity,
  subagentActivity,
  visibleChildren,
  type SessionStatus,
  type SubagentActivity,
  type SubagentActivityDeps,
} from "./subagent-status.ts";

const SUBAGENT_THREAD_PREFIX = "agent:main:subagent:";

export function isSubagentThreadRef(threadRef: string): boolean {
  return threadRef.startsWith(SUBAGENT_THREAD_PREFIX);
}

export function requiresDelegation(
  request: Pick<OrchestratorInput, "surface" | "surfaceTools" | "conversation" | "swarm" | "surfaceOrigin">,
): boolean {
  return (
    request.surfaceOrigin?.audience !== "external" &&
    !request.swarm &&
    !isSubagentThreadRef(request.conversation.threadRef) &&
    (request.surface === "slack" || request.surfaceTools === true)
  );
}

export function isOwnerFire(request: Pick<OrchestratorInput, "origin" | "botActor">): boolean {
  return request.origin.kind === "automation" && request.origin.ownerFire === true && !request.botActor;
}

export async function delegatedAuthorizationOrigin(
  request: OrchestratorInput,
  deps: { runs: Pick<RunStore, "get">; sessions: Pick<SessionStore, "get" | "getByThread"> },
): Promise<OrchestratorInput["origin"] | undefined> {
  const seen = new Set<string>();
  let current = request;
  for (let depth = 0; depth < 32; depth++) {
    if (
      (current.origin.kind === "automation" && !isOwnerFire(current)) ||
      current.readOnly ||
      current.privateSessionMessage ||
      current.swarm ||
      !current.delegatingRunId ||
      !current.sessionSenderId ||
      seen.has(current.delegatingRunId)
    )
      return;
    seen.add(current.delegatingRunId);
    const source = await deps.runs.get(current.delegatingRunId);
    const sender = await deps.sessions.get(current.sessionSenderId);
    const child = await deps.sessions.getByThread(current.conversation.threadRef);
    if (!source || !sender || !child) return;
    const delegated =
      isSubagentThreadRef(child.threadRef) &&
      child.parentSessionId === sender.id &&
      source.sessionId === sender.threadRef;
    const continued =
      isSubagentThreadRef(sender.threadRef) &&
      sender.parentSessionId === child.id &&
      source.sessionId === child.threadRef;
    const started =
      current.surface === "web" &&
      !child.parentSessionId &&
      !isSubagentThreadRef(child.threadRef) &&
      source.sessionId === sender.threadRef;
    if (!delegated && !continued && !started) return;
    const parent = source.request;
    const audience = new Set([parent.actor.id, ...parent.conversation.audience.map((person) => person.id)]);
    if (
      parent.actor.id !== request.actor.id ||
      parent.actor.type !== "internal" ||
      parent.readOnly ||
      parent.privateSessionMessage ||
      parent.swarm ||
      sender.scopeId !== child.scopeId ||
      child.scopeId !== conversationScope(parent.conversation, parent.actor.id) ||
      child.scopeId !== conversationScope(current.conversation, current.actor.id) ||
      current.conversation.audience.some((person) => !audience.has(person.id))
    )
      return;
    const internal =
      parent.conversation.audience.every((person) => person.type === "internal") &&
      (parent.conversation.kind === "dm" ||
        (!!parent.conversation.publishMembers?.length &&
          parent.conversation.publishMembers.every((person) => person.type === "internal")));
    if (
      !isSessionTurn(parent) &&
      internal &&
      (parent.origin.kind === "human" ||
        isOwnerFire(parent) ||
        (parent.origin.kind === "ambient" && parent.origin.live === true && parent.conversation.kind !== "dm"))
    )
      return parent.origin;
    current = parent;
  }
}

export function ownsSessionContext(
  threadRef: string,
  input: Pick<OrchestratorInput, "sessionSenderId" | "delegatingRunId" | "privateSessionMessage" | "swarm">,
): boolean {
  return (
    !isSessionTurn(input) &&
    !input.privateSessionMessage &&
    !input.swarm &&
    !isSubagentThreadRef(threadRef) &&
    !threadRef.startsWith("swarm:")
  );
}

export const isSidebarSession = (session: Session): boolean =>
  !session.parentSessionId && !isSubagentThreadRef(session.threadRef) && !session.threadRef.startsWith("swarm:");

export function doesBotWork(session: Pick<Session, "spawnMeta"> | null, request: { botActor?: boolean }): boolean {
  return request.botActor === true || session?.spawnMeta?.botActor === true;
}

export async function forkOfBotWork(
  tenant: Tenant,
  session: Pick<Session, "id" | "forkedFrom"> | null,
  deps: { sessions: Pick<SessionStore, "forkOrigin">; swarms?: Pick<SwarmService, "botStartedWorker"> },
): Promise<boolean> {
  if (!session?.forkedFrom) return false;
  const origin = await deps.sessions.forkOrigin(tenant, session.id);
  if (!origin || origin.forkedFrom) return true;
  if (isSubagentThreadRef(origin.threadRef)) return origin.spawnMeta?.botActor === true;
  if (!origin.threadRef.startsWith("swarm:")) return false;
  return !deps.swarms || (await deps.swarms.botStartedWorker(origin));
}

export async function hiddenFromBotWork(
  tenant: Tenant,
  viewer: { botActor?: boolean },
  session: Pick<Session, "id" | "forkedFrom" | "botWork">,
  deps: Parameters<typeof forkOfBotWork>[2],
): Promise<boolean> {
  return !sessionVisibleTo(viewer, session) && !(await forkOfBotWork(tenant, session, deps));
}

export function storedContext(session: Session): SpawnMeta | undefined {
  return (
    session.spawnMeta && {
      ...session.spawnMeta,
      ...(session.surfaceBinding && !session.spawnMeta.surfaceOrigin ? { surfaceOrigin: session.surfaceBinding } : {}),
    }
  );
}

export function sessionContextOf(input: OrchestratorInput): SpawnMeta {
  const origin: TurnOrigin =
    input.origin.kind === "automation"
      ? { kind: "automation", ...(input.origin.destination ? { destination: input.origin.destination } : {}) }
      : sessionTurnOrigin(input.origin, "");
  return {
    origin,
    ...(input.surfaceTools ? { surfaceTools: true } : {}),
    ...(input.liveReplies ? { liveReplies: true } : {}),
    ...(input.deliveryCandidates ? { deliveryCandidates: input.deliveryCandidates } : {}),
    ...(input.surfaceOrigin?.audience === "external" ? { surfaceOrigin: input.surfaceOrigin } : {}),
    ...(input.scopeVersion ? { scopeVersion: input.scopeVersion } : {}),
    ...(input.sessionParticipantIds ? { sessionParticipantIds: input.sessionParticipantIds } : {}),
    surface: input.surface ?? "web",
    conversation: input.conversation,
    actor: input.actor,
    ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
    ...(input.deliveryWebhook ? { deliveryWebhook: input.deliveryWebhook } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.readOnly ? { readOnly: true } : {}),
    ...(input.memoryNotebookOnly ? { memoryNotebookOnly: true } : {}),
    ...(input.botActor ? { botActor: true } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
  };
}

const SESSION_MESSAGE_DEPTH_CAP = 8;
const READ_DEFAULT_LIMIT = 30;
const SESSION_LIST_LIMIT = 50;
const WEB_ONLY = "sessions are a web UI feature and aren't available here.";
const HIDDEN_PARENT =
  "your parent conversation is hidden from bot work, so you can't read it; you can still write to it.";
const READ_DEFAULT_MAX_CHARS = 4_000;
const READ_MAX_CHARS_CEILING = 20_000;
const LAST_SAID_SCAN = 40;

export interface SessionOpenInput {
  requestId?: string;
  task: string;
  name?: string;
  readOnly?: boolean;
  model?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  isolation?: ChildIsolationMode;
  persistent?: boolean;
}

type SessionOpenResult =
  { ok: true; sessionId: string; title: string; isolation?: ChildIsolation } | { ok: false; message: string };

interface SessionWriteInput {
  target: string;
  peer?: boolean;
  text?: string;
  interrupt?: boolean;
  wake?: boolean;
  requestId?: string;
}

type SessionWriteResult =
  | {
      ok: true;
      sessionId: string;
      title: string;
      delivered: "queued_turn" | "steered" | "interrupted" | "queued_message";
      busy?: boolean;
      notWoken?: string;
    }
  | { ok: false; message: string };

interface SessionReadInput {
  target?: string;
  peer?: boolean;
  limit?: number;
  maxChars?: number;
}

interface SessionChildSummary {
  sessionId: string;
  title: string;
  activity: SubagentActivity;
  lastSaid?: string;
  isolation?: ChildIsolation;
}

interface SessionStartInput {
  fork: boolean;
  text?: string;
  title?: string;
}

type SessionStartResult =
  { ok: true; sessionId: string; title: string; refused?: string } | { ok: false; message: string };

interface SessionSummary {
  sessionId: string;
  title: string;
  status: SessionStatus;
  current: boolean;
}

type SessionListResult = { ok: true; sessions: SessionSummary[] } | { ok: false; message: string };

type SessionReadResult =
  | { ok: true; mode: "children"; children: SessionChildSummary[] }
  | {
      ok: true;
      mode: "transcript";
      sessionId: string;
      title: string;
      status: SessionStatus;
      activity?: SubagentActivity;
      rendered: string;
    }
  | { ok: false; message: string };

export interface SessionSyscallBinding {
  session: Session;
  scopeId: ScopeId;
  orgScopeId?: ScopeId;
  liveTurn?: boolean;
  request: Pick<
    OrchestratorInput,
    | "cancel"
    | "surface"
    | "surfaceTools"
    | "deliveryCandidates"
    | "privateSessionMessage"
    | "sessionMessageDepth"
    | "swarm"
    | "runId"
    | "delegatingRunId"
    | "conversation"
    | "actor"
    | "deliveryTarget"
    | "deliveryWebhook"
    | "timezone"
    | "readOnly"
    | "memoryNotebookOnly"
    | "botActor"
    | "scopeVersion"
    | "sessionParticipantIds"
    | "surfaceOrigin"
    | "model"
    | "thinkingLevel"
    | "fastMode"
  > & { origin?: OrchestratorInput["origin"] };
  switchedRuntime?: () => RuntimeChoice | undefined;
}

export interface SessionSyscalls {
  receive?(timeoutMs?: number, signal?: AbortSignal): Promise<SessionMessage[]>;
  acknowledge?(ids: string[]): Promise<void>;
  open(input: SessionOpenInput): Promise<SessionOpenResult>;
  write(input: SessionWriteInput): Promise<SessionWriteResult>;
  read(input: SessionReadInput): Promise<SessionReadResult>;
  liveSubagents?(): Promise<string>;
  search?(input: { query: string; limit?: number }): ReturnType<CoreSearch["search"]>;
  list?(): Promise<SessionListResult>;
  start?(input: SessionStartInput): Promise<SessionStartResult>;
}

export interface SessionSyscallsFactory {
  rejectMessage?(sessionId: string, messageId: string): Promise<void>;
  forTurn(binding: SessionSyscallBinding): SessionSyscalls;
}

export interface SessionSyscallDeps {
  mailbox: SessionMailbox;
  enabled?: (actorId: string) => Promise<boolean>;
  sessions: Pick<
    SessionStore,
    | "get"
    | "getByThread"
    | "getOrCreateByThread"
    | "setParentSession"
    | "setSpawnMeta"
    | "childrenOf"
    | "addParticipant"
    | "updateTitle"
    | "latestItemSeq"
    | "visibleItems"
    | "participantsOf"
    | "getForParticipant"
    | "descendantsOf"
  > &
    SubagentActivityDeps["sessions"];
  runs: Pick<RunStore, "enqueue" | "inFlightForThread" | "getByDedupKey" | "get" | "withdraw"> &
    SubagentActivityDeps["runs"];
  signals: Pick<RunSignalStore, "send" | "pending" | "runForDedupeKey">;
  steerRun(
    run: Run,
    signal: RunSignal,
  ): Promise<{ sent: boolean; terminal?: boolean; drained?: boolean; replayRunId?: string }>;
  maxAttempts: number;
  advisoryLock: AdvisoryLock;
  prepareRequest?: (request: OrchestratorInput) => Promise<OrchestratorInput>;
  authorize?: (target: Session, request: SessionSyscallBinding["request"]) => Promise<boolean>;
  reaches?: (target: Session, request: SessionSyscallBinding["request"], from: Session) => Promise<boolean>;
  validateRuntime?: (input: SessionOpenInput, scopeId: ScopeId) => Promise<void>;
  defaultModel?: (scopeId: ScopeId) => Promise<string>;
  conversations?: {
    search?: CoreSearch["search"];
    list(viewer: { actorId: string; botActor?: boolean }): Promise<Session[]>;
    start(
      actorId: string,
      input: {
        scopeId: ScopeId;
        forkOf?: string;
        text?: string;
        title?: string;
        origin?: OrchestratorInput["origin"];
        sessionSenderId?: string;
        delegatingRunId?: string;
      },
    ): Promise<{ session: Session; refused?: string } | { error: string }>;
  };
}

function autoTitle(task: string): string {
  const line = task.trim().split("\n")[0] ?? "";
  return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}…`;
}

function itemText(item: Item): string | undefined {
  const text = proseText(item);
  if (text?.trim()) return text;
  return item.tool === null ? undefined : `[${item.tool}]`;
}

function lastAssistantText(items: readonly Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]!;
    if (e.kind === "Stop") {
      const before = items[i - 1];
      const partial = before && isAgentReply(before) ? itemText(before) : "";
      const reason = e.body.reason;
      return partial || `[system] Subagent stopped${typeof reason === "string" ? ` ${reason}` : ""}. No reply.`;
    }
    if (e.kind !== "AgentMessage" || e.variant === "files_delivered") continue;
    const text = itemText(e);
    if (text) return text;
  }
  return undefined;
}

function renderSubagentTask(input: { title: string; parentTitle: string; task: string }): string {
  return [
    `<subagent-task session="${xmlAttrEscape(input.title)}">`,
    `You are the subagent session "${input.title}", spawned from the conversation "${input.parentTitle}". To message your parent use subagents send_message with target="parent"; use an exact sibling title or sessionId for peers, never filesystem paths. When your turn ends, your final message is delivered to your current parent session — make it the result, stated plainly. Your parent can change while you work; detached sessions have no automatic return. Use your judgment on details within the task's real limits; if an instruction seems to work against the goal, follow the goal and say so. Do not contact people, post to conversations, or change standing configuration unless the task says to. If you are blocked, end your turn saying exactly what you need.`,
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
    ...(meta.liveReplies ? { liveReplies: true } : {}),
    ...(meta.surfaceOrigin ? { surfaceOrigin: meta.surfaceOrigin } : {}),
    ...(meta.deliveryTarget ? { deliveryTarget: meta.deliveryTarget } : {}),
    ...(meta.deliveryWebhook ? { deliveryWebhook: meta.deliveryWebhook } : {}),
    ...(meta.deliveryCandidates ? { deliveryCandidates: meta.deliveryCandidates } : {}),
    actor: meta.actor,
    conversation: { ...meta.conversation, threadRef: child.threadRef },
    origin: sessionTurnOrigin(meta.origin, text),
    text,
    displayText,
    envelopeWrapped: true,
    ...(meta.readOnly ? { readOnly: true } : {}),
    ...(meta.memoryNotebookOnly ? { memoryNotebookOnly: true } : {}),
    ...(meta.botActor ? { botActor: true } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.thinkingLevel ? { thinkingLevel: meta.thinkingLevel } : {}),
    ...(meta.fastMode !== undefined ? { fastMode: meta.fastMode } : {}),
    ...(meta.timezone ? { timezone: meta.timezone } : {}),
  };
}

export function assertAudienceCompatible(
  source: { actor: Pick<Principal, "id">; conversation: Pick<OrchestratorInput["conversation"], "audience"> },
  target: Pick<OrchestratorInput, "actor" | "conversation">,
): void {
  const allowed = new Set([source.actor.id, ...source.conversation.audience.map((person) => person.id)]);
  if ([target.actor.id, ...target.conversation.audience.map((person) => person.id)].some((id) => !allowed.has(id)))
    throw new Error("the target audience includes people outside the sender's authorized audience");
}

export const AMBIENT_REACH_REFUSAL =
  "that helper belongs to another unprompted wake; only the wake that opened it can reach it.";

async function sessionAncestors(sessions: Pick<SessionStore, "get">, session: Session): Promise<Session[]> {
  const ancestors: Session[] = [];
  let current = session;
  const seen = new Set<string>();
  while (current.parentSessionId) {
    if (seen.has(current.id)) throw new Error("session parent cycle");
    seen.add(current.id);
    const parent = await sessions.get(current.parentSessionId);
    if (!parent) break;
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}

export async function sessionTreeRoot(sessions: Pick<SessionStore, "get">, session: Session): Promise<Session> {
  return (await sessionAncestors(sessions, session)).at(-1) ?? session;
}

export async function stoppableRoot(
  sessions: Pick<SessionStore, "sameScopeAncestors">,
  session: Session,
): Promise<Session | undefined> {
  if (!session.parentSessionId) return undefined;
  return (await sessions.sameScopeAncestors([session.threadRef])).find((ancestor) => !ancestor.parentSessionId);
}

export async function sessionTreeWorking(
  sessions: Pick<SessionStore, "childrenOf">,
  runs: Pick<RunStore, "activeForThread">,
  root: Session,
): Promise<boolean> {
  for (const session of await treeSessions(sessions, root)) {
    if (session.scopeId === root.scopeId && (await runs.activeForThread(session.threadRef))) return true;
  }
  return false;
}

export async function workingSessionThreadRefs(
  sessions: Pick<SessionStore, "sameScopeAncestors">,
  runs: Pick<RunStore, "activeSessionIds">,
  awaitingSessionIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const active = await runs.activeSessionIds();
  const working = new Set(active);
  for (const ancestor of await sessions.sameScopeAncestors(active))
    if (!ancestor.parentSessionId && !awaitingSessionIds.has(ancestor.id)) working.add(ancestor.threadRef);
  return working;
}

export async function treeSessions(sessions: Pick<SessionStore, "childrenOf">, root: Session): Promise<Session[]> {
  const all: Session[] = [root];
  const queue = [root];
  const seen = new Set([root.id]);
  while (queue.length) {
    const next = queue.shift()!;
    const children = await sessions.childrenOf(next.id);
    for (const child of children) {
      if (seen.has(child.id)) throw new Error("session parent cycle");
      seen.add(child.id);
      all.push(child);
      queue.push(child);
    }
  }
  return all;
}

export const PARENT_INTERRUPT = "by the parent agent";
export const ANCESTOR_STOP = "because the parent session was stopped";
export const USER_STOP = "by user";
export const USER_STOP_ALL = "by user (subagents too)";

type StopRequest = { reason?: string | undefined; scope?: StopScope; botRunsOnly?: boolean };

export const sparesDescendants = (scope: StopScope | undefined): boolean => scope === "run" || scope === "session";

async function stopOf(
  signals: Pick<RunSignalStore, "pending">,
  run: Run,
): Promise<{ scope: StopScope | undefined } | undefined> {
  if (run.result?.stopped) return { scope: run.result.stopScope };
  const abort = (await signals.pending(run.id)).find(({ signal }) => signal.kind === "abort");
  return abort && { scope: abort.signal.scope };
}

export async function runStopped(
  runs: Pick<RunStore, "get">,
  signals: Pick<RunSignalStore, "pending">,
  runId: string | undefined,
): Promise<"self" | "ancestor" | undefined> {
  const seen = new Set<string>();
  let self = false;
  for (let current = runId; current;) {
    if (seen.has(current)) return "ancestor";
    seen.add(current);
    const run = await runs.get(current);
    const stop = run && (await stopOf(signals, run));
    if (current === runId) self = !run || stop !== undefined;
    else if (!run || (stop && !sparesDescendants(stop.scope))) return "ancestor";
    current = run?.request.delegatingRunId;
  }
  return self ? "self" : undefined;
}

const unstarted = (run: Run): boolean => run.status === "pending" && run.attempts === 0 && run.turnUserSeq === null;
const interruptible = (run: Run): boolean => !unstarted(run) || Boolean(run.request.sessionSenderId);

export async function stopSessionRuns(
  deps: { runs: Pick<RunStore, "inFlightForThread" | "withdraw">; signals: Pick<RunSignalStore, "send"> },
  session: Session,
  stop: StopRequest,
  interrupt?: { by: string; mailbox: Pick<SessionMailbox, "send"> },
): Promise<{ id: string; withdrawn: boolean }[]> {
  const stopped: { id: string; withdrawn: boolean }[] = [];
  for (const run of await deps.runs.inFlightForThread(session.threadRef)) {
    if ((interrupt && !interruptible(run)) || (stop.botRunsOnly && !run.request.botActor)) continue;
    const sender = interrupt && unstarted(run) ? run.request.sessionSenderId : undefined;
    const foreign = interrupt && sender && sender !== interrupt.by ? { mailbox: interrupt.mailbox, sender } : undefined;
    if (foreign)
      await foreign.mailbox.send({
        id: `interrupted-${run.id}`,
        recipientId: session.id,
        senderId: foreign.sender,
        actor: run.request.actor,
        ...(run.request.botActor ? { botActor: true } : {}),
        audience: run.request.conversation.audience,
        text: run.request.text,
        createdAt: run.createdAt,
      });
    await deps.signals.send(run.id, {
      kind: "abort",
      ...(stop.reason ? { reason: stop.reason } : {}),
      ...(stop.scope ? { scope: stop.scope } : {}),
    });
    const withdrawn =
      run.status === "pending" && (await deps.runs.withdraw(run.id, { unstartedOnly: sparesDescendants(stop.scope) }));
    stopped.push({ id: run.id, withdrawn: withdrawn && !foreign });
  }
  return stopped;
}

async function acceptedFollowup(
  runs: Pick<RunStore, "getByDedupKey" | "inFlightForThread">,
  dedupKey: string | undefined,
  target: Session,
  stamped: string,
  title: string,
): Promise<SessionWriteResult | undefined> {
  const existing = dedupKey ? await runs.getByDedupKey(dedupKey) : null;
  if (!existing) return undefined;
  if (
    existing.sessionId !== target.threadRef ||
    (existing.request.text !== stamped && existing.request.text !== pgTextSafe(stamped))
  )
    return { ok: false, message: "the requestId was already used for different work" };
  const others = (await runs.inFlightForThread(target.threadRef)).filter((run) => run.id !== existing.id);
  return { ok: true, sessionId: target.id, title, delivered: "queued_turn", busy: others.length > 0 };
}

async function steerRunningTurn(
  deps: Pick<SessionSyscallDeps, "signals" | "steerRun">,
  inFlight: Run[],
  request: OrchestratorInput,
  message: { text: string; dedupKey: string | undefined },
): Promise<"steered" | "replayed" | "refused" | undefined> {
  if (message.dedupKey && (await deps.signals.runForDedupeKey(message.dedupKey))) return "steered";
  const live = inFlight.find((run) => run.status === "running");
  if (
    !live ||
    (request.readOnly && !live.request.readOnly) ||
    (request.memoryNotebookOnly && !live.request.memoryNotebookOnly) ||
    Boolean(request.botActor) !== Boolean(live.request.botActor)
  )
    return undefined;
  const steered = await deps.steerRun(live, {
    kind: "steer",
    text: message.text,
    ts: `${Date.now()}.${randomUUID().slice(0, 8)}`,
    request: { ...replayableRequest(request), spawned: true },
    ...(message.dedupKey ? { dedupeKey: message.dedupKey } : {}),
  });
  if (!steered.terminal) return "steered";
  return steered.drained && !steered.replayRunId ? "refused" : "replayed";
}

export async function stopSessionTree(
  deps: {
    sessions: Pick<SessionStore, "childrenOf">;
    runs: Pick<RunStore, "inFlightForThread" | "withdraw" | "get">;
    signals: Pick<RunSignalStore, "send">;
  },
  root: Session,
  reason?: string,
  botRunsOnly?: boolean,
): Promise<boolean> {
  let stopped = false;
  for (const session of await treeSessions(deps.sessions, root)) {
    const stop: StopRequest =
      session.id === root.id ? { reason, botRunsOnly } : { reason: ANCESTOR_STOP, scope: "ancestor", botRunsOnly };
    if (session.scopeId === root.scopeId && (await stopSessionRuns(deps, session, stop)).length) stopped = true;
  }
  return stopped;
}

export async function sessionTreeRuns(
  sessions: Pick<SessionStore, "childrenOf">,
  runs: Pick<RunStore, "inFlightForThread">,
  root: Session,
): Promise<Run[]> {
  const live: Run[] = [];
  for (const session of await treeSessions(sessions, root)) {
    live.push(...(await runs.inFlightForThread(session.threadRef)));
  }
  return live;
}

export function createSessionSyscalls(deps: SessionSyscallDeps): SessionSyscallsFactory {
  const lock = deps.advisoryLock;

  return {
    rejectMessage: (sessionId, messageId) => deps.mailbox.acknowledge(sessionId, [messageId]),
    forTurn(binding) {
      const callerTitle = binding.session.title?.trim() || "Untitled";

      async function resolveTarget(ref: string, writing = false): Promise<Session | string> {
        const missing = `no session matches "${ref}" — use a sessionId from open, read, or list.`;
        const trimmed = ref.trim();
        if (!trimmed) return missing;
        const visible = (session: Session | null) =>
          session && sessionVisibleTo(binding.request, session) ? session : null;
        const current = await deps.sessions.get(binding.session.id);
        const found = (session: Session | null) => {
          if (!session || visible(session)) return session ?? missing;
          if (session.id !== current?.parentSessionId) return missing;
          return writing ? session : HIDDEN_PARENT;
        };
        if (trimmed.toLowerCase() === "parent")
          return found(current?.parentSessionId ? await deps.sessions.get(current.parentSessionId) : null);
        const byId = await deps.sessions.get(trimmed);
        if (byId) return found(byId);
        const byThread = await deps.sessions.getByThread(trimmed);
        if (byThread) return found(byThread);
        const children = await deps.sessions.childrenOf(binding.session.id);
        const siblings = current?.parentSessionId ? await deps.sessions.childrenOf(current.parentSessionId) : [];
        const named = [...children, ...siblings].filter(
          (c) => c.title?.trim().toLowerCase() === trimmed.toLowerCase() && visible(c),
        );
        return named.find((c) => !c.spawnMeta?.retired) ?? named[0] ?? missing;
      }

      function sidebarRefusal(): string | null {
        if (binding.request.surface !== "web") return WEB_ONLY;
        if (binding.request.swarm) return "swarm workers coordinate through the swarm API.";
        return null;
      }

      const visibleTitle = (target: Session) =>
        (sessionVisibleTo(binding.request, target) && target.title?.trim()) || target.id;

      function peerRefusal(target: Session): string | null {
        const refusal = sidebarRefusal();
        if (refusal) return refusal;
        if (!isSidebarSession(target))
          return `"${visibleTitle(target)}" is a subagent, not a session — use the subagents tool for it.`;
        return null;
      }

      async function visibleHistory(target: Session): Promise<Item[]> {
        const audience = binding.request.conversation.audience.length
          ? binding.request.conversation.audience
          : [binding.request.actor];
        const members = await deps.sessions.participantsOf(target.id);
        if (!audience.every((p) => members.includes(p.id))) return [];
        return deps.sessions.visibleItems(target.id, binding.request.actor.id);
      }

      async function currentCaller(): Promise<OrchestratorInput> {
        binding.request.cancel?.throwIfAborted();
        if (await runStopped(deps.runs, deps.signals, binding.request.runId))
          throw new Error("this delegated task was stopped");
        if (deps.enabled && !(await deps.enabled(binding.request.actor.id)))
          throw new Error("persistent subagents are not enabled for this user");
        const current = await deps.sessions.get(binding.session.id);
        if (!current) throw new Error("this session no longer exists; nothing was started or sent.");
        if (current.scopeId !== binding.scopeId)
          throw new Error(
            `this session moved from ${binding.scopeId} to ${current.scopeId}; nothing was started or sent.`,
          );
        if (deps.authorize && !(await deps.authorize(current, binding.request)))
          throw new Error(
            `${binding.request.actor.id} can't currently be confirmed as a member of ${binding.scopeId}, so helpers can't run here; nothing was started or sent.`,
          );
        const request: OrchestratorInput = {
          ...binding.request,
          origin: binding.request.origin ?? { kind: "automation" },
          text: "",
        };
        return deps.prepareRequest ? deps.prepareRequest(request) : request;
      }

      return {
        async receive(timeoutMs = 0, signal) {
          const deadline = Date.now() + Math.min(60_000, Math.max(0, timeoutMs));
          do {
            binding.request.cancel?.throwIfAborted();
            const messages = await deps.mailbox.pending(binding.session.id);
            if (!messages.length && !timeoutMs) return [];
            const caller = await currentCaller();
            const visible: SessionMessage[] = [];
            for (const message of messages) {
              const sender = await deps.sessions.getForParticipant(message.senderId, caller.actor.id);
              if (!sender || sender.scopeId !== binding.scopeId) continue;
              if (deps.authorize && !(await deps.authorize(sender, caller))) continue;
              try {
                assertAudienceCompatible(
                  { actor: message.actor, conversation: { ...caller.conversation, audience: message.audience } },
                  caller,
                );
                if (message.sourceEntrySeq !== undefined) {
                  const viewers = new Set([
                    caller.actor.id,
                    ...caller.conversation.audience.map((person) => person.id),
                  ]);
                  const readable = await Promise.all(
                    [...viewers].map(async (id) =>
                      (await deps.sessions.visibleItems(sender.id, id)).some(
                        (item) => item.seq === message.sourceEntrySeq,
                      ),
                    ),
                  );
                  if (!readable.every(Boolean)) continue;
                }
                visible.push(message);
                if (visible.length >= 4) break;
              } catch {
                continue;
              }
            }
            if (visible.length || Date.now() >= deadline || signal?.aborted) return visible;
            await sleep(Math.min(250, deadline - Date.now()));
          } while (Date.now() <= deadline);
          return [];
        },
        async acknowledge(ids) {
          await deps.mailbox?.acknowledge(binding.session.id, ids);
        },
        async open(input) {
          if (binding.session.sideChat && !binding.session.sideChat.expanded)
            return { ok: false, message: "Side chats cannot launch subagents. Open this chat as a session first." };
          return lock
            .withLock("session-tree-admission", async (): Promise<SessionOpenResult> => {
              if (binding.request.swarm || binding.session.threadRef.startsWith("swarm:"))
                throw new Error("swarm workers coordinate through the swarm API");
              const caller = await currentCaller();
              assertAudienceCompatible(binding.request, caller);
              if (binding.request.privateSessionMessage)
                throw new Error("private session messages cannot delegate new work");
              const task = input.task?.trim();
              if (!task)
                return { ok: false, message: "open requires a task: the full instruction the subagent works from." };
              const threadRef = `${SUBAGENT_THREAD_PREFIX}${
                input.requestId
                  ? hashId([binding.session.id, binding.request.runId ?? "", input.requestId], 40)
                  : randomUUID()
              }`;
              const fingerprint = hashId([canonicalJson(input)], 40);
              const existing = await deps.sessions.getByThread(threadRef);
              if (existing?.spawnMeta?.openFingerprint && existing.spawnMeta.openFingerprint !== fingerprint)
                throw new Error("the requestId was already used for different work");
              const initialRun = await deps.runs.getByDedupKey(`subagent-open:${threadRef}`);
              if (existing && initialRun)
                return {
                  ok: true,
                  sessionId: existing.id,
                  title: visibleTitle(existing),
                  ...(existing.spawnMeta?.isolation ? { isolation: existing.spawnMeta.isolation } : {}),
                };
              const runtime =
                existing?.spawnMeta ??
                (await openRuntime(
                  input,
                  parentRuntime(binding.request, binding.switchedRuntime?.()),
                  async (choice) => {
                    await deps.validateRuntime?.({ ...input, ...choice }, binding.scopeId);
                  },
                  async () => deps.defaultModel?.(binding.scopeId),
                ));
              const child = await deps.sessions.getOrCreateByThread(
                threadRef,
                binding.session.type,
                binding.scopeId,
                binding.session.channelName,
                binding.session.surface ?? binding.request.surface,
              );
              const title = existing ? visibleTitle(existing) : input.name?.trim() || autoTitle(task);
              const readOnly = input.readOnly || binding.request.readOnly;
              const isolation = existing?.spawnMeta
                ? existing.spawnMeta.isolation
                : childIsolation({
                    requested: input.isolation,
                    parent: binding.session.spawnMeta?.isolation,
                    childId: child.id,
                    title,
                    readOnly,
                  });
              const meta: SpawnMeta = {
                ...sessionContextOf({
                  ...binding.request,
                  surface: binding.request.surface ?? binding.session.surface ?? "web",
                  origin: caller.origin,
                  readOnly,
                  model: runtime.model,
                  thinkingLevel: runtime.thinkingLevel,
                  fastMode: runtime.fastMode,
                  text: "",
                }),
                origin: caller.origin,
                openFingerprint: fingerprint,
                ...(binding.request.surfaceOrigin ? { surfaceOrigin: binding.request.surfaceOrigin } : {}),
                ...(isolation ? { isolation } : {}),
                ...(input.persistent ? { persistent: true } : {}),
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
              return { ok: true, sessionId: child.id, title, ...(isolation ? { isolation } : {}) };
            })
            .catch((error): SessionOpenResult => ({ ok: false, message: errMessage(error) }));
        },

        async write(input) {
          return lock
            .withLock("session-tree-admission", async (): Promise<SessionWriteResult> => {
              if (binding.request.swarm || binding.session.threadRef.startsWith("swarm:"))
                throw new Error("swarm workers coordinate through the swarm API");
              const caller = await currentCaller();
              assertAudienceCompatible(binding.request, caller);
              const target = await resolveTarget(input.target, !input.interrupt);
              if (typeof target === "string") return { ok: false, message: target };
              const refusal = input.peer ? peerRefusal(target) : null;
              if (refusal) return { ok: false, message: refusal };
              if (target.threadRef.startsWith("swarm:"))
                throw new Error("send messages to swarm workers through the swarm API");
              if (target.id === binding.session.id)
                return { ok: false, message: "a session cannot message itself — just continue your turn." };
              if (target.scopeId !== binding.scopeId)
                return {
                  ok: false,
                  message: "that session lives in a different context and cannot be reached from here.",
                };
              if (!(await deps.sessions.getForParticipant(target.id, binding.request.actor.id)))
                return { ok: false, message: "you are not a participant in that session." };
              if (target.spawnMeta?.retired && target.parentSessionId === binding.session.id)
                return {
                  ok: false,
                  message:
                    "that subagent finished and retired; open a fresh one with `open` (its result is already in your transcript).",
                };
              if (deps.authorize && !(await deps.authorize(target, caller)))
                return { ok: false, message: "you no longer have access to the target session" };
              if (deps.reaches && !(await deps.reaches(target, caller, binding.session)))
                return { ok: false, message: AMBIENT_REACH_REFUSAL };
              const meta = storedContext(target);
              if (!meta) return { ok: false, message: "the target has no verified runtime context yet" };
              const privateChild = isSubagentThreadRef(target.threadRef);
              const privateMessage = binding.request.privateSessionMessage === true || !privateChild;
              const messageDepth = (binding.request.sessionMessageDepth ?? 0) + 1;
              if (binding.request.privateSessionMessage && messageDepth > SESSION_MESSAGE_DEPTH_CAP)
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
                  readOnly: privateMessage || caller.readOnly || meta.readOnly || target.spawnMeta?.readOnly,
                  memoryNotebookOnly: caller.memoryNotebookOnly || meta.memoryNotebookOnly,
                  botActor: caller.botActor,
                },
                "",
                "",
              );
              const request = deps.prepareRequest ? await deps.prepareRequest(prepared) : prepared;
              assertAudienceCompatible(caller, request);
              const title = visibleTitle(target);
              if (input.interrupt) {
                if (privateMessage)
                  return { ok: false, message: "ordinary sessions accept private messages, not interrupts" };
                if (caller.readOnly && !target.spawnMeta?.readOnly)
                  return { ok: false, message: "a read-only session cannot interrupt a writable task" };
                if (caller.memoryNotebookOnly && !meta.memoryNotebookOnly)
                  return {
                    ok: false,
                    message: "a notebook-only turn cannot interrupt a session that isn't notebook-only",
                  };
                if (
                  caller.botActor &&
                  (await deps.runs.inFlightForThread(target.threadRef)).some((run) => !run.request.botActor)
                )
                  return { ok: false, message: "a Slack bot's turn cannot interrupt a person's task" };
              }
              const text = input.text?.trim();
              if (!text) {
                if (!input.interrupt)
                  return { ok: false, message: "send_message requires `text` (or interrupt: true)." };
                return (
                  await stopSessionRuns(
                    deps,
                    target,
                    { reason: PARENT_INTERRUPT, scope: "run" },
                    {
                      by: binding.session.id,
                      mailbox: deps.mailbox,
                    },
                  )
                ).length
                  ? { ok: true, sessionId: target.id, title, delivered: "interrupted" }
                  : { ok: false, message: `subagent "${title}" is not running — nothing to interrupt.` };
              }
              if (text.length > 16_000) return { ok: false, message: "message exceeds 16000 characters" };
              const stamped = renderSubagentMessage({ title: callerTitle, sessionId: binding.session.id }, text);
              const messageId = input.requestId
                ? hashId([binding.session.id, binding.request.runId ?? "", input.requestId], 40)
                : randomUUID();
              const sourceEntrySeq = await deps.sessions.latestItemSeq(binding.session.id);
              const mail = { id: messageId, text: stamped, ...(sourceEntrySeq >= 0 ? { sourceEntrySeq } : {}) };
              const inFlight = await deps.runs.inFlightForThread(target.threadRef);
              const busy = inFlight.length > 0;
              const leaveMail = async (notWoken?: string): Promise<SessionWriteResult> => {
                await deps.mailbox.send({
                  ...mail,
                  recipientId: target.id,
                  senderId: binding.session.id,
                  actor: caller.actor,
                  ...(caller.botActor ? { botActor: true } : {}),
                  audience: caller.conversation.audience,
                  createdAt: Date.now(),
                });
                const reason = notWoken ? { notWoken } : {};
                return { ok: true, sessionId: target.id, title, delivered: "queued_message", busy, ...reason };
              };
              if (!input.wake && !input.interrupt) return leaveMail();
              if (binding.request.privateSessionMessage)
                return leaveMail("a private turn cannot start work in another session");
              if (caller.memoryNotebookOnly && !meta.memoryNotebookOnly)
                return leaveMail("a notebook-only turn cannot start work in a session that isn't notebook-only");
              if (isPeerMessage(binding.session, target)) {
                if (caller.readOnly) return leaveMail("a read-only turn cannot start work in another conversation");
                if (messageDepth > SESSION_MESSAGE_DEPTH_CAP)
                  return leaveMail(
                    `${SESSION_MESSAGE_DEPTH_CAP} conversations already woke each other in a row, so this one stops the chain`,
                  );
                const woken = await wakePeer(
                  deps,
                  binding.session,
                  target,
                  { ...binding.request, peerDepth: messageDepth },
                  mail,
                ).catch((error: unknown) => ({ failed: errMessage(error) }));
                if (typeof woken === "object") return leaveMail(woken.failed);
                const delivered = woken === "woken" ? "queued_turn" : "queued_message";
                return { ok: true, sessionId: target.id, title, delivered, busy: woken === "busy" };
              }
              if (!target.parentSessionId || (target.id === binding.session.parentSessionId && !input.interrupt)) {
                if (caller.readOnly) return leaveMail("a read-only subagent cannot start a turn in its parent");
                const woken = await wakeOwnParent(deps, binding.session.id, target, binding.request, mail).catch(
                  (error: unknown) => ({ failed: errMessage(error) }),
                );
                if (typeof woken === "object") return leaveMail(woken.failed);
                if (!woken)
                  return leaveMail(
                    "a message can start a turn in a top-level conversation only when it is the sender's own parent",
                  );
                const delivered = woken === "woken" ? "queued_turn" : "queued_message";
                return { ok: true, sessionId: target.id, title, delivered, busy: woken === "busy" };
              }
              const dedupKey = input.requestId ? `subagent-followup:${messageId}` : undefined;
              const accepted = await acceptedFollowup(deps.runs, dedupKey, target, stamped, title);
              if (accepted) return accepted;
              request.origin = sessionTurnOrigin(request.origin, stamped);
              request.sessionSenderId = binding.session.id;
              request.delegatingRunId = binding.request.runId;
              const steered =
                input.interrupt || privateMessage
                  ? undefined
                  : await steerRunningTurn(
                      deps,
                      inFlight,
                      { ...request, text: stamped, displayText: text },
                      {
                        text,
                        dedupKey,
                      },
                    );
              if (steered === "steered")
                return { ok: true, sessionId: target.id, title, delivered: "steered", busy: true };
              if (steered === "replayed") return { ok: true, sessionId: target.id, title, delivered: "queued_turn" };
              if (steered === "refused")
                return { ok: false, message: `subagent "${title}" finished its turn and did not accept this message.` };
              const stopped = input.interrupt
                ? await stopSessionRuns(
                    deps,
                    target,
                    { reason: PARENT_INTERRUPT, scope: "run" },
                    {
                      by: binding.session.id,
                      mailbox: deps.mailbox,
                    },
                  )
                : [];
              await deps.runs
                .enqueue({
                  sessionId: target.threadRef,
                  dedupKey,
                  request: {
                    ...request,
                    ...(privateMessage
                      ? { privateSessionMessage: true as const, sessionMessageDepth: messageDepth }
                      : {}),
                    text: stamped,
                    displayText: text,
                  },
                  maxAttempts: deps.maxAttempts,
                })
                .catch((error: unknown) => {
                  if (!stopped.length) throw error;
                  const withdrawn = stopped.filter((run) => run.withdrawn).length;
                  const done = [
                    ...(stopped.length > withdrawn ? ["stopped its current run"] : []),
                    ...(withdrawn
                      ? [
                          `withdrew ${withdrawn === 1 ? "your queued message" : `your ${withdrawn} queued messages`} to it`,
                        ]
                      : []),
                  ].join(" and ");
                  throw new Error(`${done}, but this message was not queued: ${errMessage(error)}`);
                });
              if (stopped.length) return { ok: true, sessionId: target.id, title, delivered: "interrupted" };
              return { ok: true, sessionId: target.id, title, delivered: "queued_turn", busy };
            })
            .catch((error): SessionWriteResult => ({ ok: false, message: errMessage(error) }));
        },

        async read(input) {
          await currentCaller();
          if (!input.target?.trim()) {
            const summaries: SessionChildSummary[] = [];
            for (const { session: child, activity } of await subagentActivity(
              deps,
              await visibleChildren(deps, binding, await deps.sessions.childrenOf(binding.session.id)),
            )) {
              const said = lastAssistantText((await visibleHistory(child)).slice(-LAST_SAID_SCAN));
              summaries.push({
                sessionId: child.id,
                title: visibleTitle(child),
                activity,
                ...(said ? { lastSaid: snippet(said, 200) } : {}),
                ...(child.spawnMeta?.isolation ? { isolation: child.spawnMeta.isolation } : {}),
              });
            }
            return { ok: true, mode: "children", children: summaries };
          }
          const target = await resolveTarget(input.target);
          if (typeof target === "string") return { ok: false, message: target };
          const refusal = input.peer ? peerRefusal(target) : null;
          if (refusal) return { ok: false, message: refusal };
          if (target.scopeId !== binding.scopeId)
            return { ok: false, message: "that session lives in a different context and cannot be read from here." };
          const limit = Math.min(Math.max(1, input.limit ?? READ_DEFAULT_LIMIT), 200);
          const maxChars = Math.min(Math.max(200, input.maxChars ?? READ_DEFAULT_MAX_CHARS), READ_MAX_CHARS_CEILING);
          if (!(await deps.sessions.getForParticipant(target.id, binding.request.actor.id)))
            return { ok: false, message: "you are not a participant in that session." };
          if (deps.reaches && !(await deps.reaches(target, binding.request, binding.session)))
            return { ok: false, message: AMBIENT_REACH_REFUSAL };
          const items = await visibleHistory(target);
          const lines: string[] = [];
          for (const item of items.slice(-limit)) {
            const text = itemText(item);
            if (!text) continue;
            lines.push(`${item.kind}#${item.seq} ${snippet(text, 300)}`);
          }
          let rendered = lines.join("\n");
          if (rendered.length > maxChars) rendered = `…${rendered.slice(rendered.length - maxChars)}`;
          const activity = await sessionActivity(deps, target);
          return {
            ok: true,
            mode: "transcript",
            sessionId: target.id,
            title: visibleTitle(target),
            status: activity?.status ?? "idle",
            ...(activity && !input.peer ? { activity } : {}),
            rendered: rendered || "[no readable entries yet]",
          };
        },
        async liveSubagents() {
          return liveSubagentsNote(
            await openChildren(deps, binding, await deps.sessions.childrenOf(binding.session.id)),
            visibleTitle,
          );
        },
        async search(input) {
          const caller = await currentCaller();
          const refusal = sidebarRefusal();
          if (refusal) throw new Error(refusal);
          const search = deps.conversations?.search;
          if (!search) throw new Error("session search isn't available on this deployment.");
          const members = caller.conversation.publishMembers;
          if (caller.conversation.kind !== "dm" && !members?.length)
            throw new Error("search requires the complete principal set for a shared conversation");
          if (!input.query.trim()) throw new Error("search requires a query");
          return search({
            query: input.query,
            principals: [caller.actor, ...(members ?? caller.conversation.audience)],
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            botActor: caller.botActor,
          });
        },
        async list() {
          await currentCaller();
          const conversations = deps.conversations;
          if (!conversations) return { ok: false, message: "sessions aren't available on this deployment." };
          const refusal = sidebarRefusal();
          if (refusal) return { ok: false, message: refusal };
          const audience = binding.request.conversation.audience.length
            ? binding.request.conversation.audience
            : [binding.request.actor];
          const viewer = { actorId: binding.request.actor.id, botActor: binding.request.botActor };
          const candidates = (await conversations.list(viewer)).filter(
            (s) => s.scopeId === binding.scopeId && isSidebarSession(s) && !s.archived,
          );
          const visible: Session[] = [];
          for (const session of candidates) {
            const seen = await Promise.all(
              audience.map((person) => deps.sessions.getForParticipant(session.id, person.id)),
            );
            if (seen.every(Boolean)) visible.push(session);
          }
          const recent = visible
            .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
            .slice(0, SESSION_LIST_LIMIT);
          const active = await deps.runs.activeForThreads(recent.map((session) => session.threadRef));
          const sessions: SessionSummary[] = recent.map((session) => ({
            sessionId: session.id,
            title: session.title?.trim() || "Untitled",
            status: runState(active.get(session.threadRef)),
            current: session.id === binding.session.id,
          }));
          return { ok: true, sessions };
        },
        async start(input) {
          try {
            await currentCaller();
          } catch (error) {
            return { ok: false, message: errMessage(error) };
          }
          const conversations = deps.conversations;
          if (!conversations) return { ok: false, message: "sessions aren't available on this deployment." };
          const refusal = sidebarRefusal();
          if (refusal) return { ok: false, message: refusal };
          const verb = input.fork ? "fork" : "new";
          if (binding.liveTurn !== true)
            return {
              ok: false,
              message: `${verb} needs a person attending this turn — not a cron, trigger, subagent, or other automation.`,
            };
          if (binding.request.readOnly) return { ok: false, message: "a read-only turn cannot create sessions." };
          if (binding.request.botActor)
            return { ok: false, message: "a turn doing a Slack bot's work cannot create sessions." };
          const text = input.text?.trim();
          if (!input.fork && !text)
            return { ok: false, message: "new requires `text`: the new session's first message." };
          if (text && text.length > 16_000) return { ok: false, message: "text exceeds 16000 characters" };
          const out = await conversations
            .start(binding.request.actor.id, {
              scopeId: binding.scopeId,
              origin: binding.request.origin,
              sessionSenderId: binding.session.id,
              ...(binding.request.runId ? { delegatingRunId: binding.request.runId } : {}),
              ...(input.fork ? { forkOf: binding.session.id } : {}),
              ...(text ? { text } : {}),
              ...(input.title?.trim() ? { title: input.title.trim() } : {}),
            })
            .catch((error: unknown) => ({ error: errMessage(error) }));
          if ("error" in out) return { ok: false, message: out.error };
          return {
            ok: true,
            sessionId: out.session.id,
            title: out.session.title?.trim() || "Untitled",
            ...(out.refused ? { refused: out.refused } : {}),
          };
        },
      };
    },
  };
}
