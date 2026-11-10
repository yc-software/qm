import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createSpreadsheetWorkerBinding,
  createDeterministicSpreadsheetWorker,
  digestSpreadsheetArtifact,
  verifySpreadsheetWorkerEnvelope,
  type SpreadsheetCalculationEngine,
  type SpreadsheetWorkerEnvelope,
} from "../src/finny/deterministic-spreadsheet-worker.ts";

const artifact = new TextEncoder().encode("immutable workbook bytes");
const artifactDigest = digestSpreadsheetArtifact(artifact);
const evaluator = {
  id: "libreoffice-calc",
  revision: "24.2.7-r1",
  buildDigest: "a".repeat(64),
  contractVersion: "finny.spreadsheet-worker.v2",
  configurationDigest: "b".repeat(64),
} as const;

const checks = [
  { checkId: "formula.recalculate" as const, generation: 3 },
  { checkId: "summary.crossfoot" as const, generation: 2 },
  { checkId: "artifact.structure" as const, generation: 4 },
];

function binding() {
  return createSpreadsheetWorkerBinding({ artifactDigest, policyVersion: "finny-r5.1", evaluator, checks });
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function recomputeEnvelopeDigest(envelope: Record<string, unknown>): string {
  const { envelopeDigest: _, ...payload } = envelope;
  return createHash("sha256").update(canonical(payload)).digest("base64url");
}

const results = [
  {
    checkId: "formula.recalculate" as const,
    generation: 3,
    verdict: "pass" as const,
    reason: null,
    evidence: {
      kind: "formula-recalculation" as const,
      cells: [{ sheet: "Model", cell: "C9", formula: "=SUM(C2:C8)", calculatedValue: 42 }],
    },
  },
  {
    checkId: "summary.crossfoot" as const,
    generation: 2,
    verdict: "pass" as const,
    reason: null,
    evidence: {
      kind: "cross-foot" as const,
      comparisons: [{ sheet: "Summary", reference: "B12", expected: 42, actual: 42, difference: 0 }],
    },
  },
  {
    checkId: "artifact.structure" as const,
    generation: 4,
    verdict: "pass" as const,
    reason: null,
    evidence: {
      kind: "structure" as const,
      sheets: [{ name: "Model", rows: 9, columns: 3, formulas: 1 }],
    },
  },
];

function engine(output: unknown = results): SpreadsheetCalculationEngine {
  return {
    name: "fixture-engine",
    version: "1.0.0",
    evaluator,
    async evaluate(input) {
      assert.deepEqual(Object.keys(input).sort(), ["artifactBytes", "binding"]);
      assert(Object.isFrozen(input.artifactBytes));
      assert(Object.isFrozen(input.binding));
      return output as Awaited<ReturnType<SpreadsheetCalculationEngine["evaluate"]>>;
    },
  };
}

async function validEnvelope(): Promise<SpreadsheetWorkerEnvelope> {
  return createDeterministicSpreadsheetWorker(engine()).run({ artifactBytes: artifact, binding: binding() });
}

test("creates an immutable artifact, policy, check and generation binding", () => {
  const source = [...checks];
  const value = createSpreadsheetWorkerBinding({
    artifactDigest,
    policyVersion: "finny-r5.1",
    evaluator,
    checks: source,
  });
  source[0] = { checkId: "formula.recalculate", generation: 99 };
  assert(Object.isFrozen(value));
  assert(Object.isFrozen(value.checks));
  assert(value.checks.every(Object.isFrozen));
  assert.deepEqual(value.checks, checks);
  assert.throws(
    () =>
      createSpreadsheetWorkerBinding({
        artifactDigest,
        policyVersion: "finny-r5.1",
        evaluator,
        checks: [checks[0]!, checks[0]!],
      }),
    /duplicate/i,
  );
  assert.throws(
    () =>
      createSpreadsheetWorkerBinding({
        artifactDigest,
        policyVersion: "finny-r5.1",
        evaluator,
        checks: [{ checkId: "meaning.actionability" as never, generation: 1 }],
      }),
    /check/i,
  );
});

test("produces a deterministic unsigned evidence envelope through a replaceable engine", async () => {
  const worker = createDeterministicSpreadsheetWorker(engine([...results].reverse()));
  const first = await worker.run({ artifactBytes: artifact, binding: binding() });
  const second = await worker.run({ artifactBytes: artifact, binding: binding() });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.results.map((result) => result.checkId),
    checks.map((check) => check.checkId),
  );
  assert.equal("token" in first, false);
  assert.equal("signature" in first, false);
  assert.deepEqual(verifySpreadsheetWorkerEnvelope(artifact, binding(), first), first);
});

