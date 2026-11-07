import assert from "node:assert/strict";
import { test } from "node:test";
import { createFinnyToolServiceFactory, finnySlackAuthority } from "../src/finny/integration.ts";
import { channelThreadRef, dmThreadRef } from "../src/slack/message-gating.ts";
import type { FinnyJob, FinnyPlanPresentation } from "../src/finny/types.ts";

const evaluator = {
  id: "libreoffice-calc",
  revision: "24.2.7-r1",
  buildDigest: "a".repeat(64),
  contractVersion: "finny.spreadsheet-worker.v2",
  configurationDigest: "b".repeat(64),
} as const;

const plan: FinnyPlanPresentation = {
  title: "Close",
  phases: [{ name: "Prepare", owner: "Producer", dependencies: [] }],
  certification: "Independent audit",
  deliverable: "Workbook",
  destination: "Origin thread",
  clarifications: [],
};

function harness(
  binding: { role: "parent" | "producer" | "auditor" } | null = null,
  options: { job?: Partial<FinnyJob>; artifactBytes?: Uint8Array; deterministicOutput?: unknown } = {},
) {
  const calls: Array<[string, unknown]> = [];
  const job = {
    id: "job-1",
    scopeId: "scope-1",
    plan,
    policy: { policyVersion: "v1", requiredGenerations: {} },
    ...options.job,
  } as FinnyJob;
  const factory = createFinnyToolServiceFactory({
    config: {
      findingPolicy: { id: "bounds.v1", maxFindings: 4, maxCodeLength: 20, maxMessageLength: 200 },
      maxReworks: 2,
      workerGrantTtlMs: 1000,
      spreadsheetEngine: {
        url: "https://engine.example",
        name: "test",
        version: "1",
        timeoutMs: 1000,
        maxResponseBytes: 100_000,
        maxArtifactBytes: 100_000,
        evaluator,
      },
      maxEvidenceBytes: 100_000,
    },
    jobs: {
      async createJob(input: any) {
        calls.push(["createJob", input]);
        return { ...job, id: input.id };
      },
      async getJob(scopeId: string, jobId: string) {
        return scopeId === "scope-1" && jobId === "job-1" ? job : null;
      },
    },
    runtime: {
      async currentBinding() {
        return binding
          ? {
              ...binding,
              scopeId: "scope-1",
              jobId: "job-1",
              sessionId: "session-1",
              runId: "run-1",
              active: true,
              principalId: "actor-1",
              epoch: 1,
            }
          : null;
      },
      async claimParentTurn() {
        return binding
          ? {
              ...binding,
              scopeId: "scope-1",
              jobId: "job-1",
              sessionId: "session-1",
              runId: "run-1",
              active: true,
              principalId: "actor-1",
              epoch: 1,
            }
          : null;
      },
    },
    integration: {
      async createPlanIntent(input: any) {
        calls.push(["createPlanIntent", input]);
      },
      async completePlanIntent(input: any) {
        calls.push(["createApprovalBoundParent", input]);
      },
      async createApprovalBoundParent(input: any) {
        calls.push(["createApprovalBoundParent", input]);
      },
      async saveArtifactProposal(input: any) {
        calls.push(["saveArtifactProposal", input]);
      },
    },
    deliveries: {
      async enqueue(input: any) {
        calls.push(["enqueue", input]);
        return input;
      },
    },
    coordinator: {
      async artifactReady(input: any) {
        calls.push(["artifactReady", input]);
      },
      async auditPassed(input: any) {
        calls.push(["auditPassed", input]);
      },
      async auditBlocked(input: any) {
        calls.push(["auditBlocked", input]);
      },
    },
    files: {
      async open(id: string) {
        if (id !== job.provisionalRevision || !options.artifactBytes) return null;
        const { Readable } = await import("node:stream");
        return {
          artifact: {
            id,
            enabled: true,
            ownerScopeId: job.scopeId,
            sha256: job.artifactDigest,
            createdBy: "producer",
          },
          sizeBytes: options.artifactBytes.byteLength,
          stream: Readable.from([options.artifactBytes]),
        };
      },
    },
    deterministicSpreadsheetWorker: {
      async run(input: unknown) {
        calls.push(["deterministicWorker", input]);
        if (options.deterministicOutput) return options.deterministicOutput;
        throw new Error("deterministic worker was not configured for this test");
      },
    },
    finalizer: {
      async finalize(input: any) {
        calls.push(["finalize", input]);
        return { token: "receipt", payload: { artifactDigest: "digest", provisionalRevision: "r1" } };
      },
    },
    async deliverFinal(input: any) {
      calls.push(["deliverFinal", input]);
    },
    ids: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  } as any);
  return { factory, calls };
}

