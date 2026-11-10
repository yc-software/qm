import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FinnyToolService } from "../agent/agent-tools/finny.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { Conversation, Destination, Principal } from "../types.ts";
import type { FinnyIntegrationConfig } from "./integration-config.ts";
import type { FinnyFinalizer } from "./finalizer.ts";
import type { FinnyRuntimeStore } from "./runtime-postgres-store.ts";
import type { FinnyStore } from "./store.ts";
import { initialFinnyPolicy } from "./policy.ts";
import { assertFinnyMaterialClarificationMatchesPlan } from "./plan.ts";
import type { FinnyArtifactProposal } from "./integration-postgres-store.ts";
import type {
  FinnyCheckId,
  FinnyDeterministicEvidenceAuthority,
  FinnyJob,
  FinnyMaterialClarification,
  FinnyPlanPresentation,
  FinnyVerdict,
} from "./types.ts";
import {
  SPREADSHEET_WORKER_CHECK_IDS,
  SPREADSHEET_WORKER_PRINCIPAL_ID,
  verifySpreadsheetWorkerEnvelope,
  type SpreadsheetWorkerBinding,
  type SpreadsheetWorkerResult,
} from "./deterministic-spreadsheet-worker.ts";

export interface FinnyParentBindingSnapshot {
  schema: "finny-parent-binding.v1";
  sessionId: string;
  runId: string;
  scopeId: string;
  context: { actor: Principal; conversation: Conversation; surface: string };
}

export interface FinnyTurnBinding {
  actor: Principal;
  scopeId: string;
  sessionId: string;
  runId: string;
  originThreadRef: string;
  destination: Destination;
  parentBinding: FinnyParentBindingSnapshot;
  parent: boolean;
}

interface FinnyIntegrationStore {
  createPlanIntent(input: {
    job: import("./store.ts").CreateFinnyJobInput;
    parent: Parameters<FinnyIntegrationStore["createApprovalBoundParent"]>[0];
    clarification?: import("./store.ts").CreateFinnyClarificationRequestInput;
  }): Promise<void>;
  completePlanIntent(
    input: Parameters<FinnyIntegrationStore["createApprovalBoundParent"]>[0],
    clarification?: import("./store.ts").CreateFinnyClarificationRequestInput,
  ): Promise<void>;
  createApprovalBoundParent(input: {
    scopeId: string;
    jobId: string;
    requestId: string;
    actorId: string;
    originThreadRef: string;
    destination: Destination;
    binding: FinnyParentBindingSnapshot;
  }): Promise<void>;
  saveArtifactProposal(input: {
    scopeId: string;
    jobId: string;
    sessionId: string;
    runId: string;
    artifactDigest: string;
    provisionalRevision: string;
    idempotencyKey: string;
  }): Promise<void>;
}

interface FinnyCoordinatorPort {
  artifactReady(input: {
    sessionId: string;
    runId: string;
    scopeId: string;
    jobId: string;
    idempotencyKey: string;
  }): Promise<void>;
  auditPassed(input: {
    sessionId: string;
    runId: string;
    scopeId: string;
    jobId: string;
    artifactDigest: string;
    checkId: Parameters<FinnyToolService["pass"]>[0]["checkId"];
    generation: number;
    evidenceFileId: string;
    idempotencyKey: string;
  }): Promise<void>;
  auditBlocked(input: {
    sessionId: string;
    runId: string;
    scopeId: string;
    jobId: string;
    artifactDigest: string;
    checkId: Parameters<FinnyToolService["block"]>[0]["checkId"];
    generation: number;
    evidenceFileId: string;
    findings: Parameters<FinnyToolService["block"]>[0]["findings"];
    idempotencyKey: string;
  }): Promise<void>;
}

function jobStatus(job: FinnyJob): string {
  if (job.finalReceipt) return "finalized";
  if (job.unresolvedEscalationSequence !== undefined) return "escalated";
  if (job.pendingReworkSequence !== undefined) return "reworking";
  if (job.artifactDigest) return "auditing";
  if (job.approval?.action === "approve") return "producing";
  return "awaiting_approval";
}

function parentDestinationMatchesOrigin(destination: Destination, originThreadRef: string): boolean {
  const [surface, channel, ...thread] = originThreadRef.split(":");
  const threadTs = thread.join(":");
  return (
    surface === "slack" &&
    destination.type === "slack" &&
    Boolean(channel && threadTs) &&
    destination.target === `${channel}:${threadTs}` &&
    (destination.threadTs === undefined || destination.threadTs === threadTs)
  );
}

