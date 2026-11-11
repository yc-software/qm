import { assignedGoal, type GoalRecord, openGoal } from "../../agent/goal.ts";
import type { MemoryProviderOutcome } from "../../memory/memory-service.ts";
import { memoryRecallDelta } from "../../memory/recall-delta.ts";
import { goalView } from "../../runs/turn-stream.ts";
import type { SessionWriter } from "../../sessions/session-store.ts";
import { createSwarmGoalInbox, type openSwarmMailbox } from "../../swarms/swarm-goal-inbox.ts";
import { inboundIssuesNote } from "../attachments.ts";
import { environmentNote, guidanceUpdateEvent, membershipEvent } from "./prompt-blocks.ts";
import type { Item } from "../../sessions/items.ts";
import type { ScopeId, Session } from "../../types.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

export function segmentEnvironment(segment: {
  recalled: Parameters<typeof memoryRecallDelta>[0];
  continuation: { history: Item[] } | undefined;
  history: Item[];
  memoryView: { held: Parameters<typeof memoryRecallDelta>[2] };
  context: { memoryLabels: Parameters<typeof memoryRecallDelta>[3] };
  recallOutcomes: MemoryProviderOutcome[];
  rosterMembers: Parameters<typeof membershipEvent>[0];
  rawEntries: Item[];
  session: Session;
  external: boolean;
  deps: OrchestratorDeps;
  scopeId: ScopeId;
  conversation: OrchestratorInput["conversation"];
  turnEnvironmentContents: string;
  mailbox: Awaited<ReturnType<typeof openSwarmMailbox>> | undefined;
  memoryHeading: string;
  inboundIssues: Parameters<typeof inboundIssuesNote>[0];
  documentInputs: { notices: readonly string[] };
  appSource: string;
  continueTurn: boolean;
}) {
  const {
    recalled,
    continuation,
    history,
    memoryView,
    context,
    recallOutcomes,
    rosterMembers,
    rawEntries,
    session,
    external,
    deps,
    scopeId,
    conversation,
    turnEnvironmentContents,
    mailbox,
    memoryHeading,
    inboundIssues,
    documentInputs,
    appSource,
    continueTurn,
  } = segment;
  const recall = memoryRecallDelta(
    recalled,
    continuation?.history ?? history,
    memoryView.held,
    context.memoryLabels,
    recallOutcomes,
  );
  const snapshot = membershipEvent(rosterMembers, continuation?.history ?? rawEntries, session.id);
  const guidance = !external
    ? guidanceUpdateEvent(
        {
          version: deps.config.soulVersion(scopeId),
          personal: conversation.kind === "dm",
          revisions: deps.config.soulHistory(scopeId),
        },
        continuation?.history ?? rawEntries,
        session.id,
      )
    : undefined;
  const turnEnvironment = environmentNote(
    [
      turnEnvironmentContents,
      continuation ? "" : mailbox?.text,
      snapshot.text,
      guidance?.text,
      recall.text ? `${memoryHeading}${recall.text}` : "",
      inboundIssuesNote(inboundIssues),
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  const environment = [turnEnvironment, ...documentInputs.notices, appSource].filter(Boolean).join("\n");
  const silentResume = continueTurn && !continuation && !snapshot.text && !guidance?.text && !recall.text;
  return { recall, snapshot, guidance, environment, silentResume };
}

export async function openSegmentGoal(segment: {
  deps: OrchestratorDeps;
  session: Session;
  input: OrchestratorInput;
  swarmBinding: Awaited<ReturnType<NonNullable<OrchestratorDeps["swarms"]>["binding"]>> | undefined;
  writer: SessionWriter;
  swarmGoalTurn: boolean;
  screenSwarmMessage: (text: string) => Promise<string | null>;
}) {
  const { deps, session, input, swarmBinding, writer, swarmGoalTurn, screenSwarmMessage } = segment;
  const storedGoal = (await deps.sessions.goals([session.id])).get(session.id);
  let sessionGoal = openGoal(storedGoal);
  const installGoal = input.swarmGoal && swarmBinding ? assignedGoal(storedGoal, input.swarmGoal) : null;
  if (installGoal) {
    sessionGoal = installGoal;
    await deps.sessions.setGoal(writer, installGoal);
  }
  const saveGoal = async (goal: GoalRecord): Promise<void> => {
    await deps.sessions.setGoal(writer, goal);
    if (input.runId) deps.turnStream.noteGoal(input.runId, goalView(goal));
  };
  const swarmHandoff =
    swarmGoalTurn && deps.swarms && input.runId
      ? createSwarmGoalInbox({
          swarms: deps.swarms,
          input,
          screen: screenSwarmMessage,
          saveGoal,
        })
      : undefined;
  const goalInbox = swarmHandoff?.inbox;
  return { sessionGoal, saveGoal, swarmHandoff, goalInbox };
}
