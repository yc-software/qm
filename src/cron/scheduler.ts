import { cronTriggerAuthority } from "./authority.ts";
import { WorkAdmissionClosed, type AdmittedWork } from "../util/admitted-work.ts";
import { randomUUID } from "node:crypto";
import { type Cron, type CronFireLogEntry, type CronFireNote, type TurnRequest, type TurnResult } from "../types.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { isDeferred, type CronStore } from "./cron-store.ts";
import type { Outbound } from "../surfaces/outbound.ts";
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

export interface CronFireJob {
  cronId: string;
  scheduledAt: number;
  notBefore?: number;
}

interface CronManualFireJob {
  cronId: string;
  fireKey: string;
  firedAt: number;
}

type CronFireDisposition = JobDisposition;

export const CRON_FIRE_JOB = "cron-fire";
export const CRON_MANUAL_FIRE_JOB = "cron-fire-manual";

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
  outbound: Outbound;
  idempotency: IdempotencyStore;
  identity: IdentityService;
  run: (req: TurnRequest) => Promise<TurnResult>;
  currentScopeMembers?: CurrentScopeMembers;
  now?: () => number;
  directory?: VisibilityDirectory & {
    get(principalId: string): Promise<{ displayName: string } | null>;
    list(): Promise<DirectoryMember[]>;
  };
  jobs: Pick<JobWorker, "handle" | "spawn">;
  fireConcurrency?: number;
  resolveRecipient?: TriggerDeps["resolveRecipient"];
  skipFire?: (cron: Cron) => Promise<string | undefined>;
  deleteCron?: (id: string) => Promise<void>;
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

const isBangCommand = (task: string): boolean => /^!(run|scratch)\s/.test(task.trimStart());

