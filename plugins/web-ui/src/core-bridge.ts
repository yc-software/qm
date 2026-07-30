import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { Agent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { swallow } from "../../chassis/src/errors.ts";
import { groupDmText } from "./group-dm-label.ts";
import { base64ToBytes } from "./paste-text.ts";
import { defaultEffortForModel, harnessSupportsEffort } from "./model-options.ts";

const BASE_URL = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/").replace(/\/$/, "");

export function withBase(path: string): string {
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

const POLL_MS = 500;
const POLL_RETRY_MAX_MS = 5_000;
export const RUN_IDLE_MS = 6 * 60_000;
const STALE_GRACE_MS = 10 * 60_000;
const SSE_OPEN_TIMEOUT_MS = 4_000;

let now: () => number = () => Date.now();
export function setClock(fn: () => number): void {
  now = fn;
}

interface PiAttachment {
  type: "image" | "document";
  fileName: string;
  mimeType: string;
  size: number;
  content: string;
  extractedText?: string;
}
interface CoreAttachment {
  name: string;
  mimetype: string;
  sizeBytes: number;
  blobId: string;
}

export interface DeliveredFile {
  name: string;
  mimetype?: string;
  sizeBytes?: number;
  artifactId?: string;
}

export interface CoreSession {
  id: string;
  type: "dm" | "channel" | "group";
  scopeId: string;
  threadRef: string;
  createdAt: number;
  title?: string | null;
  channelName?: string | null;
  archived?: boolean;
  pinned?: boolean;
  color?: string | null;
  lastActivityAt?: number;
  working?: boolean;
  awaitingInput?: boolean;
  backgroundJobs?: number;
  watches?: number;
}

export interface SessionBackgroundView {
  jobs: Array<{ processId: string; command: string; startedAt: number; expiresAt: number }>;
  watches: Array<{
    id: string;
    processId: string;
    command: string;
    pattern?: string;
    instructions?: string;
    createdAt: number;
    expiresAt: number;
    lastFiredAt?: number;
  }>;
}

export interface SessionBackgroundOutput {
  chunk: string;
  cursor: number;
  state: "running" | "exited";
  exitCode?: number;
}

export interface CoreContext {
  scopeId: string;
  kind: "personal" | "channel" | "group";
  name: string | null;
  isPrivate?: boolean;
  sessionCount: number;
  lastActivityAt: number | null;
  project?: CoreProject;
}

export interface CoreProject {
  id: string;
  name: string;
  ownerId: string;
  memberIds: string[];
  scopeId: string;
  members: Array<{ principalId: string; displayName: string }>;
  createdAt?: number;
  updatedAt?: number;
}

export function slackThreadUrl(workspaceUrl: string | null, threadRef: string): string | null {
  if (!workspaceUrl) return null;
  const m = threadRef.match(/^(?:dm|ch):([A-Z0-9]+)(?::(\d+)\.(\d+))?$/i);
  if (!m) return null;
  return `${workspaceUrl}/archives/${m[1]}${m[2] ? `/p${m[2]}${m[3]}` : ""}`;
}

export function sharedContextLabel(scopeId: string | null, name: string | null): string | null {
  if (!scopeId) return null;
  if (scopeId.startsWith("channel:")) return name ? `#${name.replace(/^#/, "")}` : "Shared channel";
  if (scopeId.startsWith("group:")) return groupDmText(name) ?? name ?? "Group";
  return null;
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

export async function updateSession(
  id: string,
  patch: { title?: string | null; archived?: boolean; pinned?: boolean; color?: string | null },
): Promise<{ session: CoreSession }> {
  return api<{ session: CoreSession }>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export async function forkSession(
  id: string,
  upToSeq?: number,
): Promise<{ session: CoreSession; entries: SessionEntry[] }> {
  return api<{ session: CoreSession; entries: SessionEntry[] }>(`/api/sessions/${encodeURIComponent(id)}/fork`, {
    method: "POST",
    body: JSON.stringify(upToSeq !== undefined ? { upToSeq } : {}),
  });
}

export function forkCutSeq(entries: SessionEntry[], userOrdinal: number, isUserMessage: boolean): number | undefined {
  const seqs = forkableUserSeqs(entries);
  if (isUserMessage) return seqs[userOrdinal - 1];
  const nextUser = seqs[userOrdinal];
  return nextUser !== undefined ? nextUser - 1 : undefined;
}

function forkableUserSeqs(entries: SessionEntry[]): number[] {
  const seqs: number[] = [];
  for (const e of entries) {
    if (e.type !== "user" || e.seq === undefined) continue;
    const p = e.payload as { text?: string; attachments?: unknown[]; hidden?: boolean } | null;
    if (p?.hidden) continue;
    if ((p?.text ?? "") || (p?.attachments?.length ?? 0)) seqs.push(e.seq);
  }
  return seqs;
}

export function userMessagesBefore(entries: SessionEntry[], anchorSeq: number): number {
  return forkableUserSeqs(entries).filter((seq) => seq < anchorSeq).length;
}

export const TAIL_TURNS = 25;

export interface TranscriptPage {
  session?: CoreSession;
  entries: SessionEntry[];
  earlierEntries?: number;
}

export async function fetchTranscript(
  id: string,
  window?: { tailTurns?: number; sinceSeq?: number; beforeSeq?: number },
): Promise<TranscriptPage> {
  const qs = new URLSearchParams();
  if (window?.tailTurns !== undefined) qs.set("tailTurns", String(window.tailTurns));
  if (window?.sinceSeq !== undefined) qs.set("sinceSeq", String(window.sinceSeq));
  if (window?.beforeSeq !== undefined) qs.set("beforeSeq", String(window.beforeSeq));
  const suffix = qs.size ? `?${qs.toString()}` : "";
  return api<TranscriptPage>(`/api/sessions/${encodeURIComponent(id)}${suffix}`);
}

export async function regenerateTitle(id: string): Promise<{ title: string | null }> {
  return api<{ title: string | null }>(`/api/sessions/${encodeURIComponent(id)}/title`, { method: "POST" });
}
export interface SessionEntry {
  type:
    | "user"
    | "assistant"
    | "thinking"
    | "text"
    | "tool_call"
    | "tool_result"
    | "soul"
    | "system"
    | "approval_request"
    | "approval_resolved"
    | "delivery";
  payload: unknown;
  createdAt: number;
  seq?: number;
  parentSeq?: number | null;
}

export interface ToolActivity {
  seq: number;
  parentSeq: number | null;
  type: "tool_call" | "tool_result" | "approval_request" | "approval_resolved" | "thinking" | "text";
  payload: unknown;
  createdAt: number;
}
type WorkStatus = "thinking" | "working" | "complete" | "failed";
export interface WorkBlock {
  status: WorkStatus;
  startedAt?: number;
  finishedAt?: number;
  stale?: boolean;
  activity: ToolActivity[];
  pendingApprovals?: PendingApproval[];
}

export interface PendingApproval {
  requestId: string;
  command: string;
  reason?: string;
  purpose?: string;
  summary?: string;
  matched?: string;
  grantModes?: { session: boolean; always: boolean };
  blocksInput?: boolean;
}

export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  scope?: "once" | "session" | "always";
}
export type AssistantWork = AssistantMessage & { work?: WorkBlock; deliveredFiles?: DeliveredFile[] };

export interface RunPoll {
  status: "pending" | "running" | "done" | "failed";
  result: {
    status: string;
    reply?: string;
    reason?: string;
    stopped?: boolean;
    pendingApprovals?: PendingApproval[];
    attachments?: Array<{ name: string; mimetype?: string; sizeBytes?: number; artifactId?: string }>;
  } | null;
  partial?: string;
  alive?: boolean;
  stale?: boolean;
  replyComplete?: boolean;
  activity?: unknown[];
  startedAt?: number | null;
  finishedAt?: number | null;
}
export interface TurnOptions {
  effortLevel?: string;
  fastMode?: boolean;
  harness?: string;
  scopeId?: string | null;
  channelName?: string | null;
}

export interface ActiveRun {
  runId: string;
  run: RunPoll;
}

export function isContinuable(s: Pick<CoreSession, "threadRef" | "scopeId">, user: string): boolean {
  if (!s.threadRef.startsWith("web:")) return false;
  return s.threadRef.startsWith(`web:${user}:`) || s.scopeId.startsWith("channel:") || s.scopeId.startsWith("group:");
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function baseAssistant(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function latestUserTurn(agent: Agent): Promise<{ text: string; attachments: CoreAttachment[] }> {
  const messages = agent.state.messages as Array<AgentMessage & { attachments?: PiAttachment[] }>;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user" && m?.role !== "user-with-attachments") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("\n");
    const attachments = await Promise.all(
      (m.attachments ?? []).filter((a) => typeof a.content === "string" && a.content.length > 0).map(toCoreAttachment),
    );
    return { text, attachments };
  }
  return { text: "", attachments: [] };
}

function attachmentBytes(a: PiAttachment): Uint8Array {
  return base64ToBytes(a.content);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function toCoreAttachment(a: PiAttachment): Promise<CoreAttachment> {
  const bytes = attachmentBytes(a);
  const sha256 = toHex(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
  const r = await fetch(withBase(`/api/blobs?sha=${sha256}`), {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes as unknown as BodyInit,
  });
  if (!r.ok) {
    if (r.status === 401) reportSigninRequired(await r.json().catch(() => ({})));
    throw new ApiError(`attachment upload failed: HTTP ${r.status}`, r.status);
  }
  const { blobId, sizeBytes } = (await r.json()) as { blobId: string; sizeBytes: number };
  return { name: a.fileName, mimetype: a.mimeType, sizeBytes: sizeBytes ?? a.size, blobId };
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface SigninRequired {
  mode?: "portal" | "dev";
  reason?: "unauthenticated" | "not_allowed";
}

let onSigninRequired: ((detail: SigninRequired) => void) | null = null;

export function setSigninRequiredHandler(fn: (detail: SigninRequired) => void): void {
  onSigninRequired = fn;
}

export function reportSigninRequired(detail: SigninRequired): void {
  onSigninRequired?.(detail);
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(withBase(path), { headers: { "content-type": "application/json" }, ...init });
  const text = await r.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    swallow("web-ui: parse api response body", e);
  }
  if (!r.ok) {
    if (r.status === 401 && path !== "/signin") reportSigninRequired(body as SigninRequired);
    const msg =
      (body as { error?: string; message?: string })?.message ??
      (body as { error?: string })?.error ??
      `HTTP ${r.status}`;
    throw new ApiError(msg, r.status);
  }
  return body as T;
}

export interface RuntimeConfig {
  scopeId: string;
  approvedHarnesses: string[];
  modelsByHarness: Record<string, string[]>;
  modelCatalog: Record<string, { name: string; provider: string }>;
  orgDefault: { harnessId: string; modelId: string; revision: number };
  scopeOverride: { harnessId: string; modelId: string; orgRevision: number } | null;
  effective: { harnessId: string; modelId: string };
  upgradeAvailable: boolean;
  fastModeModelIds?: string[];
}

export async function fetchRuntimeConfig(scopeId?: string | null): Promise<RuntimeConfig | null> {
  try {
    const query = scopeId ? `?scopeId=${encodeURIComponent(scopeId)}` : "";
    return await api<RuntimeConfig>(`/api/runtime-config${query}`);
  } catch (e) {
    swallow("web-ui: fetch runtime config", e);
    return null;
  }
}

export async function updateRuntimeConfig(
  scopeId: string | null,
  change: { harnessId?: string; modelId?: string; inherit?: boolean; keep?: boolean },
): Promise<RuntimeConfig> {
  return api<RuntimeConfig>("/api/runtime-config", {
    method: "PUT",
    body: JSON.stringify({ ...change, ...(scopeId ? { scopeId } : {}) }),
  });
}

export type WorkObserver = (work: WorkBlock) => void;

let liveRun: { runId: string } | null = null;

export function hasLiveRun(): boolean {
  return liveRun !== null;
}

export async function signalLiveRun(kind: "abort" | "steer", text?: string): Promise<void> {
  const run = liveRun;
  if (!run) throw new Error("No active run to signal.");
  await api(runPath(run.runId, "/signal"), {
    method: "POST",
    body: JSON.stringify({ kind, ...(text !== undefined ? { text } : {}) }),
  });
}

export function makeCoreStreamFn(
  threadRef: string,
  agent: Agent,
  getTurnOptions?: () => TurnOptions,
  onWork?: WorkObserver,
): StreamFn {
  const fn = (
    model: Model<Api>,
    _context: Context,
    options?: { signal?: AbortSignal },
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void drive(stream, model, threadRef, agent, getTurnOptions, options?.signal, onWork);
    return stream;
  };
  return fn as unknown as StreamFn;
}

export async function activeRunForThread(threadRef: string): Promise<ActiveRun | null> {
  const q = new URLSearchParams({ threadRef });
  const r = await api<{ runId?: string | null; run?: RunPoll | null }>(`/api/runs/active?${q.toString()}`);
  return r.runId && r.run ? { runId: r.runId, run: r.run } : null;
}

export function makeRunResumeStreamFn(runId: string, initialRun?: RunPoll, onWork?: WorkObserver): StreamFn {
  const fn = (
    model: Model<Api>,
    _context: Context,
    options?: { signal?: AbortSignal },
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void resumeDrive(stream, model, runId, initialRun, options?.signal, onWork);
    return stream;
  };
  return fn as unknown as StreamFn;
}

export async function runApprovalTurn(
  threadRef: string,
  agent: Agent,
  decision: ApprovalDecision,
  getTurnOptions: (() => TurnOptions) | undefined,
  onWork: WorkObserver | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const stream = createAssistantMessageEventStream();
  await drive(stream, agent.state.model, threadRef, agent, getTurnOptions, signal, onWork, decision);
  const outcome = await stream.result();
  if (outcome.stopReason === "error") throw new Error(outcome.errorMessage || "Could not send the approval.");
}

export function makeOpenerStreamFn(
  threadRef: string,
  agent: Agent,
  getTurnOptions: (() => TurnOptions) | undefined,
  onWork: WorkObserver | undefined,
): StreamFn {
  const fn = (
    model: Model<Api>,
    _context: Context,
    options?: { signal?: AbortSignal },
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void drive(stream, model, threadRef, agent, getTurnOptions, options?.signal, onWork, undefined, true);
    return stream;
  };
  return fn as unknown as StreamFn;
}

async function drive(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  threadRef: string,
  agent: Agent,
  getTurnOptions?: () => TurnOptions,
  signal?: AbortSignal,
  onWork?: WorkObserver,
  approval?: ApprovalDecision,
  opener?: boolean,
): Promise<void> {
  const partial = baseAssistant(model);
  const work: WorkBlock = { status: "thinking", activity: [] };
  (partial as AssistantWork).work = work;
  const notify = (): void => onWork?.(work);
  const turnOptions = getTurnOptions?.() ?? {};
  const thinkingLevel =
    !turnOptions.harness || harnessSupportsEffort(turnOptions.harness)
      ? (turnOptions.effortLevel ?? agent.state.thinkingLevel ?? defaultEffortForModel(model))
      : undefined;
  const timezone = browserTimezone();
  try {
    notify();
    stream.push({ type: "start", partial });
    stream.push({ type: "text_start", contentIndex: 0, partial });

    const { text, attachments } = opener
      ? { text: "", attachments: [] as CoreAttachment[] }
      : await latestUserTurn(agent);

    const submit = await api<{ status?: string; runId?: string; reply?: string }>("/api/turn", {
      method: "POST",
      body: JSON.stringify({
        text,
        threadRef,
        ...(turnOptions.harness ? { harness: turnOptions.harness } : {}),
        model: model.id,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(typeof turnOptions.fastMode === "boolean" ? { fastMode: turnOptions.fastMode } : {}),
        ...(timezone ? { timezone } : {}),
        ...(turnOptions.scopeId ? { scopeId: turnOptions.scopeId } : {}),
        ...(turnOptions.channelName ? { channelName: turnOptions.channelName } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(approval ? { approval } : {}),
        ...(opener ? { proactiveOpener: true } : {}),
      }),
    });

    if (submit.runId) {
      await followRun(stream, partial, submit.runId, signal, notify);
      return;
    }

    work.status = "complete";
    work.finishedAt = Date.now();
    notify();
    finish(stream, partial, { acc: "", lastProgressAt: now() }, submit.reply ?? "");
  } catch (e) {
    work.status = "failed";
    work.finishedAt = Date.now();
    notify();
    fail(stream, partial, e instanceof Error ? e.message : String(e));
  }
}

async function resumeDrive(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  runId: string,
  initialRun?: RunPoll,
  signal?: AbortSignal,
  onWork?: WorkObserver,
): Promise<void> {
  const partial = baseAssistant(model);
  const work: WorkBlock = { status: "thinking", activity: [] };
  (partial as AssistantWork).work = work;
  const notify = (): void => onWork?.(work);
  try {
    notify();
    stream.push({ type: "start", partial });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    const st: Acc = { acc: "", lastProgressAt: now() };
    if (initialRun && applyRun(stream, partial, st, initialRun, notify) === "terminal") return;
    await followRun(stream, partial, runId, signal, notify, st);
  } catch (e) {
    work.status = "failed";
    work.finishedAt = Date.now();
    notify();
    fail(stream, partial, e instanceof Error ? e.message : String(e));
  }
}

async function followRun(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  runId: string,
  signal?: AbortSignal,
  notify?: () => void,
  st: Acc = { acc: "", lastProgressAt: now() },
): Promise<void> {
  liveRun = { runId };
  try {
    if (signal?.aborted) return abortStream(stream, partial);
    const viaSse = await streamRunViaSse(stream, partial, runId, st, signal, notify);
    if (viaSse === "done") return;
    if (signal?.aborted) return abortStream(stream, partial);
    return await pollRun(stream, partial, runId, st, signal, notify);
  } finally {
    if (liveRun?.runId === runId) liveRun = null;
  }
}

function runPath(runId: string, suffix: string): string {
  return `/api/runs/${encodeURIComponent(runId)}${suffix}`;
}

export interface Acc {
  acc: string;
  lastProgressAt: number;
  staleSince?: number;
}

function isRenderableThinking(payload: unknown): boolean {
  const p = payload as { thinking?: string; redacted?: boolean } | null;
  return !!p && !p.redacted && typeof p.thinking === "string" && p.thinking.trim().length > 0;
}

function parseActivity(raw: unknown): ToolActivity[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolActivity[] = [];
  for (const item of raw) {
    const a = item as Partial<ToolActivity> | null;
    if (!a || typeof a.seq !== "number" || typeof a.type !== "string" || !ACTIVITY_TYPES.has(a.type)) continue;
    if (a.type === "thinking" && !isRenderableThinking(a.payload)) continue;
    out.push({
      seq: a.seq,
      parentSeq: a.parentSeq ?? null,
      type: a.type as ToolActivity["type"],
      payload: a.payload,
      createdAt: a.createdAt ?? 0,
    });
  }
  return out;
}

function setWorkStale(work: WorkBlock | undefined, stale: boolean, notify?: () => void): void {
  if (!work || (work.stale ?? false) === stale) return;
  work.stale = stale;
  notify?.();
}

function mergeWork(work: WorkBlock | undefined, run: { activity?: unknown[]; startedAt?: number | null }): boolean {
  if (!work) return false;
  let changed = false;
  if (typeof run.startedAt === "number" && work.startedAt == null) {
    work.startedAt = run.startedAt;
    changed = true;
  }
  const activity = parseActivity(run.activity);
  if (activity.length > work.activity.length) {
    work.activity = activity;
    changed = true;
  }
  if (work.status === "thinking" && (work.activity.length > 0 || work.startedAt != null)) {
    work.status = "working";
    changed = true;
  }
  return changed;
}

function applyRun(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  st: Acc,
  run: RunPoll,
  notify?: () => void,
): "open" | "terminal" {
  const work = (partial as AssistantWork).work;
  const beforeActivity = work?.activity.length ?? 0;
  if (mergeWork(work, run)) {
    if ((work?.activity.length ?? 0) > beforeActivity) st.lastProgressAt = now();
    notify?.();
  }
  setWorkStale(work, run.stale === true, notify);
  const p = typeof run.partial === "string" ? run.partial : "";
  if (p.length > st.acc.length) {
    st.lastProgressAt = now();
    pushDelta(stream, partial, st, p);
  }
  const terminal =
    run.status === "done" || run.status === "failed" || run.result !== null || run.replyComplete === true;
  if (!terminal) return "open";
  const res = run.result;
  const delivered = deliveredFilesFromAttachments(res?.attachments);
  if (delivered.length) {
    (partial as AssistantWork).deliveredFiles = delivered;
    notify?.();
  }
  const approvals = res?.pendingApprovals ?? [];
  const paused = approvals.length > 0;
  const approvalDenied = approvalDeniedMessage(res?.reason);
  const quiet = res?.status === "silent" || res?.status === "react";
  if (work) {
    work.finishedAt = typeof run.finishedAt === "number" ? run.finishedAt : Date.now();
    work.status =
      !paused && !approvalDenied && !quiet && (run.status === "failed" || (res != null && res.status !== "ok"))
        ? "failed"
        : "complete";
    if (paused) work.pendingApprovals = approvals;
    notify?.();
  }
  if (res?.stopped) {
    if (res.reply && res.reply.length > st.acc.length) pushDelta(stream, partial, st, res.reply);
    abortStream(stream, partial);
    return "terminal";
  }
  if (res?.reply) {
    finish(stream, partial, st, res.reply);
    return "terminal";
  }
  if (approvalDenied) {
    (partial as AssistantWork & { approvalDecision?: "denied" }).approvalDecision = "denied";
    finish(stream, partial, st, approvalDenied);
    return "terminal";
  }
  if (!paused && !quiet && (run.status === "failed" || (res && res.status !== "ok"))) {
    fail(stream, partial, res?.reason ?? "The agent run failed.");
    return "terminal";
  }
  finish(stream, partial, st, st.acc);
  return "terminal";
}

export async function pollRun(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  runId: string,
  st: Acc,
  signal?: AbortSignal,
  notify?: () => void,
): Promise<void> {
  let consecutiveFailures = 0;
  for (;;) {
    if (signal?.aborted) return abortStream(stream, partial);
    let run: RunPoll;
    try {
      run = await api<RunPoll>(runPath(runId, ""));
      consecutiveFailures = 0;
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) return fail(stream, partial, e.message);
      consecutiveFailures++;
      if (now() - st.lastProgressAt > RUN_IDLE_MS)
        return fail(stream, partial, "Timed out waiting for the agent to respond.");
      await sleep(Math.min(POLL_MS * 2 ** Math.min(consecutiveFailures, 4), POLL_RETRY_MAX_MS));
      continue;
    }
    if (applyRun(stream, partial, st, run, notify) === "terminal") return;
    if (run.stale === true) st.staleSince ??= now();
    else st.staleSince = undefined;
    if (run.alive === true || (st.staleSince !== undefined && now() - st.staleSince < STALE_GRACE_MS))
      st.lastProgressAt = now();
    if (now() - st.lastProgressAt > RUN_IDLE_MS)
      return fail(stream, partial, "Timed out waiting for the agent to respond.");
    await sleep(POLL_MS);
  }
}

export interface SessionStateEvent {
  threadRef: string;
  sessionId?: string;
  state: "working" | "awaiting_approval" | "idle";
  at: number;
}

export function subscribeDeliveries(
  onThread: (threadRef: string) => void,
  onSessionState?: (event: SessionStateEvent) => void,
  onResync?: () => void,
): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const es = new EventSource(withBase("/api/deliveries/events"));
  let everOpened = false;
  es.onopen = (): void => {
    if (everOpened) onResync?.();
    everOpened = true;
  };
  es.addEventListener("session_state_resync", () => onResync?.());
  es.addEventListener("session_state", (e: MessageEvent) => {
    try {
      const ev = JSON.parse(e.data) as SessionStateEvent;
      if (typeof ev.threadRef === "string" && ev.threadRef && typeof ev.state === "string") onSessionState?.(ev);
    } catch (err) {
      swallow("web-ui: handle session-state frame", err);
    }
  });
  es.addEventListener("delivery", (e: MessageEvent) => {
    try {
      const d = JSON.parse(e.data) as { threadRef?: string };
      if (typeof d.threadRef === "string" && d.threadRef) onThread(d.threadRef);
    } catch (err) {
      swallow("web-ui: handle delivery nudge", err);
    }
  });
  return () => es.close();
}

function streamRunViaSse(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  runId: string,
  st: Acc,
  signal?: AbortSignal,
  notify?: () => void,
): Promise<"done" | "fallback"> {
  return new Promise((resolve) => {
    if (typeof EventSource === "undefined") return resolve("fallback");
    let settled = false;
    let established = false;
    const es = new EventSource(withBase(runPath(runId, "/events")));
    const settle = (outcome: "done" | "fallback"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      signal?.removeEventListener("abort", onAbort);
      es.close();
      resolve(outcome);
    };
    const onAbort = (): void => {
      abortStream(stream, partial);
      settle("done");
    };
    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) return onAbort();
    const openTimer = setTimeout(() => {
      if (!established) settle("fallback");
    }, SSE_OPEN_TIMEOUT_MS);

    es.onopen = (): void => {
      established = true;
    };
    es.addEventListener("partial", (e: MessageEvent) => {
      established = true;
      try {
        const d = JSON.parse(e.data) as { partial?: string };
        if (typeof d.partial === "string" && d.partial.length > st.acc.length) {
          st.lastProgressAt = now();
          pushDelta(stream, partial, st, d.partial);
        }
      } catch (e) {
        swallow("web-ui: handle sse partial event", e);
      }
    });
    es.addEventListener("activity", (e: MessageEvent) => {
      established = true;
      try {
        const d = JSON.parse(e.data) as { activity?: unknown[]; startedAt?: number | null };
        const work = (partial as AssistantWork).work;
        const beforeActivity = work?.activity.length ?? 0;
        if (mergeWork(work, d)) {
          if ((work?.activity.length ?? 0) > beforeActivity) st.lastProgressAt = now();
          notify?.();
        }
      } catch (e) {
        swallow("web-ui: handle sse activity event", e);
      }
    });
    es.addEventListener("alive", () => {
      established = true;
      st.lastProgressAt = now();
    });
    es.addEventListener("stale", (e: MessageEvent) => {
      established = true;
      try {
        const d = JSON.parse(e.data) as { stale?: boolean };
        const stale = d.stale === true;
        if (stale) st.staleSince ??= now();
        else st.staleSince = undefined;
        if (!stale || now() - (st.staleSince ?? 0) < STALE_GRACE_MS) st.lastProgressAt = now();
        setWorkStale((partial as AssistantWork).work, stale, notify);
      } catch (e) {
        swallow("web-ui: handle sse stale event", e);
      }
    });
    es.addEventListener("done", (e: MessageEvent) => {
      established = true;
      try {
        applyRun(stream, partial, st, JSON.parse(e.data) as RunPoll, notify);
        settle("done");
      } catch {
        settle("fallback");
      }
    });
    es.addEventListener("failed", () => settle("fallback"));
    es.onerror = (): void => {
      settle("fallback");
    };
  });
}

function fail(stream: AssistantMessageEventStream, partial: AssistantMessage, errorMessage: string): void {
  const block = partial.content[0];
  const soFar = block?.type === "text" ? block.text : "";
  const error: AssistantMessage = {
    ...partial,
    content: [{ type: "text", text: soFar }],
    stopReason: "error",
    errorMessage,
  };
  stream.push({ type: "error", reason: "error", error });
  stream.end(error);
}

function abortStream(stream: AssistantMessageEventStream, partial: AssistantMessage): void {
  const work = (partial as AssistantWork).work;
  if (work && work.status !== "complete") {
    work.status = "failed";
    work.finishedAt = Date.now();
  }
  const block = partial.content[0];
  const soFar = block?.type === "text" ? block.text : "";
  const error: AssistantMessage = {
    ...partial,
    content: [{ type: "text", text: soFar }],
    stopReason: "aborted",
    errorMessage: "aborted",
  };
  stream.push({ type: "error", reason: "aborted", error });
  stream.end(error);
}

function pushDelta(stream: AssistantMessageEventStream, partial: AssistantMessage, st: Acc, next: string): void {
  const delta = next.slice(st.acc.length);
  const block = partial.content[0];
  if (block?.type === "text") block.text = next;
  st.acc = next;
  stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
}

function finish(stream: AssistantMessageEventStream, partial: AssistantMessage, st: Acc, reply: string): void {
  const finalText = reply.length >= st.acc.length ? reply : st.acc;
  if (finalText.length > st.acc.length) pushDelta(stream, partial, st, finalText);
  const block = partial.content[0];
  if (block?.type === "text") block.text = finalText;
  stream.push({ type: "text_end", contentIndex: 0, content: finalText, partial });
  const message: AssistantMessage = { ...partial, content: [{ type: "text", text: finalText }], stopReason: "stop" };
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
}

function deliveredFilesFromAttachments(
  attachments: Array<{ name?: string; mimetype?: string; sizeBytes?: number; artifactId?: string }> | undefined,
): DeliveredFile[] {
  return (attachments ?? [])
    .filter((a) => typeof a?.name === "string" && a.name.trim())
    .map((a) => ({
      name: a.name!,
      ...(a.mimetype ? { mimetype: a.mimetype } : {}),
      ...(typeof a.sizeBytes === "number" ? { sizeBytes: a.sizeBytes } : {}),
      ...(a.artifactId ? { artifactId: a.artifactId } : {}),
    }));
}

function approvalDeniedMessage(reason?: string): string | null {
  const trimmed = reason?.trim();
  if (!trimmed) return null;
  if (trimmed === "approval denied") return "Denied.";
  return trimmed.startsWith("approval denied for ") ? "Denied." : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ACTIVITY_TYPES = new Set<string>([
  "tool_call",
  "tool_result",
  "approval_request",
  "approval_resolved",
  "thinking",
  "text",
]);

interface HistoryAttachment {
  id: string;
  type: "image" | "document";
  fileName: string;
  mimeType: string;
  size?: number;
  artifactId?: string;
}

interface HistoryUserMessage {
  role: "user";
  content: string;
  timestamp?: number;
  attachments?: HistoryAttachment[];
  steered?: boolean;
}

function postCallText(payload: unknown): string | null {
  const p = (payload ?? {}) as { action?: unknown; text?: unknown };
  if (p.action !== "post" || typeof p.text !== "string" || !p.text.trim()) return null;
  return p.text;
}

function postResultOk(payload: unknown): boolean {
  const p = (payload ?? {}) as { ok?: unknown; isError?: unknown };
  return p.isError !== true && p.ok !== false;
}

function userEntryText(payload: unknown): string | null {
  const p = (payload ?? {}) as { text?: unknown; display?: unknown; hidden?: unknown };
  if (p.hidden) return null;
  let display = "";
  if (typeof p.display === "string" && p.display.trim()) display = p.display;
  else if (typeof p.text === "string") display = p.text;
  return display.trim() ? display : null;
}

export function entriesToMessages(entries: SessionEntry[], model: Model<Api>): AgentMessage[] {
  const out: AgentMessage[] = [];
  let pending: ToolActivity[] = [];
  let deliveryFiles: DeliveredFile[] = [];
  let posted = false;
  const heldPosts = new Map<string, { text: string; activity: ToolActivity }>();
  const spillHeldPosts = (): void => {
    for (const held of heldPosts.values()) pending.push(held.activity);
    heldPosts.clear();
  };
  const appendDeliveryFiles = (files: DeliveredFile[]): void => {
    if (!files.length) return;
    const last = out[out.length - 1] as (AssistantWork & { role?: string }) | undefined;
    if (last?.role === "assistant") {
      last.deliveredFiles = [...(last.deliveredFiles ?? []), ...files];
      return;
    }
    deliveryFiles.push(...files);
  };
  const flushWork = (text: string, at?: number, closed = false): void => {
    if (!text && !pending.length && !deliveryFiles.length) return;
    const deliveredSilence = (a: ToolActivity): boolean => {
      if (a.type !== "tool_result") return false;
      const p = a.payload as { tool?: string; silent?: boolean; ok?: boolean } | null;
      return (p?.tool === "finish_silently" && p?.silent === true) || (p?.tool === "stay_silent" && p?.ok === true);
    };
    const lastText = pending.findLastIndex((a) => a.type === "text");
    if (lastText >= 0) {
      const segment = ((pending[lastText]!.payload as { text?: string } | null)?.text ?? "").trim();
      if (text) {
        if (segment === text.trim()) pending.splice(lastText, 1);
      } else if (closed && segment && !pending.some(deliveredSilence)) {
        text = segment;
        pending.splice(lastText, 1);
      }
    }
    const msg: AssistantWork = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: at ?? pending[pending.length - 1]?.createdAt,
    };
    if (pending.length)
      msg.work = {
        status: "complete",
        startedAt: pending[0]?.createdAt,
        finishedAt: at ?? pending[pending.length - 1]?.createdAt,
        activity: pending,
      };
    if (deliveryFiles.length) msg.deliveredFiles = deliveryFiles;
    out.push(msg as AgentMessage);
    pending = [];
    deliveryFiles = [];
  };
  for (const e of entries) {
    const payload = e.payload as {
      text?: string;
      display?: string;
      callId?: string;
      attachments?: Array<{ name?: string; mimetype?: string; sizeBytes?: number; artifactId?: string }>;
      files?: Array<{ name?: string; mimetype?: string; sizeBytes?: number; artifactId?: string }>;
      hidden?: boolean;
      steered?: boolean;
    } | null;
    const text = payload?.text ?? "";
    if (ACTIVITY_TYPES.has(e.type)) {
      const activity: ToolActivity = {
        seq: e.seq ?? out.length,
        parentSeq: e.parentSeq ?? null,
        type: e.type as ToolActivity["type"],
        payload: e.payload,
        createdAt: e.createdAt,
      };
      if (e.type === "tool_call") {
        const postText = postCallText(e.payload);
        if (postText && typeof payload?.callId === "string") {
          heldPosts.set(payload.callId, { text: postText, activity });
          continue;
        }
      }
      if (e.type === "tool_result" && typeof payload?.callId === "string" && heldPosts.has(payload.callId)) {
        const held = heldPosts.get(payload.callId)!;
        heldPosts.delete(payload.callId);
        if (postResultOk(e.payload)) {
          flushWork(held.text, e.createdAt);
          posted = true;
        } else {
          pending.push(held.activity, activity);
        }
        continue;
      }
      if (e.type !== "thinking" || isRenderableThinking(e.payload)) {
        pending.push(activity);
      }
      continue;
    }
    if (e.type === "user") {
      if (payload?.hidden) continue;
      posted = false;
      spillHeldPosts();
      flushWork("", e.createdAt, Boolean(payload?.steered));
      const atts = payload?.attachments ?? [];
      const userText = userEntryText(e.payload) ?? text;
      if (text || atts.length) {
        const msg: HistoryUserMessage = {
          role: "user",
          content: userText,
          timestamp: e.createdAt,
          ...(payload?.steered ? { steered: true } : {}),
        };
        if (atts.length) {
          msg.attachments = atts.map((a, i) => ({
            id: a.artifactId ?? `${e.seq ?? e.createdAt}:${i}`,
            type: a.mimetype?.startsWith("image/") ? "image" : "document",
            fileName: a.name ?? "file",
            mimeType: a.mimetype ?? "application/octet-stream",
            ...(typeof a.sizeBytes === "number" ? { size: a.sizeBytes } : {}),
            ...(a.artifactId ? { artifactId: a.artifactId } : {}),
          }));
        }
        out.push(msg as AgentMessage);
      }
    } else if (e.type === "assistant") {
      if (text || pending.length || heldPosts.size) {
        spillHeldPosts();
        if (posted && text) {
          pending.push({
            seq: e.seq ?? out.length,
            parentSeq: e.parentSeq ?? null,
            type: "text",
            payload: { text, demoted: true },
            createdAt: e.createdAt,
          });
          flushWork("", e.createdAt);
        } else {
          flushWork(text, e.createdAt, !posted);
        }
      }
      posted = false;
    } else if (e.type === "delivery") {
      appendDeliveryFiles(deliveredFilesFromAttachments(payload?.files));
    } else if (e.type === "system") {
      const failure = e.payload as { kind?: string; message?: string } | null;
      if (failure?.kind === "turn_failure" && typeof failure.message === "string" && failure.message) {
        spillHeldPosts();
        flushWork("", e.createdAt);
        const msg: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: zeroUsage(),
          stopReason: "error",
          errorMessage: failure.message,
          timestamp: e.createdAt,
        };
        out.push(msg as AgentMessage);
      }
    }
  }
  spillHeldPosts();
  flushWork("");
  return out;
}

export function attachPendingApprovals(
  messages: AgentMessage[],
  approvals: PendingApproval[],
  model: Model<Api>,
): void {
  if (!approvals.length) return;

  const turnForCommand = (command: string): AssistantWork | undefined => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as AssistantWork;
      if (m.role !== "assistant" || !m.work) continue;
      if (
        m.work.activity.some(
          (a) => a.type === "tool_call" && (a.payload as { command?: string } | null)?.command === command,
        )
      )
        return m;
    }
    return undefined;
  };

  let trailing: AssistantWork | undefined;
  const trailingTurn = (): AssistantWork => {
    if (trailing) return trailing;
    const tail = messages[messages.length - 1] as AssistantWork | undefined;
    if (tail && tail.role === "assistant") return (trailing = tail);
    trailing = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    messages.push(trailing as AgentMessage);
    return trailing;
  };

  for (const approval of approvals) {
    const target = turnForCommand(approval.command) ?? trailingTurn();
    if (!target.work) target.work = { status: "complete", activity: [] };
    (target.work.pendingApprovals ??= []).push(approval);
  }
}
