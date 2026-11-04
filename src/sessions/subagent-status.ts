import type { Session } from "../types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { SessionMailbox } from "./session-mailbox.ts";
import { xmlEscape } from "../util/message-tag.ts";

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

export async function openChildren(deps: SubagentActivityDeps, children: readonly Session[]): Promise<Session[]> {
  if (!children.length) return [];
  const descendants = await deps.sessions.descendantsOf(children.map((child) => child.id));
  const threads = children.map((child) => child.threadRef);
  const [active, finished] = await Promise.all([
    deps.runs.activeForThreads([...threads, ...descendants.map((d) => d.threadRef)]),
    deps.runs.lastFinishedForThreads(threads),
  ]);
  return children.filter((child) => {
    const last = finished.get(child.threadRef);
    return (
      active.has(child.threadRef) ||
      descendants.some((d) => d.rootId === child.id && active.has(d.threadRef)) ||
      (!!last && !last.result?.stopped && subagentOutcome(last).kind === "awaiting_input")
    );
  });
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
  if (!children.length) return "";
  return xmlEscape(
    [
      "Subagents opened from this conversation that are still working or blocked:",
      ...children.map(
        ({ session, activity }) =>
          `- ${clip(titleOf(session), 80)} (${session.id}) — ${renderSubagentActivity(activity)}`,
      ),
    ].join("\n"),
  );
}
