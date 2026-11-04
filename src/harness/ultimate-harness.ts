import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, isAbsolute } from "node:path";
import { toolCallApprovalKey } from "../core/approval-id.ts";
import { parseOutboundFiles } from "../core/attachments.ts";
import { hasParentPathSegment } from "../sandbox/sandbox.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { sleep, withAbort } from "../util/async.ts";
import { shq } from "../util/shell.ts";
import { acceptedWorkflowGate, type WorkflowDefinition, type WorkflowEvidence } from "../sessions/workflow-gate.ts";
import { NeedsApproval, type WorkflowToolInput } from "../tools/primitives.ts";
import type { SessionEntry } from "../types.ts";
import { defineHarness, type Harness, type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";
import { replayPreamble } from "./replay.ts";

interface UltimateModel {
  provider: string;
  modelId: string;
}

interface UltimateHarnessOptions {
  baseUrl: string;
  projectRoot?: string;
  agent?: string | ((input: HarnessTurnInput) => Promise<string | undefined>);
  model?: UltimateModel | ((modelId: string) => UltimateModel | undefined);
  modelBroker?: (input: HarnessTurnInput) => Promise<{ baseUrl: string; token: string; modelId: string }>;
  toolBroker?: (input: HarnessTurnInput) => Promise<{ baseUrl: string; token: string }>;
  publishArtifact?: (
    input: HarnessTurnInput,
    artifact: { name: string; value: unknown },
  ) => Promise<{ artifactId: string; digest: string }>;
  readArtifact?: (
    input: HarnessTurnInput,
    artifactId: string,
  ) => Promise<{ artifactId: string; name: string; mimetype: string; digest: string; value: unknown } | undefined>;
  workflowSnapshot?: (input: HarnessTurnInput) => Promise<UltimateWorkflowSnapshot | undefined>;
  dispatchReviewer?: (
    input: HarnessTurnInput,
    review: {
      workflowId: string;
      workflowVersion: number;
      step: string;
      role: string;
      inputEvidence: WorkflowEvidence[];
    },
  ) => Promise<{ sessionId: string }>;
  importReviewer?: (
    input: HarnessTurnInput,
    review: { workflowId: string; workflowVersion: number; step: string; reviewerSessionId: string },
  ) => Promise<boolean>;
  pollIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface UltimateAcceptedWorkflowGate {
  decision: "pass";
  subject: string;
  inputEvidence: WorkflowEvidence[];
  outputEvidence: WorkflowEvidence[];
}

interface UltimateWorkflowStepSnapshot {
  step: string;
  role: string;
  humanApproval?: true;
  after?: string;
  separateFrom?: string;
  evidenceFrom?: string;
  reviewerSessionId?: string;
  rejected?: { decision: "reject"; subject: string; findings: string[] };
  accepted?: UltimateAcceptedWorkflowGate;
}

function workflowReviewerAssignment(entry: SessionEntry) {
  if (entry.type !== "tool_result" || !entry.payload || typeof entry.payload !== "object") return undefined;
  const payload = entry.payload as Record<string, unknown>;
  if (
    payload.tool !== "workflow_reviewer_assignment" ||
    typeof payload.workflowId !== "string" ||
    typeof payload.workflowVersion !== "number" ||
    typeof payload.step !== "string" ||
    typeof payload.reviewerSessionId !== "string"
  )
    return undefined;
  return payload as {
    workflowId: string;
    workflowVersion: number;
    step: string;
    reviewerSessionId: string;
  };
}

export interface UltimateWorkflowSnapshot {
  sessionId: string;
  workflows: Array<{
    workflowId: string;
    workflowVersion: number;
    steps: UltimateWorkflowStepSnapshot[];
  }>;
}

export function ultimateWorkflowSnapshot(
  sessionId: string,
  definitions: readonly WorkflowDefinition[],
  entries: readonly SessionEntry[],
): UltimateWorkflowSnapshot | undefined {
  if (!definitions.length) return undefined;
  const gates = entries
    .filter((entry) => entry.type === "tool_result" && entry.payload && typeof entry.payload === "object")
    .map((entry) => entry.payload as Record<string, unknown>)
    .filter(
      (payload) =>
        payload.tool === "workflow_gate" &&
        typeof payload.workflowId === "string" &&
        typeof payload.workflowVersion === "number" &&
        typeof payload.step === "string",
    );
  const accepted = entries.map(acceptedWorkflowGate).filter((gate) => gate !== null);
  const assignments = entries.map(workflowReviewerAssignment).filter((assignment) => assignment !== undefined);
  return {
    sessionId,
    workflows: definitions.map((definition) => ({
      workflowId: definition.id,
      workflowVersion: definition.version,
      steps: definition.steps.map((step) => {
        const gate = accepted.findLast(
          (candidate) =>
            candidate.workflowId === definition.id &&
            candidate.workflowVersion === definition.version &&
            candidate.step === step.id,
        );
        const rejected = gates.findLast(
          (candidate) =>
            candidate.workflowId === definition.id &&
            candidate.workflowVersion === definition.version &&
            candidate.step === step.id &&
            candidate.decision === "reject" &&
            candidate.accepted === false,
        );
        const assignment = assignments.findLast(
          (candidate) =>
            candidate.workflowId === definition.id &&
            candidate.workflowVersion === definition.version &&
            candidate.step === step.id,
        );
        return {
          step: step.id,
          role: step.role,
          ...(step.humanApproval ? { humanApproval: true as const } : {}),
          ...(step.after ? { after: step.after } : {}),
          ...(step.separateFrom ? { separateFrom: step.separateFrom } : {}),
          ...(step.evidenceFrom ? { evidenceFrom: step.evidenceFrom } : {}),
          ...(assignment ? { reviewerSessionId: assignment.reviewerSessionId } : {}),
          ...(!gate && rejected
            ? {
                rejected: {
                  decision: "reject" as const,
                  subject: typeof rejected.subject === "string" ? rejected.subject : "unknown",
                  findings: Array.isArray(rejected.findings)
                    ? rejected.findings.filter((finding): finding is string => typeof finding === "string")
                    : [],
                },
              }
            : {}),
          ...(gate
            ? {
                accepted: {
                  decision: "pass" as const,
                  subject: gate.subject,
                  inputEvidence: [...gate.inputEvidence],
                  outputEvidence: [...gate.outputEvidence],
                },
              }
            : {}),
        };
      }),
    })),
  };
}

function advancedWorkflowStage(
  before: UltimateWorkflowSnapshot | undefined,
  after: UltimateWorkflowSnapshot | undefined,
):
  | {
      workflowId: string;
      workflowVersion: number;
      step: UltimateWorkflowStepSnapshot;
    }
  | undefined {
  if (!before || !after || before.sessionId !== after.sessionId) return undefined;
  for (const workflow of after.workflows) {
    const previous = before.workflows.find(
      (candidate) =>
        candidate.workflowId === workflow.workflowId && candidate.workflowVersion === workflow.workflowVersion,
    );
    if (!previous) continue;
    const previouslyAccepted = new Set(previous.steps.filter((step) => step.accepted).map((step) => step.step));
    const accepted = new Set(workflow.steps.filter((step) => step.accepted).map((step) => step.step));
    if (![...accepted].some((step) => !previouslyAccepted.has(step))) continue;
    const next = workflow.steps.find((step) => !accepted.has(step.step));
    if (next) return { workflowId: workflow.workflowId, workflowVersion: workflow.workflowVersion, step: next };
  }
  return undefined;
}

function workflowStepInputEvidence(
  snapshot: UltimateWorkflowSnapshot,
  workflowId: string,
  workflowVersion: number,
  step: UltimateWorkflowStepSnapshot,
): WorkflowEvidence[] {
  if (!step.evidenceFrom) return [];
  const workflow = snapshot.workflows.find(
    (candidate) => candidate.workflowId === workflowId && candidate.workflowVersion === workflowVersion,
  );
  return [
    ...(workflow?.steps.find((candidate) => candidate.step === step.evidenceFrom)?.accepted?.outputEvidence ?? []),
  ];
}

function pendingSeparatedWorkflowStage(snapshot: UltimateWorkflowSnapshot | undefined) {
  if (!snapshot) return undefined;
  for (const workflow of snapshot.workflows) {
    const next = workflow.steps.find((step) => !step.accepted && !step.rejected);
    if (!next?.separateFrom) continue;
    if (!workflow.steps.find((step) => step.step === next.separateFrom)?.accepted) continue;
    return { workflowId: workflow.workflowId, workflowVersion: workflow.workflowVersion, step: next };
  }
  return undefined;
}

interface UltimateHistoryEntry {
  id?: unknown;
  kind?: string;
  model?: unknown;
}

function durableConversation(history: readonly SessionEntry[]): number | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.type !== "tool_result" || !entry.payload || typeof entry.payload !== "object") continue;
    const payload = entry.payload as Record<string, unknown>;
    if (
      payload.tool === "ultimate_conversation" &&
      Number.isSafeInteger(payload.conversationId) &&
      (payload.conversationId as number) > 0
    )
      return payload.conversationId as number;
  }
  return undefined;
}

