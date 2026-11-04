import { randomUUID } from "node:crypto";
import type { ScopeId, SessionEntry, TurnRuntime } from "../types.ts";
import type { Lease, SessionStore } from "./session-store.ts";
import {
  acceptedWorkflowGate,
  evaluateWorkflowGate,
  missingWorkflowSkills,
  observedWorkflowSkills,
  unexpectedWorkflowSkills,
  type ObservedWorkflowSkill,
  type WorkflowDefinition,
  type WorkflowEvidence,
  type WorkflowGateResult,
  type WorkflowSkillRequirement,
} from "./workflow-gate.ts";

export interface WorkflowReviewReceipt {
  valid: boolean;
  workflowId: string;
  workflowVersion: number;
  step: string;
  decision: "pass" | "reject";
  subject: string;
  reviewTurnId?: string;
  inputEvidence: WorkflowEvidence[];
  outputEvidence: WorkflowEvidence[];
  findings: string[];
  observedSkills: ObservedWorkflowSkill[];
  missingSkills: WorkflowSkillRequirement[];
  unexpectedSkills: ObservedWorkflowSkill[];
  runtime: TurnRuntime;
  assignmentId: string;
}

export interface WorkflowReviewerAssignment {
  assignmentId: string;
  workflowId: string;
  workflowVersion: number;
  step: string;
  reviewerSessionId: string;
  runtime: TurnRuntime;
}

function matchingRuntime(actual: TurnRuntime, expected: TurnRuntime): boolean {
  return actual.harnessId === expected.harnessId && actual.modelId === expected.modelId;
}

function reviewReceipt(entry: SessionEntry): WorkflowReviewReceipt | null {
  if (entry.type !== "tool_result" || !entry.payload || typeof entry.payload !== "object") return null;
  const payload = entry.payload as Record<string, unknown>;
  if (
    payload.tool !== "workflow_review" ||
    payload.valid !== true ||
    typeof payload.workflowId !== "string" ||
    typeof payload.workflowVersion !== "number" ||
    typeof payload.step !== "string" ||
    (payload.decision !== "pass" && payload.decision !== "reject") ||
    typeof payload.subject !== "string" ||
    typeof payload.assignmentId !== "string" ||
    !Array.isArray(payload.observedSkills) ||
    !payload.runtime ||
    typeof payload.runtime !== "object"
  )
    return null;
  return payload as unknown as WorkflowReviewReceipt;
}

function reviewerAssignment(entry: SessionEntry): WorkflowReviewerAssignment | null {
  if (entry.type !== "tool_result" || !entry.payload || typeof entry.payload !== "object") return null;
  const payload = entry.payload as Record<string, unknown>;
  if (
    payload.tool !== "workflow_reviewer_assignment" ||
    typeof payload.workflowId !== "string" ||
    typeof payload.workflowVersion !== "number" ||
    typeof payload.step !== "string" ||
    typeof payload.reviewerSessionId !== "string" ||
    typeof payload.assignmentId !== "string" ||
    !payload.runtime ||
    typeof payload.runtime !== "object"
  )
    return null;
  return payload as unknown as WorkflowReviewerAssignment;
}

async function latestWorkflowReviewReceipt(
  sessions: Pick<SessionStore, "getEntries">,
  reviewerSessionId: string,
  assignment: WorkflowReviewerAssignment,
): Promise<WorkflowReviewReceipt | undefined> {
  return (await sessions.getEntries(reviewerSessionId, { tools: ["workflow_review"] }))
    .map(reviewReceipt)
    .filter((candidate): candidate is WorkflowReviewReceipt => candidate !== null)
    .findLast(
      (candidate) =>
        candidate.workflowId === assignment.workflowId &&
        candidate.workflowVersion === assignment.workflowVersion &&
        candidate.step === assignment.step,
    );
}

