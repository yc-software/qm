import type { Session } from "../types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "./session-store.ts";
import { xmlEscape } from "../util/message-tag.ts";
import { mailOf, pendingWork } from "./subagent-mail.ts";

type RunState = "running" | "pending" | "idle";

export function runState(run: Pick<Run, "status"> | null | undefined): RunState {
  if (run?.status === "running") return "running";
  return run?.status === "pending" ? "pending" : "idle";
}

export type SessionStatus = RunState | "waiting on subagents";

export interface SubagentActivity {
  status: SessionStatus;
  stepAgoMs?: number;
  startedAgoMs?: number;
  tool?: string;
  purpose?: string;
  outcome?: string;
  liveDescendants: number;
  unread: number;
}

export type SubagentActivityDeps = Parameters<typeof pendingWork>[0] & {
  sessions: Pick<SessionStore, "descendantsOf" | "latestToolSteps">;
  runs: Pick<RunStore, "activeForThreads" | "lastFinishedForThreads">;
};

export async function visibleChildren(
  deps: { sessions: Pick<SessionStore, "getForParticipant"> },
  caller: { scopeId: string; request: { actor: { id: string } } },
  children: readonly Session[],
): Promise<Session[]> {
  const inScope = children.filter((child) => child.scopeId === caller.scopeId);
  const seen = await Promise.all(
    inScope.map((child) => deps.sessions.getForParticipant(child.id, caller.request.actor.id)),
  );
  return inScope.filter((_, index) => seen[index]);
}

export async function subagentActivity(
  deps: SubagentActivityDeps,
  sessions: readonly Session[],
  now = Date.now(),
): Promise<{ session: Session; activity: SubagentActivity }[]> {
  if (!sessions.length) return [];
  const descendants = await deps.sessions.descendantsOf(sessions.map((s) => s.id));
  const threads = sessions.map((s) => s.threadRef);
  const [active, finished, inboxes] = await Promise.all([
    deps.runs.activeForThreads([...threads, ...descendants.map((d) => d.threadRef)]),
    deps.runs.lastFinishedForThreads(threads),
    Promise.all(sessions.map((s) => deps.mailbox.pending(s.id))),
  ]);
  const waiting = await Promise.all(sessions.map((s) => (active.has(s.threadRef) ? 0 : pendingWork(deps, s))));
  const runs = sessions.flatMap((s) => [active.get(s.threadRef), finished.get(s.threadRef)].flatMap((r) => r ?? []));
  const steps = await deps.sessions.latestToolSteps(runs.map((run) => run.id));
  const stepOf = (run: Run | undefined) => (run ? steps.get(run.id.toLowerCase()) : undefined);
  return sessions.map((session, index) => {
    const current = active.get(session.threadRef);
    const last = finished.get(session.threadRef);
    const running = current?.status === "running";
    const step = running ? stepOf(current) : (stepOf(current) ?? stepOf(last));
    const started = running && !step ? current.startedAt : null;
    const activity: SubagentActivity = {
      status: !current && waiting[index] ? "waiting on subagents" : runState(current),
      ...(step ? { stepAgoMs: Math.max(0, now - step.at), tool: step.tool } : {}),
      ...(started ? { startedAgoMs: Math.max(0, now - started) } : {}),
      ...(step?.purpose ? { purpose: step.purpose } : {}),
      ...(last
        ? { outcome: mailOf(last, last.status === "failed" || last.result?.status === "failed", undefined, 0).kind }
        : {}),
      liveDescendants: descendants.filter((d) => d.rootId === session.id && active.has(d.threadRef)).length,
      unread: inboxes[index]?.length ?? 0,
    };
    return { session, activity };
  });
}

export async function sessionActivity(
  deps: SubagentActivityDeps,
  session: Session,
): Promise<SubagentActivity | undefined> {
  return (await subagentActivity(deps, [session]))[0]?.activity;
}

function ago(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

export function renderSubagentActivity(activity: SubagentActivity): string {
  const parts: string[] = [activity.status];
  if (activity.status !== "running" && activity.outcome) parts.push(`last turn ${activity.outcome}`);
  if (activity.stepAgoMs !== undefined) {
    const tool = activity.tool ? `${clip(activity.tool, 40)} ` : "";
    parts.push(`last step ${tool}${ago(activity.stepAgoMs)} ago`);
  }
  if (activity.startedAgoMs !== undefined) parts.push(`started ${ago(activity.startedAgoMs)} ago, no tool step yet`);
  if (activity.status === "running" && activity.purpose) parts.push(`working on: ${clip(activity.purpose, 120)}`);
  if (activity.liveDescendants) parts.push(count(activity.liveDescendants, "live descendant", "live descendants"));
  if (activity.unread)
    parts.push(count(activity.unread, "message it has not read yet", "messages it has not read yet"));
  return parts.join("; ");
}

export function liveSubagentsNote(
  children: readonly { session: Session; activity: SubagentActivity }[],
  titleOf: (session: Session) => string,
): string {
  const open = children.filter(({ activity }) => activity.status !== "idle" || activity.outcome === "awaiting_input");
  if (!open.length) return "";
  return xmlEscape(
    [
      "Subagents opened from this conversation that are still working or blocked:",
      ...open.map(
        ({ session, activity }) =>
          `- ${clip(titleOf(session), 80)} (${session.id}) — ${renderSubagentActivity(activity)}`,
      ),
    ].join("\n"),
  );
}