test("rejects artifact, check and generation substitution", async () => {
  const envelope = await validEnvelope();
  const otherArtifact = new TextEncoder().encode("other workbook");
  assert.throws(() => verifySpreadsheetWorkerEnvelope(otherArtifact, binding(), envelope), /artifact/i);
  assert.throws(
    () =>
      verifySpreadsheetWorkerEnvelope(artifact, binding(), {
        ...envelope,
        artifactDigest: digestSpreadsheetArtifact(otherArtifact),
      }),
    /artifact/i,
  );
  const wrongCheck = structuredClone(envelope) as unknown as { results: Array<Record<string, unknown>> };
  wrongCheck.results[0]!.checkId = "financial.reconcile";
  assert.throws(() => verifySpreadsheetWorkerEnvelope(artifact, binding(), wrongCheck), /check/i);
  const wrongGeneration = structuredClone(envelope) as unknown as { results: Array<Record<string, unknown>> };
  wrongGeneration.results[0]!.generation = 99;
  assert.throws(() => verifySpreadsheetWorkerEnvelope(artifact, binding(), wrongGeneration), /generation/i);
});

test("rejects duplicate, unknown and missing result checks", async () => {
  const envelope = await validEnvelope();
  for (const resultSet of [
    [envelope.results[0], envelope.results[0], ...envelope.results.slice(1)],
    [{ ...envelope.results[0], checkId: "unknown.check" }, ...envelope.results.slice(1)],
    envelope.results.slice(1),
  ]) {
    assert.throws(
      () => verifySpreadsheetWorkerEnvelope(artifact, binding(), { ...envelope, results: resultSet }),
      /check/i,
    );
  }
});

test("rejects non-finite evidence numbers", async () => {
  const envelope = await validEnvelope();
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const candidate = structuredClone(envelope);
    const formula = candidate.results[0];
    assert.equal(formula?.checkId, "formula.recalculate");
    if (formula?.checkId !== "formula.recalculate") throw new Error("Expected formula result");
    (formula.evidence.cells[0] as { calculatedValue: number }).calculatedValue = value;
    assert.throws(() => verifySpreadsheetWorkerEnvelope(artifact, binding(), candidate), /finite/i);
  }
});

test("rejects nondeterministic or unrecognized metadata and a forged envelope digest", async () => {
  const envelope = await validEnvelope();
  assert.throws(
    () => verifySpreadsheetWorkerEnvelope(artifact, binding(), { ...envelope, createdAt: Date.now() }),
    /metadata|field/i,
  );
  assert.throws(
    () => verifySpreadsheetWorkerEnvelope(artifact, binding(), { ...envelope, envelopeDigest: "forged" }),
    /digest/i,
  );
  assert.throws(
    () =>
      verifySpreadsheetWorkerEnvelope(artifact, binding(), {
        ...envelope,
        engine: { ...envelope.engine, runId: "nondeterministic" },
      }),
    /metadata|field/i,
  );
});

test("worker fails closed on malformed engine output", async () => {
  const malformed = structuredClone(results) as unknown as Array<Record<string, unknown>>;
  malformed[0]!.evidence = { kind: "formula-recalculation", cells: [{ calculatedValue: Number.NaN }] };
  await assert.rejects(
    createDeterministicSpreadsheetWorker(engine(malformed)).run({ artifactBytes: artifact, binding: binding() }),
    /finite|evidence/i,
  );
});

