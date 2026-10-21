import type { OrchestratorInput } from "../core/orchestrator.ts";
import { goalAssignedNote, supersedeGoal, type GoalInbox, type GoalRecord } from "../harness/goal.ts";
import { swallowAs } from "../util/errors.ts";
import { swarmMessageText, type SwarmService } from "./swarm-service.ts";
import type { SwarmMessage } from "./swarm-store.ts";

export function createSwarmGoalInbox(deps: {
  swarms: Pick<SwarmService, "queuedMessages" | "handOver">;
  input: OrchestratorInput;
  screen(text: string): Promise<string | null>;
  saveGoal(goal: GoalRecord): Promise<void>;
}): { inbox: GoalInbox; settle(): Promise<void> } {
  const shown = new Map<string, SwarmMessage>();
  const skippedRuns = new Set<string>();
  let held = false;
  const settled: string[] = [];
  const runOf = (message: SwarmMessage) => message.notifications[deps.input.swarm!.recipientId]?.runId;
  return {
    inbox: {
      async receive(goal) {
        const out: Array<{ id: string; text: string }> = [];
        if (held) return out;
        for (const message of await deps.swarms.queuedMessages(deps.input, skippedRuns)) {
          const plain = swarmMessageText(message);
          const replaces = message.goal && message.createdAt > goal.createdAt;
          const text = await deps.screen(replaces ? `${plain}\n\n${goalAssignedNote(message.goal!)}` : plain);
          const runId = runOf(message);
          if (runId) skippedRuns.add(runId);
          if (text === null) {
            console.error(
              `[swarm] goal inbox held message=${message.id} and everything after it: the security screen blocked it mid-turn; it will run as its own turn`,
            );
            held = true;
            break;
          }
          shown.set(message.id, message);
          out.push({ id: message.id, text });
        }
        return out;
      },
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