interface UltimateAssistantMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

interface UltimatePendingApproval {
  command: string;
  reason: string;
  kind: "approval";
  matched?: string;
  approvalKey?: string;
  grantModes?: { session: boolean; always: boolean };
}

interface UltimateTurnControl {
  broker: { baseUrl: string; token: string };
  pendingApprovals: UltimatePendingApproval[];
  close(): Promise<void>;
}

const SKILL_RUN_MAX_ARGS = 256;
const SKILL_RUN_MAX_ARG_CHARS = 65_536;
const SKILL_RUN_MAX_TOTAL_ARG_CHARS = 1_048_576;

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function pendingApproval(error: NeedsApproval): UltimatePendingApproval {
  return {
    command: error.command,
    reason: error.approvalReason,
    kind: error.kind,
    ...(error.matched ? { matched: error.matched } : {}),
    ...(error.approvalKey ? { approvalKey: error.approvalKey } : {}),
    ...(error.grantModes ? { grantModes: error.grantModes } : {}),
  };
}

function workflowApproval(input: WorkflowToolInput): NeedsApproval {
  const approvalKey = toolCallApprovalKey("workflow", input);
  return new NeedsApproval(
    `workflow ${canonicalJson(input)}`,
    "approve the exact workflow plan before source execution",
    "approval",
    undefined,
    approvalKey,
    { session: false, always: false },
  );
}