export function finnySlackAuthority(
  surface: string | undefined,
  deliveryTarget: string | undefined,
  external: boolean,
  rootMessageTs?: string,
): { originThreadRef: string; destination: Destination } | undefined {
  if (external || surface !== "slack" || !deliveryTarget) return undefined;
  let canonicalTarget: string | undefined;
  if (deliveryTarget.includes(":")) canonicalTarget = deliveryTarget;
  else if (rootMessageTs) canonicalTarget = `${deliveryTarget}:${rootMessageTs}`;
  if (!canonicalTarget) return undefined;
  const separator = canonicalTarget.indexOf(":");
  const threadTs = canonicalTarget.slice(separator + 1);
  return {
    originThreadRef: `slack:${canonicalTarget}`,
    destination: {
      type: "slack",
      target: canonicalTarget,
      ...(threadTs ? { threadTs } : {}),
    },
  };
}

export function createFinnyToolServiceFactory(deps: {
  config: Omit<FinnyIntegrationConfig, "signingSecret">;
  jobs: Pick<FinnyStore, "createJob" | "getJob">;
  runtime: Pick<FinnyRuntimeStore, "currentBinding" | "claimParentTurn">;
  integration: FinnyIntegrationStore;
  deliveries: Pick<DeliveryStore, "enqueue">;
  coordinator: FinnyCoordinatorPort;
  files: Pick<FileArtifactStore, "open">;
  deterministicSpreadsheetWorker: {
    run(input: {
      scopeId: string;
      jobId: string;
      artifactBytes: Uint8Array;
      evidenceFileId: string;
      binding: SpreadsheetWorkerBinding;
    }): Promise<{ evidenceFileId: string; results: readonly SpreadsheetWorkerResult[] }>;
  };
  finalizer: FinnyFinalizer;
  deliverFinal(input: { job: FinnyJob; receipt: Awaited<ReturnType<FinnyFinalizer["finalize"]>> }): Promise<void>;
  ids?: () => string;
}) {
  const id = deps.ids ?? randomUUID;
  return {
    async forTurn(turn: FinnyTurnBinding): Promise<FinnyToolService | undefined> {
      if (turn.actor.type !== "internal" || !turn.runId || !turn.sessionId) return undefined;
      let current = await deps.runtime.currentBinding(turn.sessionId);
      if (
        current?.role === "parent" &&
        current.scopeId === turn.scopeId &&
        current.principalId === turn.actor.id &&
        current.runId !== turn.runId
      )
        current = await deps.runtime.claimParentTurn({
          sessionId: turn.sessionId,
          runId: turn.runId,
          scopeId: turn.scopeId,
          principalId: turn.actor.id,
        });
      if (
        current &&
        (current.sessionId !== turn.sessionId ||
          current.runId !== turn.runId ||
          current.scopeId !== turn.scopeId ||
          (current.role === "parent" && current.principalId !== turn.actor.id))
      )
        return undefined;
      if (!current && (!turn.parent || !parentDestinationMatchesOrigin(turn.destination, turn.originThreadRef)))
        return undefined;
      const jobForWorker = async (role: "producer" | "auditor"): Promise<FinnyJob> => {
        if (!current || current.role !== role)
          throw new Error(`Finny action requires the current ${role === "auditor" ? "Auditor" : "Producer"}`);
        const job = await deps.jobs.getJob(current.scopeId, current.jobId);
        if (!job) throw new Error("Finny job is unavailable");
        return job;
      };
      return {
        async createPlan(
          planPresentation: FinnyPlanPresentation,
          materialClarification?: FinnyMaterialClarification,
        ): Promise<string> {
          if (current) throw new Error("Finny workers cannot create plans");
          if (materialClarification)
            assertFinnyMaterialClarificationMatchesPlan(planPresentation, materialClarification);
          const jobId = id();
          const requestId = id();
          const jobInput = {
            id: jobId,
            scopeId: turn.scopeId,
            plan: planPresentation,
            policy: initialFinnyPolicy(deps.config.spreadsheetEngine.evaluator),
            findingPolicy: deps.config.findingPolicy,
            originThreadRef: turn.originThreadRef,
          };
          const parent = {
            scopeId: turn.scopeId,
            jobId,
            requestId,
            actorId: turn.actor.id,
            originThreadRef: turn.originThreadRef,
            destination: turn.destination,
            binding: turn.parentBinding,
          };
          const clarification = materialClarification
            ? {
                scopeId: turn.scopeId,
                jobId,
                requestId: id(),
                authorizedActorId: turn.actor.id,
                ...materialClarification,
                idempotencyKey: `finny-clarification:${jobId}`,
              }
            : undefined;
          await deps.integration.createPlanIntent({
            job: jobInput,
            parent,
            ...(clarification ? { clarification } : {}),
          });
          const job = await deps.jobs.createJob(jobInput);
          await deps.integration.completePlanIntent(parent, clarification);
          await deps.deliveries.enqueue({
            destination: {
              ...turn.destination,
              finnyPlanRequestId: clarification?.requestId ?? requestId,
            },
            text: clarification?.question ?? job.plan.title,
            idempotencyKey: clarification
              ? `finny-clarification:${clarification.requestId}`
              : `finny-plan:${requestId}`,
          });
          return clarification
            ? `Finny plan ${jobId} is awaiting clarification.`
            : `Finny plan ${jobId} is awaiting approval.`;
        },
        async status(jobId: string): Promise<string> {
          if (!current || current.jobId !== jobId) throw new Error("Finny status requires the bound job");
          const job = await deps.jobs.getJob(current.scopeId, jobId);
          if (!job) throw new Error("Finny job is unavailable in this scope");
          return JSON.stringify({
            jobId: job.id,
            eventHead: job.eventHead,
            status: jobStatus(job),
          });
        },
        async artifactReady(input): Promise<string> {
          const job = await jobForWorker("producer");
          await deps.integration.saveArtifactProposal({
            scopeId: current!.scopeId,
            jobId: job.id,
            sessionId: turn.sessionId,
            runId: turn.runId,
            ...input,
          });
          await deps.coordinator.artifactReady({
            scopeId: current!.scopeId,
            jobId: job.id,
            sessionId: turn.sessionId,
            runId: turn.runId,
            idempotencyKey: input.idempotencyKey,
          });
          return `Artifact ${input.artifactDigest} is queued for independent audit.`;
        },
        async pass(input): Promise<string> {
          const job = await jobForWorker("auditor");
          if (!job.artifactDigest) throw new Error("Finny job has no current artifact");
          await deps.coordinator.auditPassed({
            scopeId: current!.scopeId,
            jobId: job.id,
            sessionId: turn.sessionId,
            runId: turn.runId,
            artifactDigest: job.artifactDigest,
            ...input,
          });
          return `PASS recorded for ${input.checkId} generation ${input.generation}.`;
        },
        async block(input): Promise<string> {
          const job = await jobForWorker("auditor");
          if (!job.artifactDigest) throw new Error("Finny job has no current artifact");
          await deps.coordinator.auditBlocked({
            scopeId: current!.scopeId,
            jobId: job.id,
            sessionId: turn.sessionId,
            runId: turn.runId,
            artifactDigest: job.artifactDigest,
            checkId: input.checkId,
            generation: input.generation,
            evidenceFileId: input.evidenceFileId,
            findings: input.findings,
            idempotencyKey: input.idempotencyKey,
          });
          return `BLOCK recorded for ${input.checkId} generation ${input.generation}.`;
        },
        async deterministicAudit(input): Promise<string> {
          const job = await jobForWorker("auditor");
          if (!job.artifactDigest || !job.provisionalRevision) throw new Error("Finny job has no current artifact");
          const artifact = await immutableScopedFileBytes(
            deps.files,
            job.scopeId,
            job.provisionalRevision,
            "current artifact",
            deps.config.spreadsheetEngine.maxArtifactBytes,
          );
          if (artifact.digest !== job.artifactDigest) throw new Error("Finny current artifact digest is invalid");
          if (!isDeepStrictEqual(job.policy.evaluator, deps.config.spreadsheetEngine.evaluator)) {
            throw new Error("Finny job requires a different approved spreadsheet evaluator");
          }
          const binding = {
            artifactDigest: job.artifactDigest,
            policyVersion: job.policy.policyVersion,
            evaluator: job.policy.evaluator,
            checks: SPREADSHEET_WORKER_CHECK_IDS.map((checkId) => ({
              checkId,
              generation: job.policy.requiredGenerations[checkId],
            })),
          };
          const evidenceFileId = createHash("sha256")
            .update(
              JSON.stringify([
                "finny-deterministic-evidence",
                job.scopeId,
                job.id,
                job.artifactDigest,
                job.policy.policyVersion,
                binding.evaluator,
                binding.checks,
                input.idempotencyKey,
              ]),
            )
            .digest("hex");
          const result = await deps.deterministicSpreadsheetWorker.run({
            scopeId: job.scopeId,
            jobId: job.id,
            artifactBytes: artifact.bytes,
            evidenceFileId,
            binding,
          });
          const evaluatorError = result.results.find((check) => check.verdict === "error");
          if (evaluatorError?.verdict === "error") {
            throw new Error(
              `Deterministic spreadsheet evaluator error for ${evaluatorError.checkId}: ${evaluatorError.reason.code}`,
            );
          }
          let passes = 0;
          for (const check of result.results) {
            const idempotencyKey = `${input.idempotencyKey}:${check.checkId}:${check.generation}`;
            if (check.verdict === "block") {
              const policy = job.findingPolicy;
              if (!policy) throw new Error("Finny job has no finding policy");
              const references = check.reason.references.length
                ? ` References: ${check.reason.references.join(", ")}.`
                : "";
              const findings = [
                {
                  code: check.reason.code.slice(0, policy.maxCodeLength),
                  message: `${check.checkId} blocked by deterministic evaluator.${references}`.slice(
                    0,
                    policy.maxMessageLength,
                  ),
                },
              ];
              await deps.coordinator.auditBlocked({
                scopeId: current!.scopeId,
                jobId: job.id,
                sessionId: turn.sessionId,
                runId: turn.runId,
                artifactDigest: job.artifactDigest,
                checkId: check.checkId,
                generation: check.generation,
                evidenceFileId: result.evidenceFileId,
                findings,
                idempotencyKey,
              });
              return `Deterministic spreadsheet audit recorded BLOCK for ${check.checkId}.`;
            }
            await deps.coordinator.auditPassed({
              scopeId: current!.scopeId,
              jobId: job.id,
              sessionId: turn.sessionId,
              runId: turn.runId,
              artifactDigest: job.artifactDigest,
              checkId: check.checkId,
              generation: check.generation,
              evidenceFileId: result.evidenceFileId,
              idempotencyKey,
            });
            passes += 1;
          }
          return `Deterministic spreadsheet audit recorded ${passes} PASS results.`;
        },
        async finalize(input): Promise<string> {
          if (current?.role !== "parent" || current.jobId !== input.jobId)
            throw new Error("Finny finalization requires the bound parent session");
          const job = await deps.jobs.getJob(turn.scopeId, input.jobId);
          if (!job) throw new Error("Finny job is unavailable in this scope");
          const receipt = await deps.finalizer.finalize({ scopeId: turn.scopeId, ...input });
          await deps.deliverFinal({ job, receipt });
          return `Finny job ${job.id} finalized with signed receipt.`;
        },
      };
    },
  };
}

