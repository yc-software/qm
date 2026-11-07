import { createHash } from "node:crypto";
import type { SessionOpenInput, SessionSyscalls } from "../sessions/session-syscalls.ts";
import type { FinnyStore } from "./store.ts";
import type {
  FinnyAuditFinding,
  FinnyCheckId,
  FinnyDeterministicEvidenceAuthority,
  FinnyJob,
  FinnyVerdict,
  FinnyWorkerGrant,
  FinnyWorkerRole,
} from "./types.ts";
import { blockedCheckChangeKinds } from "./policy.ts";
import type { IssueFinnyWorkerInput } from "./worker-grants.ts";
import type { FinnyRuntimeRecovery, FinnyRuntimeStore } from "./runtime-postgres-store.ts";

interface RuntimeGrants {
  issueProducer(input: IssueFinnyWorkerInput): Promise<FinnyWorkerGrant>;
  issueAuditor(input: IssueFinnyWorkerInput): Promise<FinnyWorkerGrant>;
}

interface RuntimeDispatcher {
  dispatchPrivateIdempotent(input: {
    idempotencyKey: string;
    sessionId: string;
    runId: string;
    message: string;
    role: FinnyWorkerRole;
    principalId: string;
    expiresAt: number;
  }): Promise<void>;
}

interface RuntimeActorInput {
  sessionId: string;
  runId: string;
  scopeId: string;
  jobId: string;
}

interface ArtifactReadyRuntimeInput extends RuntimeActorInput {
  idempotencyKey: string;
}

interface AuditPassedRuntimeInput extends RuntimeActorInput {
  artifactDigest: string;
  checkId: FinnyCheckId;
  generation: number;
  evidenceFileId: string;
  idempotencyKey: string;
}

interface AuditBlockedRuntimeInput extends RuntimeActorInput {
  artifactDigest: string;
  checkId: FinnyCheckId;
  generation: number;
  evidenceFileId: string;
  findings: FinnyAuditFinding[];
  idempotencyKey: string;
}

interface ApprovedRuntimeInput {
  scopeId: string;
  jobId: string;
  parentSessionId: string;
  parentRunId: string;
  idempotencyKey: string;
}

function opened(result: Awaited<ReturnType<SessionSyscalls["open"]>>, role: string) {
  if (!result.ok) throw new Error(`Finny ${role} session open failed: ${result.message}`);
  return result;
}

function actionDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function artifactAuthority(value: unknown): { artifactDigest: string; provisionalRevision: string } {
  const authority = record(value);
  if (typeof authority?.artifactDigest !== "string" || typeof authority.provisionalRevision !== "string") {
    throw new Error("Finny artifact action authority is invalid");
  }
  return { artifactDigest: authority.artifactDigest, provisionalRevision: authority.provisionalRevision };
}

interface EvidenceAuthority {
  evidenceDigest: string;
  deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
}

function normalizeEvidenceAuthority(value: string | EvidenceAuthority): EvidenceAuthority {
  return typeof value === "string" ? { evidenceDigest: value } : value;
}

function evidenceAuthority(value: unknown): EvidenceAuthority {
  const container = record(value);
  const authority = record(container?.evidenceAuthority) ?? container;
  if (typeof authority?.evidenceDigest !== "string" || !authority.evidenceDigest) {
    throw new Error("Finny evidence action authority is invalid");
  }
  const deterministic = record(authority.deterministicAuthority);
  if (!deterministic) return { evidenceDigest: authority.evidenceDigest };
  const evaluator = record(deterministic.evaluator);
  if (
    typeof evaluator?.id !== "string" ||
    typeof evaluator.revision !== "string" ||
    typeof evaluator.buildDigest !== "string" ||
    typeof evaluator.contractVersion !== "string" ||
    typeof evaluator.configurationDigest !== "string" ||
    deterministic.reasonSchemaVersion !== "finny.spreadsheet-worker.v2" ||
    typeof deterministic.reasonCode !== "string"
  ) {
    throw new Error("Finny deterministic evidence action authority is invalid");
  }
  return {
    evidenceDigest: authority.evidenceDigest,
    deterministicAuthority: {
      evaluator: evaluator as unknown as FinnyDeterministicEvidenceAuthority["evaluator"],
      reasonSchemaVersion: deterministic.reasonSchemaVersion,
      reasonCode: deterministic.reasonCode,
    },
  };
}

