import { desktopTurnId, serveDesktopRun } from "./desktop-computer.ts";
import { reportHandledError } from "./browser-errors.ts";
import { captureMessage } from "./product-analytics.ts";
import { streamedAnswer } from "./timeline.ts";
import { fetchServerSentEvents } from "@tanstack/ai-client";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { Attachment } from "@earendil-works/pi-web-ui";
import type { Agent, StreamFn } from "@earendil-works/pi-agent-core";
import { swallow } from "../../chassis/src/errors.ts";
import { userFacingFailureText } from "../../chassis/src/failure-copy.ts";
import { type Item, type WorkActivity, isHidden } from "./items.ts";
import {
  type ActiveRun,
  ApiError,
  type InboxItemEvent,
  type LiveReasoning,
  type QueuedRun,
  type RunPoll,
  type SessionStateEvent,
  type TurnOptions,
  type WorkBlock,
  api,
  browserTimezone,
  mintSendKey,
  sendKeyOf,
  withBase,
} from "./core-bridge.ts";
import { type CoreAttachment, type PiAttachment, uploadAttachments } from "./attachments.ts";
import {
  type AssistantWork,
  type HistoryUserMessage,
  baseAssistant,
  deliveredFilesFromAttachments,
  isUserRole,
  isWorkHistoryItem,
  latestUserMessage,
} from "./transcript-messages.ts";

const POLL_MS = 500;
const POLL_RETRY_MAX_MS = 5_000;
export const RUN_IDLE_MS = 6 * 60_000;
const STALE_GRACE_MS = 10 * 60_000;
const SSE_OPEN_TIMEOUT_MS = 4_000;
const SSE_SILENCE_MS = 30_000;
const RUN_REQUEST_TIMEOUT_MS = 15_000;

export function runIsTerminal(run: Pick<RunPoll, "status" | "result" | "replyComplete">): boolean {
  return run.status === "done" || run.status === "failed" || run.result != null || run.replyComplete === true;
}

interface SendTurn {
  text: string;
  attachments: CoreAttachment[];
  idempotencyKey?: string;
  issues: string[];
  droppedIds: string[];
  retryable: Attachment[];
}

function emptyTurn(): SendTurn {
  return { text: "", attachments: [], issues: [], droppedIds: [], retryable: [] };
}

async function latestUserTurn(agent: Agent): Promise<SendTurn> {
  const m = latestUserMessage(agent);
  if (!m) return emptyTurn();
  const text =
    typeof m.content === "string"
      ? m.content
      : m.content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
  const { uploaded, skipped } = await uploadAttachments(m.attachments ?? []);
  const transientIds = new Set(skipped.filter((s) => !s.permanent).flatMap((s) => (s.id ? [s.id] : [])));
  const retryable = (m.attachments ?? []).filter(
    (a): a is PiAttachment & Attachment => a.id !== undefined && transientIds.has(a.id),
  );
  if (skipped.length && m.attachments) {
    const skippedIds = new Set(skipped.map((s) => s.id).filter(Boolean));
    m.attachments = m.attachments.filter((a) => !a.id || !skippedIds.has(a.id));
  }
  m.idempotencyKey = sendKeyOf(m) ?? mintSendKey();
  return {
    text,
    attachments: uploaded,
    idempotencyKey: m.idempotencyKey,
    issues: skipped.map((s) => s.note),
    droppedIds: skipped.filter((s) => s.permanent).flatMap((s) => (s.id ? [s.id] : [])),
    retryable,
  };
}

export type WorkObserver = (work: WorkBlock) => void;
export type SendIssueObserver = (issues: string[], retryable: Attachment[]) => void;

export interface RunSlot {
  runId: string | null;
  generation: number;
  stopGeneration: number | null;
  onStopError?: (message: string) => void;
}

export function createRunSlot(onStopError?: (message: string) => void): RunSlot {
  return { runId: null, generation: 0, stopGeneration: null, onStopError };
}

export function requestStop(slot: RunSlot): void {
  slot.stopGeneration = slot.generation;
}

export function hasLiveRun(slot: RunSlot): boolean {
  return slot.runId !== null;
}

export type SignalOutcome = { ok: true } | { ok: false; reason: string; replayed?: boolean };

export interface SteerContext {
  threadRef: string | null;
  scopeId?: string | null;
  channelName?: string | null;
}