export async function assignWorkflowReviewer(input: {
  sessions: Pick<SessionStore, "get" | "appendMany">;
  lease: Lease;
  scopeLabel: ScopeId;
  parentSessionId: string;
  reviewerSessionId: string;
  definition: WorkflowDefinition;
  step: string;
}): Promise<WorkflowReviewerAssignment> {
  const step = input.definition.steps.find((candidate) => candidate.id === input.step);
  if (!step) throw new Error(`workflow ${input.definition.id} has no step ${input.step}`);
  if (!step.separateFrom) throw new Error(`workflow step ${input.step} is not a separated review stage`);
  const reviewer = await input.sessions.get(input.reviewerSessionId);
  if (!reviewer || reviewer.parentSessionId !== input.parentSessionId)
    throw new Error("reviewer must be a direct child of the producer session");
  if (reviewer.spawnMeta?.readOnly !== true) throw new Error("reviewer must be a read-only child session");
  if (!reviewer.spawnMeta?.harness || !reviewer.spawnMeta.model)
    throw new Error("reviewer must be assigned an explicit harness and model");
  const assignment = {
    assignmentId: randomUUID(),
    workflowId: input.definition.id,
    workflowVersion: input.definition.version,
    step: input.step,
    reviewerSessionId: reviewer.id,
    runtime: { harnessId: reviewer.spawnMeta.harness, modelId: reviewer.spawnMeta.model },
  };
  const callId = `workflow-reviewer-assignment-${randomUUID()}`;
  await input.sessions.appendMany(input.lease, [
    {
      type: "tool_call",
      payload: { tool: "workflow_reviewer_assignment", callId, ...assignment },
      scopeLabel: input.scopeLabel,
    },
    {
      type: "tool_result",
      payload: { tool: "workflow_reviewer_assignment", callId, result: JSON.stringify(assignment), ...assignment },
      scopeLabel: input.scopeLabel,
    },
  ]);
  return assignment;
}

export async function recordWorkflowReview(input: {
  sessions: Pick<SessionStore, "getEntries" | "appendMany">;
  lease: Lease;
  scopeLabel: ScopeId;
  definition: WorkflowDefinition;
  runtime: TurnRuntime | undefined;
  assignment: WorkflowReviewerAssignment;
  submission: {
    step: string;
    decision: "pass" | "reject";
    inputEvidence?: readonly WorkflowEvidence[];
    outputEvidence?: readonly WorkflowEvidence[];
    findings?: readonly string[];
  };
}): Promise<WorkflowReviewReceipt> {
  const step = input.definition.steps.find((candidate) => candidate.id === input.submission.step);
  if (!step) throw new Error(`workflow ${input.definition.id} has no step ${input.submission.step}`);
  if (!input.runtime) throw new Error("review submission requires a host-reported runtime");
  if (input.assignment.step !== step.id || input.assignment.reviewerSessionId !== input.lease.sessionId)
    throw new Error("review submission does not match its durable assignment");
  const entries = await input.sessions.getEntries(input.lease.sessionId, {
    ...(input.lease.turnId ? { turnId: input.lease.turnId } : {}),
  });
  const observedSkills = observedWorkflowSkills(entries);
  const missingSkills = missingWorkflowSkills(observedSkills, step.requiredSkills);
  const unexpectedSkills = unexpectedWorkflowSkills(observedSkills, step.requiredSkills);
  const receipt: WorkflowReviewReceipt = {
    valid: missingSkills.length === 0,
    workflowId: input.definition.id,
    workflowVersion: input.definition.version,
    step: step.id,
    decision: input.submission.decision,
    subject: input.lease.sessionId,
    ...(input.lease.turnId ? { reviewTurnId: input.lease.turnId } : {}),
    inputEvidence: [...(input.submission.inputEvidence ?? [])],
    outputEvidence: [...(input.submission.outputEvidence ?? [])],
    findings: [...(input.submission.findings ?? [])],
    observedSkills,
    missingSkills,
    unexpectedSkills,
    runtime: input.runtime,
    assignmentId: input.assignment.assignmentId,
  };
  const callId = `workflow-review-${randomUUID()}`;
  await input.sessions.appendMany(input.lease, [
    {
      type: "tool_call",
      payload: {
        tool: "workflow_review",
        callId,
        workflowId: receipt.workflowId,
        workflowVersion: receipt.workflowVersion,
        step: receipt.step,
        decision: receipt.decision,
      },
      scopeLabel: input.scopeLabel,
    },
    {
      type: "tool_result",
      payload: { tool: "workflow_review", callId, result: JSON.stringify(receipt), ...receipt },
      scopeLabel: input.scopeLabel,
    },
  ]);
  return receipt;
}

