import { createHash, randomUUID } from "node:crypto";
import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";
import { isObj } from "../util/objects.ts";
import { FINNY_CHECK_IDS } from "./policy.ts";
import type { FinnyStore } from "./store.ts";
import type {
  FinnyCheckId,
  FinnyPolicySnapshot,
  FinnyWorkerGrant,
  FinnyWorkerGrantPayload,
  FinnyWorkerRole,
} from "./types.ts";

export interface IssueFinnyWorkerInput {
  scopeId: string;
  jobId: string;
  principalId: string;
  runId: string;
  expiresAt: number;
}

export interface SubmitFinnyWorkerAttestationInput {
  id: string;
  checkId: FinnyCheckId;
  generation: number;
  verdict: "pass" | "block";
  evidenceDigest: string;
  idempotencyKey: string;
}

function policyDigest(policy: FinnyPolicySnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        policyVersion: policy.policyVersion,
        requiredGenerations: Object.fromEntries(
          FINNY_CHECK_IDS.map((checkId) => [checkId, policy.requiredGenerations[checkId]]),
        ),
      }),
    )
    .digest("base64url");
}

function stringField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseGrant(value: unknown): FinnyWorkerGrantPayload | null {
  if (!isObj(value) || value.aud !== "finny.worker") return null;
  if (
    !stringField(value.jti) ||
    !stringField(value.scopeId) ||
    !stringField(value.jobId) ||
    !stringField(value.principalId) ||
    !stringField(value.runId) ||
    !stringField(value.policyDigest) ||
    (value.role !== "producer" && value.role !== "auditor") ||
    (value.artifactDigest !== undefined && !stringField(value.artifactDigest)) ||
    (value.role === "auditor" && !stringField(value.artifactDigest)) ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !Array.isArray(value.allowedChecks) ||
    !value.allowedChecks.every((checkId) => FINNY_CHECK_IDS.includes(checkId as FinnyCheckId))
  ) {
    return null;
  }
  return value as unknown as FinnyWorkerGrantPayload;
}

export function createFinnyWorkerGrants(store: FinnyStore, secret: string, now: () => number = Date.now) {
  function validateInput(input: IssueFinnyWorkerInput): void {
    if (!stringField(input.principalId) || !stringField(input.runId)) {
      throw new Error("Finny worker run and principal must be non-empty");
    }
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now()) {
      throw new Error("Finny worker grant expiry is invalid");
    }
  }

  async function issue(input: IssueFinnyWorkerInput, role: FinnyWorkerRole): Promise<FinnyWorkerGrant> {
    validateInput(input);
    const job = await store.getJob(input.scopeId, input.jobId);
    if (!job) throw new Error("Finny job was not found in this scope");
    if (job.approval?.action !== "approve" || job.approval.consumedAt !== undefined) {
      throw new Error("Finny job is not approved for worker dispatch");
    }
    if (role === "auditor" && !job.artifactDigest) {
      throw new Error("Finny Auditor grant requires a current artifact");
    }
    await store.claimWorkerRun({ scopeId: input.scopeId, jobId: input.jobId, runId: input.runId, role });
    const payload: FinnyWorkerGrantPayload = {
      aud: "finny.worker",
      jti: randomUUID(),
      scopeId: input.scopeId,
      jobId: input.jobId,
      principalId: input.principalId,
      role,
      runId: input.runId,
      ...(job.artifactDigest ? { artifactDigest: job.artifactDigest } : {}),
      policyDigest: policyDigest(job.policy),
      allowedChecks: role === "auditor" ? [...FINNY_CHECK_IDS] : [],
      issuedAt: now(),
      expiresAt: input.expiresAt,
    };
    return { payload, token: await mintSignedPayload(payload, secret) };
  }

  return {
    issueProducer: (input: IssueFinnyWorkerInput) => issue(input, "producer"),
    issueAuditor: (input: IssueFinnyWorkerInput) => issue(input, "auditor"),

    async submitAttestation(token: string, input: SubmitFinnyWorkerAttestationInput) {
      const grant = parseGrant(await verifySignedPayload(token, secret));
      if (!grant) throw new Error("Finny worker grant is invalid");
      if (now() >= grant.expiresAt) throw new Error("Finny worker grant is expired");
      if (grant.role !== "auditor" || !grant.artifactDigest) {
        throw new Error("Finny attestation requires an Auditor grant");
      }
      if (!grant.allowedChecks.includes(input.checkId)) throw new Error("Finny worker grant does not allow this check");
      const job = await store.getJob(grant.scopeId, grant.jobId);
      if (
        !job ||
        job.artifactDigest !== grant.artifactDigest ||
        policyDigest(job.policy) !== grant.policyDigest ||
        job.approval?.action !== "approve" ||
        job.approval.consumedAt !== undefined
      ) {
        throw new Error("Finny worker grant no longer matches the job");
      }
      return store.recordAttestation({
        ...input,
        scopeId: grant.scopeId,
        jobId: grant.jobId,
        artifactDigest: grant.artifactDigest,
        issuerPrincipalId: grant.principalId,
        issuerRunId: grant.runId,
      });
    },
  };
}
