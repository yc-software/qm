import { randomUUID } from "node:crypto";
import type { ScopeId, SessionEntry } from "../types.ts";
import type { Lease, SessionStore } from "./session-store.ts";

export interface WorkflowSkillRequirement {
  skillId?: string;
  skillName?: string;
  contentDigest?: string;
  minimumVersion?: number;
}

export interface WorkflowGateStep {
  id: string;
  role: string;
  humanApproval?: boolean;
  after?: string;
  separateFrom?: string;
  evidenceFrom?: string;
  requiredSkills: readonly WorkflowSkillRequirement[];
}

export interface WorkflowDefinition {
  id: string;
  version: number;
  agent?: string;
  reviewAgent?: string;
  sourceExecution?: {
    approvalStep: string;
    compiler: {
      skillName: string;
      path: string;
      contentDigest: string;
    };
    expectedPopulations: readonly string[];
  };
  steps: readonly WorkflowGateStep[];
}

export interface WorkflowGateSubmission {
  step: string;
  decision: "pass" | "reject";
  subject: string;
  inputEvidence?: readonly WorkflowEvidence[];
  outputEvidence?: readonly WorkflowEvidence[];
  findings?: readonly string[];
}

export interface WorkflowEvidence {
  id: string;
  digest: string;
}

export interface ObservedWorkflowSkill {
  name?: string;
  skillId: string;
  skillVersion: number;
  contentDigest: string;
}

export interface WorkflowGateResult {
  accepted: boolean;
  workflowId: string;
  workflowVersion: number;
  step: string;
  role: string;
  decision: "pass" | "reject";
  subject: string;
  observedSkills: ObservedWorkflowSkill[];
  missingSkills: WorkflowSkillRequirement[];
  unexpectedSkills: ObservedWorkflowSkill[];
  blockers: string[];
  findings: string[];
  inputEvidence: WorkflowEvidence[];
  outputEvidence: WorkflowEvidence[];
}

function observedSkills(entry: SessionEntry): ObservedWorkflowSkill[] {
  if (entry.type !== "tool_result" || !entry.payload || typeof entry.payload !== "object") return [];
  const payload = entry.payload as Record<string, unknown>;
  if (payload.tool !== "skills" || payload.action !== "read" || payload.found !== true) return [];
  if (!payload.provenance || typeof payload.provenance !== "object") return [];
  const provenance = payload.provenance as Record<string, unknown>;
  if (
    typeof provenance.skillId !== "string" ||
    typeof provenance.skillVersion !== "number" ||
    typeof provenance.contentDigest !== "string"
  )
    return [];
  const base = {
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
    skillId: provenance.skillId,
    skillVersion: provenance.skillVersion,
  };
  const materializedContentDigests = Array.isArray(provenance.materializedContentDigests)
    ? provenance.materializedContentDigests.filter((digest): digest is string => typeof digest === "string")
    : [];
  return [provenance.contentDigest, ...materializedContentDigests].map((contentDigest) => ({
    ...base,
    contentDigest,
  }));
}

export function observedWorkflowSkills(entries: readonly SessionEntry[]): ObservedWorkflowSkill[] {
  return entries
    .flatMap(observedSkills)
    .filter(
      (skill, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.skillId === skill.skillId &&
            candidate.name === skill.name &&
            candidate.skillVersion === skill.skillVersion &&
            candidate.contentDigest === skill.contentDigest,
        ) === index,
    );
}

export function missingWorkflowSkills(
  observed: readonly ObservedWorkflowSkill[],
  required: readonly WorkflowSkillRequirement[],
): WorkflowSkillRequirement[] {
  return required.filter((requirement) => !observed.some((skill) => workflowSkillSatisfies(skill, requirement)));
}

export function unexpectedWorkflowSkills(
  observed: readonly ObservedWorkflowSkill[],
  allowed: readonly WorkflowSkillRequirement[],
): ObservedWorkflowSkill[] {
  return observed.filter(
    (skill) =>
      !allowed.some(
        (requirement) =>
          (requirement.skillId === undefined || requirement.skillId === skill.skillId) &&
          (requirement.skillName === undefined || requirement.skillName === skill.name),
      ),
  );
}

export function workflowSkillSatisfies(observed: ObservedWorkflowSkill, required: WorkflowSkillRequirement): boolean {
  return (
    (required.skillId === undefined || observed.skillId === required.skillId) &&
    (required.skillName === undefined || observed.name === required.skillName) &&
    (required.contentDigest === undefined || observed.contentDigest === required.contentDigest) &&
    (required.minimumVersion === undefined || observed.skillVersion >= required.minimumVersion)
  );
}

export async function activeWorkflowSkillRequirements(input: {
  sessions: Pick<SessionStore, "getEntries">;
  sessionId: string;
  definitions: readonly WorkflowDefinition[];
  entries?: readonly SessionEntry[];
}): Promise<readonly WorkflowSkillRequirement[]> {
  const passed = (input.entries ?? (await input.sessions.getEntries(input.sessionId, { tools: ["workflow_gate"] })))
    .map(acceptedWorkflowGate)
    .filter((gate): gate is WorkflowGateResult => gate !== null);
  const latest = passed.findLast((gate) =>
    input.definitions.some(
      (definition) => definition.id === gate.workflowId && definition.version === gate.workflowVersion,
    ),
  );
  if (!latest) return input.definitions.length === 1 ? (input.definitions[0]?.steps[0]?.requiredSkills ?? []) : [];
  const definition = input.definitions.find(
    (candidate) => candidate.id === latest.workflowId && candidate.version === latest.workflowVersion,
  );
  const passedSteps = new Set(
    passed
      .filter((gate) => gate.workflowId === latest.workflowId && gate.workflowVersion === latest.workflowVersion)
      .map((gate) => gate.step),
  );
  const next = definition?.steps.find((step) => !passedSteps.has(step.id));
  return next?.separateFrom ? [] : (next?.requiredSkills ?? []);
}