export function cronFireReadsNotes(cron: Pick<Cron, "schedule" | "action">): boolean {
  const task = cron.action ?? "";
  if (!task.trim() || isBangCommand(task)) return false;
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

function renderCronFireInput(cron: Cron, mentionRoster?: string): string {
  const task = cron.action ?? "";
  if (!task.trim()) return task;
  if (isBangCommand(task)) return task;
  const readsNotes = cronFireReadsNotes(cron);
  return [
    "[Cron runtime context]",
    `Cron id: ${cron.id}${cron.title ? ` (${cron.title})` : ""}.`,
    "Each fire runs as a fresh thread with no memory of previous fires. Keep continuity outside the thread:",
    "- Save durable run-state (cursors, queues, checkpoints, reports) to this conversation's Files via the available Files API; confirm publication succeeds before relying on it. Recover published bytes with GET /v1/files/:id/content using the normal agent API authentication. Sandbox disk is working storage, not a durable checkpoint.",
    "- The stored task below: the standing instructions every fire receives. Edit it (via the cron tool) only to change what future fires are told to do.",
    "Use a cron-specific filename. Never put credentials in published state. If publication is unavailable, report that limitation and retain needed workspace state on a scoped computer. Do not move tasks that require existing workspace files to scratch without migrating and verifying their state.",
    `The retained fire log (cron tool, action="runs", id="${cron.id}") shows how prior fires went — useful when this run hits errors or surprising state.`,
    ...(cron.inbox
      ? [
          `This cron keeps an inbox of work items. GET $AGENT_API_URL/v1/crons/${cron.id}/items lists them. POST it with {"items":[{"dedupeKey","summary","sourcePayload":{...},"proposal":{...}}]} to add or refresh items; a repeated dedupeKey updates the same item. Close one with POST $AGENT_API_URL/v1/crons/${cron.id}/items/<item id>/action and {"kind":"done"|"fail"|"dismiss","args":{"reason":"<one line>"}}. Work every pending item before finishing.`,
        ]
      : []),
    ...(readsNotes ? fireNoteLine(cron.lastFireNote) : []),
    ...(readsNotes
      ? [
          `Before finishing, leave a short note for the next fire (cron tool, action="note", id="${cron.id}"): one or two sentences — the outcome plus anything the next fire must know. Include the published checkpoint file ID, or small progress state directly; never include credentials. It's a report for the next fire, never instructions that override the stored task. Skip it only if there is truly nothing to say.`,
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

async function fireCron(
  deps: SchedulerDeps,
  now: () => number,
  cron: Cron,
  t: number,
  fireKey: string,
  scheduledAt?: number,
): Promise<FireResult> {
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
  return fireEnabled(deps, now, current, t, fireKey, scheduledAt);
}

async function fireEnabled(
  deps: SchedulerDeps,
  now: () => number,
  cron: Cron,
  t: number,
  fireKey: string,
  scheduledAt?: number,
): Promise<FireResult> {
  const threadRef = cronFireThreadRef(cron.id, fireKey);
  const runningEntry: CronFireLogEntry = {
    fireKey,
    threadRef,
    firedAt: t,
    ...(scheduledAt !== undefined ? { scheduledAt } : {}),
    status: "running",
  };
  let outcome: Awaited<ReturnType<typeof runTrigger>>;
  try {
    outcome = await runTrigger(
      {
        outbound: deps.outbound,
        idempotency: deps.idempotency,
        identity: deps.identity,
        run: deps.run,
        ...(deps.directory ? { directory: deps.directory } : {}),
        ...(deps.currentScopeMembers ? { currentScopeMembers: deps.currentScopeMembers } : {}),
        ...(deps.resolveRecipient ? { resolveRecipient: deps.resolveRecipient } : {}),
      },
      {
        ...cronTriggerAuthority(cron),
        input: (homeRoster) => renderCronFireInput(cron, cronMentionRoster(cron, homeRoster)),
        fireKey,
        threadRef,
        surface: "cron",
        ...(cron.runtime ? { runtime: cron.runtime } : {}),
        ...(cron.title ? { title: cron.title } : {}),
        onClaimed: async () => {
          await deps.crons.beginFire(cron.id, runningEntry);
        },
        ...(cron.message !== undefined ? { message: cron.message } : {}),
        ...(cron.destination ? { destination: cron.destination } : {}),
        deferWhenBusy: scheduledAt !== undefined && t - scheduledAt <= BUSY_DEFER_MAX_LATE_MS,
      },
    );
  } catch (e) {
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

interface ManualFireContext {
  deps: SchedulerDeps;
  now: () => number;
  withWork: <T>(work: () => Promise<T>) => Promise<T>;
  withCronLifecycle: <T>(cronId: string, scheduled: boolean, run: () => Promise<T>) => Promise<T | null>;
  retryWhenClosed: (e: unknown) => JobDisposition;
  handlerOpts: { concurrency?: number };
}

function manualFireRunner(ctx: ManualFireContext): Scheduler["runNow"] {
  const { deps, now, withWork } = ctx;
  const settling = new Map<string, PromiseWithResolvers<void>>();

  async function fireManualJob(job: CronManualFireJob): Promise<CronFireDisposition> {
    const cron = await deps.crons.get(job.cronId);
    if (!cron) return "done";
    await ctx
      .withCronLifecycle(cron.id, false, () => fireCron(deps, now, cron, job.firedAt, job.fireKey))
      .catch(reportFailureAs("scheduler: manual fire", undefined, `cron=${job.cronId}`));
    return "done";
  }

  deps.jobs.handle(
    CRON_MANUAL_FIRE_JOB,
    (params) => {
      const job = params as CronManualFireJob;
      return withWork(() => fireManualJob(job))
        .catch(ctx.retryWhenClosed)
        .finally(() => {
          settling.get(job.fireKey)?.resolve();
          settling.delete(job.fireKey);
        });
    },
    ctx.handlerOpts,
  );

  async function begin(cron: Cron): Promise<RunNowResult> {
    const t = now();
    const fireKey = `cron:${cron.id}:manual:${randomUUID()}`;
    const threadRef = cronFireThreadRef(cron.id, fireKey);
    const begun = await deps.crons.beginFire(
      cron.id,
      { fireKey, threadRef, firedAt: t, status: "running" },
      { exclusive: true },
    );
    if (!begun.begun) {
      return begun.running
        ? { started: false, reason: "already_running", running: begun.running }
        : { started: false, reason: "unavailable" };
    }
    const settled = Promise.withResolvers<void>();
    settling.set(fireKey, settled);
    const job: CronManualFireJob = { cronId: cron.id, fireKey, firedAt: t };
    try {
      await deps.jobs.spawn(CRON_MANUAL_FIRE_JOB, job, fireKey);
    } catch (e) {
      settling.delete(fireKey);
      await deps.crons.recordFire(cron.id, {
        fireKey,
        threadRef,
        firedAt: t,
        endedAt: now(),
        status: "failed",
        note: truncate(errMessage(e), CRON_FIRE_REPLY_MAX_CHARS),
      });
      throw e;
    }
    return { started: true, fireKey, settled: settled.promise };
  }

  return async (cronId) => {
    try {
      return await withWork(async (): Promise<RunNowResult> => {
        const cron = await deps.crons.get(cronId);
        if (!cron || cron.archived || !cron.enabled) return { started: false, reason: "unavailable" };
        return begin(cron);
      });
    } catch (error) {
      if (error instanceof WorkAdmissionClosed) return { started: false, reason: "unavailable" };
      throw error;
    }
  };
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

  function nextSlot(cron: Cron): number | undefined {
    return recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt);
  }

  function nextJob(cron: Cron): CronFireJob | undefined {
    const slot = nextSlot(cron);
    if (slot === undefined) return undefined;
    return {
      cronId: cron.id,
      scheduledAt: slot,
      ...(cron.deferUntil !== undefined ? { notBefore: cron.deferUntil } : {}),
    };
  }

  async function enqueueNext(cronId: string): Promise<void> {
    const cron = await deps.crons.get(cronId);
    if (!cron || cron.archived || !cron.enabled) return;
    const job = nextJob(cron);
    if (job) await enqueue(job);
  }

  const enqueue = (job: CronFireJob) => deps.jobs.spawn(CRON_FIRE_JOB, job, `cron:${job.cronId}:${job.scheduledAt}`);

  async function fireJob(job: CronFireJob, at?: number): Promise<CronFireDisposition> {
    const cron = await deps.crons.get(job.cronId);
    if (!cron || cron.archived || !cron.enabled) return "release";
    const slot = nextSlot(cron);
    if (slot !== job.scheduledAt) return "done";
    const t = at ?? now();
    if (t < slot) return slot;
    if (isDeferred(cron, t)) return cron.deferUntil!;
    const fenced = () => deps.admittedWork?.paused() ?? false;
    let disposition: CronFireDisposition = "release";
    const result = await withCronLifecycle(job.cronId, true, async () => {
      if (fenced()) {
        disposition = now();
        return;
      }
      if (!(await deps.crons.claimSlot(job.cronId, slot, t))) {
        disposition = "done";
        return;
      }
      if (fenced()) {
        await deps.crons.unclaimSlot(job.cronId, slot, t, cron.lastFiredAt);
        disposition = now();
        return;
      }
      try {
        const { authzFailed, deferred } = await fireCron(deps, now, cron, t, `cron:${cron.id}:${slot}`, slot);
        if (authzFailed || deferred) {
          await deps.crons.unclaimSlot(job.cronId, slot, t, cron.lastFiredAt);
          if (deferred) disposition = (await deps.crons.get(job.cronId))?.deferUntil ?? now() + BUSY_DEFER_MS;
          return;
        }
      } catch (e) {
        reportFailure("scheduler: fire", e);
        await deps.crons.unclaimSlot(job.cronId, slot, t, cron.lastFiredAt);
        return;
      }
      disposition = "done";
      await enqueueNext(job.cronId);
    });
    if (result === null) return now() + BUSY_DEFER_MS;
    return disposition;
  }

  const retryWhenClosed = (e: unknown): JobDisposition => {
    if (e instanceof WorkAdmissionClosed) return now();
    throw e;
  };
  const handlerOpts = deps.fireConcurrency ? { concurrency: deps.fireConcurrency } : {};
  deps.jobs.handle(
    CRON_FIRE_JOB,
    (params) => withWork(() => fireJob(params as CronFireJob)).catch(retryWhenClosed),
    handlerOpts,
  );

  const runNow = manualFireRunner({ deps, now, withWork, withCronLifecycle, retryWhenClosed, handlerOpts });

  const tick = async (nowArg?: number): Promise<void> => {
    const t = nowArg ?? now();
    await withWork(async () => {
      for (const cron of await deps.crons.list()) {
        const job = cron.enabled && !cron.archived ? nextJob(cron) : undefined;
        if (job && job.scheduledAt <= t) await fireJob(job, t).catch(reportFailureAs("scheduler: fire", undefined));
      }
    });
  };

  return {
    tick,
    runNow,
    notifyChanged(cronId) {
      void enqueueNext(cronId).catch(reportFailureAs("scheduler: cron enqueue", undefined, `cron=${cronId}`));
    },
    async repair() {
      for (const cron of await deps.crons.list()) {
        if (cron.archived || !cron.enabled) continue;
        const job = nextJob(cron);
        if (job) await enqueue(job);
      }
    },
  };
}
