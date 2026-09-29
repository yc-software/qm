interface GroupDmLabel {
  names: string[];
  text: string;
  count: number;
}

function cleanMpdmPart(part: string): string {
  return part.trim().replace(/-\d+$/u, "").replace(/-/g, " ").trim();
}

export function groupDmLabel(name: string | null | undefined): GroupDmLabel | null {
  const raw = (name ?? "").trim().replace(/^#/u, "");
  if (!raw) return null;
  const names = raw.startsWith("mpdm-")
    ? raw.slice("mpdm-".length).split("--").map(cleanMpdmPart).filter(Boolean)
    : raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
  if (!names.length) return null;
  return { names, text: names.join(", "), count: names.length };
}

export function groupDmText(name: string | null | undefined): string | null {
  return groupDmLabel(name)?.text ?? null;
}

export interface SessionNavigationFields {
  id: string;
  type: "dm" | "channel" | "group";
  scopeId: string;
  threadRef: string;
  createdAt: number;
  title?: string | null;
  channelName?: string | null;
  lastActivityAt?: number;
  parentSessionId?: string;
  surface?: string;
  archived?: boolean;
  pinned?: boolean;
  awaitingInput?: boolean;
  working?: boolean;
  lastTurnFailed?: boolean;
}

export function subagentState(session: Pick<SessionNavigationFields, "awaitingInput" | "working" | "lastTurnFailed">) {
  if (session.awaitingInput) return "waiting";
  if (session.working) return "working";
  if (session.lastTurnFailed) return "failed";
  return "done";
}

export type ChatBrowseStatus = "active" | "waiting" | "archived";
type SessionNavigationSurface = "all" | "web" | "slack" | "core";
export type SessionReference = { kind: "id" | "thread"; value: string };
export type SessionNavigationSection = "recent" | "pinned" | "groups" | "archived";

export interface SessionNavigationRequest {
  surface?: "all" | "web";
  section?: SessionNavigationSection;
  cursor?: string;
  references?: SessionReference[];
}

export interface SessionSubagentCounts {
  running: number;
  waiting: number;
}

type SessionLink = Pick<SessionNavigationFields, "id" | "parentSessionId" | "working" | "awaitingInput">;

export function descendantsOf<T extends SessionLink>(
  list: readonly T[],
  rootId: string,
): { session: T; depth: number }[] {
  const children = new Map<string, { session: T; index: number }[]>();
  list.forEach((session, index) => {
    const parent = session.parentSessionId;
    if (!parent) return;
    const siblings = children.get(parent);
    if (siblings) siblings.push({ session, index });
    else children.set(parent, [{ session, index }]);
  });
  const out: { session: T; depth: number }[] = [];
  const seen = new Set([rootId]);
  let frontier = children.get(rootId) ?? [];
  for (let depth = 1; frontier.length; depth++) {
    const next: typeof frontier = [];
    for (const { session } of frontier.sort((a, b) => a.index - b.index)) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      out.push({ session, depth });
      for (const child of children.get(session.id) ?? []) next.push(child);
    }
    frontier = next;
  }
  return out;
}

export function subagentCounts(list: readonly SessionLink[], rootId: string | null | undefined): SessionSubagentCounts {
  const counts = { running: 0, waiting: 0 };
  if (!rootId) return counts;
  for (const { session } of descendantsOf(list, rootId)) {
    if (session.awaitingInput) counts.waiting++;
    else if (session.working) counts.running++;
  }
  return counts;
}

export interface SessionPageRequest {
  surface?: SessionNavigationSurface;
  status?: ChatBrowseStatus;
  scopeId?: string;
  query?: string;
  title?: string;
  children?: boolean;
  parentSessionId?: string;
  actionable?: boolean;
  pinned?: boolean;
  archived?: boolean;
  cursor?: string;
}

export interface SessionNavigationPage<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

export interface SessionNavigationContext {
  scopeId: string;
  kind: "personal" | "channel" | "group";
  name: string | null;
  isPrivate?: boolean;
  sessionCount: number;
  lastActivityAt: number | null;
  project?: { id: string; name: string; ownerId: string; createdAt: number; updatedAt: number };
}

export interface SessionNavigationGroup {
  scopeId: string;
  name: string | null;
  kind: "personal" | "project" | "channel" | "group";
  count: number;
  lastActivityAt: number;
}

