import { sharedContextLabel, type CoreContext, type CoreProject, type CoreSession } from "./core-bridge.ts";
import type { Locale } from "../../chassis/src/locale.ts";
import { webMessage, type WebMessageKey } from "./messages.ts";

type ProjectAwareContext = CoreContext & { project?: CoreProject };

type RecentGroupKind = "personal" | "project" | "channel" | "group";

export interface RecentProjectSeed {
  scopeId: string;
  name: string | null;
  kind?: RecentGroupKind;
}

export type RecentItem =
  | { kind: "session"; session: CoreSession }
  | { kind: "project"; scopeId: string; name: string | null; groupKind: RecentGroupKind; sessions: CoreSession[] };

export function activityOf(s: CoreSession): number {
  return s.lastActivityAt ?? s.createdAt;
}

export type ChatBrowseStatus = "active" | "waiting" | "archived";

export function splitPinned<T extends Pick<CoreSession, "pinned">>(sessions: readonly T[]): { pinned: T[]; rest: T[] } {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const s of sessions) (s.pinned ? pinned : rest).push(s);
  return { pinned, rest };
}

export function chatBrowseStatusMatches(
  session: Pick<CoreSession, "archived" | "awaitingInput">,
  status: ChatBrowseStatus,
): boolean {
  if (status === "archived") return Boolean(session.archived);
  if (session.archived) return false;
  return status === "waiting" ? Boolean(session.awaitingInput) : !session.awaitingInput;
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

export function groupProjectSessions(
  sessions: readonly CoreSession[],
  projectSeeds: readonly RecentProjectSeed[],
): RecentItem[] {
  const seeds = new Map(projectSeeds.map((seed) => [seed.scopeId, seed]));
  const projects = new Map<string, Extract<RecentItem, { kind: "project" }>>();
  const items: RecentItem[] = [];
  for (const session of [...sessions].sort((a, b) => activityOf(b) - activityOf(a))) {
    const seed = seeds.get(session.scopeId);
    if (!seed) {
      items.push({ kind: "session", session });
      continue;
    }
    let project = projects.get(session.scopeId);
    if (!project) {
      project = {
        kind: "project",
        scopeId: session.scopeId,
        name: seed.name,
        groupKind: seed.kind ?? "project",
        sessions: [],
      };
      projects.set(session.scopeId, project);
      items.push(project);
    }
    project.sessions.push(session);
  }
  for (const seed of projectSeeds) {
    if (projects.has(seed.scopeId)) continue;
    const kind = seed.kind ?? "project";
    if (kind === "channel" || kind === "group") continue;
    items.push({ kind: "project", scopeId: seed.scopeId, name: seed.name, groupKind: kind, sessions: [] });
  }
  return items;
}

export function recencyGroup(ms: number, now = Date.now(), selected: Locale = "en"): string {
  const d = new Date(now);
  const dayStart = (back: number): number => new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
  if (ms >= dayStart(0)) return webMessage(selected, "history.today");
  if (ms >= dayStart(1)) return webMessage(selected, "history.yesterday");
  if (ms >= dayStart(6)) return webMessage(selected, "history.previous7Days");
  if (ms >= dayStart(29)) return webMessage(selected, "history.previous30Days");
  return webMessage(selected, "history.older");
}

export function withPendingSession(list: CoreSession[], pending: CoreSession): CoreSession[] {
  return [pending, ...list.filter((s) => s.threadRef !== pending.threadRef)];
}

export function withoutUnsentPending(list: CoreSession[], threadRef: string): CoreSession[] {
  return list.filter((s) => s.id !== "" || s.threadRef !== threadRef);
}

export function bumpActivity(list: CoreSession[], threadRef: string, at: number): CoreSession[] {
  return list.map((s) => (s.threadRef === threadRef ? { ...s, lastActivityAt: at } : s));
}

export function reconcileSessions(server: CoreSession[], prev: CoreSession[]): CoreSession[] {
  const known = new Set(server.map((s) => s.threadRef));
  const pending = prev.filter((s) => !s.id && !known.has(s.threadRef));
  return [...pending, ...server];
}

export function markWorking(list: CoreSession[], threadRef: string): CoreSession[] {
  return list.map((s) => (s.threadRef === threadRef ? { ...s, working: true } : s));
}

export function clearWorking(list: CoreSession[], threadRef: string): CoreSession[] {
  return list.map((s) => (s.threadRef === threadRef ? { ...s, working: false } : s));
}

export type SessionRow = CoreSession & { stateAt?: number };

export interface SessionStateDelta {
  threadRef: string;
  state: "working" | "awaiting_approval" | "idle";
  at?: number;
}

export function applySessionState(
  list: SessionRow[],
  delta: SessionStateDelta,
): { list: SessionRow[]; matched: boolean } {
  let matched = false;
  const next = list.map((s) => {
    if (s.threadRef !== delta.threadRef) return s;
    matched = true;
    if (delta.at !== undefined && s.stateAt !== undefined && delta.at < s.stateAt) return s;
    return {
      ...s,
      working: delta.state === "working",
      awaitingInput: delta.state === "awaiting_approval",
      ...(delta.at !== undefined ? { stateAt: delta.at } : {}),
    };
  });
  return { list: matched ? next : list, matched };
}

export interface RowIndicators {
  working: boolean;
  awaiting: boolean;
  background: { count: number; label: string } | null;
}

function countMessage(selected: Locale, count: number, one: WebMessageKey, other: WebMessageKey): string {
  const key = new Intl.PluralRules(selected).select(count) === "one" ? one : other;
  return webMessage(selected, key, { count: new Intl.NumberFormat(selected).format(count) });
}

export function backgroundLabel(
  jobs: number,
  watches: number,
  selected: Locale = "en",
): { count: number; label: string } | null {
  const parts: string[] = [];
  if (jobs > 0) parts.push(countMessage(selected, jobs, "background.jobs.one", "background.jobs.other"));
  if (watches > 0) parts.push(countMessage(selected, watches, "background.watches.one", "background.watches.other"));
  return parts.length ? { count: jobs + watches, label: parts.join(" · ") } : null;
}

export function rowIndicators(s: CoreSession, liveThreadRef: string | null, selected: Locale = "en"): RowIndicators {
  return {
    working: Boolean(s.working) || (Boolean(s.threadRef) && s.threadRef === liveThreadRef),
    awaiting: Boolean(s.awaitingInput),
    background: backgroundLabel(s.backgroundJobs ?? 0, s.watches ?? 0, selected),
  };
}

export function conversationBackground(
  list: CoreSession[],
  sessionId: string | null,
  threadRef: string | null,
  selected: Locale = "en",
): RowIndicators["background"] {
  const row = list.find((s) => (sessionId ? s.id === sessionId : Boolean(threadRef) && s.threadRef === threadRef));
  return row ? rowIndicators(row, null, selected).background : null;
}
