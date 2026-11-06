import type { FinnyStore } from "./store.ts";
import type { FinnyWorkerRole } from "./types.ts";
import type { FinnyRuntimeStore } from "./runtime-postgres-store.ts";

export interface AuthoritativeFinnyRuntimeJob {
  schema: "finny-authoritative-job.v1";
  scopeId: string;
  jobId: string;
  runId: string;
  role: FinnyWorkerRole;
  eventSeq: number;
  status: string;
  policyVersion: string;
  planDigest: string;
  artifactDigest: string | null;
  requiredGenerations: Record<string, number>;
}

function status(job: NonNullable<Awaited<ReturnType<FinnyStore["getJob"]>>>): string {
  if (job.finalReceipt) return "finalized";
  if (job.unresolvedEscalationSequence !== undefined) return "escalated";
  if (job.pendingReworkSequence !== undefined) return "reworking";
  if (job.artifactDigest) return "auditing";
  return "producing";
}

export function createFinnyCurrentJobReader(deps: {
  jobs: Pick<FinnyStore, "getJob">;
  runtime: Pick<FinnyRuntimeStore, "currentBinding" | "bindingForSession">;
  authenticateSession(sessionId: string): Promise<boolean>;
}) {
  return {
    async readCurrentJob(input: {
      sessionId: string;
      signal?: AbortSignal;
    }): Promise<AuthoritativeFinnyRuntimeJob | null> {
      if (input.signal?.aborted) throw input.signal.reason;
      if (!(await deps.authenticateSession(input.sessionId))) {
        throw new Error("Finny current-job reader could not authenticate the session");
      }
      const binding = await deps.runtime.currentBinding(input.sessionId);
      if (!binding) {
        const historical = await deps.runtime.bindingForSession(input.sessionId);
        if (historical && historical.role !== "parent")
          throw new Error("Finny worker authority is unavailable for this session");
        return null;
      }
      if (binding.role === "parent") return null;
      const job = await deps.jobs.getJob(binding.scopeId, binding.jobId);
      if (!job) return null;
      return {
        schema: "finny-authoritative-job.v1",
        scopeId: binding.scopeId,
        jobId: binding.jobId,
        runId: binding.runId,
        role: binding.role,
        eventSeq: job.eventHead,
        status: status(job),
        policyVersion: job.policy.policyVersion,
        planDigest: job.planDigest,
        artifactDigest: job.artifactDigest ?? null,
        requiredGenerations: { ...job.policy.requiredGenerations },
      };
    },
  };
}
