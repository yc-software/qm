import { html, nothing, render, type TemplateResult } from "lit";
import {
  ArrowUp,
  ArrowUpRight,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Inbox as InboxGlyph,
  Mail,
  RefreshCw,
  Send,
  Undo2,
  X,
} from "lucide";
import { api, ApiError } from "./core-bridge";
import { onInboxItemEvent, onInboxResync } from "./conversations";
import { createInboxEventCoalescer, type InboxItemRef } from "./inbox-coalesce";
import { charForName, ensureEmojiIndex } from "./emoji-picker";
import type { DensityTier } from "./density";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { appState, can } from "./shell-state";
import { renderSidebarTop, switchView } from "./shell";
import { openSession, sessionsState } from "./sessions";
import { splitMentions } from "./linkify";
import { splitSlackWire } from "./slack-text";
import { listBackLink } from "./list-page";
import { registerPaneKind } from "./pane-kinds";
import { beginPaneKindDrag, endPaneDrag, exitSplitIfActive, notifyPanesChanged } from "./split";
import { tip } from "./tooltip";
import { brandName, icon, initials, relTime, slackMark, workingWave } from "./ui";

export type InboxSource = "gmail" | "slack";

export interface InboxDraft {
  to?: string[];
  cc?: string[];
  subject?: string;
  body: string;
}

export interface InboxContextMessage {
  author: string;
  at?: number;
  text: string;
  images?: string[];
}

export interface LedgerThreadMessage {
  id: string;
  role: "human" | "agent" | "system";
  text: string;
  at: number;
}

export interface LedgerItem {
  id: string;
  loopId: string;
  dedupeKey: string;
  state: "pending" | "processed" | "held" | "actioned" | "dismissed" | "failed";
  source?: string;
  sourcePayload: Record<string, unknown>;
  sourceAt?: number;
  proposal?: { data: Record<string, unknown>; by: "agent" | "human"; at: number; sessionId?: string };
  thread: LedgerThreadMessage[];
  actedAt?: number;
  actionKind?: string;
  actionResult?: string;
  updatedAt: number;
}

export interface InboxItem {
  id: string;
  loopId: string;
  source: InboxSource;
  sourceKey: string;
  status: "open" | "sent" | "dismissed" | "replied";
  title: string;
  from: string;
  fromDetail?: string;
  snippet: string;
  context?: InboxContextMessage[];
  receivedAt: number;
  externalUrl?: string;
  draft?: InboxDraft;
  draftEdited?: boolean;
  draftAt?: number;
  draftSessionId?: string;
  thread: LedgerThreadMessage[];
  gmail?: { threadId: string; subject?: string; to?: string[]; cc?: string[] };
  slack?: { channelId: string; channelLabel?: string; ts: string; threadTs?: string };
  sentAt?: number;
  dismissedAt?: number;
  repliedAt?: number;
  externalReplyText?: string;
  reactions?: string[];
  probablyResolved?: boolean;
  images?: string[];
  updatedAt: number;
}

export interface InboxView {
  id: string;
  name: string;
  sources: InboxSource[];
}

export interface InboxSyncCron {
  id: string;
  enabled: boolean;
  lastFiredAt?: number;
  taskVersion: number | null;
  currentTaskVersion: number;
}

const VIEWS: InboxView[] = [
  { id: "all", name: "All", sources: ["gmail", "slack"] },
  { id: "gmail", name: "Email", sources: ["gmail"] },
  { id: "slack", name: "Slack", sources: ["slack"] },
];

export const inboxState = {
  items: [] as InboxItem[],
  loopId: null as string | null,
  syncCron: null as InboxSyncCron | null,
  loaded: false,
  loading: false,
  error: null as string | null,
  fetchedAt: 0,
  notice: null as string | null,
  syncBusy: false,
};

const DRAFT_SUGGESTIONS = ["Make it shorter", "Make it more friendly", "Remove the salutations"];
const ASIDE_MIN_HEIGHT = 320;
const ASIDE_MAX_HEIGHT = 1100;
const CHAT_INPUT_MAX_HEIGHT = 200;
const draftEdits = new Map<string, InboxDraft & { basedOnAt?: number }>();
const sending = new Set<string>();
const acting = new Set<string>();
const chatting = new Set<string>();
const chatDrafts = new Map<string, string>();

let emojiIndexRequested = false;

function ensureEmojiChips(): void {
  if (emojiIndexRequested) return;
  emojiIndexRequested = true;
  void ensureEmojiIndex().then(() => drawAll());
}

interface InboxSurface {
  host: HTMLElement;
  viewId: string;
  pane: boolean;
  density: () => DensityTier;
  selectedId: string | null;
  showHandled: boolean;
}

const surfaces = new Set<InboxSurface>();

const externalSurfaces = new Set<{ redraw: () => void; visible: () => boolean }>();

export function attachInboxSurface(surface: { redraw: () => void; visible: () => boolean }): () => void {
  externalSurfaces.add(surface);
  ensurePolling();
  ensureRealtime();
  return () => externalSurfaces.delete(surface);
}

export function resetInboxState(): void {
  inboxState.items = [];
  inboxState.loopId = null;
  inboxState.syncCron = null;
  inboxState.loaded = false;
  inboxState.loading = false;
  inboxState.error = null;
  inboxState.fetchedAt = 0;
  inboxState.notice = null;
  inboxState.syncBusy = false;
  draftEdits.clear();
  sending.clear();
  acting.clear();
  chatting.clear();
  chatDrafts.clear();
}

export function inboxViews(): InboxView[] {
  return VIEWS;
}

export function inboxViewName(viewId: string): string {
  return VIEWS.find((v) => v.id === viewId)?.name ?? "All";
}

function viewSources(viewId: string): InboxSource[] {
  return VIEWS.find((v) => v.id === viewId)?.sources ?? ["gmail", "slack"];
}

export function itemsFor(viewId: string, status: "open" | "handled"): InboxItem[] {
  const sources = viewSources(viewId);
  return inboxState.items.filter(
    (i) => sources.includes(i.source) && (status === "open" ? i.status === "open" : i.status !== "open"),
  );
}

