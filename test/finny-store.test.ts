import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const createInput = () => ({
  id: randomUUID(),
  scopeId: "personal:U1",
  planDigest: "plan-sha256",
  artifactDigest: "artifact-sha256",
  policy: initialFinnyPolicy(),
  originThreadRef: "slack:C1:100.1",
  provisionalRevision: "delivery-revision-1",
});

test("Finny store round-trips a Core policy snapshot", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  const created = await store.createJob(input);
  assert.equal(created.id, input.id);
  assert.equal(created.scopeId, input.scopeId);
  assert.deepEqual(created.policy, input.policy);
  assert.equal(created.ledgerHead, 0);
  assert.equal(created.approval, undefined);
  assert.deepEqual(await store.getJob(input.scopeId, input.id), created);
  assert.equal(await store.getJob("personal:U2", input.id), null);
});

test("Finny approval is plan-bound and one-use", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const approved = await store.recordApproval({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId: randomUUID(),
    actorId: "U1",
    action: "approve",
    planDigest: input.planDigest,
    originThreadRef: input.originThreadRef,
    decidedAt: Date.now(),
  });
  assert.equal(approved.approval?.action, "approve");
  await assert.rejects(
    store.recordApproval({
      scopeId: input.scopeId,
      jobId: input.id,
      requestId: randomUUID(),
      actorId: "U1",
      action: "reject",
      planDigest: input.planDigest,
      originThreadRef: input.originThreadRef,
      decidedAt: Date.now(),
    }),
    /already decided/i,
  );

  const other = createInput();
  await store.createJob(other);
  await assert.rejects(
    store.recordApproval({
      scopeId: other.scopeId,
      jobId: other.id,
      requestId: randomUUID(),
      actorId: "U1",
      action: "approve",
      planDigest: "wrong-plan",
      originThreadRef: other.originThreadRef,
      decidedAt: Date.now(),
    }),
    /binding/i,
  );
});

test("Finny attestations require the current policy generation and deduplicate exact submissions", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const submission = {
    id: randomUUID(),
    scopeId: input.scopeId,
    jobId: input.id,
    checkId: "lineage.binding" as const,
    generation: 1,
    verdict: "pass" as const,
    evidenceDigest: "evidence-sha256",
    artifactDigest: input.artifactDigest,
    issuerPrincipalId: "U-auditor",
    issuerRunId: "run-auditor-1",
    idempotencyKey: randomUUID(),
  };
  const first = await store.recordAttestation(submission);
  assert.equal(first.deduped, false);
  assert.equal(first.attestation.seq, 1);
  const duplicate = await store.recordAttestation(submission);
  assert.equal(duplicate.deduped, true);
  assert.deepEqual(duplicate.attestation, first.attestation);
  assert.equal((await store.getJob(input.scopeId, input.id))?.ledgerHead, 1);

  await assert.rejects(store.recordAttestation({ ...submission, id: randomUUID(), generation: 2 }), /generation/i);
  await assert.rejects(
    store.recordAttestation({ ...submission, id: randomUUID(), checkId: "unknown.check" as never }),
    /required check/i,
  );
  await assert.rejects(
    store.recordAttestation({ ...submission, id: randomUUID(), evidenceDigest: "different" }),
    /idempotency/i,
  );
});
