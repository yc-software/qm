import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isUserItem, type Item } from "../sessions/items.ts";
import type { AgentTurnInput } from "./agent.ts";
import { goalPausedNote, goalSteeringNote, type GrindMeter } from "./goal.ts";
import { dayMarkerPrefix, userPromptText } from "./replay.ts";
import { imageRefs, runApprovedToolCall, type BridgedTool } from "./turn-support.ts";
import type { TurnSession } from "./turn-session.ts";

export function turnToolRef(dispatched: AgentTurnInput): TurnSession["ref"] {
  return {
    current: dispatched.tools,
    documents: dispatched.documents,
    runtimeHandoff: undefined,
    runtimeMutationPending: false,
    runtimeInFlight: new Set(),
    runtimeActorId: dispatched.runtimeActorId,
    pendingApprovals: [],
    pausedOnApproval: undefined,
    silentRequested: false,
    pollFire: !!dispatched.pollFire,
    screenToolResult: dispatched.screenToolResult,
    governGoal: dispatched.governGoal,
    saveGoal: dispatched.saveGoal,
    emit: dispatched.emit,
    scopeLabel: dispatched.scopeLabel,
    orgScopeId: dispatched.orgScopeId,
    toolApprovalGate: dispatched.toolApprovalGate,
    shutdown: dispatched.shutdown,
  };
}

export async function replayApprovedCalls(
  dispatched: AgentTurnInput,
  ref: TurnSession["ref"],
  tools: ToolDefinition[],
): Promise<AgentTurnInput> {
  const approvedItems: Item[] = [];
  for (const call of dispatched.approvedToolCalls ?? [])
    approvedItems.push(
      ...(
        await runApprovedToolCall(
          call,
          ref,
          tools as unknown as BridgedTool[],
          dispatched.cancel ? { cancel: dispatched.cancel } : {},
        )
      ).items,
    );
  const approvedTurn = approvedItems.length
    ? { ...dispatched, history: [...dispatched.history, ...approvedItems] }
    : dispatched;
  return approvedTurn;
}

export async function openTurnPrompt({
  entry,
  turn,
  continueTurn,
  grindMeter,
}: {
  entry: TurnSession;
  turn: AgentTurnInput;
  continueTurn: boolean;
  grindMeter: GrindMeter;
}): Promise<{ userEntry: Item | undefined; modelPrompt: string }> {
  entry.ref.goal = turn.goal ?? null;
  entry.ref.goalMeter = grindMeter;
  entry.ref.goalInbox = turn.goalInbox;
  entry.ref.goalRound = turn.continueTurn ? 1 : 0;
  const activeGoalAtStart = entry.ref.goal?.status === "active" ? entry.ref.goal : null;
  const pausedGoalAtStart = entry.ref.goal?.status === "paused" ? entry.ref.goal : null;
  const goalNote = (() => {
    if (activeGoalAtStart) return goalSteeringNote(activeGoalAtStart);
    if (pausedGoalAtStart) return goalPausedNote(pausedGoalAtStart);
    return "";
  })();
  const userEntry = continueTurn
    ? turn.history.find((e) => e.seq === turn.resumeUserSeq)
    : await turn.emit({
        kind: "UserMessage",
        text: turn.input,
        author: turn.runtimeActorId ?? null,
        externalId: turn.triggerTs ?? turn.entryTs ?? null,
        body: {
          ...(turn.environment ? { environment: turn.environment } : {}),
          ...(goalNote.trim() ? { goalNote } : {}),
          ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
          ...imageRefs(turn.images),
        },
      });
  const modelPrompt =
    (userEntry
      ? dayMarkerPrefix(
          turn.history.findLast((e) => isUserItem(e) && e.seq < userEntry.seq),
          userEntry,
        )
      : "") + userPromptText({ goalNote, text: turn.input, environment: turn.environment });
  return { userEntry, modelPrompt };
}
