import { createHash } from "node:crypto";
import type { SessionOpenInput, SessionSyscalls } from "../sessions/session-syscalls.ts";
import type { FinnyStore } from "./store.ts";
import type { FinnyJob } from "./types.ts";
import type { FinnyAuditFinding, FinnyChangeKind, FinnyCheckId, FinnyWorkerGrant } from "./types.ts";
import type { IssueFinnyWorkerInput } from "./worker-grants.ts";
import type { FinnyRuntimeStore } from "./runtime-postgres-store.ts";

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
    grantToken?: string;
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
  evidenceDigest: string;
  idempotencyKey: string;
}

interface AuditBlockedRuntimeInput extends RuntimeActorInput {
  artifactDigest: string;
  checkId: FinnyCheckId;
  generation: number;
  evidenceDigest: string;
  findings: FinnyAuditFinding[];
  changeKinds: FinnyChangeKind[];
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

function resolutionAuthority(value: unknown): { kind: "rework" } | { kind: "escalate"; reason: string } {
  const authority = record(value);
  const resolution = record(authority?.resolution);
  if (resolution?.kind === "rework") return { kind: "rework" };
  if (resolution?.kind === "escalate" && typeof resolution.reason === "string") {
    return { kind: "escalate", reason: resolution.reason };
  }
  throw new Error("Finny escalation action authority is invalid");
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
  workerPolicy: {
    credentials(job: FinnyJob, role: "producer" | "auditor"): { principalId: string; expiresAt: number };
    task(job: FinnyJob, role: "producer" | "auditor"): string;
  };
  escalationDecision?: {
    decide(input: AuditBlockedRuntimeInput): Promise<{ kind: "rework" } | { kind: "escalate"; reason: string }>;
  };
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
    grantToken?: string;
  }): Promise<void> {
    await deps.runtime.dispatchOnce(input, () =>
      deps.dispatcher.dispatchPrivateIdempotent({
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        runId: input.runId,
        message: input.message,
        ...(input.grantToken ? { grantToken: input.grantToken } : {}),
      }),
    );
  }

  return {
    async afterApproved(input: ApprovedRuntimeInput): Promise<void> {
      const job = await deps.jobs.getJob(input.scopeId, input.jobId);
      if (!job || job.approval?.action !== "approve" || job.approval.consumedAt !== undefined) {
        throw new Error("Finny runtime requires a current approved job");
      }
      const producerTask = deps.workerPolicy.task(job, "producer");
      const producerCredentials = deps.workerPolicy.credentials(job, "producer");
      const auditorCredentials = deps.workerPolicy.credentials(job, "auditor");
      const startupKey = `finny:${job.id}:${job.approval.requestId}`;
      const openProducer: SessionOpenInput = {
        requestId: `${startupKey}:producer`,
        name: "Finny Producer",
        task: "Await the role-bound Finny producer dispatch",
      };
      const openAuditor: SessionOpenInput = {
        requestId: `${startupKey}:auditor`,
        name: "Finny Auditor",
        task: "Await the artifact-bound Finny Auditor dispatch",
      };
      const [producerResult, auditorResult] = await Promise.all([
        deps.sessions.open(openProducer),
        deps.sessions.open(openAuditor),
      ]);
      const producer = opened(producerResult, "producer");
      const auditor = opened(auditorResult, "Auditor");
      await deps.runtime.bindInitial({
        scopeId: input.scopeId,
        jobId: input.jobId,
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        producerSessionId: producer.sessionId,
        producerRunId: producer.runId,
        auditorSessionId: auditor.sessionId,
        auditorRunId: auditor.runId,
        producerPrincipalId: producerCredentials.principalId,
        auditorPrincipalId: auditorCredentials.principalId,
      });
      const producerDispatchKey = `${startupKey}:producer-grant`;
      if (!(await deps.runtime.isDispatched(producerDispatchKey))) {
        const grant = await deps.grants.issueProducer({
          scopeId: input.scopeId,
          jobId: input.jobId,
          principalId: producerCredentials.principalId,
          runId: producer.runId,
          expiresAt: producerCredentials.expiresAt,
        });
        await dispatch({
          idempotencyKey: producerDispatchKey,
          scopeId: input.scopeId,
          jobId: input.jobId,
          sessionId: producer.sessionId,
          runId: producer.runId,
          kind: "producer_grant",
          intent: producerTask,
          message: producerTask,
          grantToken: grant.token,
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
          evidenceDigest: input.evidenceDigest,
        }),
      };
      const prepared = await deps.runtime.prepareAction(action);
      if (prepared.authorityPayload === undefined) {
        await deps.runtime.authorizeAction({ ...action, authorityPayload: {} });
      }
      await deps.jobs.recordAuditPassed({
        scopeId: input.scopeId,
        jobId: input.jobId,
        artifactDigest: input.artifactDigest,
        checkId: input.checkId,
        generation: input.generation,
        evidenceDigest: input.evidenceDigest,
        issuerPrincipalId: prepared.binding.principalId,
        issuerRunId: prepared.binding.runId,
        idempotencyKey: input.idempotencyKey,
      });
    },
    async auditBlocked(input: AuditBlockedRuntimeInput): Promise<void> {
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
          evidenceDigest: input.evidenceDigest,
          findings: input.findings,
          changeKinds: input.changeKinds,
        }),
      };
      const prepared = await deps.runtime.prepareAction(action);
      let resolution: { kind: "rework" } | { kind: "escalate"; reason: string };
      if (prepared.authorityPayload === undefined) {
        if (!deps.escalationDecision) throw new Error("Finny escalation decision is unavailable");
        resolution = await deps.escalationDecision.decide(input);
        const committed = await deps.runtime.authorizeAction({ ...action, authorityPayload: { resolution } });
        resolution = resolutionAuthority(committed.authorityPayload);
      } else {
        resolution = resolutionAuthority(prepared.authorityPayload);
      }
      const auditor = prepared.binding;
      await deps.jobs.recordAuditBlock({
        scopeId: input.scopeId,
        jobId: input.jobId,
        checkId: input.checkId,
        generation: input.generation,
        artifactDigest: input.artifactDigest,
        evidenceDigest: input.evidenceDigest,
        issuerPrincipalId: auditor.principalId,
        issuerRunId: auditor.runId,
        findings: input.findings,
        changeKinds: input.changeKinds,
        resolution,
        idempotencyKey: input.idempotencyKey,
      });
      await deps.runtime.retireBinding({
        sessionId: auditor.sessionId,
        runId: auditor.runId,
        role: "auditor",
      });
      if (resolution.kind === "escalate") {
        await deps.runtime.retireWorkers(input.scopeId, input.jobId);
        return;
      }
      const producer = await deps.runtime.currentRoleBinding(input.scopeId, input.jobId, "producer");
      if (!producer) throw new Error("Finny runtime has no current producer binding");
      const message = JSON.stringify({ task: "Rework the blocked artifact", findings: input.findings });
      await dispatch({
        idempotencyKey: `${input.idempotencyKey}:producer-rework`,
        scopeId: input.scopeId,
        jobId: input.jobId,
        sessionId: producer.sessionId,
        runId: producer.runId,
        kind: "producer_rework",
        intent: message,
        message,
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
      const auditorDispatchKey = `${input.idempotencyKey}:auditor-grant`;
      if (await deps.runtime.isDispatched(auditorDispatchKey)) return;
      let auditor = await deps.runtime.currentRoleBinding(input.scopeId, input.jobId, "auditor");
      if (!auditor) {
        const result = opened(
          await deps.sessions.open({
            requestId: `finny:${input.jobId}:auditor:${ready.events[0]?.seq ?? ready.job.eventHead}`,
            name: "Finny Auditor",
            task: "Await the artifact-bound Finny Auditor dispatch",
          }),
          "Auditor",
        );
        const auditorCredentials = deps.workerPolicy.credentials(ready.job, "auditor");
        auditor = await deps.runtime.bindAuditor({
          scopeId: input.scopeId,
          jobId: input.jobId,
          sessionId: result.sessionId,
          runId: result.runId,
          principalId: auditorCredentials.principalId,
        });
      }
      if (!(await deps.runtime.isDispatched(auditorDispatchKey))) {
        const currentJob = ready.job;
        const credentials = deps.workerPolicy.credentials(currentJob, "auditor");
        const auditorTask = deps.workerPolicy.task(currentJob, "auditor");
        const grant = await deps.grants.issueAuditor({
          scopeId: input.scopeId,
          jobId: input.jobId,
          principalId: auditor.principalId,
          runId: auditor.runId,
          expiresAt: credentials.expiresAt,
        });
        await dispatch({
          idempotencyKey: auditorDispatchKey,
          scopeId: input.scopeId,
          jobId: input.jobId,
          sessionId: auditor.sessionId,
          runId: auditor.runId,
          kind: "auditor_grant",
          intent: auditorTask,
          message: auditorTask,
          grantToken: grant.token,
        });
      }
    },
  };
}