export interface SessionStatusTotals {
  active: number;
  waiting: number;
  archived: number;
}

export interface SessionPageResult<T> extends SessionNavigationPage<T> {
  contexts: SessionNavigationContext[];
  statusTotals: SessionStatusTotals;
  actionable?: {
    parentSessionId: string;
    parentSubagents: SessionSubagentCounts | null;
    depths: number[];
  };
}

export interface SessionResolveResult<T> {
  references: { reference: SessionReference; session: T | null }[];
}

export interface SessionNavigationResult<T> extends SessionResolveResult<T> {
  recent: SessionNavigationPage<T>;
  pinned: SessionNavigationPage<T>;
  groups: SessionNavigationPage<SessionNavigationGroup>;
  archived?: SessionNavigationPage<T>;
  archivedCount: number;
  contexts: SessionNavigationContext[];
  statusTotals: SessionStatusTotals;
  startup: {
    hasSessions: boolean;
    hasNonCronSessions: boolean;
    oldestPersonalThreadRef: string | null;
    latest: T | null;
  };
}

export function sharedContextLabel(scopeId: string | null, name: string | null): string | null {
  if (!scopeId) return null;
  if (scopeId.startsWith("channel:")) return name ? `#${name.replace(/^#/, "")}` : "Shared channel";
  if (scopeId.startsWith("group:")) return groupDmText(name) ?? name ?? "Group";
  return null;
}

export function surfaceOf(s: SessionNavigationFields): string {
  if (s.threadRef.startsWith("web:")) return "web";
  if (s.threadRef.startsWith("dm:") || s.threadRef.startsWith("ch:")) return "slack";
  if (s.threadRef.startsWith("agent:main:subagent:") && s.surface) return s.surface;
  return "core";
}

export function channelLabel(s: SessionNavigationFields): string | null {
  return s.channelName && s.channelName.trim() ? `#${s.channelName.replace(/^#/, "")}` : null;
}

export function activityOf(s: SessionNavigationFields): number {
  return s.lastActivityAt ?? s.createdAt;
}

export function chatBrowseStatusMatches(
  session: Pick<SessionNavigationFields, "archived" | "awaitingInput">,
  status: ChatBrowseStatus,
): boolean {
  if (status === "archived") return Boolean(session.archived);
  if (session.archived) return false;
  return status === "waiting" ? Boolean(session.awaitingInput) : !session.awaitingInput;
}

export function defaultSessionTitle(s: SessionNavigationFields, project: string | null = null): string {
  if (project) return project;
  const surface = surfaceOf(s);
  if (surface === "web") return "Web chat";
  if (s.type === "channel") return channelLabel(s) ?? "Channel";
  if (s.type === "group") return groupDmText(s.channelName) ?? s.channelName?.trim() ?? "Group DM";
  return "Direct message";
}

export function sessionTitle(s: SessionNavigationFields, project: string | null = null): string {
  return s.title && s.title.trim() ? s.title : defaultSessionTitle(s, project);
}

export function chatMatches(s: SessionNavigationFields, q: string, project: string | null = null): boolean {
  const context = sharedContextLabel(s.scopeId, s.channelName ?? null) ?? "Personal";
  return [sessionTitle(s, project), s.channelName ?? "", context].join(" ").toLowerCase().includes(q);
}

type ProjectAwareContext = Pick<SessionNavigationContext, "scopeId" | "kind" | "name"> & { project?: { name: string } };

type RecentGroupKind = "personal" | "project" | "channel" | "group";

export interface RecentProjectSeed {
  scopeId: string;
  name: string | null;
  kind?: RecentGroupKind;
}

export function recentProjectSeeds(contexts: readonly ProjectAwareContext[]): RecentProjectSeed[] {
  return contexts.map((context): RecentProjectSeed => {
    if (context.project)
      return { scopeId: context.scopeId, name: context.project.name.trim() || null, kind: "project" };
    if (context.kind === "personal") return { scopeId: context.scopeId, name: "Personal", kind: "personal" };
    if (context.kind === "group")
      return { scopeId: context.scopeId, name: sharedContextLabel(context.scopeId, context.name), kind: "group" };
    return { scopeId: context.scopeId, name: sharedContextLabel(context.scopeId, context.name), kind: "channel" };
  });
}