export function inboxOpenCount(viewId = "all"): number {
  if (!inboxState.loaded) return 0;
  return itemsFor(viewId, "open").filter((i) => !i.probablyResolved).length;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function draftOf(item: LedgerItem): InboxDraft | undefined {
  const data = item.proposal?.data;
  if (!data || typeof data.body !== "string") return undefined;
  return {
    body: data.body,
    ...(Array.isArray(data.to) ? { to: data.to as string[] } : {}),
    ...(Array.isArray(data.cc) ? { cc: data.cc as string[] } : {}),
    ...(str(data.subject) ? { subject: data.subject as string } : {}),
  };
}

function resolvedStatus(entry: LedgerItem): InboxItem["status"] {
  if (entry.state === "actioned") return "sent";
  if (entry.state !== "dismissed") return "open";
  return entry.actionKind === "replied" ? "replied" : "dismissed";
}

export function toInboxItem(entry: LedgerItem): InboxItem {
  const payload = entry.sourcePayload;
  const source: InboxSource = entry.source === "gmail" ? "gmail" : "slack";
  const draft = draftOf(entry);
  const resolved = resolvedStatus(entry);
  const reactions = Array.isArray(payload.reactions) ? (payload.reactions as string[]) : undefined;
  return {
    id: entry.id,
    loopId: entry.loopId,
    source,
    sourceKey: entry.dedupeKey,
    status: resolved,
    title: str(payload.title) ?? "",
    from: str(payload.from) ?? "",
    snippet: str(payload.snippet) ?? "",
    receivedAt: entry.sourceAt ?? (typeof payload.receivedAt === "number" ? payload.receivedAt : entry.updatedAt),
    thread: entry.thread,
    updatedAt: entry.updatedAt,
    ...(str(payload.fromDetail) ? { fromDetail: payload.fromDetail as string } : {}),
    ...(Array.isArray(payload.context) ? { context: payload.context as InboxContextMessage[] } : {}),
    ...(str(payload.externalUrl) ? { externalUrl: payload.externalUrl as string } : {}),
    ...(draft ? { draft } : {}),
    ...(entry.proposal?.by === "human" ? { draftEdited: true } : {}),
    ...(entry.proposal ? { draftAt: entry.proposal.at } : {}),
    ...(entry.proposal?.sessionId ? { draftSessionId: entry.proposal.sessionId } : {}),
    ...(payload.gmail ? { gmail: payload.gmail as InboxItem["gmail"] } : {}),
    ...(payload.slack ? { slack: payload.slack as InboxItem["slack"] } : {}),
    ...(reactions?.length ? { reactions } : {}),
    ...(payload.probablyResolved === true ? { probablyResolved: true } : {}),
    ...(Array.isArray(payload.images)
      ? { images: (payload.images as unknown[]).filter((u): u is string => typeof u === "string") }
      : {}),
    ...(resolved === "sent" && entry.actedAt !== undefined ? { sentAt: entry.actedAt } : {}),
    ...(resolved === "dismissed" && entry.actedAt !== undefined ? { dismissedAt: entry.actedAt } : {}),
    ...(resolved === "replied" && entry.actedAt !== undefined ? { repliedAt: entry.actedAt } : {}),
    ...(resolved === "replied" && entry.actionResult ? { externalReplyText: entry.actionResult } : {}),
  };
}

let pollTimer: number | null = null;

function anySurfaceVisible(): boolean {
  if (!can("inbox")) return false;
  if (appState.currentView === "inbox") return true;
  return [...surfaces].some((s) => s.pane && s.host.isConnected) || [...externalSurfaces].some((s) => s.visible());
}

function ensurePolling(): void {
  if (!can("inbox")) return;
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible" || !anySurfaceVisible()) return;
    void refreshInbox({ silent: true });
  }, 120_000);
}

let refreshFollowUp = false;
let resyncMissedWhileHidden = false;

export async function refreshInbox(opts: { silent?: boolean; ifStaleMs?: number } = {}): Promise<void> {
  if (!can("inbox")) return;
  if (inboxState.loading) {
    if (opts.ifStaleMs === undefined || resyncMissedWhileHidden) refreshFollowUp = true;
    return;
  }
  if (opts.ifStaleMs !== undefined && !resyncMissedWhileHidden && Date.now() - inboxState.fetchedAt < opts.ifStaleMs)
    return;
  resyncMissedWhileHidden = false;
  inboxState.loading = true;
  if (!opts.silent) drawAll();
  try {
    const found = await api<{ loop: { id: string } | null; syncCron: InboxSyncCron | null }>("/api/inbox");
    inboxState.syncCron = found.syncCron;
    inboxState.loopId = found.loop?.id ?? null;
    inboxState.items = inboxState.loopId ? await fetchItems(inboxState.loopId) : [];
    inboxState.loaded = true;
    inboxState.error = null;
    inboxState.fetchedAt = Date.now();
  } catch (e) {
    inboxState.error = e instanceof Error ? e.message : String(e);
  } finally {
    inboxState.loading = false;
    drawAll();
  }
  if (refreshFollowUp) {
    refreshFollowUp = false;
    void refreshInbox({ silent: true });
  }
}

async function fetchItems(loopId: string): Promise<InboxItem[]> {
  const payload = await api<{ items: LedgerItem[] }>(`/api/loops/${encodeURIComponent(loopId)}/items`);
  return payload.items.map(toInboxItem);
}

let realtimeWired = false;

const enqueueRealtimeEvent = createInboxEventCoalescer(
  250,
  (batch) => void applyRealtimeBatch(batch),
  (fn, ms) => void window.setTimeout(fn, ms),
);

async function applyRealtimeBatch(batch: InboxItemRef[]): Promise<void> {
  if (batch.length !== 1 || !inboxState.loopId || inboxState.loading) return refreshInbox({ silent: true });
  const { loopId, itemId } = batch[0]!;
  try {
    const { item } = await api<{ item: LedgerItem }>(
      `/api/loops/${encodeURIComponent(loopId)}/items/${encodeURIComponent(itemId)}`,
    );
    if (inboxState.loading) return refreshInbox({ silent: true });
    upsertItem(toInboxItem(item));
    inboxState.fetchedAt = Date.now();
    drawAll();
  } catch {
    void refreshInbox({ silent: true });
  }
}

function upsertItem(next: InboxItem): void {
  if (inboxState.items.some((i) => i.id === next.id)) replaceItem(next);
  else inboxState.items = [next, ...inboxState.items];
}

