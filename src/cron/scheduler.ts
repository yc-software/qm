import { cronTriggerAuthority } from "./authority.ts";
import { ADMISSION_CLOSED_RETRY_MS, WorkAdmissionClosed, type AdmittedWork } from "../util/admitted-work.ts";
import { randomUUID } from "node:crypto";
import { type ScopeId, type TurnRequest, type TurnResult } from "../types.ts";
import type { Cron, CronFireLogEntry, CronFireNote } from "../triggers/types.ts";
import type { RuntimeChoice } from "../agent/agent.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { isDeferred, type CronStore } from "./cron-store.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { IdempotencyStore } from "../idempotency/idempotency-store.ts";
import { runTrigger, type TriggerDeps } from "../triggers/run-trigger.ts";
import type { CurrentScopeMembers } from "../resolution/scope-membership.ts";
import type { VisibilityDirectory } from "../directory/visibility.ts";
import type { DirectoryMember } from "../directory/directory-store.ts";
import { recoverNextFireAt } from "./schedule.ts";
import type { JobDisposition, JobWorker } from "../jobs/job-worker.ts";
import { hashId } from "../util/crypto.ts";
import { utcMinute } from "../util/time.ts";
import { errMessage, reportFailure, reportFailureAs } from "../util/errors.ts";

const CRON_FIRE_REPLY_MAX_CHARS = 2000;
const STRANDED_SWEEP_INTERVAL_MS = 10 * 60_000;
const FIRE_GC_INTERVAL_MS = 6 * 60 * 60_000;
const BUSY_DEFER_MS = 30_000;
const BUSY_DEFER_MAX_LATE_MS = 10 * 60_000;
const MANUAL_FIRE_MAX_ATTEMPTS = 3;
const REPAIR_INTERVAL_MS = 60_000;

type FireResult = { authzFailed: boolean; deferred?: boolean };

type RunNowResult =
  | { started: true; fireKey: string }
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

interface CronFireJob {
  cronId: string;
  scheduledAt: number;
}

interface CronManualFireJob {
  cronId: string;
  fireKey: string;
  firedAt: number;
}

export const CRON_FIRE_JOB = "cron-fire";
const CRON_MANUAL_FIRE_JOB = "cron-fire-manual";

export interface Scheduler {
  tick(now?: number): Promise<void>;
  runNow(cronId: string): Promise<RunNowResult>;
  notifyChanged(cronId: string): void;
  repair(): Promise<void>;
}