function approvedWorkflowForRun(
  history: readonly SessionEntry[],
  runId: string | undefined,
): WorkflowToolInput | undefined {
  if (!runId) return undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.type !== "approval_resolved" || !entry.payload || typeof entry.payload !== "object") continue;
    const payload = entry.payload as Record<string, unknown>;
    if (payload.runId !== runId || payload.approved !== true || typeof payload.command !== "string") continue;
    const prefix = "workflow ";
    if (!payload.command.startsWith(prefix)) continue;
    const parsed = JSON.parse(payload.command.slice(prefix.length)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Approved Ultimate workflow operation is invalid");
    return parsed as WorkflowToolInput;
  }
  return undefined;
}

function normalizedSkillPath(name: string, value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) return null;
  const path = value;
  if (path.startsWith("skills/") || path.startsWith(`${name}/`)) return null;
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".."))
    return null;
  return path;
}

interface UltimateInputArtifact {
  artifactId: string;
  digest: string;
  path: string;
}

function normalizedInputArtifacts(value: unknown): UltimateInputArtifact[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const artifacts: UltimateInputArtifact[] = [];
  const paths = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.artifactId !== "string" ||
      !candidate.artifactId ||
      typeof candidate.digest !== "string" ||
      !candidate.digest ||
      typeof candidate.path !== "string"
    )
      return null;
    const path = candidate.path.trim();
    if (!path || isAbsolute(path) || hasParentPathSegment(path) || paths.has(path)) return null;
    paths.add(path);
    artifacts.push({ artifactId: candidate.artifactId, digest: candidate.digest, path });
  }
  return artifacts;
}

