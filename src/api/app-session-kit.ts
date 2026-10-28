import { surfaceProfile } from "../surfaces/surface.ts";
import { swallowAs } from "../util/errors.ts";
import { workingSessionThreadRefs } from "../subagents/tree.ts";
import { type GetItemsOptions, windowedTranscript } from "../sessions/session-store.ts";
import { type PendingApprovalRecord, type Session, parseScopeId } from "../types.ts";
import { isUserMessage, messageTs, proseText, type Item } from "../sessions/items.ts";
import { type TranscriptSource } from "../sessions/transcript-source.ts";
import { openGoal } from "../harness/goal.ts";
import { cronIsActive } from "../cron/cron-store.ts";
import { projectIdFromGroupRef, type Project, type ProjectStore } from "../projects/project-store.ts";

import { type AppDeps, type SessionPinView, type TranscriptWindow } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import { EXIT_ONLY_PATTERN } from "../monitors/monitor-broker.ts";
import { tenant } from "../tenant.ts";

export interface SessionKit {
  deps: AppDeps;
  h: AppHelpers;
  transcripts: TranscriptSource;
}

export const MAX_SESSION_PINS = 50;
export const MAX_PIN_TEXT_CHARS = 2000;
const PIN_PREVIEW_CHARS = 240;
const ENTRIES_PER_TURN_ESTIMATE = 40;
const TAIL_WINDOW_ENTRY_CAP = 2000;

type ReadTranscript = (opts?: GetItemsOptions) => ReturnType<TranscriptSource["forRender"]>;

export async function readTail(read: ReadTranscript, window?: TranscriptWindow) {
  let limit =
    window?.tailTurns === undefined || window.sinceSeq !== undefined
      ? undefined
      : Math.min(window.tailTurns * ENTRIES_PER_TURN_ESTIMATE, TAIL_WINDOW_ENTRY_CAP);
  let result = await read({ limit, beforeSeq: window?.beforeSeq, sinceSeq: window?.sinceSeq });
  while (limit !== undefined && result.earlier > 0 && result.items.filter(isUserMessage).length < window!.tailTurns!) {
    limit *= 2;
    result = await read({ limit, beforeSeq: window?.beforeSeq });
  }
  const w = windowedTranscript(result.items, window);
  return { all: result.items, items: w.items, earlier: w.earlier + result.earlier };
}

export const GOAL_CANCEL_LEASE_WAIT_MS = 30_000;

export const MAX_LISTED_CHILDREN = 500;

export const pinView = (
  rec: { id: string; text?: string; entrySeq?: number; addedBy: string; createdAt: number },
  entry?: Item,
): SessionPinView => {
  const preview = entry ? proseText(entry) : null;
  return {
    id: rec.id,
    ...(rec.text ? { text: rec.text } : {}),
    ...(rec.entrySeq !== undefined ? { entrySeq: rec.entrySeq } : {}),
    ...(preview ? { preview: preview.slice(0, PIN_PREVIEW_CHARS) } : {}),
    addedBy: rec.addedBy,
    createdAt: rec.createdAt,
  };
};

export const decoratedPins = async (
  pins: readonly { id: string; text?: string; entrySeq?: number; addedBy: string; createdAt: number }[],
  visibleToReader: readonly Item[],
  resolveMissing: (seq: number) => Promise<Item | undefined>,
): Promise<SessionPinView[]> => {
  if (!pins.length) return [];
  const bySeq = new Map(visibleToReader.map((e) => [e.seq, e]));
  return Promise.all(
    pins.map(async (p) => {
      const entry =
        p.entrySeq !== undefined ? (bySeq.get(p.entrySeq) ?? (await resolveMissing(p.entrySeq))) : undefined;
      return pinView(p, entry);
    }),
  );
};

export const readFor =
  (k: SessionKit, sessionId: string, principalId?: string): ReadTranscript =>
  (opts) =>
    principalId === undefined
      ? k.transcripts.forRender(sessionId, opts)
      : k.transcripts.forViewer(sessionId, principalId, opts);

export const tenureOf = async (k: SessionKit, sessionId: string, principalId: string) =>
  (await k.deps.sessions.participantWindowsOf(sessionId)).find((w) => w.principalId === principalId);

export const viewerStoredEntryAt = async (k: SessionKit, sessionId: string, principalId: string, seq: number) =>
  (await k.deps.sessions.visibleItems(sessionId, principalId, { sinceSeq: seq, beforeSeq: seq + 1 }))[0];

