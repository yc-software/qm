import { randomUUID } from "node:crypto";
import { parseScopeId, type Cron, type TurnRequest, type TurnResult } from "../types.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { CronStore } from "./cron-store.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { IdempotencyStore } from "../idempotency/idempotency-store.ts";
import { runTrigger } from "../triggers/run-trigger.ts";
import type { CurrentScopeMembers } from "../resolution/scope-membership.ts";
import type { VisibilityDirectory } from "../directory/visibility.ts";
import type { DirectoryMember } from "../directory/directory-store.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper } from "../util/sweeper.ts";
import { recoverNextFireAt } from "./schedule.ts";
import type { CronFireJob, CronJobQueue } from "./job-queue.ts";
import { hashId } from "../util/crypto.ts";
import { errMessage } from "../util/errors.ts";
import { sleep } from "../util/async.ts";

const TICK_LEASE_KEY = "cron:scheduler:tick";
const CRON_FIRE_REPLY_MAX_CHARS = 2000;

export interface Scheduler {
  tick(now?: number): Promise<void>;
  runNow(cronId: string): Promise<void>;
  notifyChanged(cronId: string): void;
  start(intervalMs: number): void;
  stop(): void;
}

export interface SchedulerDeps {
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
  jobQueue?: CronJobQueue;
}

function truncate(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : `${s.slice(0, maxChars - 3)}...`;
}

function cronFireLogReply(s: string): string {
  if (s.includes("[Cron runtime context]") || s.includes("[End cron runtime context]")) {
    return "[reply echoed cron runtime context; omitted]";
  }
  return truncate(s, CRON_FIRE_REPLY_MAX_CHARS);
}

