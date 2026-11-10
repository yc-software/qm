import { leaseLapsed, type Run, type RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import type { MonitorStore } from "../monitors/monitor-store.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";

export interface SessionWorkStep {
  purpose?: string | undefined;
}

export interface SessionWorkBranch {
  id: string;
  title: string;
  step: string | undefined;
  background?: "job" | "watch";
}

export interface SessionWork {
  sessionId?: string;
  busy: boolean;
  running?: SessionWorkStep;
  queued?: SessionWorkStep;
  branches: SessionWorkBranch[];
  returning: boolean;
  background?: SessionWorkStep & { kind: "job" | "watch" };
  delivering: boolean;
}

export interface SessionWorkDeps {
  runs: Pick<RunStore, "inFlightForThread" | "activeForThreads" | "pendingReturns">;
  sessions?: Pick<SessionStore, "getByThread" | "childrenOf" | "descendantsOf" | "latestToolSteps">;
  processes?: Pick<ProcessRegistry, "liveByScope">;
  monitors?: Pick<MonitorStore, "ownedBy">;
  deliveries?: Pick<DeliveryStore, "pending">;
}

export function createSessionWork(deps: SessionWorkDeps, now = Date.now) {
  return {
    async of(threadRef: string, surface: string): Promise<SessionWork> {
      const own = (await deps.runs.inFlightForThread(threadRef)).filter((run) => !run.request.privateSessionMessage);
      const session = await deps.sessions?.getByThread(threadRef);
      const children = session
        ? ((await deps.sessions?.childrenOf(session.id)) ?? []).filter((child) => child.scopeId === session.scopeId)
        : [];
      const descendants = children.length
        ? ((await deps.sessions?.descendantsOf(children.map((child) => child.id))) ?? [])
        : [];
      const lineage = [...children, ...descendants].map((s) => s.threadRef);
      const threads = new Set([threadRef, ...lineage]);
      const jobs = session
        ? ((await deps.processes?.liveByScope(session.scopeId, now())) ?? []).filter(
            (job) => job.kind === "background" && !!job.sessionRef && threads.has(job.sessionRef),
          )
        : [];
      const watches = session
        ? ((await deps.monitors?.ownedBy(session.scopeId)) ?? []).filter(
            (monitor) => monitor.enabled && threads.has(monitor.threadRef) && monitor.expiresAt > now(),
          )
        : [];
      const childRuns = lineage.length ? await deps.runs.activeForThreads(lineage) : new Map<string, Run>();
      const returning = lineage.length > 0 && (await deps.runs.pendingReturns(1, "", lineage)).length > 0;
      const steps =
        (await deps.sessions?.latestToolSteps([...own, ...childRuns.values()].map((run) => run.id))) ??
        new Map<string, { purpose?: string }>();
      const purposeOf = (run: Run) => steps.get(run.id.toLowerCase())?.purpose;
      const backgroundOf = (ref: string): (SessionWorkStep & { kind: "job" | "watch" }) | undefined => {
        const watch = watches.find((m) => m.threadRef === ref);
        if (watch) return { kind: "watch", purpose: watch.purpose };
        const job = jobs.find((j) => j.sessionRef === ref);
        return job && { kind: "job", purpose: job.purpose };
      };
      const branchOf = (ref: string): Omit<SessionWorkBranch, "id" | "title"> | undefined => {
        const run = childRuns.get(ref);
        if (run) return { step: purposeOf(run) };
        const background = backgroundOf(ref);
        return background && { step: background.purpose, background: background.kind };
      };
      const branches = children.flatMap((child) => {
        const refs = [child, ...descendants.filter((d) => d.rootId === child.id)].map((s) => s.threadRef);
        const work = refs.map(branchOf).find(Boolean);
        return work ? [{ id: child.id, title: child.title || "Subagent", ...work }] : [];
      });
      const running = own.find((run) => run.status === "running" && !leaseLapsed(run, now()));
      const queued = running ? undefined : own[0];
      const background = backgroundOf(threadRef);
      const delivering =
        !own.length &&
        !branches.length &&
        !returning &&
        !background &&
        ((await deps.deliveries?.pending(surface, threadRef)) ?? []).length > 0;
      return {
        ...(session ? { sessionId: session.id } : {}),
        busy: own.length > 0 || branches.length > 0 || returning || !!background || delivering,
        ...(running ? { running: { purpose: purposeOf(running) } } : {}),
        ...(queued ? { queued: { purpose: purposeOf(queued) } } : {}),
        branches,
        returning,
        ...(background ? { background } : {}),
        delivering,
      };
    },
  };
}

export type SessionWorkReader = ReturnType<typeof createSessionWork>;