const deterministicChecks = new Set<FinnyCheckId>(SPREADSHEET_WORKER_CHECK_IDS);

async function immutableScopedFileBytes(
  files: Pick<FileArtifactStore, "open">,
  scopeId: string,
  fileId: string,
  label: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; digest: string; createdBy: string }> {
  const opened = await files.open(fileId);
  if (
    !opened ||
    !opened.artifact.enabled ||
    opened.artifact.ownerScopeId !== scopeId ||
    opened.artifact.id !== fileId
  ) {
    throw new Error(`Finny ${label} is not an enabled immutable scoped evidence file`);
  }
  if (opened.sizeBytes > maxBytes) {
    opened.stream.destroy();
    throw new Error(`Finny ${label} exceeds the configured byte limit`);
  }
  const chunks: Buffer[] = [];
  let streamedBytes = 0;
  for await (const chunk of opened.stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    streamedBytes += bytes.byteLength;
    if (streamedBytes > maxBytes) {
      opened.stream.destroy();
      throw new Error(`Finny ${label} exceeds the configured byte limit`);
    }
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== opened.sizeBytes) throw new Error(`Finny ${label} byte length is invalid`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (opened.artifact.sha256 !== digest) throw new Error(`Finny ${label} immutable digest is invalid`);
  return { bytes, digest, createdBy: opened.artifact.createdBy };
}

export interface FinnyResolvedEvidenceAuthority {
  evidenceDigest: string;
  deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
}

export async function resolveFinnyEvidenceFile(
  files: Pick<FileArtifactStore, "open">,
  input: {
    job: FinnyJob;
    evidenceFileId: string;
    checkId: FinnyCheckId;
    generation: number;
    verdict: FinnyVerdict;
  },
  limits: { maxArtifactBytes: number; maxEvidenceBytes: number },
): Promise<FinnyResolvedEvidenceAuthority> {
  const evidence = await immutableScopedFileBytes(
    files,
    input.job.scopeId,
    input.evidenceFileId,
    "evidence file",
    limits.maxEvidenceBytes,
  );
  if (!deterministicChecks.has(input.checkId)) return { evidenceDigest: evidence.digest };
  if (evidence.createdBy !== SPREADSHEET_WORKER_PRINCIPAL_ID) {
    throw new Error("Finny evidence file lacks deterministic worker provenance");
  }
  if (!input.job.artifactDigest || !input.job.provisionalRevision) throw new Error("Finny job has no current artifact");
  const artifact = await immutableScopedFileBytes(
    files,
    input.job.scopeId,
    input.job.provisionalRevision,
    "current artifact",
    limits.maxArtifactBytes,
  );
  if (artifact.digest !== input.job.artifactDigest) throw new Error("Finny current artifact digest is invalid");
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder().decode(evidence.bytes)) as unknown;
  } catch (error) {
    throw new Error("Finny deterministic evidence JSON is invalid", { cause: error });
  }
  const binding = {
    artifactDigest: input.job.artifactDigest,
    policyVersion: input.job.policy.policyVersion,
    evaluator: input.job.policy.evaluator,
    checks: SPREADSHEET_WORKER_CHECK_IDS.map((checkId) => ({
      checkId,
      generation: input.job.policy.requiredGenerations[checkId],
    })),
  };
  const envelope = verifySpreadsheetWorkerEnvelope(artifact.bytes, binding, candidate);
  const result = envelope.results.find((entry) => entry.checkId === input.checkId);
  if (!result || result.generation !== input.generation) {
    throw new Error("Finny deterministic evidence does not contain the requested current generation");
  }
  if (result.verdict !== input.verdict) throw new Error("Finny deterministic evidence verdict is invalid");
  return {
    evidenceDigest: envelope.envelopeDigest,
    deterministicAuthority: {
      evaluator: envelope.evaluator,
      reasonSchemaVersion: envelope.contractVersion,
      reasonCode: result.verdict === "pass" ? "PASS" : result.reason.code,
    },
  };
}