function cronFireThreadRef(cronId: string, fireKey: string): string {
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
  return [
    "[Cron runtime context]",
    `Cron id: ${cron.id}${cron.title ? ` (${cron.title})` : ""}.`,
    "Each fire runs as a fresh thread with no memory of previous fires. Two things persist between fires:",
    "- Your workspace disk. Durable state — notes, queues, checkpoints, anything a future fire should know — lives in files there.",
    "- The stored task below: the standing instructions every fire receives. Edit it (via the cron tool) only to change what future fires are told to do.",
    `The retained fire log (cron tool, action="runs", id="${cron.id}") shows how prior fires went — useful when this run hits errors or surprising state.`,
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
  const maxFiresPerTick = deps.maxFiresPerTick ?? 100;
  const leaderLease = deps.leaderLease ?? createNoopLeaderLease();

  async function fire(cron: Cron, t: number, fireKey: string, scheduledAt?: number): Promise<{ authzFailed: boolean }> {
    const threadRef = cronFireThreadRef(cron.id, fireKey);
    const mentionRoster = await cronMentionRoster(deps, cron).catch(() => undefined);
    let outcome: Awaited<ReturnType<typeof runTrigger>>;
    try {
      outcome = await runTrigger(
        {
          deliveries: deps.deliveries,
          idempotency: deps.idempotency,
          identity: deps.identity,
          run: deps.run,
          ...(deps.directory ? { directory: deps.directory } : {}),
          ...(deps.currentScopeMembers ? { currentScopeMembers: deps.currentScopeMembers } : {}),
        },
        {
          owner: cron.owner,
          ownerScopeId: cron.ownerScopeId,
          input: renderCronFireInput(cron, mentionRoster),
          fireKey,
          threadRef,
          surface: "cron",
          ...(cron.message !== undefined ? { message: cron.message } : {}),
          ...(cron.destination ? { destination: cron.destination } : {}),
          ...(cron.runAs ? { runAs: cron.runAs } : {}),
          ...(cron.members ? { members: cron.members } : {}),
          ...(cron.recipientConsent ? { recipientConsent: cron.recipientConsent } : {}),
          recipientConsentRequired: cron.schedule.everyMs !== undefined || cron.schedule.cron !== undefined,
        },
      );
    } catch (e) {
      await deps.crons.recordFire(cron.id, {
        fireKey,
        threadRef,
        firedAt: t,
        ...(scheduledAt !== undefined ? { scheduledAt } : {}),
        status: "failed",
        note: truncate(errMessage(e), CRON_FIRE_REPLY_MAX_CHARS),
      });
      throw e;
    }
    if (outcome.ran || outcome.authzFailed) {
      await deps.crons.recordFire(cron.id, {
        fireKey,
        threadRef,
        firedAt: t,
        ...(scheduledAt !== undefined ? { scheduledAt } : {}),
        ...(outcome.status ? { status: outcome.status } : {}),
        ...(outcome.note ? { note: truncate(outcome.note, CRON_FIRE_REPLY_MAX_CHARS) } : {}),
        ...(outcome.reply !== undefined ? { reply: cronFireLogReply(outcome.reply) } : {}),
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      });
    }
    if (outcome.authzFailed) {
      await deps.crons.setEnabled(cron.id, false);
      return { authzFailed: true };
    }
    if (cron.schedule.everyMs == null && cron.schedule.cron == null) await deps.crons.setEnabled(cron.id, false);
    return { authzFailed: false };
  }

  const fireDue = async (t: number): Promise<void> => {
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
          console.error("[scheduler] attempt mark failed, holding this cron back:", errMessage(e));
        }
      }
      console.warn(`[scheduler] fan-out capped: firing ${batch.length}/${due.length} due crons this tick`);
    }
    for (const cron of batch) {
      try {
        const { authzFailed } = await fire(cron, t, `cron:${cron.id}:${cron.scheduledAt}`, cron.scheduledAt);
        if (!authzFailed) await deps.crons.markFired(cron.id, t, cron.scheduledAt);
      } catch (e) {
        console.error("[scheduler] fire failed:", errMessage(e));
      }
    }
  };

  const tick = async (nowArg?: number): Promise<void> => {
    const t = nowArg ?? now();
    await leaderLease.hold(TICK_LEASE_KEY, async () => {
      await fireDue(t);
      await deps.sweepAsks?.(t).catch((e: unknown) => console.error("[scheduler] ask sweep failed:", e));
    });
  };

  const sweeper = createSweeper(
    () => tick().catch((e: unknown) => console.error("[scheduler] tick failed:", e)),
    1000,
    { label: "scheduler" },
  );

  function nextSlot(cron: Cron): number | undefined {
    return recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt);
  }

  async function enqueueNext(cronId: string): Promise<void> {
    const cron = await deps.crons.get(cronId);
    if (!cron || cron.archived || !cron.enabled) return;
    const slot = nextSlot(cron);
    if (slot !== undefined) await deps.jobQueue!.enqueueFire({ cronId, scheduledAt: slot });
  }

  async function fireJob(job: CronFireJob): Promise<void> {
    const cron = await deps.crons.get(job.cronId);
    if (!cron || cron.archived || !cron.enabled) return;
    const slot = nextSlot(cron);
    if (slot !== job.scheduledAt) return;
    const t = now();
    if (t < slot) {
      await deps.jobQueue!.enqueueFire(job);
      return;
    }
    if (!(await deps.crons.claimSlot(job.cronId, slot, t))) return;
    try {
      const { authzFailed } = await fire(cron, t, `cron:${cron.id}:${slot}`, slot);
      if (authzFailed) {
        await deps.crons.unclaimSlot(job.cronId, slot, t, cron.lastFiredAt);
        return;
      }
    } catch (e) {
      console.error("[scheduler] fire failed:", e);
      await deps.crons.unclaimSlot(job.cronId, slot, t, cron.lastFiredAt);
      return;
    }
    await enqueueNext(job.cronId);
  }

  async function reconcile(): Promise<void> {
    try {
      for (const cron of await deps.crons.list()) {
        if (cron.archived || !cron.enabled) continue;
        const slot = nextSlot(cron);
        if (slot !== undefined) await deps.jobQueue!.enqueueFire({ cronId: cron.id, scheduledAt: slot });
      }
    } catch (e) {
      console.error("[scheduler] tick failed:", e);
    }
    await deps.sweepAsks?.(now()).catch((e: unknown) => console.error("[scheduler] ask sweep failed:", e));
  }

  const leaseGuard = createSweeper(
    () =>
      deps.jobQueue!.healthy()
        ? leaderLease.hold(TICK_LEASE_KEY, async (lost) => {
            let lockLost = false;
            void lost.then(() => (lockLost = true));
            while (!stopped && !lockLost && deps.jobQueue!.healthy())
              await Promise.race([sleep(1000, { unref: true }), lost]);
          })
        : undefined,
    1000,
    { label: "scheduler lease guard", immediate: true },
  );

  let stopped = false;
  return {
    tick,
    async runNow(cronId) {
      const cron = await deps.crons.get(cronId);
      if (!cron || cron.archived || !cron.enabled) return;
      await fire(cron, now(), `cron:${cron.id}:manual:${randomUUID()}`);
    },
    notifyChanged(cronId) {
      if (!deps.jobQueue) return;
      void enqueueNext(cronId).catch((e: unknown) => console.error("[scheduler] cron enqueue failed:", errMessage(e)));
    },
    start(intervalMs) {
      if (!deps.jobQueue) {
        sweeper.start(intervalMs);
        return;
      }
      stopped = false;
      void deps.jobQueue.start({ onFire: fireJob, onTick: reconcile }, intervalMs).then(
        () => {
          if (!stopped) leaseGuard.start();
        },
        (e: unknown) => {
          console.error("[scheduler] cron job queue failed to start; falling back to interval ticks:", errMessage(e));
          if (!stopped) sweeper.start(intervalMs);
        },
      );
    },
    stop() {
      stopped = true;
      sweeper.stop();
      leaseGuard.stop();
      void deps.jobQueue
        ?.stop()
        .catch((e: unknown) => console.error("[scheduler] cron job queue stop failed:", errMessage(e)));
    },
  };
}
