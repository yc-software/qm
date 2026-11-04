import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDefinition, WorkflowGateStep, WorkflowSkillRequirement } from "./workflow-gate.ts";
import { safeSkillFilePath } from "../skills/skill-store.ts";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty`);
  return value;
}

function requirement(value: unknown, label: string): WorkflowSkillRequirement {
  const item = record(value, label);
  const contentDigest = item.contentDigest;
  if (contentDigest !== undefined && (typeof contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(contentDigest)))
    throw new Error(`${label}.contentDigest must be a SHA-256 digest`);
  const minimumVersion = item.minimumVersion;
  if (minimumVersion !== undefined && (!Number.isSafeInteger(minimumVersion) || Number(minimumVersion) < 1))
    throw new Error(`${label}.minimumVersion must be a positive integer`);
  const skillId = item.skillId === undefined ? undefined : text(item.skillId, `${label}.skillId`);
  const skillName = item.skillName === undefined ? undefined : text(item.skillName, `${label}.skillName`);
  if (!skillId && !skillName) throw new Error(`${label} must include skillId or skillName`);
  return {
    ...(skillId ? { skillId } : {}),
    ...(skillName ? { skillName } : {}),
    ...(contentDigest ? { contentDigest } : {}),
    ...(minimumVersion !== undefined ? { minimumVersion: Number(minimumVersion) } : {}),
  };
}

function definition(value: unknown, index: number): WorkflowDefinition {
  const item = record(value, `workflows[${index}]`);
  const id = text(item.id, `workflows[${index}].id`);
  if (!Number.isSafeInteger(item.version) || Number(item.version) < 1)
    throw new Error(`workflow ${id} version must be a positive integer`);
  if (!Array.isArray(item.steps) || !item.steps.length) throw new Error(`workflow ${id} steps must be nonempty`);
  const seen = new Set<string>();
  const steps = item.steps.map((value, stepIndex): WorkflowGateStep => {
    const raw = record(value, `workflow ${id} steps[${stepIndex}]`);
    const stepId = text(raw.id, `workflow ${id} steps[${stepIndex}].id`);
    if (seen.has(stepId)) throw new Error(`workflow ${id} contains duplicate step ${stepId}`);
    for (const field of ["after", "separateFrom", "evidenceFrom"] as const) {
      if (raw[field] !== undefined && !seen.has(text(raw[field], `workflow ${id} step ${stepId}.${field}`)))
        throw new Error(`workflow ${id} step ${stepId}.${field} must reference an earlier step`);
    }
    if (raw.humanApproval === true && raw.separateFrom !== undefined)
      throw new Error(`workflow ${id} step ${stepId} cannot combine human approval with reviewer separation`);
    if (!Array.isArray(raw.requiredSkills))
      throw new Error(`workflow ${id} step ${stepId}.requiredSkills must be an array`);
    const step: WorkflowGateStep = {
      id: stepId,
      role: text(raw.role, `workflow ${id} step ${stepId}.role`),
      ...(raw.humanApproval === true ? { humanApproval: true } : {}),
      ...(typeof raw.after === "string" ? { after: raw.after } : {}),
      ...(typeof raw.separateFrom === "string" ? { separateFrom: raw.separateFrom } : {}),
      ...(typeof raw.evidenceFrom === "string" ? { evidenceFrom: raw.evidenceFrom } : {}),
      requiredSkills: raw.requiredSkills.map((skill, skillIndex) =>
        requirement(skill, `workflow ${id} step ${stepId}.requiredSkills[${skillIndex}]`),
      ),
    };
    seen.add(stepId);
    return step;
  });
  const approvals = steps.filter((step) => step.humanApproval);
  if (approvals.length !== 1 || approvals[0]!.id !== "PLAN_APPROVED")
    throw new Error(`workflow ${id} must define PLAN_APPROVED as its only human-approval step`);
  let sourceExecution: WorkflowDefinition["sourceExecution"];
  if (item.sourceExecution !== undefined) {
    const source = record(item.sourceExecution, `workflow ${id}.sourceExecution`);
    const approvalStep = text(source.approvalStep, `workflow ${id}.sourceExecution.approvalStep`);
    if (!steps.some((step) => step.id === approvalStep && step.humanApproval))
      throw new Error(`workflow ${id}.sourceExecution.approvalStep must name a human-approval step`);
    const compiler = record(source.compiler, `workflow ${id}.sourceExecution.compiler`);
    const contentDigest = text(compiler.contentDigest, `workflow ${id}.sourceExecution.compiler.contentDigest`);
    if (!/^[a-f0-9]{64}$/.test(contentDigest))
      throw new Error(`workflow ${id}.sourceExecution.compiler.contentDigest must be a SHA-256 digest`);
    const path = safeSkillFilePath(text(compiler.path, `workflow ${id}.sourceExecution.compiler.path`));
    if (!Array.isArray(source.expectedPopulations) || !source.expectedPopulations.length)
      throw new Error(`workflow ${id}.sourceExecution.expectedPopulations must be a nonempty array`);
    const expectedPopulations = source.expectedPopulations.map((population, populationIndex) =>
      text(population, `workflow ${id}.sourceExecution.expectedPopulations[${populationIndex}]`),
    );
    if (new Set(expectedPopulations).size !== expectedPopulations.length)
      throw new Error(`workflow ${id}.sourceExecution.expectedPopulations must be unique`);
    sourceExecution = {
      approvalStep,
      compiler: {
        skillName: text(compiler.skillName, `workflow ${id}.sourceExecution.compiler.skillName`),
        path,
        contentDigest,
      },
      expectedPopulations,
    };
  }
  const agent = item.agent === undefined ? undefined : text(item.agent, `workflow ${id}.agent`);
  const reviewAgent = item.reviewAgent === undefined ? undefined : text(item.reviewAgent, `workflow ${id}.reviewAgent`);
  return {
    id,
    version: Number(item.version),
    ...(agent ? { agent } : {}),
    ...(reviewAgent ? { reviewAgent } : {}),
    ...(sourceExecution ? { sourceExecution } : {}),
    steps,
  };
}

export function loadWorkflowDefinitions(deploymentLayerDir?: string): WorkflowDefinition[] {
  if (!deploymentLayerDir) return [];
  const path = join(deploymentLayerDir, "workflow-gates.json");
  if (!existsSync(path)) return [];
  const root = record(JSON.parse(readFileSync(path, "utf8")), "workflow-gates.json");
  if (!Array.isArray(root.workflows)) throw new Error("workflow-gates.json workflows must be an array");
  const workflows = root.workflows.map(definition);
  if (workflows.length > 1) throw new Error("workflow-gates.json supports exactly one active workflow");
  const ids = new Set<string>();
  for (const workflow of workflows) {
    if (ids.has(workflow.id)) throw new Error(`workflow-gates.json contains duplicate workflow ${workflow.id}`);
    ids.add(workflow.id);
  }
  return workflows;
}