test("worker output does not alias mutable engine results", async () => {
  const engineResults = structuredClone(results);
  const envelope = await createDeterministicSpreadsheetWorker(engine(engineResults)).run({
    artifactBytes: artifact,
    binding: binding(),
  });
  const engineFormula = engineResults[0];
  assert.equal(engineFormula?.checkId, "formula.recalculate");
  if (engineFormula?.checkId !== "formula.recalculate") throw new Error("Expected formula result");
  engineFormula.evidence.cells[0]!.calculatedValue = 999;
  const returnedFormula = envelope.results[0];
  assert.equal(returnedFormula?.checkId, "formula.recalculate");
  if (returnedFormula?.checkId !== "formula.recalculate") throw new Error("Expected formula result");
  assert.equal(returnedFormula.evidence.cells[0]!.calculatedValue, 42);
  assert(Object.isFrozen(envelope));
  assert(Object.isFrozen(envelope.results));
  assert(Object.isFrozen(returnedFormula));
  assert(Object.isFrozen(returnedFormula.evidence));
  assert(Object.isFrozen(returnedFormula.evidence.cells));
  assert(Object.isFrozen(returnedFormula.evidence.cells[0]!));
});

test("Core verification returns a deeply frozen canonical copy without caller aliases", async () => {
  const candidate = structuredClone(await validEnvelope());
  const verified = verifySpreadsheetWorkerEnvelope(artifact, binding(), candidate);
  const candidateFormula = candidate.results[0];
  assert.equal(candidateFormula?.checkId, "formula.recalculate");
  if (candidateFormula?.checkId !== "formula.recalculate") throw new Error("Expected formula result");
  (candidateFormula.evidence.cells[0] as { calculatedValue: number }).calculatedValue = 999;
  const verifiedFormula = verified.results[0];
  assert.equal(verifiedFormula?.checkId, "formula.recalculate");
  if (verifiedFormula?.checkId !== "formula.recalculate") throw new Error("Expected formula result");
  assert.equal(verifiedFormula.evidence.cells[0]!.calculatedValue, 42);
  assert.notEqual(verified, candidate);
  assert(Object.isFrozen(verified));
  assert(Object.isFrozen(verified.engine));
  assert(Object.isFrozen(verified.results));
  assert(Object.isFrozen(verifiedFormula));
  assert(Object.isFrozen(verifiedFormula.evidence));
  assert(Object.isFrozen(verifiedFormula.evidence.cells));
  assert(Object.isFrozen(verifiedFormula.evidence.cells[0]!));
});

test("Core worker persists deterministic evidence with reserved immutable Files provenance", async () => {
  const { createPersistedDeterministicSpreadsheetWorker, SPREADSHEET_WORKER_PRINCIPAL_ID } =
    await import("../src/finny/deterministic-spreadsheet-worker.ts");
  const puts: any[] = [];
  const persisted = createPersistedDeterministicSpreadsheetWorker({
    engine: engine(),
    files: {
      async put(input: any) {
        puts.push(input);
        return {
          created: true,
          artifact: {
            id: input.id,
            ownerScopeId: input.ownerScopeId,
            createdBy: input.createdBy,
            enabled: true,
            sha256: createHash("sha256").update(input.data).digest("hex"),
          },
        };
      },
    } as any,
    ids: () => "deterministic-evidence-file",
  });
  const output = await persisted.run({
    scopeId: "personal:U1" as any,
    jobId: "job-1",
    artifactBytes: artifact,
    binding: binding(),
  });
  assert.equal(output.evidenceFileId, "deterministic-evidence-file");
  assert.equal(output.envelopeDigest, (await validEnvelope()).envelopeDigest);
  assert.deepEqual(output.results, (await validEnvelope()).results);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].ownerScopeId, "personal:U1");
  assert.equal(puts[0].createdBy, SPREADSHEET_WORKER_PRINCIPAL_ID);
  assert.equal(puts[0].direction, "out");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(puts[0].data)), await validEnvelope());
});