export function acceptedWorkflowGate(entry: SessionEntry): WorkflowGateResult | null {
  if (entry.type !== "tool_result" || !entry.payload || typeof entry.payload !== "object") return null;
  const payload = entry.payload as Record<string, unknown>;
  if (payload.tool !== "workflow_gate" || payload.accepted !== true) return null;
  if (
    typeof payload.workflowId !== "string" ||
    typeof payload.workflowVersion !== "number" ||
    typeof payload.step !== "string" ||
    typeof payload.subject !== "string"
  )
    return null;
  return payload as unknown as WorkflowGateResult;
}

function sameEvidence(left: readonly WorkflowEvidence[], right: readonly WorkflowEvidence[]): boolean {
  return (
    left.length === right.length &&
    left.every((evidence) =>
      right.some((candidate) => candidate.id === evidence.id && candidate.digest === evidence.digest),
    )
  );
}

export async function evaluateWorkflowGate(input: {
  sessions: Pick<SessionStore, "getEntries" | "appendMany">;
  lease: Lease;
  scopeLabel: ScopeId;
  definition: WorkflowDefinition;
  submission: WorkflowGateSubmission;
  observedSkills?: readonly ObservedWorkflowSkill[];
}): Promise<WorkflowGateResult> {
  const step = input.definition.steps.find((candidate) => candidate.id === input.submission.step);
  if (!step) throw new Error(`workflow ${input.definition.id} has no step ${input.submission.step}`);
  const gateEntries = await input.sessions.getEntries(input.lease.sessionId, { tools: ["workflow_gate"] });
  const passedEntries = gateEntries
    .map((entry) => ({ entry, gate: acceptedWorkflowGate(entry) }))
    .filter((item): item is { entry: SessionEntry; gate: WorkflowGateResult } => item.gate !== null)
    .filter(
      (item) => item.gate.workflowId === input.definition.id && item.gate.workflowVersion === input.definition.version,
    );
  const predecessorEntry = step.after ? passedEntries.findLast((item) => item.gate.step === step.after) : undefined;
  const skillEntries = await input.sessions.getEntries(
    input.lease.sessionId,
    input.lease.turnId ? { turnId: input.lease.turnId } : { tools: ["skills"] },
  );
  const observedSkills = [
    ...(input.observedSkills ??
      observedWorkflowSkills(
        predecessorEntry ? skillEntries.filter((entry) => entry.seq > predecessorEntry.entry.seq) : skillEntries,
      )),
  ];
  const missingSkills = missingWorkflowSkills(observedSkills, step.requiredSkills);
  const unexpectedSkills = unexpectedWorkflowSkills(observedSkills, step.requiredSkills);
  const passed = passedEntries.map((item) => item.gate);
  const predecessor = step.after ? passed.findLast((gate) => gate.step === step.after) : undefined;
  const separated = step.separateFrom ? passed.findLast((gate) => gate.step === step.separateFrom) : undefined;
  const evidenceSource = step.evidenceFrom ? passed.findLast((gate) => gate.step === step.evidenceFrom) : undefined;
  const alreadyPassed = passed.some((gate) => gate.step === step.id);
  const inputEvidence = [...(input.submission.inputEvidence ?? [])];
  const outputEvidence = [...(input.submission.outputEvidence ?? [])];
  const blockers = [
    ...(alreadyPassed ? [`step ${step.id} has already passed`] : []),
    ...(step.after && !predecessor ? [`required predecessor ${step.after} has not passed`] : []),
    ...(step.separateFrom && !separated ? [`required separation gate ${step.separateFrom} has not passed`] : []),
    ...(step.separateFrom && separated?.subject === input.submission.subject
      ? [`subject must differ from ${step.separateFrom}`]
      : []),
    ...(step.evidenceFrom && !evidenceSource ? [`required evidence gate ${step.evidenceFrom} has not passed`] : []),
    ...(step.evidenceFrom && evidenceSource && !sameEvidence(evidenceSource.outputEvidence, inputEvidence)
      ? [`evidence does not match ${step.evidenceFrom}`]
      : []),
    ...(step.evidenceFrom && evidenceSource?.outputEvidence.length === 0
      ? [`required evidence gate ${step.evidenceFrom} has no evidence`]
      : []),
  ];
  const result: WorkflowGateResult = {
    accepted: input.submission.decision === "pass" && missingSkills.length === 0 && blockers.length === 0,
    workflowId: input.definition.id,
    workflowVersion: input.definition.version,
    step: step.id,
    role: step.role,
    decision: input.submission.decision,
    subject: input.submission.subject,
    observedSkills,
    missingSkills: [...missingSkills],
    unexpectedSkills,
    blockers,
    findings: [...(input.submission.findings ?? [])],
    inputEvidence,
    outputEvidence,
  };
  const callId = `workflow-gate-${randomUUID()}`;
  await input.sessions.appendMany(input.lease, [
    {
      type: "tool_call",
      payload: {
        tool: "workflow_gate",
        callId,
        workflowId: input.definition.id,
        workflowVersion: input.definition.version,
        step: step.id,
        decision: input.submission.decision,
        subject: input.submission.subject,
      },
      scopeLabel: input.scopeLabel,
    },
    {
      type: "tool_result",
      payload: { tool: "workflow_gate", callId, result: JSON.stringify(result), ...result },
      scopeLabel: input.scopeLabel,
    },
  ]);
  return result;
}
