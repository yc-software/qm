import type { OrchestratorInput } from "../core/orchestrator.ts";
import { goalAssignedNote, supersedeGoal, type GoalInbox, type GoalRecord } from "../harness/goal.ts";
import { reportFailureAs, swallowAs } from "../util/errors.ts";
import { swarmMessageText, type SwarmService } from "./swarm-service.ts";
import type { SwarmMessage } from "./swarm-store.ts";

export function createSwarmGoalInbox(deps: {
  swarms: Pick<SwarmService, "queuedMessages" | "handOver" | "held">;
  input: OrchestratorInput;
  saveGoal(goal: GoalRecord): Promise<void>;
}): { inbox: GoalInbox; settle(): Promise<void> } {
  const shown = new Map<string, SwarmMessage>();
  const skippedRuns = new Set<string>();
  const settled: string[] = [];
  const runOf = (message: SwarmMessage) => message.notifications[deps.input.swarm!.recipientId]?.runId;
  return {
    inbox: {
      async receive(goal) {
        const out: Array<{ id: string; text: string }> = [];
        for (const message of await deps.swarms.queuedMessages(deps.input, { skipRuns: skippedRuns })) {
          if (shown.has(message.id)) continue;
          const plain = swarmMessageText(message);
          const replaces = message.goal && message.createdAt > goal.createdAt;
          const text = replaces ? `${plain}\n\n${goalAssignedNote(message.goal!)}` : plain;
          const runId = runOf(message);
          if (runId) skippedRuns.add(runId);
          shown.set(message.id, message);
          out.push({ id: message.id, text });
        }
        return out;
      },
      ...(deps.input.swarm ? { held: () => deps.swarms.held(deps.input) } : {}),
      async acknowledge(ids, goal) {
        const messages = ids.flatMap((id) => shown.get(id) ?? []);
        for (const message of messages)
          if (message.goal) supersedeGoal(goal, { ...message.goal, assignedAt: message.createdAt });
        settled.push(...ids);
        if (messages.some((message) => message.goal))
          await deps.saveGoal(goal).catch(swallowAs("swarm: save goal adopted from a message", undefined));
      },
    },
    async settle() {
      if (settled.length)
        await deps.swarms.handOver(deps.input, settled).catch(swallowAs("swarm: goal message handoff", []));
    },
  };
}

export async function openSwarmMailbox(deps: {
  swarms: Pick<SwarmService, "queuedMessages" | "handOver">;
  input: OrchestratorInput;
}): Promise<{ text: string; settle(): Promise<void> }> {
  const messages = await deps.swarms
    .queuedMessages(deps.input, { mailboxOnly: true })
    .catch(reportFailureAs("swarm: read the mailbox", []));
  const shown = messages.map(swarmMessageText);
  return {
    text: shown.length ? `Swarm messages left in your mailbox since your last turn:\n\n${shown.join("\n\n")}` : "",
    async settle() {
      const ids = messages.splice(0).map((message) => message.id);
      if (ids.length) await deps.swarms.handOver(deps.input, ids).catch(reportFailureAs("swarm: mailbox handoff", []));
    },
  };
}