function ensureRealtime(): void {
  if (realtimeWired) return;
  realtimeWired = true;
  onInboxItemEvent((event) => {
    if (!can("inbox")) return;
    if (inboxState.loopId && event.loopId !== inboxState.loopId) return;
    enqueueRealtimeEvent({ loopId: event.loopId, itemId: event.itemId });
  });
  onInboxResync(() => {
    if (!can("inbox")) return;
    if (document.visibilityState !== "visible" || !anySurfaceVisible()) {
      resyncMissedWhileHidden = true;
      return;
    }
    void refreshInbox({ silent: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !anySurfaceVisible()) return;
    void refreshInbox({ ifStaleMs: 30_000, silent: true });
  });
}

function replaceItem(next: InboxItem): void {
  inboxState.items = inboxState.items.map((i) => (i.id === next.id ? next : i));
}

function notify(msg: string | null): void {
  inboxState.notice = msg;
  drawAll();
  if (msg) {
    window.setTimeout(() => {
      if (inboxState.notice === msg) {
        inboxState.notice = null;
        drawAll();
      }
    }, 4000);
  }
}

function draftSubject(item: InboxItem, draft: InboxDraft): string {
  if (draft.subject !== undefined) return draft.subject;
  return item.gmail?.subject ? `Re: ${item.gmail.subject.replace(/^re:\s*/i, "")}` : "";
}

function headerPeek(item: InboxItem, draft: InboxDraft): string {
  const to = (draft.to ?? []).join(", ");
  const subject = draftSubject(item, draft);
  return [to, subject].filter(Boolean).join(" · ") || "Recipients and subject";
}

function effectiveDraft(item: InboxItem): InboxDraft {
  const edited = draftEdits.get(item.id);
  if (edited) {
    const { basedOnAt: _basedOnAt, ...draft } = edited;
    return draft;
  }
  return (
    item.draft ?? {
      body: "",
      ...(item.source === "gmail" ? { to: item.gmail?.to ?? [], subject: item.gmail?.subject } : {}),
    }
  );
}

function editDraft(item: InboxItem, patch: Partial<InboxDraft>): void {
  const basedOnAt = draftEdits.get(item.id)?.basedOnAt ?? item.draftAt;
  draftEdits.set(item.id, { ...effectiveDraft(item), ...patch, ...(basedOnAt !== undefined ? { basedOnAt } : {}) });
}

function isDraftConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && /draft changed/i.test(e.message);
}

async function explainDraftConflict(item: InboxItem, edited: boolean): Promise<void> {
  await refetchItem(item);
  const fresh = inboxState.items.find((i) => i.id === item.id);
  const overlay = draftEdits.get(item.id);
  if (overlay && fresh?.draftAt !== undefined) draftEdits.set(item.id, { ...overlay, basedOnAt: fresh.draftAt });
  const preview = (fresh?.draft?.body ?? "").trim().slice(0, 140);
  notify(
    edited
      ? `The agent redrafted this reply while you were editing. Your text is kept in the box. New draft: "${preview}". Send again to use yours.`
      : "The draft changed while you were looking. Review the new draft, then send again.",
  );
}

