import type { DensityTier } from "./density";

type InboxSource = "gmail" | "slack" | "generic";

export interface InboxDraft {
  to?: string[];
  cc?: string[];
  subject?: string;
  body: string;
}

interface InboxContextMessage {
  author: string;
  authorId?: string;
  avatarUrl?: string;
  at?: number;
  text: string;
  images?: string[];
  reply?: boolean;
  nearby?: boolean;
}

interface LedgerThreadMessage {
  id: string;
  role: "human" | "agent" | "system";
  text: string;
  at: number;
}

export interface LedgerItem {
  id: string;
  cronId: string;
  dedupeKey: string;
  state: "pending" | "held" | "actioned" | "dismissed" | "failed";
  summary?: string;
  parkedReason?: string;
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
  sentChat?: boolean;
  id: string;
  cronId: string;
  source: InboxSource;
  sourceKey: string;
  attention?: boolean;
  proposalData?: Record<string, unknown>;
  detailLoaded?: boolean;
  status: "open" | "sent" | "dismissed" | "replied";
  title: string;
  from: string;
  snippet: string;
  context?: InboxContextMessage[];
  participants?: Participant[];
  receivedAt: number;
  externalUrl?: string;
  draft?: InboxDraft;
  draftAt?: number;
  draftSessionId?: string;
  thread: LedgerThreadMessage[];
  gmail?: { threadId: string; subject?: string; to?: string[]; cc?: string[] };
  slack?: { channelId: string; channelLabel?: string; ts: string; threadTs?: string; userId?: string };
  sentAt?: number;
  dismissedAt?: number;
  repliedAt?: number;
  externalReplyText?: string;
  noReplyNeeded?: { reason?: string };
  reactions?: string[];
  probablyResolved?: boolean;
  automated?: boolean;
  images?: string[];
  updatedAt: number;
  sourceContextFetched?: boolean;
  sourceContextPartial?: boolean;
  sourceRefreshError?: string;
}

export interface InboxView {
  id: string;
  name: string;
}

export interface InboxSyncCron {
  id: string;
  enabled: boolean;
  lastFiredAt?: number;
}

const DEFAULT_VIEWS: InboxView[] = [
  { id: "all", name: "All" },
  { id: "gmail", name: "Email" },
  { id: "slack", name: "Slack" },
  { id: "sent", name: "Sent" },
];

export function isInboxViewId(value: string | null): value is string {
  return value !== null && [...DEFAULT_VIEWS, ...inboxViews()].some((view) => view.id === value);
}

export function inboxViewIdForSegment(segment: string | null): string | null {
  if (segment?.startsWith("cron-")) return segment.slice(5);
  if (segment === "email") return "gmail";
  return isInboxViewId(segment) ? segment : null;
}

export function inboxViewSegment(viewId: string): string {
  if (viewId === "gmail") return "email";
  return DEFAULT_VIEWS.some((view) => view.id === viewId) ? viewId : `cron-${viewId}`;
}

export const INBOX_FILTERS = [
  { id: "all", label: "All emails", description: "All synced emails, including newsletters and automated mail" },
  {
    id: "human",
    label: "Light filtering — exclude notifications",
    description: "Emails from people, including conversations that need no reply",
  },
  {
    id: "triaged",
    label: "Heavy filtering — only emails that need your attention",
    description: "Emails identified as needing a reply or review",
  },
] as const;

export type InboxFilter = (typeof INBOX_FILTERS)[number]["id"];

export const freshInboxState = () => ({
  filter: "human" as InboxFilter,
  filterBusy: false,
  items: [] as InboxItem[],
  selected: [] as Array<{
    id: string;
    name: string;
    sources?: string[];
    count: number;
    source?: string;
    syncCron?: InboxSyncCron | null;
  }>,
  available: [] as Array<{
    id: string;
    name: string;
    sources?: string[];
    source?: string;
    selected: boolean;
  }>,
  total: 0,
  nextCursor: null as string | null,
  picker: false,
  menuId: null as string | null,
  selectionBusy: false,
  loaded: false,
  loading: false,
  error: null as string | null,
  fetchedAt: 0,
  notice: null as string | null,
  syncBusy: false,
});

export const inboxState = freshInboxState();

export interface InboxSurface {
  host: HTMLElement;
  viewId: string;
  pane: boolean;
  density: () => DensityTier;
  selectedId: string | null;
  showHandled: boolean;
}

export const surfaces = new Set<InboxSurface>();

export function inboxViews(): InboxView[] {
  return [{ id: "all", name: "All" }, ...inboxState.selected.map((cron) => ({ id: cron.id, name: cron.name }))];
}

export function inboxViewName(viewId: string): string {
  return inboxViews().find((v) => v.id === viewId)?.name ?? DEFAULT_VIEWS.find((v) => v.id === viewId)?.name ?? "All";
}

