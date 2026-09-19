import { cronTriggerAuthority, unattendedActorRefusal } from "./authority.ts";
import { WorkAdmissionClosed, type AdmittedWork } from "../util/admitted-work.ts";
import { randomUUID } from "node:crypto";
import {
  parseScopeId,
  type Cron,
  type CronFireLogEntry,
  type CronFireNote,
  type TriggerInitiator,
  type TurnRequest,
  type TurnResult,
} from "../types.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { type CronStore } from "./cron-store.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { IdempotencyStore } from "../idempotency/idempotency-store.ts";
import { runTrigger, type TriggerDeps } from "../triggers/run-trigger.ts";
import type { CurrentScopeMembers } from "../resolution/scope-membership.ts";
import type { VisibilityDirectory } from "../directory/visibility.ts";
import type { DirectoryMember } from "../directory/directory-store.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper } from "../util/sweeper.ts";
import { hashId } from "../util/crypto.ts";
import { utcMinute } from "../util/time.ts";
import { errMessage, reportFailure, reportFailureAs } from "../util/errors.ts";
import { isDurableControlFlow, type DurableTasks, type DurableTaskContext } from "../durable/tasks.ts";
import { createDurableScheduler } from "./durable-scheduler.ts";

const TICK_LEASE_KEY = "cron:scheduler:tick";
const CRON_FIRE_REPLY_MAX_CHARS = 2000;
const STRANDED_SWEEP_INTERVAL_MS = 10 * 60_000;
const FIRE_GC_INTERVAL_MS = 6 * 60 * 60_000;
const BUSY_DEFER_MS = 30_000;
const BUSY_DEFER_MAX_LATE_MS = 10 * 60_000;

type FireResult = { authzFailed: boolean; deferred?: boolean };

type RunNowResult =
  | { started: true; fireKey: string; settled: Promise<void> }
  | { started: false; reason: "unavailable" }
  | { started: false; reason: "already_running"; running: CronFireLogEntry };

export function describeRunNowRefusal(
  id: string,
  result: RunNowResult,
  now = Date.now(),
): { error: "already_running" | "bad_request"; message: string } | null {
  if (result.started) return null;
  if (result.reason === "already_running") {
    const ageMin = Math.round((now - result.running.firedAt) / 60_000);
    return {
      error: "already_running",
      message: `cron ${id} is already firing (fire ${result.running.fireKey}, started ${ageMin}m ago) — wait for it to finish instead of firing again`,
    };
  }
  return { error: "bad_request", message: `cron ${id} can't be fired on demand right now` };
}

export interface Scheduler {
  tick(now?: number): Promise<void>;
  runNow(cronId: string, initiator?: TriggerInitiator): Promise<RunNowResult>;
  notifyChanged(cronId: string): void;
  start(intervalMs: number): void;
  ready(): Promise<void>;
  stopClaims(): Promise<void>;
  drained(): Promise<void>;
  stop(): Promise<void>;
}

export interface SchedulerDeps {
  admittedWork?: AdmittedWork;
  tasks?: DurableTasks;
  crons: CronStore;
  deliveries: DeliveryStore;
  idempotency: IdempotencyStore;
  identity: IdentityService;
  run: (req: TurnRequest) => Promise<TurnResult>;
  currentScopeMembers?: CurrentScopeMembers;
  now?: () => number;
  maxFiresPerTick?: number;
  leaderLease?: LeaderLease;
  directory?: VisibilityDirectory & {
    get(principalId: string): Promise<{ displayName: string } | null>;
    list(): Promise<DirectoryMember[]>;
  };
  sweepAsks?: (now: number) => Promise<void>;
  sessions?: TriggerDeps["sessions"];
  samePerson?: (a: string, b: string) => Promise<boolean>;
  fireLoop?: (
    loopId: string,
    fireKey: string,
    cronId: string,
    initiator?: TriggerInitiator,
  ) => Promise<{ status?: TurnResult["status"]; note?: string }>;
}