const parent = {
  actor: { id: "actor-1", type: "internal" as const },
  scopeId: "scope-1",
  sessionId: "session-1",
  runId: "run-1",
  originThreadRef: "slack:C1:100.1",
  destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
  parent: true,
  parentBinding: {
    schema: "finny-parent-binding.v1" as const,
    sessionId: "session-1",
    runId: "run-1",
    scopeId: "scope-1",
    context: {
      actor: { id: "actor-1", type: "internal" as const },
      conversation: {
        kind: "dm" as const,
        threadRef: "slack:C1:100.1",
        audience: [{ id: "actor-1", type: "internal" as const }],
      },
      surface: "slack",
    },
  },
};

test("parent create_plan persists server authority before idempotent native plan delivery", async () => {
  const { factory, calls } = harness();
  const service = await factory.forTurn(parent);
  assert.ok(service);
  assert.equal(await service.createPlan(plan), "Finny plan id-1 is awaiting approval.");
  const created: any = calls.find(([name]) => name === "createJob")?.[1];
  assert.equal(created.scopeId, "scope-1");
  assert.equal(created.originThreadRef, parent.originThreadRef);
  assert.equal(created.findingPolicy.id, "bounds.v1");
  const approval: any = calls.find(([name]) => name === "createApprovalBoundParent")?.[1];
  assert.equal(approval.actorId, "actor-1");
  const delivery: any = calls.find(([name]) => name === "enqueue")?.[1];
  assert.equal(delivery.destination.finnyPlanRequestId, "id-2");
  assert.equal(delivery.idempotencyKey, "finny-plan:id-2");
});

test("material clarification is persisted before delivery while the plan card stays withheld", async () => {
  const { factory, calls } = harness();
  const service = await factory.forTurn(parent);
  assert.ok(service);
  const clarifiedPlan = {
    ...plan,
    clarifications: [{ question: "Which basis?", answer: "Signed contracts" }],
  };
  assert.equal(
    await service.createPlan(clarifiedPlan, {
      question: "Which basis?",
      options: [
        { id: "contracts", label: "Signed contracts" },
        { id: "invoices", label: "Issued invoices" },
      ],
      recommendedOptionId: "contracts",
    }),
    "Finny plan id-1 is awaiting clarification.",
  );
  const intent: any = calls.find(([name]) => name === "createPlanIntent")?.[1];
  assert.equal(intent.clarification.requestId, "id-3");
  assert.equal(intent.clarification.authorizedActorId, "actor-1");
  const delivery: any = calls.find(([name]) => name === "enqueue")?.[1];
  assert.equal(delivery.destination.finnyPlanRequestId, "id-3");
  assert.equal(delivery.idempotencyKey, "finny-clarification:id-3");
  assert.equal(
    calls.some(([name, value]: any) => name === "enqueue" && value.idempotencyKey === "finny-plan:id-2"),
    false,
  );
});

test("material clarification must match the immutable plan recommendation", async () => {
  const { factory, calls } = harness();
  const service = await factory.forTurn(parent);
  assert.ok(service);
  await assert.rejects(
    service.createPlan(plan, {
      question: "Which basis?",
      options: [
        { id: "contracts", label: "Signed contracts" },
        { id: "invoices", label: "Issued invoices" },
      ],
      recommendedOptionId: "contracts",
    }),
    /unambiguously match/i,
  );
  await assert.rejects(
    service.createPlan(
      {
        ...plan,
        clarifications: [
          { question: "Which basis?", answer: "Signed contracts" },
          { question: "Which basis?", answer: "Issued invoices" },
        ],
      },
      {
        question: "Which basis?",
        options: [
          { id: "contracts", label: "Signed contracts" },
          { id: "invoices", label: "Issued invoices" },
        ],
        recommendedOptionId: "contracts",
      },
    ),
    /unambiguously match/i,
  );
  assert.equal(calls.length, 0);
});