export async function signalLiveRun(
  slot: RunSlot,
  kind: "abort" | "steer",
  text: string | undefined,
  context: SteerContext,
  queuedRunId?: string,
): Promise<SignalOutcome> {
  const runId = slot.runId;
  if (runId === null) throw new Error("No active run to signal.");
  const steerContext =
    kind === "steer" && context.threadRef
      ? {
          threadRef: context.threadRef,
          ...(context.scopeId ? { scopeId: context.scopeId } : {}),
          ...(context.channelName ? { channelName: context.channelName } : {}),
        }
      : {};
  try {
    await api(runPath(runId, "/signal"), {
      method: "POST",
      signal: kind === "abort" ? AbortSignal.timeout(RUN_REQUEST_TIMEOUT_MS) : undefined,
      body: JSON.stringify({
        kind,
        ...(text !== undefined ? { text } : {}),
        ...steerContext,
        ...(queuedRunId ? { queuedRunId } : {}),
      }),
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
      const body = (err.body ?? {}) as { reason?: string; replayed?: boolean };
      return {
        ok: false,
        reason: body.reason ?? (err.status === 404 ? "not_found" : "terminal"),
        ...(body.replayed ? { replayed: true } : {}),
      };
    }
    throw err;
  }
}

export interface Live {
  stream: AssistantMessageEventStream;
  partial: AssistantMessage;
  st: Acc;
  signal?: AbortSignal;
  notify?: () => void;
}

interface Drive extends Live {
  notify: () => void;
  settle: (status: "complete" | "failed") => void;
  gen: number;
}

function driveStreamFn(
  slot: RunSlot | undefined,
  onWork: WorkObserver | undefined,
  run: (drive: Drive) => Promise<void>,
  prepare?: (partial: AssistantMessage) => void,
): StreamFn {
  const fn = (
    model: Model<Api>,
    _context: Context,
    options?: { signal?: AbortSignal },
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const gen = slot ? ++slot.generation : 0;
    const partial = baseAssistant(model);
    prepare?.(partial);
    const work: WorkBlock = { status: "thinking", activity: [] };
    (partial as AssistantWork).work = work;
    const notify = (): void => onWork?.(work);
    const settle = (status: "complete" | "failed"): void => {
      work.status = status;
      work.finishedAt = Date.now();
      notify();
    };
    const d: Drive = { stream, partial, st: freshAcc(), notify, settle, signal: options?.signal, gen };
    void (async () => {
      try {
        notify();
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        await run(d);
      } catch (e) {
        settle("failed");
        fail(d, e instanceof Error ? e.message : String(e));
      } finally {
        if (slot?.stopGeneration === gen) slot.stopGeneration = null;
      }
    })();
    return stream;
  };
  return fn as unknown as StreamFn;
}

export function makeCoreStreamFn(
  threadRef: string,
  agent: Agent,
  getTurnOptions?: () => TurnOptions,
  onWork?: WorkObserver,
  slot?: RunSlot,
  onSendIssues?: SendIssueObserver,
): StreamFn {
  return driveStreamFn(slot, onWork, (d) => drive(d, threadRef, agent, getTurnOptions, false, slot, onSendIssues));
}

export async function activeRunForThread(threadRef: string): Promise<ActiveRun> {
  const r = await api<{ runId?: string | null; run?: RunPoll | null; queued?: QueuedRun[] }>(
    `/api/runs/active?${new URLSearchParams({ threadRef }).toString()}`,
  );
  const live = r.runId && r.run ? { runId: r.runId, run: r.run } : { runId: null, run: null };
  return { ...live, queued: r.queued ?? [] };
}

export const PENDING_APPROVAL_REASON = "Approve or deny the pending command to continue.";

export async function queueTurn(
  threadRef: string,
  text: string,
  agent: Agent,
  getTurnOptions?: () => TurnOptions,
  idempotencyKey?: string,
  attachments: CoreAttachment[] = [],
): Promise<QueuedRun> {
  const submit = await submitTurn(threadRef, text, agent.state.model.id, getTurnOptions, {
    idempotencyKey,
    attachments,
  });
  if (submit.status === "pending_approval") throw new Error(submit.reason ?? PENDING_APPROVAL_REASON);
  if (!submit.runId) throw new Error("Could not queue the message.");
  return { runId: submit.runId, text, ...(attachments.length ? { hasAttachments: true } : {}) };
}

export async function editQueuedRun(runId: string, text: string, expectedText: string): Promise<void> {
  await api(runPath(runId, "/input"), { method: "PATCH", body: JSON.stringify({ text, expectedText }) });
}

export async function withdrawRun(runId: string): Promise<boolean> {
  const r = await api<{ withdrawn?: boolean }>(runPath(runId, "/withdraw"), { method: "POST" });
  return r.withdrawn === true;
}

export function makeRunResumeStreamFn(
  runId: string,
  initialRun?: RunPoll,
  onWork?: WorkObserver,
  slot?: RunSlot,
  seedText?: string,
): StreamFn {
  const snapshotText = initialRun?.partial ?? "";
  return driveStreamFn(
    slot,
    onWork,
    async (d) => {
      if (seedText?.trim()) pushDelta(d, seedText);
      if (initialRun && applyRun(d, initialRun) === "terminal") return;
      await followRun(d, runId, slot);
    },
    (partial) => {
      (partial as AssistantWork).streamingBaseline =
        snapshotText.length > (seedText?.length ?? 0) ? snapshotText : (seedText ?? "");
    },
  );
}

export function makeOpenerStreamFn(
  threadRef: string,
  agent: Agent,
  getTurnOptions: (() => TurnOptions) | undefined,
  onWork: WorkObserver | undefined,
  slot?: RunSlot,
): StreamFn {
  return driveStreamFn(slot, onWork, (d) => drive(d, threadRef, agent, getTurnOptions, true, slot));
}

async function submitTurn(
  threadRef: string,
  text: string,
  modelId: string,
  getTurnOptions: (() => TurnOptions) | undefined,
  send: { idempotencyKey?: string; attachments?: CoreAttachment[]; opener?: boolean },
) {
  const { idempotencyKey, attachments = [], opener } = send;
  const turnOptions = getTurnOptions?.() ?? {};
  const thinkingLevel = turnOptions.effortLevel;
  const timezone = browserTimezone();
  const body = {
    desktopClientId: desktopTurnId(),
    text,
    threadRef,
    ...(thinkingLevel ? { model: modelId, thinkingLevel } : {}),
    ...(typeof turnOptions.fastMode === "boolean" ? { fastMode: turnOptions.fastMode } : {}),
    ...(timezone ? { timezone } : {}),
    ...(turnOptions.scopeId ? { scopeId: turnOptions.scopeId } : {}),
    ...(turnOptions.channelName ? { channelName: turnOptions.channelName } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(opener ? { proactiveOpener: true, desktopClientId: undefined } : {}),
  };
  const submit = await api<{ status?: string; runId?: string; reply?: string; reason?: string }>("/api/turn", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (body.desktopClientId && submit.runId)
    void serveDesktopRun(submit.runId, body.desktopClientId, withBase, api).catch((error) =>
      reportHandledError("desktop-computer", error),
    );
  return submit;
}

async function drive(
  d: Drive,
  threadRef: string,
  agent: Agent,
  getTurnOptions?: () => TurnOptions,
  opener?: boolean,
  slot?: RunSlot,
  onSendIssues?: SendIssueObserver,
): Promise<void> {
  const { partial, settle } = d;
  try {
    const { text, attachments, idempotencyKey, issues, droppedIds, retryable } = opener
      ? emptyTurn()
      : await latestUserTurn(agent);
    if (!opener && !text.trim() && attachments.length === 0) {
      settle("failed");
      if (issues.length) {
        (partial as AssistantWork).sendFailed = "attachments";
        (partial as AssistantWork).droppedAttachmentIds = droppedIds;
      }
      fail(d, issues.join(" ") || "Nothing to send.");
      return;
    }
    if (issues.length) onSendIssues?.(issues, retryable);

    const submit = await submitTurn(threadRef, text, partial.model, getTurnOptions, {
      idempotencyKey,
      attachments,
      opener,
    });

    if (submit.runId) {
      if (!opener) {
        const userMessages = agent.state.messages.filter(
          (message) => isUserRole(message) && !(message as { opener?: boolean }).opener,
        );
        captureMessage(submit.runId, userMessages.length === 1);
      }
      const message = agent.state.messages.find((message) => idempotencyKey && sendKeyOf(message) === idempotencyKey);
      if (message) (message as unknown as HistoryUserMessage).runId = submit.runId;
      d.st.lastProgressAt = Date.now();
      await followRun(d, submit.runId, slot);
      return;
    }

    if (submit.status === "pending_approval") {
      settle("failed");
      (partial as AssistantWork).sendBlocked = "pending_approval";
      fail(d, submit.reason ?? PENDING_APPROVAL_REASON);
      return;
    }

    settle("complete");
    finish(d, submit.reply ?? "");
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    reportHandledError("web:send_failed", e);
    settle("failed");
    const errorMessage = "Message wasn’t sent. Check your connection and try again.";
    const message = latestUserMessage(agent);
    if (message) message.sendFailure = errorMessage;
    fail(d, errorMessage, true);
  }
}

async function followRun(d: Drive, runId: string, slot?: RunSlot): Promise<void> {
  const { signal, notify, gen } = d;
  try {
    if (slot && slot.stopGeneration === gen) {
      slot.runId = runId;
      void signalLiveRun(slot, "abort", undefined, { threadRef: null }).catch(() => {
        if (slot.generation !== gen || slot.stopGeneration !== gen) return;
        slot.stopGeneration = null;
        slot.onStopError?.("Could not request stop. Try again.");
        notify();
      });
    }
    if (signal?.aborted) return abortStream(d);
    if (slot) slot.runId = runId;
    if ((await streamRunViaSse(d, runId)) === "done") return;
    if (signal?.aborted) return abortStream(d);
    return await pollRun(d, runId);
  } finally {
    if (slot?.runId === runId) slot.runId = null;
  }
}

function runPath(runId: string, suffix: string): string {
  return `/api/runs/${encodeURIComponent(runId)}${suffix}`;
}

export interface Acc {
  startOffset: number;
  acc: string;
  lastProgressAt: number;
  staleSince?: number;
}

function freshAcc(): Acc {
  return { acc: "", startOffset: 0, lastProgressAt: Date.now() };
}

function isWorkItem(item: Item): boolean {
  if (item.kind === "SteeringMessage") return !isHidden(item);
  return item.kind === "ElicitationResponse" || isWorkHistoryItem(item);
}

function parseActivity(raw: RunPoll["activity"]): WorkActivity[] {
  return (Array.isArray(raw) ? raw : []).filter((entry): entry is WorkActivity =>
    "item" in entry ? isWorkItem(entry.item) : entry.marker === "text_start",
  );
}

function mergeReasoning(work: WorkBlock | undefined, block: LiveReasoning, offset = 0): boolean {
  if (!work || typeof block.step !== "string" || !Number.isSafeInteger(block.index) || typeof block.text !== "string")
    return false;
  const blocks = work.reasoning ?? [];
  const at = blocks.findIndex((b) => b.step === block.step && b.index === block.index);
  const current = at >= 0 ? blocks[at]!.text : "";
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > current.length) return false;
  const text = current.slice(0, offset) + block.text;
  if (text.length <= current.length) return false;
  const next = { step: block.step, index: block.index, text };
  work.reasoning =
    at >= 0 ? blocks.map((b, i) => (i === at ? next : b)) : [...blocks.filter((b) => b.step === block.step), next];
  return true;
}

function mergeWork(work: WorkBlock | undefined, run: Pick<RunPoll, "activity" | "startedAt">): boolean {
  if (!work) return false;
  const { startedAt, activity, status } = work;
  if (typeof run.startedAt === "number") work.startedAt ??= run.startedAt;
  const next = parseActivity(run.activity);
  if (next.length > activity.length) work.activity = next;
  if (status === "thinking" && (work.activity.length > 0 || work.startedAt != null)) work.status = "working";
  return work.startedAt !== startedAt || work.activity !== activity || work.status !== status;
}

function applyRun(live: Live, run: RunPoll): "open" | "terminal" {
  const { partial, st, notify } = live;
  const work = (partial as AssistantWork).work;
  const beforeActivity = work?.activity.length ?? 0;
  if (mergeWork(work, run)) {
    if ((work?.activity.length ?? 0) > beforeActivity) st.lastProgressAt = Date.now();
    notify?.();
  }
  if (work && typeof run.attempt === "number" && work.attempt !== run.attempt) {
    if (work.attempt !== undefined && work.reasoning?.length) work.reasoning = [];
    work.attempt = run.attempt;
  }
  if (Array.isArray(run.reasoning) && run.reasoning.map((block) => mergeReasoning(work, block)).some(Boolean))
    notify?.();
  if (work && (work.stale ?? false) !== (run.stale === true)) {
    work.stale = run.stale === true;
    notify?.();
  }
  for (const key of ["goal", "runtime"] as const) {
    if (!work || !run[key] || JSON.stringify(run[key]) === JSON.stringify(work[key])) continue;
    Object.assign(work, { [key]: run[key] });
    notify?.();
  }
  const p = typeof run.partial === "string" ? run.partial : "";
  const startOffset = run.partialStartOffset ?? 0;
  if (p && startOffset + p.length >= st.startOffset + st.acc.length) {
    if (startOffset + p.length > st.startOffset + st.acc.length) st.lastProgressAt = Date.now();
    if (startOffset !== st.startOffset) (partial as AssistantWork).streamingBaseline = "";
    st.startOffset = startOffset;
    if (work) work.streamStartOffset = startOffset;
    pushDelta(live, p);
  }
  if (!runIsTerminal(run)) return "open";
  const res = run.result;
  const delivered = deliveredFilesFromAttachments(res?.attachments);
  if (delivered.length) {
    (partial as AssistantWork).deliveredFiles = delivered;
    notify?.();
  }
  const approvals = res?.pendingApprovals ?? [];
  const paused = approvals.length > 0;
  const quiet = res?.status === "silent" || res?.status === "react";
  const failed = !paused && !quiet && (run.status === "failed" || (res != null && res.status !== "ok"));
  if (work) {
    work.finishedAt = typeof run.finishedAt === "number" ? run.finishedAt : Date.now();
    work.status = failed ? "failed" : "complete";
    if (paused) work.pendingApprovals = approvals;
    notify?.();
  }
  if (res?.stopped) {
    abortStream(live, res.reply);
    return "terminal";
  }
  if (res?.reply) {
    finish(live, res.reply);
    return "terminal";
  }
  if (failed) {
    fail(live, userFacingFailureText(res ?? { status: "failed" }));
    return "terminal";
  }
  finish(live, st.acc);
  return "terminal";
}

export async function pollRun(live: Live, runId: string): Promise<void> {
  const { st, signal } = live;
  const failIdle = (): void => {
    (live.partial as AssistantWork).interruptedRunId = runId;
    fail(live, "Timed out waiting for the agent to respond.");
  };
  let consecutiveFailures = 0;
  for (;;) {
    if (signal?.aborted) return abortStream(live);
    let run: RunPoll;
    try {
      const timeout = AbortSignal.timeout(RUN_REQUEST_TIMEOUT_MS);
      run = await api<RunPoll>(runPath(runId, ""), {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      consecutiveFailures = 0;
    } catch (e) {
      if (signal?.aborted) return abortStream(live);
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) return fail(live, e.message);
      consecutiveFailures++;
      if (Date.now() - st.lastProgressAt > RUN_IDLE_MS) return failIdle();
      await sleep(Math.min(POLL_MS * 2 ** Math.min(consecutiveFailures, 4), POLL_RETRY_MAX_MS));
      continue;
    }
    if (applyRun(live, run) === "terminal") return;
    if (run.stale === true) st.staleSince ??= Date.now();
    else st.staleSince = undefined;
    if (run.alive === true || (st.staleSince !== undefined && Date.now() - st.staleSince < STALE_GRACE_MS))
      st.lastProgressAt = Date.now();
    if (Date.now() - st.lastProgressAt > RUN_IDLE_MS) return failIdle();
    await sleep(POLL_MS);
  }
}

export function subscribeDeliveries(
  onSessionState?: (event: SessionStateEvent) => void,
  onResync?: () => void,
  onInboxItem?: (event: InboxItemEvent) => void,
  onInboxResync?: () => void,
): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const es = new EventSource(withBase("/api/session-events"));
  let everOpened = false;
  es.onopen = (): void => {
    if (everOpened) {
      onResync?.();
      onInboxResync?.();
    }
    everOpened = true;
  };
  es.addEventListener("session_state_resync", () => onResync?.());
  es.addEventListener("inbox_resync", () => onInboxResync?.());
  const frames = <T>(name: string, label: string, handle: (event: T) => void): void =>
    es.addEventListener(name, (e: MessageEvent) => {
      try {
        handle(JSON.parse(e.data) as T);
      } catch (err) {
        swallow(`web-ui: handle ${label} frame`, err);
      }
    });
  frames<SessionStateEvent>("session_state", "session-state", (ev) => {
    if (typeof ev.threadRef === "string" && ev.threadRef && typeof ev.state === "string") onSessionState?.(ev);
  });
  frames<InboxItemEvent>("inbox_item", "inbox-item", (ev) => {
    if (typeof ev.cronId === "string" && typeof ev.itemId === "string") onInboxItem?.(ev);
  });
  return () => es.close();
}

async function streamRunViaSse(live: Live, runId: string): Promise<"done" | "fallback"> {
  const { st, signal } = live;
  if (typeof window === "undefined") return "fallback";
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timer = setTimeout(abort, SSE_OPEN_TIMEOUT_MS);
  const received = (): void => {
    clearTimeout(timer);
    timer = setTimeout(abort, SSE_SILENCE_MS);
  };
  const transport = fetchServerSentEvents(withBase(runPath(runId, "/events")), {
    credentials: "same-origin",
  });
  try {
    for await (const event of transport.joinRun(runId, controller.signal)) {
      received();
      if (event.type !== "CUSTOM") continue;
      if (event.name === "delta") {
        const {
          offset,
          delta,
          startOffset = 0,
        } = event.value as { offset: number; delta: unknown; startOffset?: number };
        if (!Number.isSafeInteger(offset) || offset < 0 || typeof delta !== "string") return "fallback";
        if (offset > Math.max(st.startOffset + st.acc.length, startOffset)) return "fallback";
        applyStreamText(live, delta, offset, startOffset);
      } else if (event.name === "reasoning") {
        const value = event.value as { step: string; index: number; offset: number; delta: string };
        const work = (live.partial as AssistantWork).work;
        if (mergeReasoning(work, { step: value.step, index: value.index, text: value.delta }, value.offset)) {
          st.lastProgressAt = Date.now();
          live.notify?.();
        }
      } else if (event.name === "run") {
        const run = event.value as RunPoll;
        const terminal = run.status === "done" || run.status === "failed" || run.result != null;
        if (applyRun(live, { ...run, replyComplete: terminal }) === "terminal") return "done";
        if (run.alive) st.lastProgressAt = Date.now();
      }
    }
    return "fallback";
  } catch (error) {
    if (!controller.signal.aborted) reportHandledError("web:run_stream", error);
    return "fallback";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

function endWithError(
  { stream, partial }: Live,
  reason: "error" | "aborted",
  errorMessage: string,
  reply?: string,
  extra: { retryableSend?: true } = {},
): void {
  const block = partial.content[0];
  const soFar = block?.type === "text" ? block.text : "";
  const work = (partial as AssistantWork).work;
  const text = reply ?? (work ? streamedAnswer(soFar, work) : soFar);
  const error: AssistantMessage = {
    ...partial,
    content: [{ type: "text", text }],
    stopReason: reason,
    errorMessage,
    ...extra,
  };
  stream.push({ type: "error", reason, error });
  stream.end(error);
}

function fail(live: Live, message: string, retryable = false): void {
  endWithError(live, "error", message, undefined, retryable ? { retryableSend: true } : {});
}

function abortStream(live: Live, reply?: string): void {
  const work = (live.partial as AssistantWork).work;
  if (work && work.status !== "complete") {
    work.status = "failed";
    work.finishedAt = Date.now();
  }
  endWithError(live, "aborted", "aborted", reply);
}

function applyStreamText(live: Live, text: string, offset: number, startOffset: number): void {
  const { partial, st } = live;
  const end = st.startOffset + st.acc.length;
  if (offset + text.length < end || (offset + text.length === end && startOffset <= st.startOffset)) return;
  const start = Math.max(st.startOffset ?? 0, startOffset);
  const next = offset > end ? text : st.acc + text.slice(Math.max(0, end - offset));
  const nextStart = offset > end ? offset : st.startOffset;
  const work = (partial as AssistantWork).work;
  if (work) work.streamStartOffset = start;
  if (start !== st.startOffset) (partial as AssistantWork).streamingBaseline = "";
  st.acc = offset > end ? "" : st.acc.slice(start - st.startOffset);
  st.lastProgressAt = Date.now();
  pushDelta(live, next.slice(start - nextStart));
  st.startOffset = start;
}

function pushDelta({ stream, partial, st }: Live, next: string): void {
  const delta = next.slice(st.acc.length);
  const block = partial.content[0];
  if (block?.type === "text") block.text = next;
  st.acc = next;
  stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
}

function finish(live: Live, reply: string): void {
  const { stream, partial } = live;
  if (reply.length > live.st.acc.length) pushDelta(live, reply);
  const block = partial.content[0];
  if (block?.type === "text") block.text = reply;
  stream.push({ type: "text_end", contentIndex: 0, content: reply, partial });
  const message: AssistantMessage = { ...partial, content: [{ type: "text", text: reply }], stopReason: "stop" };
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