export async function resolveFinnyFileArtifactProposal(
  files: Pick<FileArtifactStore, "get">,
  proposal: FinnyArtifactProposal,
  maxArtifactBytes: number,
): Promise<{ artifactDigest: string; provisionalRevision: string }> {
  const artifact = await files.get(proposal.provisionalRevision, { includeDisabled: true });
  if (
    !artifact ||
    !artifact.enabled ||
    artifact.ownerScopeId !== proposal.scopeId ||
    artifact.sha256 !== proposal.artifactDigest
  )
    throw new Error("Finny artifact proposal does not match an immutable file artifact");
  if (artifact.sizeBytes > maxArtifactBytes) {
    throw new Error("Finny artifact proposal exceeds the configured byte limit");
  }
  return { artifactDigest: artifact.sha256, provisionalRevision: artifact.id };
}

export function finnyFinalDelivery(
  parent: { originThreadRef: string; destination: Destination },
  job: FinnyJob,
  receipt: Awaited<ReturnType<FinnyFinalizer["finalize"]>>,
  publicWebUrl: string,
) {
  if (
    job.originThreadRef !== parent.originThreadRef ||
    !parentDestinationMatchesOrigin(parent.destination, parent.originThreadRef)
  )
    throw new Error("Finny final delivery destination does not match the origin thread");
  const artifactUrl = `${publicWebUrl.replace(/\/$/, "")}/v1/files/${encodeURIComponent(
    receipt.payload.provisionalRevision,
  )}/content`;
  return {
    destination: parent.destination,
    text: [
      `*${job.plan.title} — Finny certification complete*`,
      `*Artifact:* <${artifactUrl}|Open final artifact>`,
      `*Artifact digest:* \`${receipt.payload.artifactDigest}\``,
      `*Certification:* ${job.plan.certification}`,
      `*Approval receipt:* \`${receipt.token}\``,
    ].join("\n"),
    idempotencyKey: `finny-final:${job.id}:${receipt.payload.ledgerHead}`,
  };
}

export function createFinnyEscalationDecision(deps: { jobs: Pick<FinnyStore, "listEvents">; maxReworks: number }) {
  return {
    async decide(input: { scopeId: string; jobId: string }) {
      const events = await deps.jobs.listEvents(input.scopeId, input.jobId);
      const reworks = events.filter((event) => event.type === "rework_requested").length;
      return reworks >= deps.maxReworks
        ? ({ kind: "escalate", reason: `Finny reached the configured ${deps.maxReworks} BLOCK limit` } as const)
        : ({ kind: "rework" } as const);
    },
  };
}