test("worker service derives job authority from exact current session and run", async () => {
  const { factory, calls } = harness({ role: "producer" });
  const service = await factory.forTurn(parent);
  assert.ok(service);
  await service.artifactReady({ artifactDigest: "digest", provisionalRevision: "r1", idempotencyKey: "ready-1" });
  assert.deepEqual(
    calls.filter(([name]) => name === "saveArtifactProposal").map(([, value]) => value),
    [
      {
        scopeId: "scope-1",
        jobId: "job-1",
        sessionId: "session-1",
        runId: "run-1",
        artifactDigest: "digest",
        provisionalRevision: "r1",
        idempotencyKey: "ready-1",
      },
    ],
  );
  const artifactReady = calls.find(([name]) => name === "artifactReady")?.[1] as { jobId?: string } | undefined;
  assert.equal(artifactReady?.jobId, "job-1");
  await assert.rejects(
    () => service.pass({ checkId: "artifact.integrity", generation: 1, evidenceFileId: "e", idempotencyKey: "p" }),
    /Auditor/,
  );
});

test("forged worker session or run receives no Finny service", async () => {
  const { factory } = harness({ role: "auditor" });
  assert.equal(await factory.forTurn({ ...parent, runId: "forged", parent: false }), undefined);
  assert.equal(await factory.forTurn({ ...parent, sessionId: "forged", parent: false }), undefined);
});

test("configured max reworks escalates after the authoritative rework limit", async () => {
  const { createFinnyEscalationDecision } = await import("../src/finny/integration.ts");
  const events: any[] = [{ type: "rework_requested" }, { type: "rework_requested" }];
  const decision = createFinnyEscalationDecision({
    jobs: {
      async listEvents() {
        return events;
      },
    },
    maxReworks: 2,
  });
  assert.deepEqual(await decision.decide({ scopeId: "s", jobId: "j" }), {
    kind: "escalate",
    reason: "Finny reached the configured 2 BLOCK limit",
  });
  events.pop();
  assert.deepEqual(await decision.decide({ scopeId: "s", jobId: "j" }), { kind: "rework" });
});

test("Slack parent service fails closed when destination does not match the origin thread", async () => {
  const { factory } = harness();
  assert.equal(
    await factory.forTurn({ ...parent, destination: { type: "slack", target: "C2:100.1", threadTs: "100.1" } }),
    undefined,
  );
});

