import { randomUUID } from "node:crypto";
import type { FinnyToolService } from "../agent/agent-tools/finny.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { Conversation, Destination, Principal } from "../types.ts";
import type { FinnyIntegrationConfig } from "./integration-config.ts";
import type { FinnyFinalizer } from "./finalizer.ts";
import type { FinnyRuntimeStore } from "./runtime-postgres-store.ts";
import type { FinnyStore } from "./store.ts";
import { initialFinnyPolicy } from "./policy.ts";
import type { FinnyArtifactProposal } from "./integration-postgres-store.ts";
import type { FinnyJob, FinnyPlanPresentation } from "./types.ts";

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
  }): Promise<void>;
  completePlanIntent(input: Parameters<FinnyIntegrationStore["createApprovalBoundParent"]>[0]): Promise<void>;
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
    evidenceDigest: string;
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
    evidenceDigest: string;
    findings: Parameters<FinnyToolService["block"]>[0]["findings"];
    changeKinds: Parameters<FinnyToolService["block"]>[0]["changeKinds"];
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
        async createPlan(planPresentation: FinnyPlanPresentation): Promise<string> {
          if (current) throw new Error("Finny workers cannot create plans");
          const jobId = id();
          const requestId = id();
          const jobInput = {
            id: jobId,
            scopeId: turn.scopeId,
            plan: planPresentation,
            policy: initialFinnyPolicy(),
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
          await deps.integration.createPlanIntent({ job: jobInput, parent });
          const job = await deps.jobs.createJob(jobInput);
          await deps.integration.completePlanIntent(parent);
          await deps.deliveries.enqueue({
            destination: { ...turn.destination, finnyPlanRequestId: requestId },
            text: job.plan.title,
            idempotencyKey: `finny-plan:${requestId}`,
          });
          return `Finny plan ${jobId} is awaiting approval.`;
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
            evidenceDigest: input.evidenceDigest,
            findings: input.findings,
            changeKinds: input.changeKinds,
            idempotencyKey: input.idempotencyKey,
          });
          return `BLOCK recorded for ${input.checkId} generation ${input.generation}.`;
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

export async function resolveFinnyFileArtifactProposal(
  files: Pick<FileArtifactStore, "get">,
  proposal: FinnyArtifactProposal,
): Promise<{ artifactDigest: string; provisionalRevision: string }> {
  const artifact = await files.get(proposal.provisionalRevision, { includeDisabled: true });
  if (
    !artifact ||
    !artifact.enabled ||
    artifact.ownerScopeId !== proposal.scopeId ||
    artifact.sha256 !== proposal.artifactDigest
  )
    throw new Error("Finny artifact proposal does not match an immutable file artifact");
  return { artifactDigest: artifact.sha256, provisionalRevision: artifact.id };
}

export function finnyFinalDelivery(
  parent: { originThreadRef: string; destination: Destination },
  job: FinnyJob,
  receipt: Awaited<ReturnType<FinnyFinalizer["finalize"]>>,
) {
  if (
    job.originThreadRef !== parent.originThreadRef ||
    !parentDestinationMatchesOrigin(parent.destination, parent.originThreadRef)
  )
    throw new Error("Finny final delivery destination does not match the origin thread");
  return {
    destination: parent.destination,
    text: JSON.stringify({
      title: job.plan.title,
      artifactDigest: receipt.payload.artifactDigest,
      revision: receipt.payload.provisionalRevision,
      certification: job.plan.certification,
      receipt: receipt.token,
    }),
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