export const entryAt = async (k: SessionKit, sessionId: string, seq: number, principalId?: string) => {
  const latest = await k.deps.sessions.latestItemSeq(sessionId);
  if (seq > latest) return undefined;
  const read = readFor(k, sessionId, principalId);
  let scoped = (await read({ limit: latest - seq + 1 })).items;
  if (scoped.length && scoped[0]!.seq > seq) scoped = (await read()).items;
  return (
    scoped.find((e) => e.seq === seq) ??
    (await (principalId === undefined
      ? k.deps.sessions.getItem(sessionId, seq)
      : viewerStoredEntryAt(k, sessionId, principalId, seq)))
  );
};

const slackDmChannel = (session: { surface?: string; threadRef: string }): string | null =>
  surfaceProfile(session.surface).dmContainer?.(session.threadRef) ?? null;

export const mirrorNativePin = async (
  k: SessionKit,
  session: { id: string; surface?: string; threadRef: string },
  pinId: string,
  entrySeq: number | undefined,
  remove: boolean,
): Promise<void> => {
  if (entrySeq === undefined || !k.deps.outbound) return;
  const channel = slackDmChannel(session);
  if (!channel) return;
  const entry = await entryAt(k, session.id, entrySeq);
  const ts = entry ? messageTs(entry) : null;
  if (!ts) return;
  await k.deps.outbound
    .send({
      destination: { type: "slack", target: channel, pin: { messageTs: ts, ...(remove ? { remove: true } : {}) } },
      text: "",
      idempotencyKey: `session-pin:${pinId}:${remove ? "remove" : "add"}`,
    })
    .catch(swallowAs("pins: mirror the pin in Slack", undefined));
};

export const editableProject = async (k: SessionKit, id: string, principalId: string) => {
  if (!k.deps.projects) return { status: "not_found" as const };
  if (!k.deps.identity.isInternal(k.deps.identity.classify(principalId))) return { status: "forbidden" as const };
  const existing = await k.deps.projects.get(id);
  if (!existing || existing.orgId !== tenant().orgId) return { status: "not_found" as const };
  return { status: "ok" as const, existing, projects: k.deps.projects };
};

export const withProjectView = async (k: SessionKit, result: Awaited<ReturnType<ProjectStore["rename"]>>) =>
  result.status === "ok" ? { ...result, project: await k.h.projectView(result.project) } : result;

export const continuable = async (k: SessionKit, principalId: string, session: Session): Promise<Session> => ({
  ...session,
  canContinue: await k.h.canContinueOnWeb(principalId, session),
});

export const withProjectMembers = <T>(
  k: SessionKit,
  groupRef: string,
  principalId: string,
  fn: (members: readonly string[], project: Project) => Promise<T>,
): Promise<T | null> => {
  const projects = k.deps.projects;
  if (!projects) return Promise.resolve(null);
  return projects.withRosterLock(projectIdFromGroupRef(groupRef)!, async (project) => {
    if (project.orgId !== tenant().orgId) return null;
    const members = await projects.members(groupRef);
    return members?.includes(principalId) ? fn(members, project) : null;
  });
};