async function createTurnControl(
  input: HarnessTurnInput,
  publishArtifact: UltimateHarnessOptions["publishArtifact"],
  readArtifact: UltimateHarnessOptions["readArtifact"],
  approvedWorkflow?: { input: WorkflowToolInput; result: unknown },
): Promise<UltimateTurnControl> {
  const token = randomBytes(32).toString("base64url");
  const callNamespace = randomBytes(12).toString("hex");
  const pendingApprovals: UltimatePendingApproval[] = [];
  let skillCall = 0;
  const readSkill = async (name: string, path?: string, source?: string) => {
    const callId = `ultimate-skill-${callNamespace}-${++skillCall}`;
    await input.emit({
      type: "tool_call",
      payload: {
        tool: "skills",
        action: "read",
        name,
        ...(path ? { path } : {}),
        ...(source ? { source } : {}),
        callId,
      },
      scopeLabel: input.scopeLabel,
    });
    const result = await input.tools.skill(name, {
      ...(path ? { path } : {}),
      ...(source ? { source } : {}),
      ...(input.cancel ? { signal: input.cancel } : {}),
    });
    const text = result.content ?? `[no such skill file: ${name}/${path ?? "SKILL.md"}]`;
    await input.emit({
      type: "tool_result",
      payload: {
        tool: "skills",
        action: "read",
        name,
        ...(path ? { path } : {}),
        found: result.content !== null,
        ...(result.content !== null ? { bytes: result.content.length, sourceScopeId: result.sourceScopeId } : {}),
        ...(result.dir ? { dir: result.dir } : {}),
        ...(result.provenance ? { provenance: result.provenance } : {}),
        callId,
        isError: result.content === null,
        result: text,
      },
      scopeLabel: input.scopeLabel,
    });
    return result;
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`)
        return sendJson(response, 401, { error: "unauthorized" });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/skills") {
        const query = url.searchParams.get("query") ?? undefined;
        const source = url.searchParams.get("source") ?? undefined;
        const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined;
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
        const { sourceScopeId: _, ...result } = await input.tools.listSkills(query, offset, limit, source);
        return sendJson(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/skills/read") {
        const body = (await requestBody(request)) as { name?: unknown; path?: unknown; source?: unknown };
        if (typeof body?.name !== "string" || !body.name) return sendJson(response, 400, { error: "name_required" });
        const path = normalizedSkillPath(body.name, body.path);
        if (path === null) return sendJson(response, 400, { error: "invalid_skill_path" });
        const source = typeof body.source === "string" ? body.source : undefined;
        const result = await readSkill(body.name, path, source);
        return sendJson(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/skills/run") {
        const body = (await requestBody(request)) as {
          name?: unknown;
          path?: unknown;
          args?: unknown;
          inputArtifacts?: unknown;
          outputFiles?: unknown;
        };
        if (typeof body?.name !== "string" || !body.name) return sendJson(response, 400, { error: "name_required" });
        const path = normalizedSkillPath(body.name, body.path);
        if (path === null || path === undefined) return sendJson(response, 400, { error: "invalid_skill_path" });
        if (
          !Array.isArray(body.args) ||
          body.args.length > SKILL_RUN_MAX_ARGS ||
          body.args.some((arg) => typeof arg !== "string" || arg.length > SKILL_RUN_MAX_ARG_CHARS) ||
          body.args.reduce((total, arg) => total + (typeof arg === "string" ? arg.length : 0), 0) >
            SKILL_RUN_MAX_TOTAL_ARG_CHARS
        )
          return sendJson(response, 400, { error: "invalid_skill_args" });
        const outputFiles = parseOutboundFiles(body.outputFiles);
        if (!outputFiles.ok || outputFiles.files.some((file) => typeof file !== "string" || isAbsolute(file)))
          return sendJson(response, 400, { error: "invalid_output_files" });
        const inputArtifacts = normalizedInputArtifacts(body.inputArtifacts);
        if (!inputArtifacts) return sendJson(response, 400, { error: "invalid_input_artifacts" });
        const skill = await readSkill(body.name, "SKILL.md");
        if (skill.content === null || !skill.dir || !skill.provenance)
          return sendJson(response, 403, { error: "skill_not_authorized" });
        const file = await readSkill(body.name, path);
        if (
          file.content === null ||
          !file.provenance ||
          file.provenance.skillId !== skill.provenance.skillId ||
          file.provenance.skillVersion !== skill.provenance.skillVersion ||
          !skill.provenance.materializedContentDigests?.includes(file.provenance.contentDigest)
        )
          return sendJson(response, 403, { error: "skill_file_not_authorized" });
        if (inputArtifacts.length && !readArtifact)
          return sendJson(response, 503, { error: "artifact_read_unavailable" });
        const materialized: Array<{ path: string; value: unknown }> = [];
        for (const requested of inputArtifacts) {
          const artifact = await readArtifact!(input, requested.artifactId);
          if (!artifact || artifact.digest !== requested.digest || artifact.mimetype !== "application/json")
            return sendJson(response, 403, { error: "input_artifact_not_authorized" });
          materialized.push({ path: requested.path, value: artifact.value });
        }
        for (const artifact of materialized) await input.tools.write(artifact.path, JSON.stringify(artifact.value));
        const script = `${skill.dir}/${path}`;
        const command = `chmod u+x ${shq(script)} && ${shq(script)}${body.args.length ? ` ${body.args.map(shq).join(" ")}` : ""}`;
        const result = await input.tools.execute(command, {
          ...(input.cancel ? { signal: input.cancel } : {}),
        });
        if (result.code === 0 && outputFiles.files.length) {
          const attached = await input.tools.attach(outputFiles.files);
          if (!attached.ok)
            return sendJson(response, 422, { error: "skill_outputs_unavailable", message: attached.message });
          return sendJson(response, 200, {
            exitCode: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            files: attached.files,
            staged: attached.staged,
          });
        }
        return sendJson(response, 200, {
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
      if (request.method === "POST" && url.pathname === "/artifacts") {
        if (!publishArtifact) return sendJson(response, 503, { error: "artifact_publish_unavailable" });
        const body = (await requestBody(request)) as { name?: unknown; value?: unknown };
        if (typeof body?.name !== "string" || !body.name || !("value" in body))
          return sendJson(response, 400, { error: "name_and_value_required" });
        if (basename(body.name) !== body.name || body.name === "." || body.name === "..")
          return sendJson(response, 400, { error: "invalid_artifact_name" });
        return sendJson(response, 200, await publishArtifact(input, { name: body.name, value: body.value }));
      }
      if (request.method === "POST" && url.pathname === "/artifacts/read") {
        if (!readArtifact) return sendJson(response, 503, { error: "artifact_read_unavailable" });
        const body = (await requestBody(request)) as { artifactId?: unknown };
        if (typeof body?.artifactId !== "string" || !body.artifactId)
          return sendJson(response, 400, { error: "artifact_id_required" });
        const artifact = await readArtifact(input, body.artifactId);
        return artifact
          ? sendJson(response, 200, artifact)
          : sendJson(response, 403, { error: "artifact_not_authorized" });
      }
      if (request.method === "POST" && url.pathname === "/workflow") {
        const body = (await requestBody(request)) as WorkflowToolInput;
        if (!input.tools.workflow) return sendJson(response, 503, { error: "workflow_unavailable" });
        try {
          if (body.action === "approve") {
            if (approvedWorkflow && canonicalJson(body) === canonicalJson(approvedWorkflow.input))
              return sendJson(response, 200, { result: approvedWorkflow.result });
            const approval = workflowApproval(body);
            if (!input.toolApprovalGate?.("workflow", approval.approvalKey)) throw approval;
          }
          return sendJson(response, 200, { result: await input.tools.workflow(body) });
        } catch (error) {
          if (!(error instanceof NeedsApproval)) throw error;
          const approval = pendingApproval(error);
          pendingApprovals.push(approval);
          return sendJson(response, 409, { error: "needs_approval", approval });
        }
      }
      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Ultimate control broker did not bind a loopback port");
  return {
    broker: { baseUrl: `http://127.0.0.1:${address.port}`, token },
    pendingApprovals,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function assistantMessages(entry: UltimateHistoryEntry): UltimateAssistantMessage[] {
  if (entry.kind !== "pi.assistant" || !Array.isArray(entry.model)) return [];
  return entry.model.filter(
    (candidate): candidate is UltimateAssistantMessage =>
      !!candidate && typeof candidate === "object" && "role" in candidate && candidate.role === "assistant",
  );
}

function assistantText(entry: UltimateHistoryEntry): string | undefined {
  const message = assistantMessages(entry).find((candidate) => candidate.stopReason === "stop");
  if (!message || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part,
    )
    .map((part) => part.text)
    .join("");
  return text;
}

export function createUltimateHarness(options: UltimateHarnessOptions): Harness {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const pollIntervalMs = options.pollIntervalMs ?? 250;

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const response = await request(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok)
      throw new Error(`Ultimate ${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
    return body;
  }

  async function runTurn(input: HarnessTurnInput) {
    const continueTurn = !!input.continueTurn && input.history.some((entry) => entry.seq === input.resumeUserSeq);
    const approvedWorkflow = approvedWorkflowForRun(input.history, input.runId);
    let approvedWorkflowResult: unknown;
    if (approvedWorkflow) {
      if (!input.tools.workflow) throw new Error("Approved Ultimate workflow operation cannot run without workflow");
      const approval = workflowApproval(approvedWorkflow);
      if (!input.toolApprovalGate?.("workflow", approval.approvalKey))
        throw new Error("Approved Ultimate workflow operation is not authorized for this turn");
      approvedWorkflowResult = await input.tools.workflow(approvedWorkflow);
    }
    if (!continueTurn && !approvedWorkflow)
      await input.emit({
        type: "user",
        payload: {
          text: input.input,
          ...(input.environment ? { environment: input.environment } : {}),
          ...((input.triggerTs ?? input.entryTs) ? { ts: input.triggerTs ?? input.entryTs } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        },
        scopeLabel: input.scopeLabel,
        ...(input.runtimeActorId ? { author: input.runtimeActorId } : {}),
      });
    let initialWorkflowSnapshot = await options.workflowSnapshot?.(input);
    const assignedReview = pendingSeparatedWorkflowStage(initialWorkflowSnapshot);
    if (assignedReview?.step.reviewerSessionId && options.importReviewer) {
      const imported = await options.importReviewer(input, {
        workflowId: assignedReview.workflowId,
        workflowVersion: assignedReview.workflowVersion,
        step: assignedReview.step.step,
        reviewerSessionId: assignedReview.step.reviewerSessionId,
      });
      if (imported) initialWorkflowSnapshot = await options.workflowSnapshot?.(input);
    }
    const approvedWorkflowReplay = approvedWorkflow
      ? { input: approvedWorkflow, result: approvedWorkflowResult }
      : undefined;
    let control = await createTurnControl(input, options.publishArtifact, options.readArtifact, approvedWorkflowReplay);
    let activeConversationId: number | undefined;
    const performTurn = async (): Promise<HarnessTurnResult> => {
      const model = typeof options.model === "function" ? options.model(input.runtime?.modelId ?? "") : options.model;
      const agent = typeof options.agent === "function" ? await options.agent(input) : options.agent;
      const modelBroker = await options.modelBroker?.(input);
      const toolBroker = await options.toolBroker?.(input);
      let workflowSnapshot = initialWorkflowSnapshot;
      let id = durableConversation(input.history);
      let historyAfter = 0;
      if (id) {
        activeConversationId = id;
        const page = (await call(`/api/conversations/${id}/history?before=${Number.MAX_SAFE_INTEGER}`, {
          signal: input.cancel,
        })) as { entries?: unknown };
        const entries = Array.isArray(page.entries) ? (page.entries as UltimateHistoryEntry[]) : [];
        historyAfter = entries.reduce(
          (latest, entry) => (Number.isSafeInteger(entry.id) ? Math.max(latest, entry.id as number) : latest),
          0,
        );
        const configure = {
          ...(agent ? { agent } : {}),
          ...(modelBroker ? { modelBroker } : {}),
          ...(toolBroker ? { toolBroker } : {}),
          controlBroker: control.broker,
          ...(workflowSnapshot ? { workflowSnapshot } : {}),
        };
        if (Object.keys(configure).length)
          await call(`/api/conversations/${id}/configure`, {
            method: "POST",
            body: JSON.stringify(configure),
            signal: input.cancel,
          });
      } else {
        const created = (await call("/api/conversations", {
          method: "POST",
          body: JSON.stringify({
            cwd: options.projectRoot ?? process.cwd(),
            title: `QM ${input.session.id}`,
            ...(agent ? { agent } : {}),
            instructions: input.systemPrompt,
            ...(modelBroker ? { modelBroker } : {}),
            ...(toolBroker ? { toolBroker } : {}),
            controlBroker: control.broker,
            ...(workflowSnapshot ? { workflowSnapshot } : {}),
          }),
          signal: input.cancel,
        })) as { id?: unknown };
        if (!Number.isSafeInteger(created.id)) throw new Error("Ultimate did not return a conversation id");
        id = created.id as number;
        activeConversationId = id;
        const callId = `ultimate-conversation-${id}`;
        await input.emit({
          type: "tool_call",
          payload: { tool: "ultimate_conversation", callId, action: "bind" },
          scopeLabel: input.scopeLabel,
        });
        await input.emit({
          type: "tool_result",
          payload: {
            tool: "ultimate_conversation",
            callId,
            conversationId: id,
            ...(agent ? { agent } : {}),
            result: JSON.stringify({ conversationId: id, ...(agent ? { agent } : {}) }),
          },
          scopeLabel: input.scopeLabel,
        });
      }
      let aborting: Promise<unknown> | undefined;
      const abort = () => {
        aborting = call(`/api/conversations/${id}/abort`, { method: "POST", body: "{}" }).catch(() => {});
      };
      input.cancel?.addEventListener("abort", abort, { once: true });
      try {
        if (model && !modelBroker)
          await call(`/api/conversations/${id}/configure`, {
            method: "POST",
            body: JSON.stringify({ model }),
            signal: input.cancel,
          });
        let submittedText = approvedWorkflow ? "Continue the workflow after the approved operation." : input.input;
        if (!historyAfter)
          submittedText = continueTurn
            ? replayPreamble(input.history).trim()
            : `${replayPreamble(input.history)}\n\n${input.input}`.trim();
        await call(`/api/conversations/${id}/submit`, {
          method: "POST",
          body: JSON.stringify({ text: submittedText }),
          signal: input.cancel,
        });
        for (;;) {
          if (input.cancel?.aborted) return { reply: "", stopped: true as const };
          const page = (await call(
            `/api/conversations/${id}/history?before=${Number.MAX_SAFE_INTEGER}${historyAfter ? `&after=${historyAfter + 1}` : ""}`,
            {
              signal: input.cancel,
            },
          )) as { entries?: unknown };
          const entries = Array.isArray(page.entries) ? (page.entries as UltimateHistoryEntry[]) : [];
          const failure = entries.flatMap(assistantMessages).find((message) => message.stopReason === "error");
          if (failure)
            throw new Error(
              typeof failure.errorMessage === "string" ? failure.errorMessage : "Ultimate model request failed",
            );
          const reply = entries.map(assistantText).find((text) => text !== undefined);
          if (reply !== undefined) {
            const refreshedWorkflowSnapshot = await options.workflowSnapshot?.(input);
            const advanced = advancedWorkflowStage(workflowSnapshot, refreshedWorkflowSnapshot);
            const pendingReview = advanced?.step.separateFrom
              ? advanced
              : pendingSeparatedWorkflowStage(refreshedWorkflowSnapshot);
            if (
              !control.pendingApprovals.length &&
              !input.session.parentSessionId &&
              pendingReview &&
              options.dispatchReviewer
            ) {
              try {
                await options.dispatchReviewer(input, {
                  workflowId: pendingReview.workflowId,
                  workflowVersion: pendingReview.workflowVersion,
                  step: pendingReview.step.step,
                  role: pendingReview.step.role,
                  inputEvidence: workflowStepInputEvidence(
                    refreshedWorkflowSnapshot!,
                    pendingReview.workflowId,
                    pendingReview.workflowVersion,
                    pendingReview.step,
                  ),
                });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                  reply: `Independent reviewer dispatch failed for ${pendingReview.step.step}: ${message}`,
                };
              }
            }
            if (
              !control.pendingApprovals.length &&
              advanced &&
              !advanced.step.humanApproval &&
              !advanced.step.separateFrom
            ) {
              historyAfter = entries.reduce(
                (latest, entry) => (Number.isSafeInteger(entry.id) ? Math.max(latest, entry.id as number) : latest),
                historyAfter,
              );
              const nextControl = await createTurnControl(
                input,
                options.publishArtifact,
                options.readArtifact,
                approvedWorkflowReplay,
              );
              try {
                await call(`/api/conversations/${id}/configure`, {
                  method: "POST",
                  body: JSON.stringify({
                    controlBroker: nextControl.broker,
                    ...(refreshedWorkflowSnapshot ? { workflowSnapshot: refreshedWorkflowSnapshot } : {}),
                  }),
                  signal: input.cancel,
                });
              } catch (error) {
                await nextControl.close();
                throw error;
              }
              const previousControl = control;
              control = nextControl;
              await previousControl.close();
              workflowSnapshot = refreshedWorkflowSnapshot;
              const continuation = "Continue the accepted workflow from its next required stage.";
              await call(`/api/conversations/${id}/submit`, {
                method: "POST",
                body: JSON.stringify({
                  text: continuation,
                }),
                signal: input.cancel,
              });
              continue;
            }
            input.recordModelCall({ model: model?.modelId ?? "ultimate", inputTokens: 0, entryCount: 1 });
            input.onDelta?.(reply);
            await input.emit({ type: "assistant", payload: { text: reply }, scopeLabel: input.scopeLabel });
            return {
              reply,
              modelCalls: 1,
              ...(control.pendingApprovals.length
                ? { pendingApprovals: control.pendingApprovals, pausedOnApproval: true as const }
                : {}),
            };
          }
          await withAbort(() => sleep(pollIntervalMs), input.cancel);
        }
      } catch (error) {
        if (input.cancel?.aborted) return { reply: "", stopped: true as const };
        throw error;
      } finally {
        input.cancel?.removeEventListener("abort", abort);
        await aborting;
      }
    };
    let turnResult: HarnessTurnResult | undefined;
    let turnFailure: unknown;
    try {
      turnResult = await performTurn();
    } catch (error) {
      turnFailure = error;
    }
    let cleanupFailure: unknown;
    if (activeConversationId)
      try {
        await call(`/api/conversations/${activeConversationId}/configure`, {
          method: "POST",
          body: JSON.stringify({ controlBroker: null }),
        });
      } catch (error) {
        cleanupFailure = error;
      }
    try {
      await control.close();
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (turnFailure) throw turnFailure;
    if (cleanupFailure) throw cleanupFailure;
    return turnResult!;
  }

  return defineHarness(
    {
      id: "ultimate",
      controlTransport: "http",
      toolTransport: "mcp",
      transcriptFormat: "pi-durable",
      capabilities: new Set(["abort", "thinking-level"]),
    },
    { runTurn, resetSession: () => {} },
  );
}