test("pins the complete evaluator identity and rejects a stale evaluator despite a recomputed digest", async () => {
  const envelope = await validEnvelope();
  assert.deepEqual(envelope.evaluator, evaluator);
  const stale = structuredClone(envelope) as any;
  stale.evaluator.revision = "24.2.6-r9";
  const staleEngine = engine(results);
  (staleEngine as any).evaluator = { ...evaluator, revision: "24.2.6-r9" };
  await assert.rejects(
    createDeterministicSpreadsheetWorker(staleEngine).run({ artifactBytes: artifact, binding: binding() }),
    /evaluator/i,
  );
  // A stale producer cannot make the candidate trusted even after recomputing the canonical envelope digest.
  stale.envelopeDigest = recomputeEnvelopeDigest(stale);
  assert.notEqual(stale.envelopeDigest, envelope.envelopeDigest);
  assert.throws(() => verifySpreadsheetWorkerEnvelope(artifact, binding(), stale), /evaluator/i);
});

test("rejects missing and unknown evaluator metadata", async () => {
  const envelope = structuredClone(await validEnvelope()) as any;
  delete envelope.evaluator.configurationDigest;
  assert.throws(() => verifySpreadsheetWorkerEnvelope(artifact, binding(), envelope), /evaluator.*metadata|field/i);
  const unknown = structuredClone(await validEnvelope()) as any;
  unknown.evaluator.imageTag = "latest";
  assert.throws(() => verifySpreadsheetWorkerEnvelope(artifact, binding(), unknown), /evaluator.*metadata|field/i);
});

test("enforces outcome-specific reasons and check-specific reason codes", async () => {
  const formulaBlock = structuredClone(results) as any[];
  formulaBlock[0] = {
    ...formulaBlock[0],
    verdict: "block",
    reason: { code: "FORMULA_MISMATCH", references: ["Model!C9"] },
  };
  await createDeterministicSpreadsheetWorker(engine(formulaBlock)).run({ artifactBytes: artifact, binding: binding() });

  for (const invalid of [
    { ...results[0], verdict: "pass", reason: { code: "FORMULA_MISMATCH", references: ["Model!C9"] } },
    { ...results[0], verdict: "block", reason: null },
    { ...results[0], verdict: "block", reason: { code: "CROSSFOOT_MISMATCH", references: ["Model!C9"] } },
    { ...results[0], verdict: "error", reason: { code: "FORMULA_MISMATCH", references: ["Model!C9"] } },
    { ...results[0], verdict: "block", reason: { code: "FORMULA_MISMATCH", references: [] } },
    {
      ...results[0],
      verdict: "block",
      reason: { code: "FORMULA_MISMATCH", references: Array.from({ length: 101 }, (_, index) => `Model!A${index}`) },
    },
    { ...results[0], verdict: "block", reason: { code: "FORMULA_MISMATCH", references: ["x".repeat(257)] } },
  ]) {
    const candidate = structuredClone(results) as any[];
    candidate[0] = invalid;
    await assert.rejects(
      createDeterministicSpreadsheetWorker(engine(candidate)).run({ artifactBytes: artifact, binding: binding() }),
      /reason|code/i,
    );
  }
});

test("preserves evaluator errors as distinct from audit blocks", async () => {
  const errors = structuredClone(results) as any[];
  errors[0] = {
    ...errors[0],
    verdict: "error",
    reason: { code: "FORMULA_EVALUATION_ERROR", references: ["Model!C9"] },
  };
  const envelope = await createDeterministicSpreadsheetWorker(engine(errors)).run({
    artifactBytes: artifact,
    binding: binding(),
  });
  assert.equal(envelope.results[0]?.verdict, "error");
});

test("rejects semantically false PASS outcomes", async () => {
  const cases = [
    { index: 0, evidence: { kind: "formula-recalculation", cells: [] } },
    {
      index: 1,
      evidence: {
        kind: "cross-foot",
        comparisons: [{ sheet: "Summary", reference: "B12", expected: 42, actual: 41, difference: -1 }],
      },
    },
    { index: 2, evidence: { kind: "structure", sheets: [] } },
  ];
  for (const item of cases) {
    const candidate = structuredClone(results) as any[];
    candidate[item.index].evidence = item.evidence;
    await assert.rejects(
      createDeterministicSpreadsheetWorker(engine(candidate)).run({ artifactBytes: artifact, binding: binding() }),
      /pass.*evidence|evidence.*pass|inconsistent/i,
    );
  }
});