test("final delivery remains in the exact bound Slack thread with revision and signed receipt", async () => {
  const { finnyFinalDelivery } = await import("../src/finny/integration.ts");
  const job = {
    id: "job-1",
    originThreadRef: "slack:C1:100.1",
    plan: { ...plan, title: "Pack", certification: "Certified" },
  } as FinnyJob;
  const delivery = finnyFinalDelivery(
    { originThreadRef: job.originThreadRef, destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" } },
    job,
    { token: "signed-receipt", payload: { artifactDigest: "digest", provisionalRevision: "r7", ledgerHead: 9 } } as any,
    "https://qm.example",
  );
  assert.deepEqual(delivery.destination, { type: "slack", target: "C1:100.1", threadTs: "100.1" });
  assert.match(delivery.text, /signed-receipt/);
  assert.match(delivery.text, /<https:\/\/qm\.example\/v1\/files\/r7\/content\|Open final artifact>/);
  assert.match(delivery.text, /Certified/);
  assert.equal(delivery.idempotencyKey, "finny-final:job-1:9");
  assert.throws(
    () =>
      finnyFinalDelivery(
        { originThreadRef: job.originThreadRef, destination: { type: "slack", target: "C2:100.1" } },
        job,
        { token: "x", payload: {} } as any,
        "https://qm.example",
      ),
    /does not match/,
  );
});

test("artifact binding resolves immutable bytes from Core file authority", async () => {
  const { resolveFinnyFileArtifactProposal } = await import("../src/finny/integration.ts");
  const proposal = {
    scopeId: "scope-1",
    jobId: "job-1",
    sessionId: "session-1",
    runId: "run-1",
    artifactDigest: "sha-1",
    provisionalRevision: "file-1",
    idempotencyKey: "ready-1",
  };
  const get = async () => ({ id: "file-1", ownerScopeId: "scope-1", sha256: "sha-1", sizeBytes: 5, enabled: true });
  assert.deepEqual(await resolveFinnyFileArtifactProposal({ get } as any, proposal, 5), {
    artifactDigest: "sha-1",
    provisionalRevision: "file-1",
  });
  await assert.rejects(
    () =>
      resolveFinnyFileArtifactProposal(
        { get: async () => ({ ...(await get()), sha256: "other" }) } as any,
        proposal,
        5,
      ),
    /does not match/,
  );
  await assert.rejects(
    () =>
      resolveFinnyFileArtifactProposal({ get: async () => ({ ...(await get()), sizeBytes: 6 }) } as any, proposal, 5),
    /artifact proposal.*byte limit/i,
  );
});

test("real Slack channel and DM refs derive authority from the exact delivery target", () => {
  assert.equal(channelThreadRef("channel", "C1", "100.1"), "ch:C1:100.1");
  assert.equal(dmThreadRef("D1", "100.1"), "dm:D1:100.1");
  assert.deepEqual(finnySlackAuthority("slack", "C1:100.1", false), {
    originThreadRef: "slack:C1:100.1",
    destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
  });
  assert.deepEqual(finnySlackAuthority("slack", "D1", false, "200.2"), {
    originThreadRef: "slack:D1:200.2",
    destination: { type: "slack", target: "D1:200.2", threadTs: "200.2" },
  });
  assert.equal(finnySlackAuthority("slack", "D1", false), undefined);
  assert.equal(finnySlackAuthority("slack", "C1:100.1", true), undefined);
});

test("evidence authority derives immutable scoped file digests and verifies deterministic envelopes", async () => {
  const { Readable } = await import("node:stream");
  const { createHash } = await import("node:crypto");
  const { resolveFinnyEvidenceFile } = await import("../src/finny/integration.ts");
  const { createDeterministicSpreadsheetWorker, digestSpreadsheetArtifact } =
    await import("../src/finny/deterministic-spreadsheet-worker.ts");
  const artifactBytes = new TextEncoder().encode("current workbook");
  const artifactDigest = digestSpreadsheetArtifact(artifactBytes);
  const policy = {
    policyVersion: "finny-r5.1",
    evaluator,
    requiredGenerations: {
      "source.completeness": 1,
      "financial.reconcile": 1,
      "formula.recalculate": 2,
      "summary.crossfoot": 3,
      "meaning.actionability": 1,
      "artifact.integrity": 1,
      "artifact.structure": 4,
      "lineage.binding": 1,
    },
  };
  const binding = {
    artifactDigest,
    policyVersion: policy.policyVersion,
    evaluator,
    checks: [
      { checkId: "formula.recalculate" as const, generation: 2 },
      { checkId: "summary.crossfoot" as const, generation: 3 },
      { checkId: "artifact.structure" as const, generation: 4 },
    ],
  };
  const envelope = await createDeterministicSpreadsheetWorker({
    name: "test-engine",
    version: "1",
    evaluator,
    async evaluate() {
      return [
        {
          checkId: "formula.recalculate" as const,
          generation: 2,
          verdict: "pass" as const,
          reason: null,
          evidence: {
            kind: "formula-recalculation" as const,
            cells: [{ sheet: "Model", cell: "A1", formula: "=1", calculatedValue: 1 }],
          },
        },
        {
          checkId: "summary.crossfoot" as const,
          generation: 3,
          verdict: "block" as const,
          reason: { code: "CROSSFOOT_MISMATCH" as const, references: ["Summary!A1"] },
          evidence: {
            kind: "cross-foot" as const,
            comparisons: [{ sheet: "Summary", reference: "A1", expected: 1, actual: 2, difference: 1 }],
          },
        },
        {
          checkId: "artifact.structure" as const,
          generation: 4,
          verdict: "pass" as const,
          reason: null,
          evidence: { kind: "structure" as const, sheets: [{ name: "Model", rows: 1, columns: 1, formulas: 1 }] },
        },
      ];
    },
  }).run({ artifactBytes, binding });
  const evidenceBytes = new TextEncoder().encode(JSON.stringify(envelope));
  const evidenceSha = createHash("sha256").update(evidenceBytes).digest("hex");
  const records = new Map<string, any>([
    ["artifact-file", { bytes: artifactBytes, sha256: artifactDigest, ownerScopeId: "scope-1", enabled: true }],
    [
      "evidence-file",
      {
        bytes: evidenceBytes,
        sha256: evidenceSha,
        ownerScopeId: "scope-1",
        enabled: true,
        createdBy: "finny-deterministic-spreadsheet-worker",
      },
    ],
    [
      "forged-envelope-file",
      { bytes: evidenceBytes, sha256: evidenceSha, ownerScopeId: "scope-1", enabled: true, createdBy: "auditor" },
    ],
    ["generic-file", { bytes: new TextEncoder().encode("generic evidence"), ownerScopeId: "scope-1", enabled: true }],
  ]);
  const files = {
    async open(id: string) {
      const value = records.get(id);
      if (!value) return null;
      const bytes = value.bytes;
      const sha256 = value.sha256 ?? createHash("sha256").update(bytes).digest("hex");
      const streamBytes = value.streamBytes ?? bytes;
      const stream = Readable.from(
        (async function* () {
          value.onRead?.();
          yield streamBytes;
        })(),
      );
      const destroy = stream.destroy.bind(stream);
      stream.destroy = (error) => {
        value.onDestroy?.();
        return destroy(error);
      };
      return {
        artifact: { id, ...value, sha256 },
        sizeBytes: value.sizeBytes ?? bytes.length,
        stream,
      };
    },
  };
  const limits = { maxArtifactBytes: artifactBytes.length, maxEvidenceBytes: evidenceBytes.length, evaluator };
  const job = {
    id: "job-1",
    scopeId: "scope-1",
    artifactDigest,
    provisionalRevision: "artifact-file",
    policy,
  } as FinnyJob;
  assert.deepEqual(
    await resolveFinnyEvidenceFile(
      files as any,
      {
        job,
        evidenceFileId: "evidence-file",
        checkId: "formula.recalculate",
        generation: 2,
        verdict: "pass",
      },
      limits,
    ),
    {
      evidenceDigest: envelope.envelopeDigest,
      deterministicAuthority: {
        evaluator,
        reasonSchemaVersion: "finny.spreadsheet-worker.v2",
        reasonCode: "PASS",
      },
    },
  );

  await assert.rejects(
    resolveFinnyEvidenceFile(
      files as any,
      {
        job,
        evidenceFileId: "forged-envelope-file",
        checkId: "formula.recalculate",
        generation: 2,
        verdict: "pass",
      },
      limits,
    ),
    /deterministic worker provenance/i,
  );

  assert.deepEqual(
    await resolveFinnyEvidenceFile(
      files as any,
      {
        job,
        evidenceFileId: "generic-file",
        checkId: "financial.reconcile",
        generation: 1,
        verdict: "pass",
      },
      limits,
    ),
    { evidenceDigest: createHash("sha256").update("generic evidence").digest("hex") },
  );
  await assert.rejects(
    resolveFinnyEvidenceFile(
      files as any,
      {
        job,
        evidenceFileId: "generic-file",
        checkId: "formula.recalculate",
        generation: 2,
        verdict: "pass",
      },
      limits,
    ),
    /envelope|JSON|deterministic/i,
  );
  await assert.rejects(
    resolveFinnyEvidenceFile(
      files as any,
      {
        job,
        evidenceFileId: "evidence-file",
        checkId: "summary.crossfoot",
        generation: 3,
        verdict: "pass",
      },
      limits,
    ),
    /verdict/i,
  );
  records.set("wrong-owner", { bytes: evidenceBytes, sha256: evidenceSha, ownerScopeId: "scope-2", enabled: true });
  await assert.rejects(
    resolveFinnyEvidenceFile(
      files as any,
      {
        job,
        evidenceFileId: "wrong-owner",
        checkId: "financial.reconcile",
        generation: 1,
        verdict: "pass",
      },
      limits,
    ),
    /immutable scoped evidence file/i,
  );
  let oversizedMetadataRead = false;
  let oversizedMetadataDestroyed = false;
  records.set("oversized-evidence-metadata", {
    bytes: new Uint8Array([1]),
    onRead: () => {
      oversizedMetadataRead = true;
    },
    onDestroy: () => {
      oversizedMetadataDestroyed = true;
    },
    sizeBytes: limits.maxEvidenceBytes + 1,
    ownerScopeId: "scope-1",
    enabled: true,
  });
  await assert.rejects(
    resolveFinnyEvidenceFile(
      files as any,
      {
        job,
        evidenceFileId: "oversized-evidence-metadata",
        checkId: "financial.reconcile",
        generation: 1,
        verdict: "pass",
      },
      limits,
    ),
    /evidence file.*byte limit/i,
  );
  assert.equal(oversizedMetadataRead, false);
  assert.equal(oversizedMetadataDestroyed, true);
  records.set("lying-evidence-stream", {
    bytes: new Uint8Array([1]),
    streamBytes: new Uint8Array(limits.maxEvidenceBytes + 1),
    sizeBytes: 1,
    ownerScopeId: "scope-1",
    enabled: true,
  });
  await assert.rejects(
    resolveFinnyEvidenceFile(
      files as any,
      {
        job,
        evidenceFileId: "lying-evidence-stream",
        checkId: "financial.reconcile",
        generation: 1,
        verdict: "pass",
      },
      limits,
    ),
    /evidence file.*byte limit/i,
  );
  const oversizedArtifactJob = { ...job, provisionalRevision: "oversized-artifact-metadata" };
  records.set("oversized-artifact-metadata", {
    bytes: artifactBytes,
    sizeBytes: limits.maxArtifactBytes + 1,
    sha256: artifactDigest,
    ownerScopeId: "scope-1",
    enabled: true,
  });
  await assert.rejects(
    resolveFinnyEvidenceFile(
      files as any,
      {
        job: oversizedArtifactJob,
        evidenceFileId: "evidence-file",
        checkId: "formula.recalculate",
        generation: 2,
        verdict: "pass",
      },
      limits,
    ),
    /current artifact.*byte limit/i,
  );
});

test("bound Auditor runs all current deterministic checks from one trusted evidence envelope", async () => {
  const artifactBytes = new TextEncoder().encode("workbook");
  const { digestSpreadsheetArtifact } = await import("../src/finny/deterministic-spreadsheet-worker.ts");
  const { initialFinnyPolicy } = await import("../src/finny/policy.ts");
  const policy = initialFinnyPolicy(evaluator);
  const results = [
    {
      checkId: "formula.recalculate" as const,
      generation: 1,
      verdict: "pass" as const,
      evidence: { kind: "formula-recalculation" as const, cells: [] },
    },
    {
      checkId: "summary.crossfoot" as const,
      generation: 1,
      verdict: "pass" as const,
      reason: null,
      evidence: { kind: "cross-foot" as const, comparisons: [] },
    },
    {
      checkId: "artifact.structure" as const,
      generation: 1,
      verdict: "pass" as const,
      reason: null,
      evidence: { kind: "structure" as const, sheets: [] },
    },
  ];
  const { factory, calls } = harness(
    { role: "auditor" },
    {
      artifactBytes,
      job: {
        artifactDigest: digestSpreadsheetArtifact(artifactBytes),
        provisionalRevision: "artifact-file",
        policy,
      },
      deterministicOutput: { evidenceFileId: "trusted-evidence", results },
    },
  );
  const service = await factory.forTurn(parent);
  assert.ok(service);
  assert.equal(
    await service.deterministicAudit({ idempotencyKey: "audit-1" }),
    "Deterministic spreadsheet audit recorded 3 PASS results.",
  );
  const workerInput = calls.find(([name]) => name === "deterministicWorker")?.[1] as any;
  assert.deepEqual(Array.from(workerInput.artifactBytes), Array.from(artifactBytes));
  assert.deepEqual(workerInput.binding.checks, [
    { checkId: "formula.recalculate", generation: 1 },
    { checkId: "summary.crossfoot", generation: 1 },
    { checkId: "artifact.structure", generation: 1 },
  ]);
  assert.deepEqual(
    calls.filter(([name]) => name === "auditPassed").map(([, value]) => value),
    results.map((result) => ({
      scopeId: "scope-1",
      jobId: "job-1",
      sessionId: "session-1",
      runId: "run-1",
      artifactDigest: digestSpreadsheetArtifact(artifactBytes),
      checkId: result.checkId,
      generation: 1,
      evidenceFileId: "trusted-evidence",
      idempotencyKey: `audit-1:${result.checkId}:1`,
    })),
  );
  await service.deterministicAudit({ idempotencyKey: "audit-1" });
  const workerInputs = calls.filter(([name]) => name === "deterministicWorker").map(([, value]) => value as any);
  assert.equal(typeof workerInputs[0]?.evidenceFileId, "string");
  assert.equal(workerInputs[0]?.evidenceFileId, workerInputs[1]?.evidenceFileId);
});

test("deterministic BLOCK uses Core findings and stops before stale remaining results", async () => {
  const artifactBytes = new TextEncoder().encode("blocked workbook");
  const { digestSpreadsheetArtifact } = await import("../src/finny/deterministic-spreadsheet-worker.ts");
  const { initialFinnyPolicy } = await import("../src/finny/policy.ts");
  const policy = initialFinnyPolicy(evaluator);
  const results = [
    {
      checkId: "formula.recalculate" as const,
      generation: 1,
      verdict: "block" as const,
      reason: { code: "FORMULA_MISMATCH" as const, references: ["Summary!B9"] },
      evidence: { kind: "formula-recalculation" as const, cells: [] },
    },
    {
      checkId: "summary.crossfoot" as const,
      generation: 1,
      verdict: "pass" as const,
      evidence: { kind: "cross-foot" as const, comparisons: [] },
    },
    {
      checkId: "artifact.structure" as const,
      generation: 1,
      verdict: "pass" as const,
      evidence: { kind: "structure" as const, sheets: [] },
    },
  ];
  const { factory, calls } = harness(
    { role: "auditor" },
    {
      artifactBytes,
      job: {
        artifactDigest: digestSpreadsheetArtifact(artifactBytes),
        provisionalRevision: "artifact-file",
        policy,
        findingPolicy: { id: "bounds", maxFindings: 1, maxCodeLength: 8, maxMessageLength: 16 },
      },
      deterministicOutput: { evidenceFileId: "trusted-evidence", results },
    },
  );
  const service = await factory.forTurn(parent);
  assert.ok(service);
  assert.equal(
    await service.deterministicAudit({ idempotencyKey: "audit-block" }),
    "Deterministic spreadsheet audit recorded BLOCK for formula.recalculate.",
  );
  assert.equal(calls.filter(([name]) => name === "auditPassed").length, 0);
  const blocked = calls.find(([name]) => name === "auditBlocked")?.[1] as any;
  assert.equal(blocked.checkId, "formula.recalculate");
  assert.equal(blocked.evidenceFileId, "trusted-evidence");
  assert.equal(blocked.idempotencyKey, "audit-block:formula.recalculate:1");
  assert.equal(blocked.findings.length, 1);
  assert.ok(blocked.findings[0].code.length <= 8);
  assert.ok(blocked.findings[0].message.length <= 16);
});

test("deterministic evaluator ERROR records neither PASS nor BLOCK", async () => {
  const artifactBytes = new TextEncoder().encode("engine failure workbook");
  const { digestSpreadsheetArtifact } = await import("../src/finny/deterministic-spreadsheet-worker.ts");
  const { initialFinnyPolicy } = await import("../src/finny/policy.ts");
  const policy = initialFinnyPolicy(evaluator);
  const results = [
    {
      checkId: "formula.recalculate" as const,
      generation: 1,
      verdict: "error" as const,
      reason: { code: "FORMULA_EVALUATION_ERROR" as const, references: ["Model!A1"] },
      evidence: { kind: "formula-recalculation" as const, cells: [] },
    },
    {
      checkId: "summary.crossfoot" as const,
      generation: 1,
      verdict: "pass" as const,
      reason: null,
      evidence: { kind: "cross-foot" as const, comparisons: [] },
    },
    {
      checkId: "artifact.structure" as const,
      generation: 1,
      verdict: "pass" as const,
      reason: null,
      evidence: { kind: "structure" as const, sheets: [] },
    },
  ];
  const { factory, calls } = harness(
    { role: "auditor" },
    {
      artifactBytes,
      job: {
        artifactDigest: digestSpreadsheetArtifact(artifactBytes),
        provisionalRevision: "artifact-file",
        policy,
      },
      deterministicOutput: { evidenceFileId: "trusted-evidence", results },
    },
  );
  const service = await factory.forTurn(parent);
  assert.ok(service);
  await assert.rejects(service.deterministicAudit({ idempotencyKey: "audit-error" }), /evaluator error.*formula/i);
  assert.equal(calls.filter(([name]) => name === "auditPassed").length, 0);
  assert.equal(calls.filter(([name]) => name === "auditBlocked").length, 0);
});