export async function importWorkflowReview(input: {
  sessions: Pick<SessionStore, "get" | "getEntries" | "appendMany">;
  lease: Lease;
  scopeLabel: ScopeId;
  parentSessionId: string;
  definition: WorkflowDefinition;
  producerSubmission?: {
    step: string;
    decision: "pass" | "reject";
    inputEvidence?: readonly WorkflowEvidence[];
    outputEvidence?: readonly WorkflowEvidence[];
    findings?: readonly string[];
  };
  reviewerSessionId?: string;
  reviewStep?: string;
}): Promise<WorkflowGateResult> {
  if (input.producerSubmission) {
    return evaluateWorkflowGate({
      sessions: input.sessions,
      lease: input.lease,
      scopeLabel: input.scopeLabel,
      definition: input.definition,
      submission: { ...input.producerSubmission, subject: input.parentSessionId },
    });
  }
  if (!input.reviewerSessionId || !input.reviewStep) throw new Error("reviewerSessionId and reviewStep are required");
  const reviewer = await input.sessions.get(input.reviewerSessionId);
  if (!reviewer || reviewer.parentSessionId !== input.parentSessionId)
    throw new Error("reviewer must be a direct child of the producer session");
  const assignment = await assignedWorkflowReview({
    sessions: input.sessions,
    parentSessionId: input.parentSessionId,
    reviewerSessionId: reviewer.id,
    definition: input.definition,
    step: input.reviewStep,
  });
  if (!assignment) throw new Error("reviewer is not assigned to this workflow step");
  const receipt = await latestWorkflowReviewReceipt(input.sessions, reviewer.id, assignment);
  if (!receipt) throw new Error("reviewer has no valid durable receipt for this workflow step");
  if (receipt.assignmentId !== assignment.assignmentId)
    throw new Error("reviewer receipt does not match the durable assignment");
  if (!matchingRuntime(receipt.runtime, assignment.runtime))
    throw new Error("reviewer runtime does not match the durable assignment");
  return evaluateWorkflowGate({
    sessions: input.sessions,
    lease: input.lease,
    scopeLabel: input.scopeLabel,
    definition: input.definition,
    observedSkills: receipt.observedSkills,
    submission: {
      step: receipt.step,
      decision: receipt.decision,
      subject: reviewer.id,
      inputEvidence: receipt.inputEvidence,
      outputEvidence: receipt.outputEvidence,
      findings: receipt.findings,
    },
  });
}

export async function workflowReviewReady(input: {
  sessions: Pick<SessionStore, "getEntries">;
  parentSessionId: string;
  reviewerSessionId: string;
  definition: WorkflowDefinition;
  step: string;
}): Promise<boolean> {
  const assignment = await assignedWorkflowReview(input);
  if (!assignment) return false;
  const parentEntries = await input.sessions.getEntries(input.parentSessionId, {
    tools: ["workflow_reviewer_assignment", "workflow_gate"],
  });
  const assignmentEntry = parentEntries.findLast(
    (entry) => reviewerAssignment(entry)?.assignmentId === assignment.assignmentId,
  );
  if (
    assignmentEntry &&
    parentEntries.some((entry) => {
      if (entry.seq <= assignmentEntry.seq || entry.type !== "tool_result" || !entry.payload) return false;
      const payload = entry.payload as Record<string, unknown>;
      return (
        payload.tool === "workflow_gate" &&
        payload.workflowId === assignment.workflowId &&
        payload.workflowVersion === assignment.workflowVersion &&
        payload.step === assignment.step &&
        payload.subject === input.reviewerSessionId
      );
    })
  )
    return false;
  const receipt = await latestWorkflowReviewReceipt(input.sessions, input.reviewerSessionId, assignment);
  return (
    !!receipt &&
    receipt.assignmentId === assignment.assignmentId &&
    matchingRuntime(receipt.runtime, assignment.runtime)
  );
}