function resolutionAuthority(value: unknown): { kind: "rework" } | { kind: "escalate"; reason: string } {
  const authority = record(value);
  const resolution = record(authority?.resolution);
  if (resolution?.kind === "rework") return { kind: "rework" };
  if (resolution?.kind === "escalate" && typeof resolution.reason === "string") {
    return { kind: "escalate", reason: resolution.reason };
  }
  throw new Error("Finny escalation action authority is invalid");
}

export async function reconcileFinnyRuntimeRecoveries(deps: {
  recoveries(): Promise<FinnyRuntimeRecovery[]>;
  coordinatorFor(
    scopeId: string,
    jobId: string,
  ): Promise<{
    artifactReady(input: ArtifactReadyRuntimeInput): Promise<void>;
    auditPassed(input: AuditPassedRuntimeInput): Promise<void>;
    auditBlocked(input: AuditBlockedRuntimeInput): Promise<void>;
    verificationReopened(input: {
      scopeId: string;
      jobId: string;
      idempotencyKey: string;
      forceNewAuditor?: boolean;
    }): Promise<void>;
  }>;
  recordError(error: unknown, recovery: FinnyRuntimeRecovery): Promise<void>;
}): Promise<void> {
  for (const recovery of await deps.recoveries()) {
    try {
      const coordinator = await deps.coordinatorFor(recovery.scopeId, recovery.jobId);
      if (recovery.kind === "artifact_ready") await coordinator.artifactReady(recovery);
      else if (recovery.kind === "audit_passed") await coordinator.auditPassed(recovery);
      else if (recovery.kind === "audit_blocked") await coordinator.auditBlocked(recovery);
      else await coordinator.verificationReopened(recovery);
    } catch (error) {
      await deps.recordError(error, recovery);
    }
  }
}