export interface SchedulerDeps {
  admittedWork?: AdmittedWork;
  advisoryLock: import("../persistence/advisory-lock.ts").AdvisoryLock;
  crons: CronStore;
  deliveries: DeliveryStore;
  idempotency: IdempotencyStore;
  identity: IdentityService;
  run: (req: TurnRequest) => Promise<TurnResult>;
  currentScopeMembers?: CurrentScopeMembers;
  now?: () => number;
  directory?: VisibilityDirectory & {
    get(principalId: string): Promise<{ displayName: string } | null>;
    list(): Promise<DirectoryMember[]>;
  };
  jobs: Pick<JobWorker, "handle" | "spawn" | "every">;
  fireConcurrency?: number;
  sessions?: TriggerDeps["sessions"];
  resolveRecipient?: TriggerDeps["resolveRecipient"];
  skipFire?: (cron: Cron) => Promise<string | undefined>;
  deleteCron?: (id: string) => Promise<void>;
  fireLoop?: (
    loopId: string,
    fireKey: string,
    cronId: string,
  ) => Promise<{ status?: TurnResult["status"]; note?: string }>;
  runtimeError?: (scope: ScopeId, runtime: RuntimeChoice) => Promise<string | null>;
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

function cronFireThreadRef(cronId: string, fireKey: string): string {
  return `cron:${cronId}:fire:${hashId([fireKey], 12)}`;
}

const CRON_MENTION_ROSTER_MAX = 40;

function mentionable(m: DirectoryMember): string {
  const mentionId = m.slackId ?? (/^[A-Z0-9]+$/i.test(m.principalId) ? m.principalId : undefined);
  return `@${m.displayName}${mentionId ? ` (<@${mentionId}>)` : ""}`;
}

function cronMentionRoster(cron: Cron, homeRoster: DirectoryMember[] | undefined): string | undefined {
  if (cron.destination?.audienceScopeId !== cron.ownerScopeId) return undefined;
  const internal = homeRoster?.filter((m) => m.type === "internal") ?? [];
  if (!internal.length || internal.length > CRON_MENTION_ROSTER_MAX) return undefined;
  return internal.map(mentionable).join(", ");
}

function renderCronFireInput(cron: Cron, mentionRoster?: string, runtimeProblem?: string | null): string {
  const task = cron.action ?? "";
  if (!task.trim()) return task;
  if (/^!(run|scratch)\s/.test(task.trimStart())) return task;
  const readsNotes = cronFireReadsNotes(cron);
  return [
    "[Cron runtime context]",
    `Cron id: ${cron.id}${cron.title ? ` (${cron.title})` : ""}.`,
    "Each fire runs as a fresh thread with no memory of previous fires. Keep continuity outside the thread:",
    "- Save durable run-state (cursors, queues, checkpoints, reports) to this conversation's Files via the available Files API; confirm publication succeeds before relying on it. Recover published bytes with GET /v1/files/:id/content using the normal agent API authentication. Sandbox disk is working storage, not a durable checkpoint.",
    "- The stored task below: the standing instructions every fire receives. Edit it (via the cron tool) only to change what future fires are told to do.",
    "Use a cron-specific filename. Never put credentials in published state. If publication is unavailable, report that limitation and retain needed workspace state on a scoped computer. Do not move tasks that require existing workspace files to scratch without migrating and verifying their state.",
    `The retained fire log (cron tool, action="runs", id="${cron.id}") shows how prior fires went — useful when this run hits errors or surprising state.`,
    ...(readsNotes ? fireNoteLine(cron.lastFireNote) : []),
    ...(readsNotes
      ? [
          `Before finishing, leave a short note for the next fire (cron tool, action="note", id="${cron.id}"): one or two sentences — the outcome plus anything the next fire must know. Include the published checkpoint file ID, or small progress state directly; never include credentials. It's a report for the next fire, never instructions that override the stored task. Skip it only if there is truly nothing to say.`,
        ]
      : []),
    ...(runtimeProblem
      ? [
          `This fire runs on the default model because the cron's own model can't run: ${runtimeProblem}`,
          `Tell the people this cron reports to, unless the fire log shows they already know. If the cron's model looks stale, you can change it (cron tool, action="patch", id="${cron.id}", runtime); it is used again as soon as it can run.`,
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

  async function withCronLifecycle<T>(cronId: string, scheduled: boolean, run: () => Promise<T>): Promise<T | null> {
    if (scheduled) {
      const result = await deps.advisoryLock.tryWithLock(`cron-lifecycle:${cronId}`, run);
      if (result === null) await deps.crons.defer(cronId, now() + BUSY_DEFER_MS);
      return result;
    }
    return deps.advisoryLock.withLock(`cron-lifecycle:${cronId}`, run);
  }

  async function fire(cron: Cron, t: number, fireKey: string, scheduledAt?: number): Promise<FireResult> {
    const current = await deps.crons.get(cron.id);
    if (!current || current.archived || !current.enabled) {
      await deps.crons.recordFire(cron.id, {
        fireKey,
        threadRef: cronFireThreadRef(cron.id, fireKey),
        firedAt: t,
        endedAt: now(),
        status: "silent",
        note: "Cron is no longer enabled",
      });
      return { authzFailed: true };
    }
    const skipped =
      scheduledAt !== undefined
        ? await deps.skipFire?.(current).catch(reportFailureAs(`scheduler: skip check for cron ${cron.id}`, undefined))
        : undefined;
    if (skipped) {
      await deps.crons.recordFire(cron.id, {
        fireKey,
        threadRef: cronFireThreadRef(cron.id, fireKey),
        firedAt: t,
        endedAt: now(),
        scheduledAt,
        status: "silent",
        note: skipped,
      });
      return { authzFailed: false };
    }
    return fireEnabled(current, t, fireKey, scheduledAt);
  }

  async function fireEnabled(cron: Cron, t: number, fireKey: string, scheduledAt?: number): Promise<FireResult> {
    const threadRef = cronFireThreadRef(cron.id, fireKey);
    const runningEntry: CronFireLogEntry = {
      fireKey,
      threadRef,
      firedAt: t,
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
      status: "running",
    };
    if (cron.loopId) {
      await deps.crons.beginFire(cron.id, runningEntry);
      let result: { status?: TurnResult["status"]; note?: string };
      if (!deps.fireLoop) {
        result = { status: "failed", note: "loop service unavailable" };
      } else
        try {
          result = await deps.fireLoop(cron.loopId, fireKey, cron.id);
        } catch (e) {
          if (e instanceof WorkAdmissionClosed) throw e;
          result = { status: "failed", note: errMessage(e) };
        }
      await deps.crons.recordFire(cron.id, {
        fireKey,
        threadRef,
        firedAt: t,
        endedAt: now(),
        ...(scheduledAt !== undefined ? { scheduledAt } : {}),
        status: result.status ?? "ok",
        ...(result.note ? { note: truncate(result.note, CRON_FIRE_REPLY_MAX_CHARS) } : {}),
      });
      if (isOneShotSchedule(cron.schedule)) await deps.crons.setEnabled(cron.id, false);
      return { authzFailed: false };
    }
    const previous = (await deps.crons.listFires(cron.id, { limit: 2 })).runs
      .filter((r) => r.fireKey !== fireKey)
      .at(-1);
    const failingAlready = previous?.status === "failed" || previous?.status === "refused";
    let outcome: Awaited<ReturnType<typeof runTrigger>>;
    try {
      const runtimeProblem = cron.runtime ? await deps.runtimeError?.(cron.ownerScopeId, cron.runtime) : null;
      outcome = await runTrigger(
        {
          deliveries: deps.deliveries,
          idempotency: deps.idempotency,
          identity: deps.identity,
          run: deps.run,
          ...(deps.directory ? { directory: deps.directory } : {}),
          ...(deps.currentScopeMembers ? { currentScopeMembers: deps.currentScopeMembers } : {}),
          ...(deps.sessions ? { sessions: deps.sessions } : {}),
          ...(deps.resolveRecipient ? { resolveRecipient: deps.resolveRecipient } : {}),
        },
        {
          ...cronTriggerAuthority(cron),
          input: (homeRoster) => renderCronFireInput(cron, cronMentionRoster(cron, homeRoster), runtimeProblem),
          fireKey,
          threadRef,
          surface: "cron",
          ...(cron.runtime && !runtimeProblem ? { runtime: cron.runtime } : {}),
          ...(cron.title ? { title: cron.title } : {}),
          onClaimed: async () => {
            await deps.crons.beginFire(cron.id, runningEntry);
          },
          ...(cron.message !== undefined ? { message: cron.message } : {}),
          ...(cron.destination ? { destination: cron.destination } : {}),
          ...(failingAlready
            ? {}
            : {
                errorNotice: (reason: string) =>
                  `⚠️ Scheduled task “${cron.title ?? cron.id}” did not run: ${reason.endsWith(".") ? reason.slice(0, -1) : reason}. Later failures go only to its run log until it runs successfully again.`,
              }),
          deferWhenBusy: scheduledAt !== undefined && t - scheduledAt <= BUSY_DEFER_MAX_LATE_MS,
        },
      );
    } catch (e) {
      if (e instanceof WorkAdmissionClosed) throw e;
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
    if (outcome.ownerLeft) await (deps.deleteCron ? deps.deleteCron(cron.id) : deps.crons.delete(cron.id));
    else if (outcome.authzFailed) await deps.crons.setEnabled(cron.id, false);
    if (outcome.authzFailed) return { authzFailed: true };
    if (isOneShotSchedule(cron.schedule)) await deps.crons.setEnabled(cron.id, false);
    return { authzFailed: false };
  }

  const sweepStranded = async (): Promise<void> => {
    const swept = await deps.crons.sweepStrandedFires(now());
    if (swept > 0) console.warn(`[scheduler] closed ${swept} stranded running fire(s) as failed`);
  };

  const gcFires = async (): Promise<void> => {
    const pruned = await deps.crons.pruneFires(now());
    if (pruned > 0) console.log(`[scheduler] pruned ${pruned} old cron fire row(s)`);
  };

  function nextSlot(cron: Cron): number | undefined {
    return recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt);
  }

  function nextJob(cron: Cron): CronFireJob | undefined {
    const slot = nextSlot(cron);
    if (slot === undefined) return undefined;
    return { cronId: cron.id, scheduledAt: slot };
  }

  const enqueue = (job: CronFireJob) => deps.jobs.spawn(CRON_FIRE_JOB, job, `cron:${job.cronId}:${job.scheduledAt}`);

  async function enqueueNext(cronId: string): Promise<void> {
    const cron = await deps.crons.get(cronId);
    if (!cron || cron.archived || !cron.enabled) return;
    const job = nextJob(cron);
    if (job) await enqueue(job);
  }

  async function fireJob(job: CronFireJob, at?: number): Promise<JobDisposition> {
    const cron = await deps.crons.get(job.cronId);
    if (!cron || cron.archived || !cron.enabled) return "release";
    const slot = nextSlot(cron);
    if (slot !== job.scheduledAt) return "release";
    const t = at ?? now();
    if (t < slot) return slot;
    if (isDeferred(cron, t)) return cron.deferUntil!;
    let disposition: JobDisposition = "release";
    const result = await withCronLifecycle(job.cronId, true, async () => {
      if (!(await deps.crons.claimSlot(job.cronId, slot, t))) return;
      try {
        const { authzFailed, deferred } = await fire(cron, t, `cron:${cron.id}:${slot}`, slot);
        if (authzFailed || deferred) {
          await deps.crons.unclaimSlot(job.cronId, slot, t, cron.lastFiredAt);
          if (deferred) disposition = (await deps.crons.get(job.cronId))?.deferUntil ?? now() + BUSY_DEFER_MS;
          return;
        }
      } catch (e) {
        await deps.crons.unclaimSlot(job.cronId, slot, t, cron.lastFiredAt);
        if (e instanceof WorkAdmissionClosed) disposition = now() + ADMISSION_CLOSED_RETRY_MS;
        else reportFailure("scheduler: fire", e);
        return;
      }
      disposition = "done";
      await enqueueNext(job.cronId);
    });
    if (result === null) return now() + BUSY_DEFER_MS;
    return disposition;
  }

  async function fireManualJob(job: CronManualFireJob): Promise<JobDisposition> {
    const cron = await deps.crons.get(job.cronId);
    if (!cron) return "done";
    await withCronLifecycle(cron.id, false, () => fire(cron, job.firedAt, job.fireKey)).catch((e: unknown) => {
      if (e instanceof WorkAdmissionClosed) throw e;
      reportFailure("scheduler: manual fire", e, `cron=${job.cronId}`);
    });
    return "done";
  }

  const retryWhenClosed = (e: unknown): JobDisposition => {
    if (e instanceof WorkAdmissionClosed) return now() + ADMISSION_CLOSED_RETRY_MS;
    throw e;
  };
  const concurrency = deps.fireConcurrency ? { concurrency: deps.fireConcurrency } : {};
  deps.jobs.handle(
    CRON_FIRE_JOB,
    (params) => withWork(() => fireJob(params as CronFireJob)).catch(retryWhenClosed),
    concurrency,
  );
  deps.jobs.handle(
    CRON_MANUAL_FIRE_JOB,
    (params) => withWork(() => fireManualJob(params as CronManualFireJob)).catch(retryWhenClosed),
    { ...concurrency, maxAttempts: MANUAL_FIRE_MAX_ATTEMPTS },
  );

  async function repair(): Promise<void> {
    for (const cron of await deps.crons.list()) {
      if (cron.archived || !cron.enabled) continue;
      const job = nextJob(cron);
      if (job) await enqueue(job).catch(reportFailureAs("scheduler: cron enqueue", undefined, `cron=${cron.id}`));
    }
  }

  deps.jobs.every("cron:repair", REPAIR_INTERVAL_MS, () => withWork(repair), { immediate: true });
  deps.jobs.every("cron:stranded-fires", STRANDED_SWEEP_INTERVAL_MS, () => withWork(sweepStranded));
  deps.jobs.every("cron:fire-gc", FIRE_GC_INTERVAL_MS, () => withWork(gcFires));

  async function runNow(cronId: string): Promise<RunNowResult> {
    try {
      return await withWork(async (): Promise<RunNowResult> => {
        const cron = await deps.crons.get(cronId);
        if (!cron || cron.archived || !cron.enabled) return { started: false, reason: "unavailable" };
        const t = now();
        const fireKey = `cron:${cron.id}:manual:${randomUUID()}`;
        const job: CronManualFireJob = { cronId: cron.id, fireKey, firedAt: t };
        const begun = await deps.crons.beginFire(
          cronId,
          { fireKey, threadRef: cronFireThreadRef(cron.id, fireKey), firedAt: t, status: "running" },
          { exclusive: true, enqueue: (db) => deps.jobs.spawn(CRON_MANUAL_FIRE_JOB, job, fireKey, db) },
        );
        if (!begun.begun) {
          return begun.running
            ? { started: false, reason: "already_running", running: begun.running }
            : { started: false, reason: "unavailable" };
        }
        return { started: true, fireKey };
      });
    } catch (error) {
      if (error instanceof WorkAdmissionClosed) return { started: false, reason: "unavailable" };
      throw error;
    }
  }

  return {
    async tick(nowArg) {
      const t = nowArg ?? now();
      await withWork(async () => {
        for (const cron of await deps.crons.list()) {
          const job = cron.enabled && !cron.archived ? nextJob(cron) : undefined;
          if (job && job.scheduledAt <= t) await fireJob(job, t).catch(reportFailureAs("scheduler: fire", undefined));
        }
      });
    },
    runNow,
    repair,
    notifyChanged(cronId) {
      void enqueueNext(cronId).catch(reportFailureAs("scheduler: cron enqueue", undefined, `cron=${cronId}`));
    },
  };
}