export async function assignedWorkflowReview(input: {
  sessions: Pick<SessionStore, "getEntries">;
  parentSessionId: string;
  reviewerSessionId: string;
  definition: WorkflowDefinition;
  step: string;
}): Promise<WorkflowReviewerAssignment | undefined> {
  const assignment = (
    await input.sessions.getEntries(input.parentSessionId, { tools: ["workflow_reviewer_assignment"] })
  )
    .map(reviewerAssignment)
    .filter((candidate): candidate is WorkflowReviewerAssignment => candidate !== null)
    .findLast(
      (candidate) =>
        candidate.workflowId === input.definition.id &&
        candidate.workflowVersion === input.definition.version &&
        candidate.step === input.step,
    );
  return assignment?.reviewerSessionId === input.reviewerSessionId ? assignment : undefined;
}

export async function activeWorkflowReviewAssignment(input: {
  sessions: Pick<SessionStore, "getEntries">;
  parentSessionId: string;
  reviewerSessionId: string;
  definitions: readonly WorkflowDefinition[];
  entries?: readonly SessionEntry[];
}): Promise<
  | {
      assignment: WorkflowReviewerAssignment;
      definition: WorkflowDefinition;
      step: WorkflowDefinition["steps"][number];
    }
  | undefined
> {
  const entries =
    input.entries ??
    (await input.sessions.getEntries(input.parentSessionId, {
      tools: ["workflow_gate", "workflow_reviewer_assignment"],
    }));
  const assignments = entries
    .map(reviewerAssignment)
    .filter((candidate): candidate is WorkflowReviewerAssignment => candidate !== null);
  const completed = entries
    .map(acceptedWorkflowGate)
    .filter((candidate): candidate is WorkflowGateResult => candidate !== null);
  const seenSteps = new Set<string>();
  for (let index = assignments.length - 1; index >= 0; index -= 1) {
    const assignment = assignments[index]!;
    const assignmentStep = `${assignment.workflowId}:${assignment.workflowVersion}:${assignment.step}`;
    if (seenSteps.has(assignmentStep)) continue;
    seenSteps.add(assignmentStep);
    if (assignment.reviewerSessionId !== input.reviewerSessionId) continue;
    const definition = input.definitions.find(
      (candidate) => candidate.id === assignment.workflowId && candidate.version === assignment.workflowVersion,
    );
    const step = definition?.steps.find((candidate) => candidate.id === assignment.step);
    if (
      definition &&
      step &&
      !completed.some(
        (gate) =>
          gate.workflowId === assignment.workflowId &&
          gate.workflowVersion === assignment.workflowVersion &&
          gate.step === assignment.step,
      )
    )
      return { assignment, definition, step };
  }
  return undefined;
}

export async function workflowEvidenceForReviewer(input: {
  sessions: Pick<SessionStore, "getEntries">;
  parentSessionId: string;
  reviewerSessionId: string;
  definitions: readonly WorkflowDefinition[];
}): Promise<WorkflowEvidence[]> {
  const entries = await input.sessions.getEntries(input.parentSessionId, {
    tools: ["workflow_gate", "workflow_reviewer_assignment"],
  });
  const review = await activeWorkflowReviewAssignment({ ...input, entries });
  if (!review?.step.evidenceFrom) return [];
  const evidenceGate = entries
    .map(acceptedWorkflowGate)
    .filter((candidate): candidate is WorkflowGateResult => candidate !== null)
    .findLast(
      (gate) =>
        gate.workflowId === review.definition.id &&
        gate.workflowVersion === review.definition.version &&
        gate.step === review.step.evidenceFrom,
    );
  return [...(evidenceGate?.outputEvidence ?? [])];
}

export async function workflowEvidenceForProducer(input: {
  sessions: Pick<SessionStore, "getEntries">;
  sessionId: string;
  definitions: readonly WorkflowDefinition[];
}): Promise<WorkflowEvidence[]> {
  const entries = await input.sessions.getEntries(input.sessionId, { tools: ["workflow_gate"] });
  const accepted = entries
    .map(acceptedWorkflowGate)
    .filter((candidate): candidate is WorkflowGateResult => candidate !== null)
    .filter((gate) =>
      input.definitions.some(
        (definition) => definition.id === gate.workflowId && definition.version === gate.workflowVersion,
      ),
    );
  const evidence = new Map<string, WorkflowEvidence>();
  for (const gate of accepted)
    for (const item of gate.outputEvidence) evidence.set(`${item.id}:${item.digest}`, { ...item });
  return [...evidence.values()];
}