export function createFinnyRuntimeCoordinator(deps: {
  jobs: FinnyStore;
  runtime: FinnyRuntimeStore;
  grants: RuntimeGrants;
  sessions: Pick<SessionSyscalls, "open">;
  dispatcher: RuntimeDispatcher;
  artifactBinding: {
    resolve(input: ArtifactReadyRuntimeInput): Promise<{ artifactDigest: string; provisionalRevision: string }>;
  };
  evidenceAuthority: {
    resolve(input: {
      job: FinnyJob;
      evidenceFileId: string;
      checkId: FinnyCheckId;
      generation: number;
      verdict: FinnyVerdict;
    }): Promise<string | EvidenceAuthority>;
  };
  workerPolicy: {
    credentials(job: FinnyJob, role: "producer" | "auditor"): { principalId: string; expiresAt: number };
    task(job: FinnyJob, role: "producer" | "auditor"): string;
  };
  escalationDecision?: {
    decide(input: AuditBlockedRuntimeInput): Promise<{ kind: "rework" } | { kind: "escalate"; reason: string }>;
  };
  recoveryWake?(recovery: FinnyRuntimeRecovery): void;
}) {
  async function dispatch(input: {
    idempotencyKey: string;
    scopeId: string;
    jobId: string;
    sessionId: string;
    runId: string;
    kind: string;
    intent: string;
    message: string;
    role: FinnyWorkerRole;
    principalId: string;
    expiresAt: number;
    guard?: () => Promise<boolean>;
  }): Promise<void> {
    await deps.runtime.dispatchOnce(input, async () => {
      if (input.guard && !(await input.guard())) return;
      await deps.dispatcher.dispatchPrivateIdempotent({
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        runId: input.runId,
        message: input.message,
        role: input.role,
        principalId: input.principalId,
        expiresAt: input.expiresAt,
      });
    });
  }

  return {
    async afterApproved(input: ApprovedRuntimeInput): Promise<void> {
      const job = await deps.jobs.getJob(input.scopeId, input.jobId);
      if (!job || job.approval?.action !== "approve" || job.approval.consumedAt !== undefined) {
        throw new Error("Finny runtime requires a current approved job");
      }
      const approval = job.approval;
      const producerTask = deps.workerPolicy.task(job, "producer");
      const producerCredentials = deps.workerPolicy.credentials(job, "producer");
      const auditorCredentials = deps.workerPolicy.credentials(job, "auditor");
      const startupKey = `finny:${job.id}:${job.approval.requestId}`;
      await deps.runtime.bindParent({
        scopeId: input.scopeId,
        jobId: input.jobId,
        sessionId: input.parentSessionId,
        runId: input.parentRunId,
        principalId: approval.actorId,
      });
      const bindWorker = (role: "producer" | "auditor", identity: { sessionId: string; runId: string }) =>
        deps.runtime.bindWorker({
          scopeId: input.scopeId,
          jobId: input.jobId,
          sessionId: identity.sessionId,
          runId: identity.runId,
          role,
          principalId: role === "producer" ? producerCredentials.principalId : auditorCredentials.principalId,
          epoch: role === "producer" ? 0 : 1,
          expiresAt: role === "producer" ? producerCredentials.expiresAt : auditorCredentials.expiresAt,
        });
      const openProducer: SessionOpenInput = {
        requestId: `${startupKey}:producer`,
        name: "Finny Producer",
        task: "Await the role-bound Finny producer dispatch",
        beforeEnqueue: (identity) => bindWorker("producer", identity),
      };
      const openAuditor: SessionOpenInput = {
        requestId: `${startupKey}:auditor`,
        name: "Finny Auditor",
        task: "Await the artifact-bound Finny Auditor dispatch",
        beforeEnqueue: (identity) => bindWorker("auditor", identity),
      };
      // Session admission is guarded by one global lock. Open the two workers in
      // deterministic order so they do not contend for that lock; once enqueued,
      // their runs remain independent and can execute concurrently.
      const producerResult = await deps.sessions.open(openProducer);
      const auditorResult = await deps.sessions.open(openAuditor);
      const producer = opened(producerResult, "producer");
      const auditor = opened(auditorResult, "Auditor");
      await Promise.all([bindWorker("producer", producer), bindWorker("auditor", auditor)]);
      const currentProducer = await deps.runtime.currentRoleBinding(input.scopeId, input.jobId, "producer");
      if (!currentProducer || currentProducer.sessionId !== producer.sessionId)
        throw new Error("Finny Producer runtime binding is unavailable");
      const producerDispatchKey = `${startupKey}:producer-grant:${currentProducer.runId}`;
      if (!(await deps.runtime.isDispatched(producerDispatchKey))) {
        await dispatch({
          idempotencyKey: producerDispatchKey,
          scopeId: input.scopeId,
          jobId: input.jobId,
          sessionId: currentProducer.sessionId,
          runId: currentProducer.runId,
          kind: "producer_grant",
          intent: producerTask,
          message: producerTask,
          role: "producer",
          principalId: producerCredentials.principalId,
          expiresAt: producerCredentials.expiresAt,
        });
      }
    },
    async auditPassed(input: AuditPassedRuntimeInput): Promise<void> {
      const action = {
        idempotencyKey: input.idempotencyKey,
        kind: "audit_passed",
        sessionId: input.sessionId,
        runId: input.runId,
        scopeId: input.scopeId,
        jobId: input.jobId,
        role: "auditor" as const,
        requestDigest: actionDigest({
          artifactDigest: input.artifactDigest,
          checkId: input.checkId,
          generation: input.generation,
          evidenceFileId: input.evidenceFileId,
        }),
      };
      const prepared = await deps.runtime.prepareAction(action);
      let authority: EvidenceAuthority;
      if (prepared.authorityPayload === undefined) {
        const job = await deps.jobs.getJob(input.scopeId, input.jobId);
        if (!job) throw new Error("Finny job is unavailable");
        const resolved = normalizeEvidenceAuthority(
          await deps.evidenceAuthority.resolve({
            job,
            evidenceFileId: input.evidenceFileId,
            checkId: input.checkId,
            generation: input.generation,
            verdict: "pass",
          }),
        );
        const committed = await deps.runtime.authorizeAction({
          ...action,
          authorityPayload: {
            evidenceAuthority: resolved,
            recovery: {
              artifactDigest: input.artifactDigest,
              checkId: input.checkId,
              generation: input.generation,
              evidenceFileId: input.evidenceFileId,
            },
          },
        });
        authority = evidenceAuthority(committed.authorityPayload);
      } else {
        authority = evidenceAuthority(prepared.authorityPayload);
      }
      await deps.jobs.recordAuditPassed({
        scopeId: input.scopeId,
        jobId: input.jobId,
        artifactDigest: input.artifactDigest,
        checkId: input.checkId,
        generation: input.generation,
        evidenceDigest: authority.evidenceDigest,
        ...(authority.deterministicAuthority ? { deterministicAuthority: authority.deterministicAuthority } : {}),
        issuerPrincipalId: prepared.binding.principalId,
        issuerRunId: prepared.binding.runId,
        idempotencyKey: input.idempotencyKey,
      });
    },
    async auditBlocked(input: AuditBlockedRuntimeInput): Promise<void> {
      const findings = input.findings.map(({ code, message }) => ({ code, message }));
      const action = {
        idempotencyKey: input.idempotencyKey,
        kind: "audit_blocked",
        sessionId: input.sessionId,
        runId: input.runId,
        scopeId: input.scopeId,
        jobId: input.jobId,
        role: "auditor" as const,
        requestDigest: actionDigest({
          artifactDigest: input.artifactDigest,
          checkId: input.checkId,
          generation: input.generation,
          evidenceFileId: input.evidenceFileId,
          findings,
        }),
      };
      const prepared = await deps.runtime.prepareAction(action);
      let resolution: { kind: "rework" } | { kind: "escalate"; reason: string };
      let authority: EvidenceAuthority;
      if (prepared.authorityPayload === undefined) {
        if (!deps.escalationDecision) throw new Error("Finny escalation decision is unavailable");
        const job = await deps.jobs.getJob(input.scopeId, input.jobId);
        if (!job) throw new Error("Finny job is unavailable");
        const resolvedEvidenceAuthority = normalizeEvidenceAuthority(
          await deps.evidenceAuthority.resolve({
            job,
            evidenceFileId: input.evidenceFileId,
            checkId: input.checkId,
            generation: input.generation,
            verdict: "block",
          }),
        );
        const decidedResolution = await deps.escalationDecision.decide(input);
        const committed = await deps.runtime.authorizeAction({
          ...action,
          authorityPayload: {
            resolution: decidedResolution,
            evidenceAuthority: resolvedEvidenceAuthority,
            recovery: {
              artifactDigest: input.artifactDigest,
              checkId: input.checkId,
              generation: input.generation,
              evidenceFileId: input.evidenceFileId,
              findings,
            },
          },
        });
        resolution = resolutionAuthority(committed.authorityPayload);
        authority = evidenceAuthority(committed.authorityPayload);
      } else {
        resolution = resolutionAuthority(prepared.authorityPayload);
        authority = evidenceAuthority(prepared.authorityPayload);
      }
      const auditor = prepared.binding;
      const blocked = await deps.jobs.recordAuditBlock({
        scopeId: input.scopeId,
        jobId: input.jobId,
        checkId: input.checkId,
        generation: input.generation,
        artifactDigest: input.artifactDigest,
        evidenceDigest: authority.evidenceDigest,
        ...(authority.deterministicAuthority ? { deterministicAuthority: authority.deterministicAuthority } : {}),
        issuerPrincipalId: auditor.principalId,
        issuerRunId: auditor.runId,
        findings,
        changeKinds: blockedCheckChangeKinds(input.checkId),
        resolution,
        idempotencyKey: input.idempotencyKey,
      });
      if (resolution.kind === "rework" && blocked.job.pendingReworkSequence === undefined) return;
      if (resolution.kind === "rework" && !blocked.deduped)
        deps.recoveryWake?.({ kind: "audit_blocked", ...input, findings });
      await deps.runtime.retireBinding({
        sessionId: auditor.sessionId,
        runId: auditor.runId,
        role: "auditor",
      });
      if (resolution.kind === "escalate") {
        await deps.runtime.retireWorkers(input.scopeId, input.jobId);
        return;
      }
      const producer = await deps.runtime.activeRoleBinding(input.scopeId, input.jobId, "producer");
      if (!producer) throw new Error("Finny runtime has no current producer binding");
      const message = JSON.stringify({ task: "Rework the blocked artifact", findings });
      const producerCredentials = deps.workerPolicy.credentials(blocked.job, "producer");
      await dispatch({
        idempotencyKey: `${input.idempotencyKey}:producer-rework`,
        scopeId: input.scopeId,
        jobId: input.jobId,
        sessionId: producer.sessionId,
        runId: producer.runId,
        kind: "producer_rework",
        intent: message,
        message,
        role: "producer",
        principalId: producerCredentials.principalId,
        expiresAt: producerCredentials.expiresAt,
        guard: async () => {
          const currentJob = await deps.jobs.getJob(input.scopeId, input.jobId);
          return currentJob?.pendingReworkSequence !== undefined;
        },
      });
    },
    async verificationReopened(input: {
      scopeId: string;
      jobId: string;
      idempotencyKey: string;
      forceNewAuditor?: boolean;
    }): Promise<void> {
      const job = await deps.jobs.getJob(input.scopeId, input.jobId);
      if (
        !job?.artifactDigest ||
        !job.provisionalRevision ||
        job.pendingReworkSequence !== undefined ||
        job.unresolvedEscalationSequence !== undefined ||
        job.finalizedAt !== undefined
      ) {
        throw new Error("Finny reverification requires a current immutable artifact");
      }
      const dispatchPrefix = `${input.idempotencyKey}:auditor-reverify`;
      let auditor = await deps.runtime.currentRoleBinding(input.scopeId, input.jobId, "auditor");
      if (auditor && input.forceNewAuditor) {
        await deps.runtime.retireBinding({
          sessionId: auditor.sessionId,
          runId: auditor.runId,
          role: "auditor",
        });
        auditor = null;
      }
      if (!auditor) {
        const credentials = deps.workerPolicy.credentials(job, "auditor");
        const bindAuditor = (identity: { sessionId: string; runId: string }) =>
          deps.runtime.bindAuditor({
            scopeId: input.scopeId,
            jobId: input.jobId,
            sessionId: identity.sessionId,
            runId: identity.runId,
            principalId: credentials.principalId,
            expiresAt: credentials.expiresAt,
          });
        const openedAuditor = opened(
          await deps.sessions.open({
            requestId: `finny:${input.jobId}:auditor-reverify:${input.idempotencyKey}`,
            name: "Finny Auditor",
            task: "Await the evaluator-bound Finny reverification dispatch",
            beforeEnqueue: async (identity) => {
              await bindAuditor(identity);
            },
          }),
          "Auditor",
        );
        auditor = await bindAuditor(openedAuditor);
      }
      const dispatchKey = `${dispatchPrefix}:${auditor.runId}`;
      if (await deps.runtime.isDispatched(dispatchKey)) return;
      const credentials = deps.workerPolicy.credentials(job, "auditor");
      const task = deps.workerPolicy.task(job, "auditor");
      await dispatch({
        idempotencyKey: dispatchKey,
        scopeId: input.scopeId,
        jobId: input.jobId,
        sessionId: auditor.sessionId,
        runId: auditor.runId,
        kind: "auditor_reverification",
        intent: task,
        message: task,
        role: "auditor",
        principalId: credentials.principalId,
        expiresAt: credentials.expiresAt,
      });
    },
    async artifactReady(input: ArtifactReadyRuntimeInput): Promise<void> {
      const action = {
        idempotencyKey: input.idempotencyKey,
        kind: "artifact_ready",
        sessionId: input.sessionId,
        runId: input.runId,
        scopeId: input.scopeId,
        jobId: input.jobId,
        role: "producer" as const,
        requestDigest: actionDigest({}),
      };
      const prepared = await deps.runtime.prepareAction(action);
      let artifact: { artifactDigest: string; provisionalRevision: string };
      if (prepared.authorityPayload === undefined) {
        artifact = await deps.artifactBinding.resolve(input);
        const committed = await deps.runtime.authorizeAction({ ...action, authorityPayload: artifact });
        artifact = artifactAuthority(committed.authorityPayload);
      } else {
        artifact = artifactAuthority(prepared.authorityPayload);
      }
      const ready = await deps.jobs.recordArtifactReady({
        scopeId: input.scopeId,
        jobId: input.jobId,
        artifactDigest: artifact.artifactDigest,
        provisionalRevision: artifact.provisionalRevision,
        idempotencyKey: input.idempotencyKey,
      });
      if (!ready.deduped) deps.recoveryWake?.({ kind: "artifact_ready", ...input });
      const auditorDispatchPrefix = `${input.idempotencyKey}:auditor-grant`;
      let auditor = await deps.runtime.currentRoleBinding(input.scopeId, input.jobId, "auditor");
      if (!auditor) {
        const latestAuditor = await deps.runtime.latestRoleBinding(input.scopeId, input.jobId, "auditor");
        if (!latestAuditor?.active && (await deps.runtime.hasDeliveredDispatch(auditorDispatchPrefix))) return;
      }
      if (!auditor) {
        const auditorCredentials = deps.workerPolicy.credentials(ready.job, "auditor");
        const bindAuditor = (identity: { sessionId: string; runId: string }) =>
          deps.runtime.bindAuditor({
            scopeId: input.scopeId,
            jobId: input.jobId,
            sessionId: identity.sessionId,
            runId: identity.runId,
            principalId: auditorCredentials.principalId,
            expiresAt: auditorCredentials.expiresAt,
          });
        const result = opened(
          await deps.sessions.open({
            requestId: `finny:${input.jobId}:auditor:${ready.events[0]?.seq ?? ready.job.eventHead}`,
            name: "Finny Auditor",
            task: "Await the artifact-bound Finny Auditor dispatch",
            beforeEnqueue: async (identity) => {
              await bindAuditor(identity);
            },
          }),
          "Auditor",
        );
        auditor = await bindAuditor(result);
      }
      const auditorDispatchKey = `${auditorDispatchPrefix}:${auditor.runId}`;
      if (!(await deps.runtime.isDispatched(auditorDispatchKey))) {
        const currentJob = ready.job;
        const credentials = deps.workerPolicy.credentials(currentJob, "auditor");
        const auditorTask = deps.workerPolicy.task(currentJob, "auditor");
        await dispatch({
          idempotencyKey: auditorDispatchKey,
          scopeId: input.scopeId,
          jobId: input.jobId,
          sessionId: auditor.sessionId,
          runId: auditor.runId,
          kind: "auditor_grant",
          intent: auditorTask,
          message: auditorTask,
          role: "auditor",
          principalId: credentials.principalId,
          expiresAt: credentials.expiresAt,
        });
      }
    },
  };
}
