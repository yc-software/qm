import type { Session } from "../types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { SessionMailbox } from "./session-mailbox.ts";

export type SubagentMailKind = "final_answer" | "no_reply" | "awaiting_input" | "errored" | "refused";

export function subagentOutcome(run: Pick<Run, "status" | "result">): { kind: SubagentMailKind; body: string } {
  const result = run.result;
  if (run.status === "failed" || result?.status === "failed")
    return { kind: "errored", body: result?.reason ?? "the turn failed" };
  if (result?.pendingApprovals?.length || result?.status === "pending_approval")
    return {
      kind: "awaiting_input",
      body: result.pendingApprovals?.map((a) => a.command).join("; ") ?? "a command needs human approval",
    };
  if (result?.status === "refused") return { kind: "refused", body: result.reason ?? "the turn was refused" };
  if (result?.status === "ok") {
    const reply = result.reply?.trim();
    if (reply) return { kind: "final_answer", body: reply };
    const files = result.attachments?.map((file) => file.name) ?? [];
    if (files.length) return { kind: "final_answer", body: `Produced ${files.join(", ")}.` };
  }
  return { kind: "no_reply", body: "completed without sending a reply." };
}

export type RunState = "running" | "pending" | "idle";

export function runState(run: Pick<Run, "status"> | null | undefined): RunState {
  if (run?.status === "running") return "running";
  return run?.status === "pending" ? "pending" : "idle";
}

export interface SubagentActivity {
  status: RunState;
  stepAgoMs?: number;
  startedAgoMs?: number;
  tool?: string;
  purpose?: string;
  outcome?: string;
  liveDescendants: number;
  unread: number;
}

export interface SubagentActivityDeps {
  sessions: Pick<SessionStore, "descendantsOf" | "latestToolSteps">;
  runs: Pick<RunStore, "activeForThreads" | "lastFinishedForThreads">;
  mailbox: Pick<SessionMailbox, "pending">;
}

export async function visibleChildren(
  deps: { sessions: Pick<SessionStore, "childrenOf" | "getForParticipant"> },
  caller: { session: Session; scopeId: string; request: { actor: { id: string } } },
): Promise<Session[]> {
  const visible: Session[] = [];
  for (const child of await deps.sessions.childrenOf(caller.session.id))
    if (child.scopeId === caller.scopeId && (await deps.sessions.getForParticipant(child.id, caller.request.actor.id)))
      visible.push(child);
  return visible;
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
      status: runState(current),
      ...(step ? { stepAgoMs: Math.max(0, now - step.at), tool: step.tool } : {}),
      ...(started ? { startedAgoMs: Math.max(0, now - started) } : {}),
      ...(step?.purpose ? { purpose: step.purpose } : {}),
      ...(last ? { outcome: last.result?.stopped ? "stopped" : subagentOutcome(last).kind } : {}),
      liveDescendants: descendants.filter((d) => d.rootId === session.id && active.has(d.threadRef)).length,
      unread: inboxes[index]?.length ?? 0,
    };
    return { session, activity };
  });
}

export async function sessionActivity(deps: SubagentActivityDeps, session: Session): Promise<SubagentActivity> {
  const [row] = await subagentActivity(deps, [session]);
  return row?.activity ?? { status: "idle", liveDescendants: 0, unread: 0 };
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

export function renderSubagentActivity(activity: SubagentActivity): string {
  const parts: string[] = [activity.status];
  if (activity.status !== "running" && activity.outcome) parts.push(`last turn ${activity.outcome}`);
  if (activity.stepAgoMs !== undefined) parts.push(`last step ${activity.tool} ${ago(activity.stepAgoMs)} ago`);
  if (activity.startedAgoMs !== undefined) parts.push(`started ${ago(activity.startedAgoMs)} ago, no tool step yet`);
  if (activity.status === "running" && activity.purpose) parts.push(`latest purpose: ${activity.purpose}`);
  if (activity.liveDescendants) parts.push(count(activity.liveDescendants, "live descendant", "live descendants"));
  if (activity.unread) parts.push(count(activity.unread, "unread message", "unread messages"));
  return parts.join("; ");
}

export function liveSubagentsNote(
  children: readonly { session: Session; activity: SubagentActivity }[],
  titleOf: (session: Session) => string,
): string {
  const live = children.filter(({ activity }) => activity.status !== "idle");
  if (!live.length) return "";
  return [
    "Subagents opened from this conversation that are still running or queued:",
    ...live.map(
      ({ session, activity }) => `- ${titleOf(session)} (${session.id}) — ${renderSubagentActivity(activity)}`,
    ),
  ].join("\n");
}