function splitAddresses(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function actionPath(item: InboxItem, leaf: "action" | "followup"): string {
  return `/api/loops/${encodeURIComponent(item.loopId)}/items/${encodeURIComponent(item.id)}/${leaf}`;
}

async function refetchItem(item: InboxItem): Promise<void> {
  try {
    const { item: fresh } = await api<{ item: LedgerItem }>(
      `/api/loops/${encodeURIComponent(item.loopId)}/items/${encodeURIComponent(item.id)}`,
    );
    replaceItem(toInboxItem(fresh));
    drawAll();
  } catch {
    void refreshInbox({ silent: true });
  }
}

async function postAction(item: InboxItem, kind: string, args?: Record<string, unknown>): Promise<InboxItem> {
  const { item: next } = await api<{ item: LedgerItem }>(actionPath(item, "action"), {
    method: "POST",
    body: JSON.stringify({ kind, ...(args ? { args } : {}) }),
  });
  return toInboxItem(next);
}

const persistQueue = new Map<string, Promise<void>>();
const persistWaiting = new Set<string>();

function enqueueForItem(itemId: string, task: () => Promise<void>): Promise<void> {
  const queued = (persistQueue.get(itemId) ?? Promise.resolve()).then(task);
  persistQueue.set(itemId, queued);
  void queued.finally(() => {
    if (persistQueue.get(itemId) === queued) persistQueue.delete(itemId);
  });
  return queued;
}

export function persistDraft(item: InboxItem): Promise<void> {
  if (persistWaiting.has(item.id)) return persistQueue.get(item.id) ?? Promise.resolve();
  persistWaiting.add(item.id);
  return enqueueForItem(item.id, () => {
    persistWaiting.delete(item.id);
    return persistDraftNow(item.id);
  });
}

async function persistDraftNow(itemId: string): Promise<void> {
  const item = inboxState.items.find((i) => i.id === itemId);
  if (!item) return;
  const edited = draftEdits.get(item.id);
  if (!edited) return;
  const saved = item.draft;
  if (
    saved &&
    saved.body === edited.body &&
    (saved.subject ?? "") === (edited.subject ?? "") &&
    (saved.to ?? []).join(",") === (edited.to ?? []).join(",") &&
    (saved.cc ?? []).join(",") === (edited.cc ?? []).join(",")
  ) {
    draftEdits.delete(item.id);
    return;
  }
  const { basedOnAt, ...proposal } = edited;
  try {
    const next = await postAction(item, "edit", {
      proposal,
      ...(basedOnAt !== undefined ? { expectedProposalAt: basedOnAt } : {}),
    });
    const newer = draftEdits.get(item.id);
    if (newer === edited) draftEdits.delete(item.id);
    else if (newer && next.draftAt !== undefined) draftEdits.set(item.id, { ...newer, basedOnAt: next.draftAt });
    replaceItem(next);
  } catch (e) {
    if (isDraftConflict(e)) return explainDraftConflict(item, true);
    notify(`Couldn't save the draft: ${e instanceof Error ? e.message : e}`);
  }
}

async function sendItem(item: InboxItem): Promise<void> {
  if (sending.has(item.id)) return;
  if (!effectiveDraft(item).body.trim()) {
    notify("Nothing to send. The draft is empty.");
    return;
  }
  sending.add(item.id);
  drawAll();
  try {
    await enqueueForItem(item.id, () => sendItemNow(item.id));
  } finally {
    sending.delete(item.id);
    drawAll();
  }
}

async function sendItemNow(itemId: string): Promise<void> {
  const item = inboxState.items.find((i) => i.id === itemId);
  if (!item) return;
  const edited = draftEdits.get(item.id);
  const draft = effectiveDraft(item);
  if (!draft.body.trim()) {
    notify("Nothing to send. The draft is empty.");
    return;
  }
  try {
    const basedOnAt = edited?.basedOnAt ?? item.draftAt;
    const next = await postAction(item, "send", {
      proposal: draft,
      ...(basedOnAt !== undefined ? { expectedProposalAt: basedOnAt } : {}),
    });
    if (draftEdits.get(item.id) === edited) draftEdits.delete(item.id);
    replaceItem(next);
    notify(item.source === "gmail" ? "Reply sent by email." : "Reply posted to Slack.");
  } catch (e) {
    if (isDraftConflict(e)) return explainDraftConflict(item, Boolean(edited));
    const hint =
      e instanceof ApiError && e.status === 409 && /connect/i.test(e.message) ? ". Reconnect it under Keychain" : "";
    notify(`Send failed: ${e instanceof Error ? e.message : e}${hint}`);
  }
}

export async function setItemStatus(item: InboxItem, status: "open" | "dismissed"): Promise<void> {
  if (acting.has(item.id)) return;
  acting.add(item.id);
  try {
    replaceItem(await postAction(item, status === "dismissed" ? "dismiss" : "reopen"));
  } catch (e) {
    notify(`Couldn't update the item: ${e instanceof Error ? e.message : e}`);
  } finally {
    acting.delete(item.id);
    drawAll();
  }
}

export async function askAgent(item: InboxItem, message: string): Promise<void> {
  const text = message.trim();
  if (!text || chatting.has(item.id)) return;
  chatting.add(item.id);
  chatDrafts.delete(item.id);
  drawAll();
  try {
    const { item: next } = await api<{ item: LedgerItem }>(actionPath(item, "followup"), {
      method: "POST",
      body: JSON.stringify({ message: text }),
    });
    const mapped = toInboxItem(next);
    draftEdits.delete(item.id);
    replaceItem(mapped);
  } catch (e) {
    notify(`The agent couldn't answer: ${e instanceof Error ? e.message : e}`);
    if (!chatDrafts.has(item.id)) chatDrafts.set(item.id, text);
  } finally {
    chatting.delete(item.id);
    drawAll();
  }
}

async function setUpSync(): Promise<void> {
  if (inboxState.syncBusy) return;
  inboxState.syncBusy = true;
  drawAll();
  try {
    const out = await api<{ loop: { id: string } | null; syncCron: InboxSyncCron | null }>("/api/inbox/sync-cron", {
      method: "POST",
      body: JSON.stringify({}),
    });
    inboxState.syncCron = out.syncCron;
    inboxState.loopId = out.loop?.id ?? inboxState.loopId;
    notify("Inbox sync is on. First pass runs within 15 minutes.");
  } catch (e) {
    notify(`Couldn't set up sync: ${e instanceof Error ? e.message : e}`);
  } finally {
    inboxState.syncBusy = false;
    drawAll();
  }
}

async function syncNow(): Promise<void> {
  const cron = inboxState.syncCron;
  if (!cron || inboxState.syncBusy) return;
  inboxState.syncBusy = true;
  drawAll();
  try {
    await api(`/api/crons/${encodeURIComponent(cron.id)}/run`, { method: "POST", body: "{}" });
    notify("Sync kicked off. New items appear as the agent finishes drafting.");
  } catch (e) {
    notify(`Couldn't start a sync: ${e instanceof Error ? e.message : e}`);
  } finally {
    inboxState.syncBusy = false;
    drawAll();
  }
}

function openDraftSession(e: MouseEvent, sessionId: string): void {
  e.preventDefault();
  const session = sessionsState.list.find((s) => s.id === sessionId);
  if (session) void openSession(session);
  else window.location.assign(deepLinkPath(UI_BASE, "chats", sessionId));
}

function sourceGlyph(source: InboxSource): SVGElement | TemplateResult {
  return source === "gmail" ? icon(Mail, 14) : slackMark(14);
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

interface Participant {
  key: string;
  name: string;
}

function participantName(raw: string): string {
  return (raw.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] ?? raw).trim();
}

function participantKey(raw: string): string {
  return (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase();
}

function participantsOf(item: InboxItem): Participant[] {
  const found = new Map<string, Participant>();
  for (const raw of [item.from, ...(item.context ?? []).map((m) => m.author)]) {
    const name = participantName(raw ?? "");
    if (!name) continue;
    const key = participantKey(raw);
    if (!found.has(key)) found.set(key, { key, name });
  }
  return [...found.values()];
}

function avatarHue(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 360;
  return hash;
}

const AVATARS_SHOWN = 4;

export function participantsTpl(item: InboxItem): TemplateResult | typeof nothing {
  const people = participantsOf(item);
  if (!people.length) return nothing;
  const shown = people.length > AVATARS_SHOWN ? people.slice(0, AVATARS_SHOWN - 1) : people;
  const rest = people.slice(shown.length);
  return html`<span class="inbox-avatars" aria-label=${`In this conversation: ${people.map((p) => p.name).join(", ")}`}>
    ${shown.map(
      (p) =>
        html`<span class="inbox-avatar" style=${`--avatar-hue:${avatarHue(p.key)}`} ${tip(p.name)} aria-hidden="true"
          >${initials(p.name)}</span
        >`,
    )}
    ${
      rest.length
        ? html`<span class="inbox-avatar more" ${tip(rest.map((p) => p.name).join(", "))} aria-hidden="true"
            >+${rest.length}</span
          >`
        : nothing
    }
  </span>`;
}

function selfHandle(): string {
  const me = appState.me?.user ?? "";
  return (me.split("@")[0] || me).trim().toLowerCase();
}

export function slackTextTpl(item: InboxItem, text: string, opts: { links?: boolean } = {}): TemplateResult {
  if (item.source !== "slack") return html`${text}`;
  const self = selfHandle();
  const mentionChip = (handle: string): TemplateResult =>
    html`<span class="slack-mention ${handle.toLowerCase() === self ? "self" : ""}">@${handle}</span>`;
  const withMentions = (str: string): Array<TemplateResult | string> =>
    splitMentions(str).map((m) => (m.kind === "text" ? m.text : mentionChip(m.handle)));
  return html`${splitSlackWire(text).map((seg) => {
    if (seg.kind === "mention") return mentionChip(seg.handle);
    if (seg.kind === "link") {
      if (opts.links === false) return html`<span ${tip(seg.href)}>${withMentions(seg.label)}</span>`;
      return html`<a class="inbox-text-link" href=${seg.href} target="_blank" rel="noreferrer noopener"
        >${withMentions(seg.label)}</a
      >`;
    }
    return withMentions(seg.text);
  })}`;
}

function itemImagesTpl(item: InboxItem, urls: string[] | undefined, ctxIndex: number): TemplateResult | typeof nothing {
  if (!urls?.length) return nothing;
  const base = `${UI_BASE}/api/loops/${encodeURIComponent(item.loopId)}/items/${encodeURIComponent(item.id)}/image`;
  return html`<div class="inbox-images">
    ${urls.map((_u, j) => {
      const src = `${base}?ctx=${ctxIndex}&i=${j}`;
      return html`<a href=${src} target="_blank" rel="noreferrer noopener"
        ><img class="inbox-image" src=${src} loading="lazy" alt="attached image"
      /></a>`;
    })}
  </div>`;
}

export function contextTpl(item: InboxItem): TemplateResult | typeof nothing {
  const rows = [
    ...(item.context ?? []).map((message, index) => ({ ...message, imageIndex: index })),
    { author: item.from, at: item.receivedAt, text: item.snippet, images: item.images, imageIndex: -1 },
  ];
  return html`<div class="inbox-context">
    ${rows.map((m) => {
      const name = participantName(m.author) || m.author;
      return html`
        <div class="inbox-context-msg">
          <span class="inbox-avatar" style=${`--avatar-hue:${avatarHue(participantKey(m.author))}`} aria-hidden="true"
            >${initials(name)}</span
          >
          <div class="inbox-context-body">
            <div class="inbox-context-head">
              <span class="inbox-context-author">${name}</span>
              ${m.at ? html`<span class="inbox-context-at">${relTime(m.at)}</span>` : nothing}
            </div>
            <div class="inbox-context-text">${slackTextTpl(item, m.text)}</div>
            ${itemImagesTpl(item, m.images, m.imageIndex)}
          </div>
        </div>
      `;
    })}
  </div>`;
}

export function chatTpl(item: InboxItem): TemplateResult {
  const busy = chatting.has(item.id);
  const pending = chatDrafts.get(item.id) ?? "";
  const submit = (el: HTMLTextAreaElement): void => {
    if (busy) return;
    const text = el.value;
    el.value = "";
    autosizeChatInput(el);
    void askAgent(item, text);
  };
  const empty = item.thread.length === 0;
  return html`
    <div class="inbox-chat">
      ${
        empty
          ? html`<div class="inbox-chat-empty">
              <h2 class="inbox-chat-cta">What should I change?</h2>
              <div class="inbox-chat-suggestions">
                ${DRAFT_SUGGESTIONS.map(
                  (prompt) =>
                    html`<button
                      class="inbox-chat-suggestion"
                      type="button"
                      ?disabled=${busy}
                      @click=${() => void askAgent(item, prompt)}
                    >
                      ${prompt}
                    </button>`,
                )}
              </div>
            </div>`
          : html`<div class="inbox-chat-log">
              ${item.thread.map(
                (m) =>
                  html`<div class="inbox-chat-msg ${m.role}">
                    <span class="inbox-chat-text">${m.text}</span>
                  </div>`,
              )}
            </div>`
      }
      ${busy ? html`<div class="inbox-chat-working">${workingWave()}<span>Thinking…</span></div>` : nothing}
      <div class="inbox-chat-composer ${pending.trim() ? "has-text" : ""}">
        <textarea
          class="inbox-chat-input"
          rows="1"
          placeholder=${`Ask ${brandName()} for something`}
          .value=${pending}
          @input=${(e: Event) => {
            const box = e.currentTarget as HTMLTextAreaElement;
            const had = Boolean((chatDrafts.get(item.id) ?? "").trim());
            chatDrafts.set(item.id, box.value);
            autosizeChatInput(box);
            if (had !== Boolean(box.value.trim())) drawAll();
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(e.currentTarget as HTMLTextAreaElement);
            }
          }}
        ></textarea>
        <div class="inbox-chat-actions">
          <div class="inbox-chat-suggest">
            ${
              item.status === "open"
                ? html`
                    <button
                      class="inbox-suggest-chip primary"
                      type="button"
                      ?disabled=${sending.has(item.id)}
                      ${tip(item.source === "gmail" ? "Send the drafted reply in Gmail" : "Send the drafted reply to Slack")}
                      @click=${() => void sendItem(item)}
                    >
                      ${icon(Send, 12)}<span>${sending.has(item.id) ? "Sending…" : "Send it"}</span>
                    </button>
                    <button
                      class="inbox-suggest-chip"
                      type="button"
                      @click=${() => void setItemStatus(item, "dismissed")}
                    >
                      ${icon(X, 12)}<span>Dismiss</span>
                    </button>
                  `
                : nothing
            }
          </div>
          <button
            class="btn inbox-chat-send"
            type="button"
            aria-label="Ask"
            ${tip("Ask. Enter to send, Shift+Enter for a new line")}
            ?disabled=${busy || !pending.trim()}
            @click=${(e: MouseEvent) => {
              const box = (e.currentTarget as HTMLElement)
                .closest(".inbox-chat-composer")
                ?.querySelector<HTMLTextAreaElement>(".inbox-chat-input");
              if (box) submit(box);
            }}
          >
            ${icon(ArrowUp, 14)}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function draftEditorTpl(item: InboxItem, opts: { chat?: boolean } = {}): TemplateResult {
  const draft = effectiveDraft(item);
  const gmail = item.source === "gmail";
  const showCc = gmail && ((draft.cc?.length ?? 0) > 0 || (item.gmail?.cc?.length ?? 0) > 0);
  return html`
    <div class="inbox-draft ${gmail ? "email" : "slack"}">
      <div class="inbox-draft-head">
        <span class="inbox-draft-label">Draft reply</span>
        ${
          item.draftSessionId
            ? html`<a
                class="inbox-session-link"
                href=${deepLinkPath(UI_BASE, "chats", item.draftSessionId)}
                title="See how the agent arrived at this draft"
                @click=${(e: MouseEvent) => openDraftSession(e, item.draftSessionId!)}
              >
                ${icon(ArrowUpRight, 12)}<span>Open agent session</span>
              </a>`
            : nothing
        }
        ${
          item.externalUrl
            ? html`<a class="inbox-external-link" href=${item.externalUrl} target="_blank" rel="noreferrer noopener">
                ${icon(ArrowUpRight, 12)}<span>Open in ${gmail ? "Gmail" : "Slack"}</span>
              </a>`
            : nothing
        }
      </div>
      ${
        gmail
          ? html`
              <details class="inbox-draft-headers">
                <summary><span class="inbox-draft-headers-peek">${headerPeek(item, draft)}</span></summary>
                <div class="inbox-draft-headers-fields">
                  <label class="inbox-field">
                    <span>To</span>
                    <input
                      type="text"
                      .value=${(draft.to ?? []).join(", ")}
                      placeholder="who@example.com"
                      @input=${(e: Event) => editDraft(item, { to: splitAddresses((e.currentTarget as HTMLInputElement).value) })}
                      @blur=${() => void persistDraft(item)}
                    />
                  </label>
                  ${
                    showCc
                      ? html`<label class="inbox-field">
                          <span>Cc</span>
                          <input
                            type="text"
                            .value=${(draft.cc ?? []).join(", ")}
                            @input=${(e: Event) => editDraft(item, { cc: splitAddresses((e.currentTarget as HTMLInputElement).value) })}
                            @blur=${() => void persistDraft(item)}
                          />
                        </label>`
                      : nothing
                  }
                  <label class="inbox-field">
                    <span>Subject</span>
                    <input
                      type="text"
                      .value=${draftSubject(item, draft)}
                      @input=${(e: Event) => editDraft(item, { subject: (e.currentTarget as HTMLInputElement).value })}
                      @blur=${() => void persistDraft(item)}
                    />
                  </label>
                </div>
              </details>
            `
          : nothing
      }
      <div class="inbox-draft-body-wrap">
        <textarea
          class="inbox-draft-body"
          rows=${gmail ? 7 : 3}
          placeholder=${item.draft ? "" : "No draft yet. The next sync writes one, or write your own."}
          .value=${draft.body}
          @input=${(e: Event) => editDraft(item, { body: (e.currentTarget as HTMLTextAreaElement).value })}
          @blur=${() => void persistDraft(item)}
        ></textarea>
      </div>
      ${
        !gmail && item.reactions?.length
          ? html`<div class="inbox-reactions">${item.reactions.map((name) => reactionChipTpl(name))}</div>`
          : nothing
      }
      ${opts.chat === false ? nothing : chatTpl(item)}
    </div>
  `;
}

function reactionChipTpl(name: string): TemplateResult {
  ensureEmojiChips();
  const char = charForName(name);
  return html`<span class="inbox-reaction-chip" title=${`:${name}:`}>${char ?? `:${name}:`}</span>`;
}

function handledStateLabel(item: InboxItem): string {
  if (item.status === "sent") return "Sent";
  if (item.status === "replied") return "Replied";
  return "Dismissed";
}

function itemSideMark(item: InboxItem, handled: boolean): TemplateResult | typeof nothing {
  if (handled) return html`<span class="inbox-item-state">${handledStateLabel(item)}</span>`;
  if (item.draft)
    return html`<span class="inbox-item-drafted" title="A reply is drafted and ready">${icon(CheckCheck, 12)}</span>`;
  return nothing;
}

function reopenButtonTpl(item: InboxItem): TemplateResult {
  return html`<button class="btn inbox-reopen" type="button" @click=${() => void setItemStatus(item, "open")}>
    ${icon(Undo2, 13)}<span>Reopen</span>
  </button>`;
}

export function handledNoteTpl(item: InboxItem): TemplateResult {
  if (item.status === "sent") {
    return html`<div class="inbox-handled-note">
      ${icon(CheckCheck, 13)}<span>Reply sent ${item.sentAt ? relTime(item.sentAt) : ""}</span>
    </div>`;
  }
  if (item.status === "replied") {
    const where = item.source === "slack" ? "Slack" : "Gmail";
    return html`<div class="inbox-handled-note inbox-replied-note">
      <div class="inbox-handled-line">
        ${icon(CheckCheck, 13)}<span>You replied in ${where} ${item.repliedAt ? relTime(item.repliedAt) : ""}</span>
        ${reopenButtonTpl(item)}
      </div>
      ${item.externalReplyText ? html`<div class="inbox-replied-text">${slackTextTpl(item, item.externalReplyText)}</div>` : nothing}
    </div>`;
  }
  return html`<div class="inbox-handled-note">
    ${icon(X, 13)}<span>Dismissed ${item.dismissedAt ? relTime(item.dismissedAt) : ""}</span>
    ${reopenButtonTpl(item)}
  </div>`;
}

function itemRowTpl(surface: InboxSurface, item: InboxItem): TemplateResult {
  const inlineDetail = surface.pane;
  const open = surface.selectedId === item.id;
  const expanded = inlineDetail && open;
  const expandedAttr = inlineDetail ? String(open) : nothing;
  const handled = item.status !== "open";
  const gmail = item.source === "gmail";
  const heading = gmail ? item.from : (item.slack?.channelLabel ?? item.title);
  const sub = gmail ? item.title : item.from;
  return html`
    <div class="inbox-item ${expanded ? "expanded" : ""} ${handled ? "handled" : ""} src-${item.source}">
      <button
        class="inbox-item-row"
        type="button"
        aria-expanded=${expandedAttr}
        @click=${() => {
          const previous = surface.selectedId;
          if (previous && previous !== item.id) {
            const prevItem = inboxState.items.find((i) => i.id === previous);
            if (prevItem) void persistDraft(prevItem);
          }
          surface.selectedId = inlineDetail && open ? null : item.id;
          if (!inlineDetail) syncItemUrl(surface.selectedId, true);
          drawAll();
        }}
      >
        <span class="inbox-item-glyph">${sourceGlyph(item.source)}</span>
        <span class="inbox-item-main">
          <span class="inbox-item-top">
            <span class="inbox-item-heading">${heading}</span>
            <span class="inbox-item-sub">${sub}</span>
          </span>
          <span class="inbox-item-snippet">${slackTextTpl(item, item.snippet, { links: false })}</span>
        </span>
        <span class="inbox-item-side">
          ${participantsTpl(item)} ${itemSideMark(item, handled)}
          <span class="inbox-item-time" title=${fmtClock(item.receivedAt)}>${relTime(item.receivedAt)}</span>
          ${icon(expanded ? ChevronDown : ChevronRight, 13)}
        </span>
      </button>
      ${
        expanded
          ? html`<div class="inbox-item-detail">
              ${contextTpl(item)} ${handled ? handledNoteTpl(item) : draftEditorTpl(item)}
            </div>`
          : nothing
      }
    </div>
  `;
}

function syncStatusLabel(cron: InboxSyncCron): string {
  if (!cron.enabled) return "Sync paused";
  return cron.lastFiredAt ? `Synced ${relTime(cron.lastFiredAt)}` : "First sync pending";
}

function syncLineTpl(): TemplateResult {
  const cron = inboxState.syncCron;
  if (!cron) {
    return html`<button
      class="btn inbox-sync-setup"
      type="button"
      ${tip("Create the inbox loop and the personal cron that scans your connected apps and drafts replies")}
      ?disabled=${inboxState.syncBusy}
      @click=${() => void setUpSync()}
    >
      ${icon(RefreshCw, 13)}<span>${inboxState.syncBusy ? "Setting up…" : "Set up sync"}</span>
    </button>`;
  }
  return html`<span class="inbox-sync-line">
    <button
      class="icon-btn subtle compact"
      type="button"
      ${tip("Sync now")}
      aria-label="Sync now"
      ?disabled=${inboxState.syncBusy}
      @click=${() => void syncNow()}
    >
      ${icon(RefreshCw, 14)}
    </button>
    <span ${tip(cron.enabled ? "The sync cron is on" : "The sync cron is paused. Manage it under Crons")}>
      ${syncStatusLabel(cron)}
    </span>
  </span>`;
}

function surfaceTpl(surface: InboxSurface): TemplateResult {
  const density = surface.density();
  const compact = density !== "full";
  const allOpen = itemsFor(surface.viewId, "open");
  const openItems = allOpen.filter((i) => !i.probablyResolved);
  const resolvedItems = allOpen.filter((i) => i.probablyResolved);
  const handledItems = itemsFor(surface.viewId, "handled");
  const chips = html`
    <div class="inbox-chips" role="tablist" aria-label="Inbox views">
      ${VIEWS.map((v) => {
        const count = inboxOpenCount(v.id);
        return html`<button
          class="inbox-chip ${surface.viewId === v.id ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${surface.viewId === v.id ? "true" : "false"}
          @click=${() => {
            surface.viewId = v.id;
            if (surface === fullSurface) fullViewId = v.id;
            drawAll();
          }}
        >
          <span>${v.name}</span>${count > 0 ? html`<span class="inbox-chip-count">${count}</span>` : nothing}
        </button>`;
      })}
      <button
        class="inbox-chip inbox-review-chip"
        type="button"
        draggable="true"
        title="Draft review. Drag into the split canvas to pin it as a pane"
        @dragstart=${(e: DragEvent) => {
          e.dataTransfer?.setData("application/x-webui-draft-review", surface.viewId);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
          beginPaneKindDrag("draftReview", surface.viewId);
        }}
        @dragend=${() => endPaneDrag()}
        @click=${() => notify("Drag Draft review into the split canvas to pin it as a pane.")}
      >
        <span>Draft review</span>
      </button>
    </div>
  `;
  const list = html`
    ${!inboxState.loaded && inboxState.loading ? html`<div class="empty compact">Reading your inbox…</div>` : nothing}
    ${
      inboxState.error && !inboxState.loaded
        ? html`<div class="empty compact">Couldn't load the inbox: ${inboxState.error}</div>`
        : nothing
    }
    ${
      inboxState.loaded && openItems.length === 0
        ? html`<div class="empty compact inbox-zero">
            ${
              inboxState.syncCron
                ? "Nothing is waiting on you. Clear water ahead."
                : "No items yet. Set up sync and the agent will surface everything waiting on a reply, drafted and ready."
            }
          </div>`
        : nothing
    }
    <div class="inbox-list">${openItems.map((i) => itemRowTpl(surface, i))}</div>
    ${
      resolvedItems.length
        ? html`<div class="inbox-resolved-sect">
            <div class="inbox-resolved-head">Probably resolved · no reply likely needed</div>
            <div class="inbox-list inbox-resolved-list">${resolvedItems.map((i) => itemRowTpl(surface, i))}</div>
          </div>`
        : nothing
    }
    ${
      handledItems.length
        ? html`
            <button
              class="inbox-handled-toggle"
              type="button"
              aria-expanded=${surface.showHandled ? "true" : "false"}
              @click=${() => {
                surface.showHandled = !surface.showHandled;
                drawAll();
              }}
            >
              ${icon(surface.showHandled ? ChevronDown : ChevronRight, 13)}
              <span>Handled (${handledItems.length})</span>
            </button>
            ${surface.showHandled ? html`<div class="inbox-list handled">${handledItems.map((i) => itemRowTpl(surface, i))}</div>` : nothing}
          `
        : nothing
    }
  `;
  return html`
    <div class="inbox-surface ${compact ? "compact" : ""}" data-density=${density}>
      <div class="inbox-toolbar">
        ${chips} ${surface.pane ? html`<span class="inbox-toolbar-spacer"></span>${syncLineTpl()}` : nothing}
      </div>
      ${inboxState.notice ? html`<div class="inbox-notice" role="status">${inboxState.notice}</div>` : nothing}
      <div class="inbox-scroll">${list}</div>
    </div>
  `;
}

function itemPageTpl(item: InboxItem): TemplateResult {
  const handled = item.status !== "open";
  const gmail = item.source === "gmail";
  const heading = gmail ? item.from : (item.slack?.channelLabel ?? item.title);
  const sub = gmail ? item.title : "";
  return html`
    <div class="pane-head inbox-item-head src-${item.source}">
      <div class="inbox-item-head-copy">
        ${listBackLink("Inbox", closeInboxItem)}
        <h1 class="pane-title">
          <span class="inbox-item-glyph">${sourceGlyph(item.source)}</span><span>${heading}</span>
          <span class="inbox-item-head-meta">
            ${participantsTpl(item)} ${itemSideMark(item, handled)}
            <span class="inbox-item-time" title=${fmtClock(item.receivedAt)}>${relTime(item.receivedAt)}</span>
          </span>
        </h1>
        ${sub ? html`<div class="pane-subtitle">${sub}</div>` : nothing}
      </div>
    </div>
    <div class="inbox-surface inbox-item-surface">
      <div class="inbox-scroll inbox-item-thread">
        ${contextTpl(item)} ${handled ? handledNoteTpl(item) : draftEditorTpl(item, { chat: false })}
      </div>
    </div>
    <aside class="inbox-item-aside">${chatTpl(item)}</aside>
  `;
}

function keepingChatLogsPinned(host: HTMLElement, draw: () => void): void {
  const logs = () => [...host.querySelectorAll<HTMLElement>(".inbox-chat-log")];
  const wasAtBottom = logs().map((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  draw();
  logs().forEach((el, i) => {
    if (wasAtBottom[i] ?? true) el.scrollTop = el.scrollHeight;
  });
}

function drawSurface(surface: InboxSurface): void {
  if (!surface.host.isConnected && surface.pane) return;
  keepingChatLogsPinned(surface.host, () => render(surfaceTpl(surface), surface.host));
  sizeChatInputs(surface.host);
}

let fullSurface: InboxSurface | null = null;
let asideObserver: ResizeObserver | null = null;
let fullViewId = "all";
let pendingItemId: string | null = null;

function drawFull(): void {
  if (appState.currentView !== "inbox" || !appState.mainEl) return;
  if (!fullSurface || !fullSurface.host.isConnected || fullSurface.host.parentElement !== appState.mainEl) {
    const host = document.createElement("div");
    host.className = "pane inbox-page";
    fullSurface = {
      host,
      viewId: fullViewId,
      pane: false,
      density: () => "full" as DensityTier,
      selectedId: fullSurface?.selectedId ?? null,
      showHandled: fullSurface?.showHandled ?? false,
    };
    appState.mainEl.replaceChildren(host);
    observeAsideSize(host);
  }
  fullSurface.viewId = fullViewId;
  if (pendingItemId) {
    fullSurface.selectedId = pendingItemId;
    pendingItemId = null;
  }
  const openItem = fullSurface.selectedId ? inboxState.items.find((i) => i.id === fullSurface?.selectedId) : undefined;
  if (fullSurface.selectedId && !openItem && inboxState.loaded) fullSurface.selectedId = null;
  syncItemUrl(fullSurface.selectedId);
  const host = fullSurface.host;
  const surface = fullSurface;
  keepingChatLogsPinned(host, () =>
    render(
      openItem
        ? itemPageTpl(openItem)
        : html`
            <div class="pane-head">
              <h1 class="pane-title">Inbox</h1>
              <div class="pane-head-actions">${syncLineTpl()}</div>
            </div>
            ${surfaceTpl(surface)}
          `,
      host,
    ),
  );
  sizeAside(host);
  sizeChatInputs(host);
}

/**
 * The assistant sticks to the top of a page that now scrolls, so its height is
 * the viewport below wherever it starts rather than a share of a fixed frame.
 */
function sizeAside(host: HTMLElement): void {
  if (!host.querySelector(".inbox-item-aside")) return;
  const pad = getComputedStyle(host);
  const padTop = Number.parseFloat(pad.paddingTop) || 0;
  const padBottom = Number.parseFloat(pad.paddingBottom) || 0;
  const available = host.clientHeight - padTop - padBottom;
  const height = Math.min(ASIDE_MAX_HEIGHT, Math.max(ASIDE_MIN_HEIGHT, available));
  const next = `${height}px`;
  if (host.style.getPropertyValue("--inbox-aside-height") === next) return;
  host.style.setProperty("--inbox-aside-height", next);
}

function observeAsideSize(host: HTMLElement): void {
  if (typeof ResizeObserver === "undefined") return;
  asideObserver?.disconnect();
  asideObserver = new ResizeObserver(() => {
    sizeAside(host);
    sizeChatInputs(host);
  });
  asideObserver.observe(host);
}

function autosizeChatInput(box: HTMLTextAreaElement): void {
  box.style.height = "auto";
  const cap = Number.parseFloat(getComputedStyle(box).maxHeight) || CHAT_INPUT_MAX_HEIGHT;
  const content = box.scrollHeight;
  box.style.height = `${Math.min(cap, content)}px`;
  box.style.overflowY = content > cap ? "auto" : "hidden";
}

function sizeChatInputs(host: HTMLElement): void {
  for (const box of host.querySelectorAll<HTMLTextAreaElement>(".inbox-chat-input")) autosizeChatInput(box);
}

function syncItemUrl(itemId: string | null, push = false): void {
  if (appState.currentView !== "inbox") return;
  const next = deepLinkPath(UI_BASE, "inbox", null, null, itemId);
  if (`${location.pathname}${location.search}` === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

export function resetActiveInboxItem(): void {
  const open = fullSurface?.selectedId;
  if (!open || !fullSurface) return;
  const item = inboxState.items.find((i) => i.id === open);
  if (item) void persistDraft(item);
  fullSurface.selectedId = null;
}

function closeInboxItem(): void {
  resetActiveInboxItem();
  syncItemUrl(null);
  drawAll();
}

export function routeInboxHistory(itemId: string | null): void {
  if (!fullSurface) return;
  fullSurface.selectedId = itemId;
  drawAll();
}

export function openInboxItemById(itemId: string): void {
  pendingItemId = itemId;
}

export function drawAll(): void {
  for (const s of surfaces) drawSurface(s);
  for (const s of externalSurfaces) s.redraw();
  drawFull();
  renderSidebarTop();
  notifyPanesChanged();
}

export function selectInboxView(viewId: string): void {
  fullViewId = viewId;
  if (fullSurface) {
    fullSurface.viewId = viewId;
    fullSurface.selectedId = null;
  }
}

export async function renderInbox(): Promise<void> {
  ensurePolling();
  ensureRealtime();
  drawFull();
  await refreshInbox({ ifStaleMs: 30_000, silent: true });
}

export function mountInboxPane(opts: {
  host: HTMLElement;
  viewId: string;
  density: () => DensityTier;
  onDensityChange: (handler: () => void) => void;
}): { dispose: () => void } {
  const surface: InboxSurface = {
    host: opts.host,
    viewId: opts.viewId,
    pane: true,
    density: opts.density,
    selectedId: null,
    showHandled: false,
  };
  surfaces.add(surface);
  opts.host.classList.add("inbox-pane-host");
  opts.onDensityChange(() => drawSurface(surface));
  ensurePolling();
  ensureRealtime();
  drawSurface(surface);
  void refreshInbox({ ifStaleMs: 30_000, silent: true });
  return {
    dispose() {
      surfaces.delete(surface);
      opts.host.classList.remove("inbox-pane-host");
    },
  };
}

registerPaneKind({
  paramsKey: "inboxView",
  glyph: InboxGlyph,
  title: (id) => inboxViewName(id),
  badge: (id) => (can("inbox") ? inboxOpenCount(id) : 0),
  mount: ({ host, id, density, onDensityChange }) => mountInboxPane({ host, viewId: id, density, onDensityChange }),
  maximize: (id) => {
    exitSplitIfActive();
    selectInboxView(id);
    switchView("inbox");
  },
});