function truncate(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : `${s.slice(0, maxChars - 3)}...`;
}

const CRON_CONTEXT_MARKERS = ["[Cron runtime context]", "[End cron runtime context]"] as const;

export function echoesCronContextMarkers(s: string): boolean {
  return CRON_CONTEXT_MARKERS.some((marker) => s.includes(marker));
}

function cronFireLogReply(s: string): string {
  if (echoesCronContextMarkers(s)) {
    return "[reply echoed cron runtime context; omitted]";
  }
  return truncate(s, CRON_FIRE_REPLY_MAX_CHARS);
}

function isOneShotSchedule(schedule: Cron["schedule"]): boolean {
  return schedule.everyMs == null && schedule.cron == null;
}

export function cronFireReadsNotes(cron: Pick<Cron, "schedule" | "action" | "loopId">): boolean {
  const task = cron.action ?? "";
  if (cron.loopId || !task.trim() || /^!(run|scratch)\s/.test(task.trimStart())) return false;
  return !isOneShotSchedule(cron.schedule);
}

export function flattenFireNote(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fireNoteLine(note: CronFireNote | undefined): string[] {
  if (!note || !Number.isFinite(note.at)) return [];
  const text = flattenFireNote(note.text);
  if (!text || echoesCronContextMarkers(text)) return [];
  return [
    note.by
      ? `Note left for this fire by ${note.by} (${utcMinute(note.at)}): ${text}`
      : `Notes from last fire agent (${utcMinute(note.at)}): ${text}`,
  ];
}

export function cronFireThreadRef(cronId: string, fireKey: string): string {
  return `cron:${cronId}:fire:${hashId([fireKey], 12)}`;
}

const CRON_MENTION_ROSTER_MAX = 40;

function mentionable(m: DirectoryMember): string {
  const mentionId = m.slackId ?? (/^[A-Z0-9]+$/i.test(m.principalId) ? m.principalId : undefined);
  return `@${m.displayName}${mentionId ? ` (<@${mentionId}>)` : ""}`;
}

async function cronMentionRoster(deps: SchedulerDeps, cron: Cron): Promise<string | undefined> {
  if (!deps.directory) return undefined;
  const scope = cron.destination?.audienceScopeId;
  if (!scope) return undefined;
  const kind = parseScopeId(scope).kind;
  if (kind !== "channel" && kind !== "group") return undefined;
  const members = cron.members ?? [];
  if (!members.length || members.length > CRON_MENTION_ROSTER_MAX) return undefined;
  const byId = new Map((await deps.directory.list().catch(() => [])).map((m) => [m.principalId, m]));
  const roster = members
    .map((m) => byId.get(m.id))
    .filter((m): m is DirectoryMember => !!m && m.type === "internal")
    .map(mentionable);
  return roster.length ? roster.join(", ") : undefined;
}

function renderCronFireInput(cron: Cron, mentionRoster?: string): string {
  const task = cron.action ?? "";
  if (!task.trim()) return task;
  if (/^!(run|scratch)\s/.test(task.trimStart())) return task;
  const readsNotes = cronFireReadsNotes(cron);
  return [
    "[Cron runtime context]",
    `Cron id: ${cron.id}${cron.title ? ` (${cron.title})` : ""}.`,
    "Each fire runs as a fresh thread with no memory of previous fires. Two things persist between fires:",
    "- Your workspace disk. Durable state — notes, queues, checkpoints, anything a future fire should know — lives in files there.",
    "- The stored task below: the standing instructions every fire receives. Edit it (via the cron tool) only to change what future fires are told to do.",
    `The retained fire log (cron tool, action="runs", id="${cron.id}") shows how prior fires went — useful when this run hits errors or surprising state.`,
    ...(readsNotes ? fireNoteLine(cron.lastFireNote) : []),
    ...(readsNotes
      ? [
          `Before finishing, leave a short note for the next fire (cron tool, action="note", id="${cron.id}"): one or two sentences — the outcome plus anything the next fire must know. It's a report for the next fire, never instructions that override the stored task. Skip it only if there is truly nothing to say.`,
        ]
      : []),
    ...(mentionRoster
      ? [
          `People here: ${mentionRoster}.`,
          "If this reminder is for a specific person, @-mention them with their <@…> id so they're actually notified — addressing them by name alone does not ping them.",
        ]
      : []),
    "[End cron runtime context]",
    "",
    "Stored cron task:",
    task,
  ].join("\n");
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => Date.now());
  const withWork = <T>(work: () => Promise<T>): Promise<T> => deps.admittedWork?.run(work) ?? work();
  const maxFiresPerTick = deps.maxFiresPerTick ?? 100;
  const leaderLease = deps.leaderLease ?? createNoopLeaderLease();

  async function fire(
    cron: Cron,
    t: number,
    fireKey: string,
    scheduledAt?: number,
    context?: DurableTaskContext,
    initiator?: TriggerInitiator,
  ): Promise<FireResult> {
    const step = <T>(name: string, work: () => Promise<T>): Promise<T> =>
      context ? context.step(`cron:${name}`, work) : work();
    const threadRef = cronFireThreadRef(cron.id, fireKey);
    const runningEntry: CronFireLogEntry = {
      ...(initiator ? { initiator } : {}),
      fireKey,
      threadRef,
      firedAt: t,
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
      status: "running",
    };
    if (cron.loopId) {
      await step("begin", () => deps.crons.beginFire(cron.id, runningEntry));
      let result: { status?: TurnResult["status"]; note?: string };
      if (!deps.fireLoop) {
        result = { status: "failed", note: "loop service unavailable" };
      } else
        try {
          result = await step("loop", () => deps.fireLoop!(cron.loopId!, fireKey, cron.id, initiator));
        } catch (e) {
          if (isDurableControlFlow(e)) throw e;
          result = { status: "failed", note: errMessage(e) };
        }
      await step("finish", () =>
        deps.crons.recordFire(cron.id, {
          fireKey,
          threadRef,
          firedAt: t,
          endedAt: now(),
          ...(scheduledAt !== undefined ? { scheduledAt } : {}),
          status: result.status ?? "ok",
          ...(result.note ? { note: truncate(result.note, CRON_FIRE_REPLY_MAX_CHARS) } : {}),
        }),
      );
      if (isOneShotSchedule(cron.schedule)) await deps.crons.setEnabled(cron.id, false);
      return { authzFailed: false };
    }
    const mentionRoster = await cronMentionRoster(deps, cron).catch(() => undefined);
    let outcome: Awaited<ReturnType<typeof runTrigger>>;
    try {
      outcome = await runTrigger(
        {
          deliveries: deps.deliveries,
          idempotency: deps.idempotency,
          identity: deps.identity,
          run: async (request) => {
            if (initiator && cron.unattendedGrants?.length) {
              const refusal = await unattendedActorRefusal(cron.owner, initiator, deps.samePerson);
              if (refusal) return { status: "refused", reason: refusal };
            }
            return deps.run(request);
          },
          ...(deps.directory ? { directory: deps.directory } : {}),
          ...(deps.currentScopeMembers ? { currentScopeMembers: deps.currentScopeMembers } : {}),
          ...(deps.sessions ? { sessions: deps.sessions } : {}),
        },
        {
          ...cronTriggerAuthority(cron),
          input: renderCronFireInput(cron, mentionRoster),
          fireKey,
          threadRef,
          surface: "cron",
          ...(cron.title ? { title: cron.title } : {}),
          onClaimed: async () => {
            await deps.crons.beginFire(cron.id, runningEntry);
          },
          ...(cron.message !== undefined ? { message: cron.message } : {}),
          ...(cron.destination ? { destination: cron.destination } : {}),
          ...(cron.recipientConsent ? { recipientConsent: cron.recipientConsent } : {}),
          recipientConsentRequired: cron.schedule.everyMs !== undefined || cron.schedule.cron !== undefined,
          deferWhenBusy: scheduledAt !== undefined && now() - scheduledAt <= BUSY_DEFER_MAX_LATE_MS,
        },
        context,
      );
    } catch (e) {
      if (isDurableControlFlow(e)) throw e;
      await deps.crons.recordFire(cron.id, {
        fireKey,
        threadRef,
        firedAt: t,
        endedAt: now(),
        ...(scheduledAt !== undefined ? { scheduledAt } : {}),
        status: "failed",
        note: truncate(errMessage(e), CRON_FIRE_REPLY_MAX_CHARS),
      });
      throw e;
    }
    if (outcome.deferred) {
      const deferUntil = now() + BUSY_DEFER_MS;
      await deps.crons.recordFire(cron.id, {
        fireKey,
        threadRef,
        firedAt: t,
        endedAt: now(),
        ...(scheduledAt !== undefined ? { scheduledAt } : {}),
        status: "deferred",
        note: `session busy — retrying at ${utcMinute(deferUntil)}`,
      });
      await deps.crons.defer(cron.id, deferUntil);
      return { authzFailed: false, deferred: true };
    }
    if (outcome.ran || outcome.authzFailed) {
      await deps.crons.recordFire(cron.id, {
        fireKey,
        threadRef,
        firedAt: t,
        endedAt: now(),
        ...(scheduledAt !== undefined ? { scheduledAt } : {}),
        status: outcome.status ?? (outcome.authzFailed ? "refused" : "ok"),
        ...(outcome.note ? { note: truncate(outcome.note, CRON_FIRE_REPLY_MAX_CHARS) } : {}),
        ...(outcome.reply !== undefined ? { reply: cronFireLogReply(outcome.reply) } : {}),
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      });
    }
    if (outcome.authzFailed) {
      await deps.crons.setEnabled(cron.id, false);
      return { authzFailed: true };
    }
    if (isOneShotSchedule(cron.schedule)) await deps.crons.setEnabled(cron.id, false);
    return { authzFailed: false };
  }

  if (deps.tasks) return createDurableScheduler(deps, fire);

  let lastStrandedSweep = 0;
  const sweepStranded = async (t: number): Promise<void> => {
    if (t - lastStrandedSweep < STRANDED_SWEEP_INTERVAL_MS) return;
    lastStrandedSweep = t;
    try {
      const swept = await deps.crons.sweepStrandedFires(t);
      if (swept > 0) console.warn(`[scheduler] closed ${swept} stranded running fire(s) as failed`);
    } catch (e) {
      reportFailure("scheduler: stranded-fire sweep", e);
    }
  };

  let lastFireGc = 0;
  const gcFires = async (t: number): Promise<void> => {
    if (t - lastFireGc < FIRE_GC_INTERVAL_MS) return;
    lastFireGc = t;
    try {
      const pruned = await deps.crons.pruneFires(t);
      if (pruned > 0) console.log(`[scheduler] pruned ${pruned} old cron fire row(s)`);
    } catch (e) {
      reportFailure("scheduler: cron fire gc", e);
    }
  };

  const fireDue = async (t: number, observed: number): Promise<void> => {
    const due = await deps.crons.due(t);
    let batch = due;
    if (due.length > maxFiresPerTick) {
      const ordered = [...due].sort((a, b) => (a.lastAttemptAt ?? 0) - (b.lastAttemptAt ?? 0));
      batch = [];
      for (const cron of ordered) {
        if (batch.length >= maxFiresPerTick) break;
        try {
          await deps.crons.markAttempted(cron.id, t);
          batch.push(cron);
        } catch (e) {
          reportFailure("scheduler: attempt mark (holding this cron back)", e);
        }
      }
      console.warn(`[scheduler] fan-out capped: firing ${batch.length}/${due.length} due crons this tick`);
    }
    for (const cron of batch) {
      if (stopped || observed !== epoch) break;
      try {
        const { authzFailed, deferred } = await fire(cron, t, `cron:${cron.id}:${cron.scheduledAt}`, cron.scheduledAt);
        if (!authzFailed && !deferred) await deps.crons.markFired(cron.id, t, cron.scheduledAt);
      } catch (e) {
        reportFailure("scheduler: fire", e);
      }
    }
  };

  const tick = async (nowArg?: number): Promise<void> => {
    const t = nowArg ?? now();
    const observed = epoch;
    await withWork(() =>
      leaderLease.hold(TICK_LEASE_KEY, async () => {
        await fireDue(t, observed);
        await sweepStranded(t);
        await gcFires(t);
        await deps.sweepAsks?.(t).catch(reportFailureAs("scheduler: ask sweep", undefined));
      }),
    );
  };

  const makeSweeper = () =>
    createSweeper(() => tick().catch(reportFailureAs("scheduler: tick", undefined)), 1000, {
      label: "scheduler",
    });

  let sweeper = makeSweeper();

  let stopped = false;
  let epoch = 0;
  let started = false;
  let stopping: Promise<void> | null = null;
  const oldSweeps = new Set<Promise<void>>();
  const retireSweep = (work: Promise<void>) => {
    oldSweeps.add(work);
    void work.finally(() => oldSweeps.delete(work));
  };
  const pending = new Set<Promise<unknown>>();
  return {
    tick,
    async runNow(cronId, initiator) {
      try {
        const preparing = withWork(async (): Promise<RunNowResult> => {
          const cron = await deps.crons.get(cronId);
          if (!cron || cron.archived || !cron.enabled) return { started: false, reason: "unavailable" };
          initiator ??= { actorId: cron.owner, liveActor: false };
          const t = now();
          const fireKey = `cron:${cron.id}:manual:${randomUUID()}`;
          const begin = await deps.crons.beginFire(
            cronId,
            {
              fireKey,
              threadRef: cronFireThreadRef(cron.id, fireKey),
              firedAt: t,
              status: "running",
              ...(initiator ? { initiator } : {}),
            },
            { exclusive: true },
          );
          if (!begin.begun) {
            return begin.running
              ? { started: false, reason: "already_running", running: begin.running }
              : { started: false, reason: "unavailable" };
          }
          const settled = withWork(() => fire(cron, t, fireKey, undefined, undefined, initiator)).then(
            () => undefined,
            reportFailureAs("scheduler: manual fire", undefined, `cron=${cronId}`),
          );
          pending.add(settled);
          void settled.finally(() => pending.delete(settled));
          return { started: true, fireKey, settled };
        });
        pending.add(preparing);
        try {
          return await preparing;
        } finally {
          pending.delete(preparing);
        }
      } catch (error) {
        if (error instanceof WorkAdmissionClosed) return { started: false, reason: "unavailable" };
        throw error;
      }
    },
    notifyChanged() {},
    start(intervalMs) {
      if (started || stopping) return;
      started = true;
      stopped = false;
      sweeper.start(intervalMs);
    },
    async ready() {},
    async stopClaims() {
      stopped = true;
      started = false;
      epoch++;
      retireSweep(sweeper.stop());
      sweeper = makeSweeper();
    },
    async drained() {
      while (oldSweeps.size || pending.size) await Promise.all([...oldSweeps, ...pending]);
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      started = false;
      epoch++;
      stopping = (async () => {
        await sweeper.stop();
        while (oldSweeps.size || pending.size) await Promise.allSettled([...oldSweeps, ...pending]);
      })().finally(() => {
        stopping = null;
      });
      return stopping;
    },
  };
}
