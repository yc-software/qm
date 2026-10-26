import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { forEachTerminalRun, type Run, type RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { goalCapSpent, type GoalRecord } from "../harness/goal.ts";
import { swallowAs } from "../util/errors.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import {
  appendMessage,
  controlState,
  goalOwner,
  memberById,
  swarmExpired,
  SWARM_LIMITS,
  type Swarm,
  type SwarmMember,
  type SwarmStore,
} from "./swarm-store.ts";

const GOAL_CONTINUATION_TEXT =
  "Your previous turn ended before your goal was finished, and the goal is still active. Continue working on it.";

function goalPauseText(goal: GoalRecord): string {
  return [
    "The governor paused my goal; it needs a decision from you, as the agent that gave me the goal (or my parent, if I set it myself).",
    `Goal: ${goal.objective}`,
    `Why it paused: ${goal.pauseReason ?? ""}`,
    "Reply to me with notify:true: a message from you or the swarm root after the pause lets me resume the goal. Sending me a new goal replaces it instead.",
  ].join("\n");
}

type GoalProgress = NonNullable<SwarmMember["goalContinuation"]>;

function queueFromWorker(swarm: Swarm, worker: SwarmMember, text: string, recipient: string): void {
  appendMessage(
    swarm,
    {
      senderId: worker.id,
      senderSessionId: worker.sessionId!,
      author: "agent",
      actorId: swarm.ownerId,
      text,
      audience: [recipient],
      unbudgeted: true,
    },
    [recipient],
  );
}

function goalWorker(swarm: Swarm, memberId: string): SwarmMember | undefined {
  const member = memberById(swarm, memberId);
  if (!member?.sessionId || member.id === swarm.id || member.state !== "ready" || swarmExpired(swarm)) return undefined;
  return member;
}

function continuationDue(swarm: Swarm, memberId: string, progress: GoalProgress): SwarmMember | undefined {
  const member = goalWorker(swarm, memberId);
  const last = member?.goalContinuation;
  if (
    !member ||
    controlState(swarm, member.id) !== "active" ||
    (last?.goalCreatedAt === progress.goalCreatedAt && last.tokensUsed >= progress.tokensUsed) ||
    swarm.messages.some((message) => message.notifications[member.id]?.state === "pending")
  )
    return undefined;
  return member;
}

function pauseNoticeDue(swarm: Swarm, memberId: string, goal: GoalRecord): SwarmMember | undefined {
  const member = goalWorker(swarm, memberId);
  const last = member?.goalPauseNotice;
  if (
    !member ||
    controlState(swarm, member.id) === "stopped" ||
    (last?.goalCreatedAt === goal.createdAt && last.pausedAt === goal.updatedAt)
  )
    return undefined;
  return member;
}

function interrupted(run: Run): boolean {
  return !!run.result?.stopped || run.lastStop?.kind === "shutdown" || run.lastStop?.kind === "parked";
}

export function createSwarmGoalContinuation(deps: {
  store: SwarmStore;
  sessions: SessionStore;
  runs: RunStore;
  lock: AdvisoryLock;
}): Sweeper & { sweep(): Promise<void> } {
  const { store, sessions, runs } = deps;

  async function noticePause(swarm: Swarm, memberId: string, goal: GoalRecord): Promise<Swarm> {
    if (!pauseNoticeDue(swarm, memberId, goal)) return swarm;
    return store.update(swarm.id, (current) => {
      const worker = pauseNoticeDue(current, memberId, goal);
      if (!worker) return;
      worker.goalPauseNotice = { goalCreatedAt: goal.createdAt, pausedAt: goal.updatedAt };
      queueFromWorker(current, worker, goalPauseText(goal), goalOwner(current, worker.id, goal.createdAt));
    });
  }

  async function continueGoal(swarm: Swarm, memberId: string, goal: GoalRecord): Promise<Swarm> {
    const progress = { goalCreatedAt: goal.createdAt, tokensUsed: goal.tokensUsed };
    const member = continuationDue(swarm, memberId, progress);
    if (!member || (await runs.inFlightForThread(member.threadRef)).length) return swarm;
    return store.update(swarm.id, (current) => {
      const recipient = continuationDue(current, member.id, progress);
      if (!recipient) return;
      recipient.goalContinuation = progress;
      queueFromWorker(current, recipient, GOAL_CONTINUATION_TEXT, recipient.id);
    });
  }

  async function sweepWorker(swarms: Map<string, Swarm | null>, run: Run, goal: GoalRecord): Promise<void> {
    const { swarmId, recipientId } = run.request.swarm!;
    const swarm = swarms.get(swarmId);
    if (!swarm) return;
    if (goal.status === "paused" && goal.governor?.verdict === "pause")
      swarms.set(swarmId, await noticePause(swarm, recipientId, goal));
    else if (interrupted(run) && goal.status === "active" && !goalCapSpent(goal))
      swarms.set(swarmId, await continueGoal(swarm, recipientId, goal));
  }

  async function sweep(): Promise<void> {
    const claim = deps.lock.tryWithLock?.bind(deps.lock) ?? deps.lock.withLock.bind(deps.lock);
    await claim("swarm-goal-continuation", () => {
      const now = Date.now();
      const swarms = new Map<string, Swarm | null>();
      const seen = new Set<string>();
      return forEachTerminalRun(
        runs,
        { fromMs: now - SWARM_LIMITS.continuationLookbackMs, beforeMs: now, page: SWARM_LIMITS.continuationPage },
        async (batch) => {
          const due: Array<{ run: Run; sessionId: string }> = [];
          for (const run of batch) {
            const target = run.request.swarm;
            if (!target) continue;
            const worker = `${target.swarmId}:${target.recipientId}`;
            if (seen.has(worker) && !interrupted(run)) continue;
            seen.add(worker);
            if (!swarms.has(target.swarmId))
              swarms.set(
                target.swarmId,
                await store.get(target.swarmId).catch(swallowAs("swarm: goal continuation", null)),
              );
            const swarm = swarms.get(target.swarmId);
            const sessionId = swarm ? memberById(swarm, target.recipientId)?.sessionId : undefined;
            if (sessionId) due.push({ run, sessionId });
          }
          if (!due.length) return;
          const goals = await sessions
            .goals([...new Set(due.map(({ sessionId }) => sessionId))])
            .catch(swallowAs("swarm: goal continuation", new Map<string, GoalRecord>()));
          for (const { run, sessionId } of due) {
            const goal = goals.get(sessionId);
            if (goal) await sweepWorker(swarms, run, goal).catch(swallowAs("swarm: goal continuation", undefined));
          }
        },
      );
    });
  }

  return {
    ...createSweeper(sweep, SWARM_LIMITS.continuationSweepMs, { label: "swarm-goal-continuation", immediate: true }),
    sweep,
  };
}