export async function decorateSessions(k: SessionKit, principalId: string, all: Session[]): Promise<Session[]> {
  const visibleById = new Map(all.map((session) => [session.id, session]));
  const roots = all.map((session) => session.id);
  const descendants = roots.length ? await k.deps.sessions.descendantsOf(roots) : [];
  const descendantIds = new Set(descendants.map((d) => d.id));
  const approvalRows: PendingApprovalRecord[] = [];
  const approvalIds = [...visibleById.keys(), ...descendantIds];
  const approvals = approvalIds.length ? await k.deps.approvals?.forSessions(approvalIds) : [];
  for (const [, record] of approvals ?? []) {
    const session = visibleById.get(record.sessionId);
    if (
      session
        ? await k.h.approvalRecordIsCurrent(record, session)
        : descendantIds.has(record.sessionId) && (await k.h.approvalRecordIsCurrent(record))
    )
      approvalRows.push(record);
  }
  const waiting = new Set(approvalRows.filter((r) => r.blocksInput !== false).map((r) => r.sessionId));
  const workingThreadRefs = await workingSessionThreadRefs(k.deps.sessions, k.deps.runs, waiting);
  const sharedAccess = new Map<string, Promise<boolean>>(
    all
      .filter((s) => {
        const { kind, ref } = parseScopeId(s.scopeId);
        return kind === "group" && projectIdFromGroupRef(ref);
      })
      .map((s) => [s.scopeId, Promise.resolve(true)]),
  );
  const sessions = await Promise.all(
    all
      .filter(
        (s) =>
          s.hasEntries !== false || Boolean(s.title?.trim()) || workingThreadRefs.has(s.threadRef) || waiting.has(s.id),
      )
      .map(async ({ hasEntries: _hasEntries, ...s }) => ({
        ...s,
        canContinue: await k.h.canContinueOnWeb(principalId, s, sharedAccess),
      })),
  );
  const now = Date.now();
  const tally = (refs: Array<string | undefined>) => {
    const counts = new Map<string, number>();
    for (const ref of refs) if (ref) counts.set(ref, (counts.get(ref) ?? 0) + 1);
    return counts;
  };
  const jobCounts = tally(
    ((await k.deps.processes?.listLive(now)) ?? []).map((rec) =>
      rec.kind === "background" ? rec.sessionRef : undefined,
    ),
  );
  const watchCounts = tally(
    ((await k.deps.monitors?.enabled()) ?? []).map((m) =>
      m.expiresAt > now && m.pattern !== EXIT_ONLY_PATTERN ? m.threadRef : undefined,
    ),
  );
  const cronCounts = tally(
    (await k.deps.crons.list())
      .filter(cronIsActive)
      .flatMap((c) => [...new Set([c.destination?.target, c.sessionRef])]),
  );
  const working = sessions.filter((s) => workingThreadRefs.has(s.threadRef));
  const idleChildren = sessions.filter(
    (s) => s.parentSessionId && !workingThreadRefs.has(s.threadRef) && !waiting.has(s.id),
  );
  const [latestRuns, sessionGoals] = await Promise.all([
    k.deps.runs.latestForThreads([...working, ...idleChildren].map((s) => s.threadRef)),
    k.deps.sessions.goals(working.map((s) => s.id)),
  ]);
  const failedChildren = new Set<string>();
  for (const s of idleChildren) {
    const run = latestRuns.get(s.threadRef);
    if (run?.status === "failed" || run?.result?.status === "failed") failedChildren.add(s.id);
  }
  const goals = new Map<
    string,
    { objective: string; activeMs: number; runningSince?: number; floor?: Record<string, number> }
  >();
  for (const s of working) {
    const goal = openGoal(sessionGoals.get(s.id));
    if (!goal) continue;
    const runningSince = latestRuns.get(s.threadRef)?.startedAt ?? undefined;
    if (goal.status === "active")
      goals.set(s.id, {
        objective: goal.objective,
        activeMs: goal.activeMs ?? 0,
        ...(runningSince ? { runningSince: Math.max(runningSince, goal.activeSince ?? goal.createdAt) } : {}),
        ...(goal.floor ? { floor: { ...goal.floor } } : {}),
      });
  }
  const subagents = new Map<string, { running: number; waiting: number }>();
  for (const d of descendants) {
    const isWaiting = waiting.has(d.id);
    if (!isWaiting && !workingThreadRefs.has(d.threadRef)) continue;
    const counts = subagents.get(d.rootId) ?? { running: 0, waiting: 0 };
    counts[isWaiting ? "waiting" : "running"]++;
    subagents.set(d.rootId, counts);
  }
  return sessions.map((s) => ({
    ...s,
    ...(workingThreadRefs.has(s.threadRef) ? { working: true } : {}),
    ...(waiting.has(s.id) ? { awaitingInput: true } : {}),
    ...(failedChildren.has(s.id) ? { lastTurnFailed: true } : {}),
    ...(jobCounts.has(s.threadRef) ? { backgroundJobs: jobCounts.get(s.threadRef)! } : {}),
    ...(watchCounts.has(s.threadRef) ? { watches: watchCounts.get(s.threadRef)! } : {}),
    ...(cronCounts.has(s.threadRef) ? { crons: cronCounts.get(s.threadRef)! } : {}),
    ...(goals.has(s.id) ? { goal: goals.get(s.id)! } : {}),
    ...(subagents.has(s.id) ? { subagents: subagents.get(s.id)! } : {}),
  }));
}