export function itemsFor(viewId: string, status: "open" | "handled"): InboxItem[] {
  return inboxState.items.filter((item) => {
    if (item.sentChat) return false;
    if (viewId !== "all" && viewId !== "sent" && item.cronId !== viewId && item.source !== viewId) return false;
    if (viewId === "sent") return item.status === "sent" && item.source !== "generic";
    if (status !== "open") return item.status !== "open";
    if (item.status !== "open") return false;
    if (item.source === "gmail") {
      if (inboxState.filter === "all") return true;
      if (item.automated) return false;
      if (inboxState.filter === "human") return true;
      if (item.probablyResolved) return false;
    }
    return item.attention !== false;
  });
}

export function inboxOpenCount(viewId = "all"): number {
  if (!inboxState.loaded) return 0;
  return viewId === "all" ? inboxState.total : (inboxState.selected.find((cron) => cron.id === viewId)?.count ?? 0);
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
  if (entry.state === "actioned") return entry.source === "gmail" || entry.source === "slack" ? "sent" : "dismissed";
  if (entry.state !== "dismissed") return "open";
  return entry.actionKind === "replied" ? "replied" : "dismissed";
}

export function toInboxItem(entry: LedgerItem): InboxItem {
  const payload = entry.sourcePayload;
  const source: InboxSource = entry.source === "gmail" || entry.source === "slack" ? entry.source : "generic";
  const status = resolvedStatus(entry);
  const reactions = Array.isArray(payload.reactions) ? (payload.reactions as string[]) : [];
  const actedAt = (when: InboxItem["status"]) => (status === when ? entry.actedAt : undefined);
  return {
    id: entry.id,
    cronId: entry.cronId,
    source,
    sourceKey: entry.dedupeKey,
    status,
    sentChat: payload.sentChat === true,
    detailLoaded: payload.sentChat === true,
    title: str(payload.title) ?? entry.summary ?? "Review item",
    attention: entry.state === "held" || (entry.state === "failed" && Boolean(entry.parkedReason)),
    proposalData: entry.proposal?.data,
    from: str(payload.from) ?? "",
    snippet: str(payload.snippet) ?? entry.parkedReason ?? entry.summary ?? "",
    receivedAt: entry.sourceAt ?? (typeof payload.receivedAt === "number" ? payload.receivedAt : entry.updatedAt),
    thread: entry.thread,
    updatedAt: entry.updatedAt,
    sourceContextFetched: payload.sourceContextFetched === true,
    sourceContextPartial: payload.sourceContextPartial === true,
    sourceRefreshError: typeof payload.sourceRefreshError === "string" ? payload.sourceRefreshError : undefined,
    participants:
      source === "slack" && Array.isArray(payload.participants)
        ? payload.participants.flatMap((person) =>
            person && typeof person.id === "string" && typeof person.name === "string"
              ? [{ key: person.id, name: person.name, avatarUrl: str(person.avatarUrl) }]
              : [],
          )
        : undefined,
    context: Array.isArray(payload.context) ? (payload.context as InboxContextMessage[]) : undefined,
    externalUrl: str(payload.externalUrl),
    draft: draftOf(entry),
    draftAt: entry.proposal?.at,
    draftSessionId: entry.proposal?.sessionId,
    gmail: payload.gmail as InboxItem["gmail"],
    slack: payload.slack as InboxItem["slack"],
    reactions: reactions.length ? reactions : undefined,
    probablyResolved: payload.probablyResolved === true,
    automated: payload.automated === true,
    images: Array.isArray(payload.images)
      ? (payload.images as unknown[]).filter((u): u is string => typeof u === "string")
      : undefined,
    sentAt: actedAt("sent"),
    dismissedAt: actedAt("dismissed"),
    repliedAt: actedAt("replied"),
    externalReplyText: status === "replied" && entry.actionResult ? entry.actionResult : undefined,
    noReplyNeeded: entry.actionKind === "no_reply_needed" ? { reason: entry.actionResult } : undefined,
  };
}

export interface Participant {
  key: string;
  name: string;
  avatarUrl?: string;
}

export function syncCrons(viewId: string) {
  return inboxState.selected.filter(
    (cron) => cron.source && (viewId === "all" || cron.id === viewId || cron.source === viewId),
  );
}

export const inboxPage = {
  surface: null as InboxSurface | null,
  viewId: "all",
};

let redraw = (): void => {};

export function onInboxRedraw(fn: () => void): void {
  redraw = fn;
}

export function redrawInbox(): void {
  redraw();
}

export function notify(msg: string | null): void {
  inboxState.notice = msg;
  redrawInbox();
  if (msg) {
    window.setTimeout(() => {
      if (inboxState.notice === msg) {
        inboxState.notice = null;
        redrawInbox();
      }
    }, 4000);
  }
}
