import { createHash, randomUUID } from "node:crypto";
import { artifactPath, type FileArtifactStore } from "../files/file-artifact-store.ts";
import type { ScopeId } from "../types.ts";
import type { FinnyEvaluatorRef } from "./types.ts";

export const SPREADSHEET_WORKER_PRINCIPAL_ID = "finny-deterministic-spreadsheet-worker";

export const SPREADSHEET_WORKER_CHECK_IDS = ["formula.recalculate", "summary.crossfoot", "artifact.structure"] as const;

export type SpreadsheetWorkerCheckId = (typeof SPREADSHEET_WORKER_CHECK_IDS)[number];

export interface SpreadsheetWorkerCheckBinding {
  readonly checkId: SpreadsheetWorkerCheckId;
  readonly generation: number;
}

export interface SpreadsheetWorkerBinding {
  readonly artifactDigest: string;
  readonly policyVersion: string;
  readonly evaluator: FinnyEvaluatorRef;
  readonly checks: readonly SpreadsheetWorkerCheckBinding[];
}

export interface FormulaRecalculationEvidence {
  readonly kind: "formula-recalculation";
  readonly cells: readonly {
    readonly sheet: string;
    readonly cell: string;
    readonly formula: string;
    readonly calculatedValue: number;
  }[];
}

export interface CrossFootEvidence {
  readonly kind: "cross-foot";
  readonly comparisons: readonly {
    readonly sheet: string;
    readonly reference: string;
    readonly expected: number;
    readonly actual: number;
    readonly difference: number;
  }[];
}

export interface StructureEvidence {
  readonly kind: "structure";
  readonly sheets: readonly {
    readonly name: string;
    readonly rows: number;
    readonly columns: number;
    readonly formulas: number;
  }[];
}

export type FormulaReasonCode = "FORMULA_MISMATCH" | "FORMULA_EVALUATION_ERROR" | "UNSUPPORTED_FORMULA";
export type CrossFootReasonCode = "CROSSFOOT_MISMATCH" | "CROSSFOOT_EVALUATION_ERROR";
export type StructureReasonCode = "STRUCTURE_INVALID" | "STRUCTURE_INSPECTION_ERROR";

export interface SpreadsheetWorkerReason<Code extends string> {
  readonly code: Code;
  readonly references: readonly string[];
}

type SpreadsheetResult<
  CheckId extends SpreadsheetWorkerCheckId,
  Evidence,
  BlockCode extends string,
  ErrorCode extends string,
> =
  | {
      readonly checkId: CheckId;
      readonly generation: number;
      readonly verdict: "pass";
      readonly reason: null;
      readonly evidence: Evidence;
    }
  | {
      readonly checkId: CheckId;
      readonly generation: number;
      readonly verdict: "block";
      readonly reason: SpreadsheetWorkerReason<BlockCode>;
      readonly evidence: Evidence;
    }
  | {
      readonly checkId: CheckId;
      readonly generation: number;
      readonly verdict: "error";
      readonly reason: SpreadsheetWorkerReason<ErrorCode>;
      readonly evidence: Evidence;
    };

export type SpreadsheetWorkerResult =
  | SpreadsheetResult<
      "formula.recalculate",
      FormulaRecalculationEvidence,
      "FORMULA_MISMATCH",
      "FORMULA_EVALUATION_ERROR" | "UNSUPPORTED_FORMULA"
    >
  | SpreadsheetResult<"summary.crossfoot", CrossFootEvidence, "CROSSFOOT_MISMATCH", "CROSSFOOT_EVALUATION_ERROR">
  | SpreadsheetResult<"artifact.structure", StructureEvidence, "STRUCTURE_INVALID", "STRUCTURE_INSPECTION_ERROR">;

export interface SpreadsheetWorkerEnvelope {
  readonly contractVersion: "finny.spreadsheet-worker.v2";
  readonly artifactDigest: string;
  readonly policyVersion: string;
  readonly evaluator: FinnyEvaluatorRef;
  readonly engine: {
    readonly name: string;
    readonly version: string;
  };
  readonly results: readonly SpreadsheetWorkerResult[];
  readonly envelopeDigest: string;
}

export interface SpreadsheetCalculationInput {
  readonly artifactBytes: readonly number[];
  readonly binding: SpreadsheetWorkerBinding;
}

export interface SpreadsheetCalculationEngine {
  readonly name: string;
  readonly version: string;
  readonly evaluator: FinnyEvaluatorRef;
  evaluate(input: SpreadsheetCalculationInput): Promise<readonly SpreadsheetWorkerResult[]>;
}

export interface SpreadsheetWorkerRunInput {
  readonly artifactBytes: Uint8Array | readonly number[];
  readonly binding: SpreadsheetWorkerBinding;
}

const checkIds = new Set<string>(SPREADSHEET_WORKER_CHECK_IDS);
const contractVersion = "finny.spreadsheet-worker.v2" as const;
const digestPattern = /^[a-f0-9]{64}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains an unrecognized field or metadata`);
  }
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
}

function finiteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  finiteNumber(value, label);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
}

function positiveGeneration(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Spreadsheet check generation is invalid");
}

function artifactBytes(value: Uint8Array | readonly number[]): readonly number[] {
  const bytes = Array.from(value);
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("Spreadsheet artifact bytes are invalid");
  }
  return Object.freeze(bytes);
}

export function digestSpreadsheetArtifact(bytes: Uint8Array | readonly number[]): string {
  return createHash("sha256")
    .update(Uint8Array.from(artifactBytes(bytes)))
    .digest("hex");
}

function validateEvaluatorRef(value: unknown): FinnyEvaluatorRef {
  const evaluator = record(value, "Spreadsheet evaluator metadata");
  exactKeys(
    evaluator,
    ["id", "revision", "buildDigest", "contractVersion", "configurationDigest"],
    "Spreadsheet evaluator metadata",
  );
  nonEmptyString(evaluator.id, "Spreadsheet evaluator id");
  nonEmptyString(evaluator.revision, "Spreadsheet evaluator revision");
  nonEmptyString(evaluator.contractVersion, "Spreadsheet evaluator contract version");
  if (evaluator.contractVersion !== contractVersion)
    throw new Error("Spreadsheet evaluator contract version is invalid");
  if (typeof evaluator.buildDigest !== "string" || !digestPattern.test(evaluator.buildDigest))
    throw new Error("Spreadsheet evaluator build digest is invalid");
  if (typeof evaluator.configurationDigest !== "string" || !digestPattern.test(evaluator.configurationDigest))
    throw new Error("Spreadsheet evaluator configuration digest is invalid");
  return Object.freeze({
    id: evaluator.id,
    revision: evaluator.revision,
    buildDigest: evaluator.buildDigest,
    contractVersion: evaluator.contractVersion,
    configurationDigest: evaluator.configurationDigest,
  });
}

function sameEvaluator(left: FinnyEvaluatorRef, right: FinnyEvaluatorRef): boolean {
  return (
    left.id === right.id &&
    left.revision === right.revision &&
    left.buildDigest === right.buildDigest &&
    left.contractVersion === right.contractVersion &&
    left.configurationDigest === right.configurationDigest
  );
}

export function createSpreadsheetWorkerBinding(input: SpreadsheetWorkerBinding): SpreadsheetWorkerBinding {
  const source = record(input, "Spreadsheet worker binding");
  exactKeys(source, ["artifactDigest", "policyVersion", "evaluator", "checks"], "Spreadsheet worker binding");
  nonEmptyString(source.artifactDigest, "Spreadsheet artifact digest");
  nonEmptyString(source.policyVersion, "Spreadsheet policy version");
  const evaluator = validateEvaluatorRef(source.evaluator);
  if (!Array.isArray(source.checks) || source.checks.length === 0)
    throw new Error("Spreadsheet check binding is invalid");
  const seen = new Set<string>();
  const checks = source.checks.map((candidate) => {
    const check = record(candidate, "Spreadsheet check binding");
    exactKeys(check, ["checkId", "generation"], "Spreadsheet check binding");
    if (typeof check.checkId !== "string" || !checkIds.has(check.checkId)) {
      throw new Error("Spreadsheet check binding contains an unknown check");
    }
    if (seen.has(check.checkId)) throw new Error("Spreadsheet check binding contains a duplicate check");
    seen.add(check.checkId);
    positiveGeneration(check.generation);
    return Object.freeze({ checkId: check.checkId as SpreadsheetWorkerCheckId, generation: check.generation });
  });
  checks.sort(
    (left, right) =>
      SPREADSHEET_WORKER_CHECK_IDS.indexOf(left.checkId) - SPREADSHEET_WORKER_CHECK_IDS.indexOf(right.checkId),
  );
  return Object.freeze({
    artifactDigest: source.artifactDigest,
    policyVersion: source.policyVersion,
    evaluator,
    checks: Object.freeze(checks),
  });
}

function validateFormulaEvidence(value: unknown): FormulaRecalculationEvidence {
  const evidence = record(value, "Formula evidence");
  exactKeys(evidence, ["kind", "cells"], "Formula evidence");
  if (evidence.kind !== "formula-recalculation" || !Array.isArray(evidence.cells)) {
    throw new Error("Formula evidence is invalid");
  }
  for (const candidate of evidence.cells) {
    const cell = record(candidate, "Formula evidence cell");
    exactKeys(cell, ["sheet", "cell", "formula", "calculatedValue"], "Formula evidence cell");
    nonEmptyString(cell.sheet, "Formula evidence sheet");
    nonEmptyString(cell.cell, "Formula evidence cell reference");
    nonEmptyString(cell.formula, "Formula evidence formula");
    finiteNumber(cell.calculatedValue, "Formula evidence calculated value");
  }
  return evidence as unknown as FormulaRecalculationEvidence;
}

function validateCrossFootEvidence(value: unknown): CrossFootEvidence {
  const evidence = record(value, "Cross-foot evidence");
  exactKeys(evidence, ["kind", "comparisons"], "Cross-foot evidence");
  if (evidence.kind !== "cross-foot" || !Array.isArray(evidence.comparisons)) {
    throw new Error("Cross-foot evidence is invalid");
  }
  for (const candidate of evidence.comparisons) {
    const comparison = record(candidate, "Cross-foot evidence comparison");
    exactKeys(comparison, ["sheet", "reference", "expected", "actual", "difference"], "Cross-foot evidence comparison");
    nonEmptyString(comparison.sheet, "Cross-foot evidence sheet");
    nonEmptyString(comparison.reference, "Cross-foot evidence reference");
    finiteNumber(comparison.expected, "Cross-foot evidence expected value");
    finiteNumber(comparison.actual, "Cross-foot evidence actual value");
    finiteNumber(comparison.difference, "Cross-foot evidence difference");
  }
  return evidence as unknown as CrossFootEvidence;
}

function validateStructureEvidence(value: unknown): StructureEvidence {
  const evidence = record(value, "Structure evidence");
  exactKeys(evidence, ["kind", "sheets"], "Structure evidence");
  if (evidence.kind !== "structure" || !Array.isArray(evidence.sheets))
    throw new Error("Structure evidence is invalid");
  for (const candidate of evidence.sheets) {
    const sheet = record(candidate, "Structure evidence sheet");
    exactKeys(sheet, ["name", "rows", "columns", "formulas"], "Structure evidence sheet");
    nonEmptyString(sheet.name, "Structure evidence sheet name");
    nonNegativeInteger(sheet.rows, "Structure evidence row count");
    nonNegativeInteger(sheet.columns, "Structure evidence column count");
    nonNegativeInteger(sheet.formulas, "Structure evidence formula count");
  }
  return evidence as unknown as StructureEvidence;
}

const reasonCodes = {
  "formula.recalculate": {
    block: new Set(["FORMULA_MISMATCH"]),
    error: new Set(["FORMULA_EVALUATION_ERROR", "UNSUPPORTED_FORMULA"]),
  },
  "summary.crossfoot": {
    block: new Set(["CROSSFOOT_MISMATCH"]),
    error: new Set(["CROSSFOOT_EVALUATION_ERROR"]),
  },
  "artifact.structure": {
    block: new Set(["STRUCTURE_INVALID"]),
    error: new Set(["STRUCTURE_INSPECTION_ERROR"]),
  },
} as const;

function validateReason(value: unknown, checkId: SpreadsheetWorkerCheckId, verdict: "block" | "error"): void {
  const reason = record(value, "Spreadsheet worker reason");
  exactKeys(reason, ["code", "references"], "Spreadsheet worker reason");
  if (typeof reason.code !== "string" || !reasonCodes[checkId][verdict].has(reason.code as never)) {
    throw new Error("Spreadsheet worker reason code is invalid for the check outcome");
  }
  if (!Array.isArray(reason.references) || reason.references.length === 0 || reason.references.length > 100) {
    throw new Error("Spreadsheet worker reason references are invalid");
  }
  const seen = new Set<string>();
  for (const reference of reason.references) {
    if (typeof reference !== "string" || reference.length === 0 || reference.length > 256 || seen.has(reference)) {
      throw new Error("Spreadsheet worker reason reference is invalid");
    }
    seen.add(reference);
  }
}

function validatePassConsistency(
  result: Record<string, unknown>,
  evidence: FormulaRecalculationEvidence | CrossFootEvidence | StructureEvidence,
): void {
  if (result.verdict !== "pass") return;
  if (evidence.kind === "formula-recalculation" && evidence.cells.length === 0)
    throw new Error("Spreadsheet PASS evidence is empty");
  if (evidence.kind === "cross-foot") {
    if (
      evidence.comparisons.length === 0 ||
      evidence.comparisons.some((item) => item.difference !== 0 || item.actual !== item.expected)
    ) {
      throw new Error("Spreadsheet PASS evidence is inconsistent");
    }
  }
  if (
    evidence.kind === "structure" &&
    (evidence.sheets.length === 0 || evidence.sheets.some((sheet) => sheet.rows === 0 || sheet.columns === 0))
  ) {
    throw new Error("Spreadsheet PASS evidence is empty or inconsistent");
  }
}

function validateResult(value: unknown): SpreadsheetWorkerResult {
  const result = record(value, "Spreadsheet worker result");
  exactKeys(result, ["checkId", "generation", "verdict", "reason", "evidence"], "Spreadsheet worker result");
  if (typeof result.checkId !== "string" || !checkIds.has(result.checkId))
    throw new Error("Spreadsheet worker result contains an unknown check");
  const checkId = result.checkId as SpreadsheetWorkerCheckId;
  positiveGeneration(result.generation);
  if (result.verdict !== "pass" && result.verdict !== "block" && result.verdict !== "error")
    throw new Error("Spreadsheet worker verdict is invalid");
  if (result.verdict === "pass") {
    if (result.reason !== null) throw new Error("Spreadsheet worker PASS reason must be null");
  } else validateReason(result.reason, checkId, result.verdict);
  let evidence: FormulaRecalculationEvidence | CrossFootEvidence | StructureEvidence;
  switch (checkId) {
    case "formula.recalculate":
      evidence = validateFormulaEvidence(result.evidence);
      break;
    case "summary.crossfoot":
      evidence = validateCrossFootEvidence(result.evidence);
      break;
    case "artifact.structure":
      evidence = validateStructureEvidence(result.evidence);
      break;
  }
  validatePassConsistency(result, evidence);
  return result as unknown as SpreadsheetWorkerResult;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    finiteNumber(value, "Canonical evidence number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = record(value, "Canonical evidence value");
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function canonicalClone(value: unknown): unknown {
  return JSON.parse(canonical(value)) as unknown;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function envelopePayload(envelope: Omit<SpreadsheetWorkerEnvelope, "envelopeDigest">): string {
  return canonical(envelope);
}

function digestEnvelope(envelope: Omit<SpreadsheetWorkerEnvelope, "envelopeDigest">): string {
  return createHash("sha256").update(envelopePayload(envelope)).digest("base64url");
}

function validateEnvelopeShape(value: unknown): void {
  const envelope = record(value, "Spreadsheet worker envelope");
  exactKeys(
    envelope,
    ["contractVersion", "artifactDigest", "policyVersion", "evaluator", "engine", "results", "envelopeDigest"],
    "Spreadsheet worker envelope",
  );
  if (envelope.contractVersion !== contractVersion) throw new Error("Spreadsheet worker contract version is invalid");
  nonEmptyString(envelope.artifactDigest, "Spreadsheet envelope artifact digest");
  nonEmptyString(envelope.policyVersion, "Spreadsheet envelope policy version");
  nonEmptyString(envelope.envelopeDigest, "Spreadsheet envelope digest");
  validateEvaluatorRef(envelope.evaluator);
  const engine = record(envelope.engine, "Spreadsheet worker engine metadata");
  exactKeys(engine, ["name", "version"], "Spreadsheet worker engine metadata");
  nonEmptyString(engine.name, "Spreadsheet worker engine name");
  nonEmptyString(engine.version, "Spreadsheet worker engine version");
  if (!Array.isArray(envelope.results)) throw new Error("Spreadsheet worker result checks are invalid");
  envelope.results.forEach(validateResult);
}

export function verifySpreadsheetWorkerEnvelope(
  artifact: Uint8Array | readonly number[],
  expectedBinding: SpreadsheetWorkerBinding,
  candidate: unknown,
): SpreadsheetWorkerEnvelope {
  const binding = createSpreadsheetWorkerBinding(expectedBinding);
  const actualArtifactDigest = digestSpreadsheetArtifact(artifact);
  if (actualArtifactDigest !== binding.artifactDigest)
    throw new Error("Spreadsheet artifact does not match its binding");
  const cloned = canonicalClone(candidate);
  validateEnvelopeShape(cloned);
  const envelope = cloned as SpreadsheetWorkerEnvelope;
  if (envelope.artifactDigest !== binding.artifactDigest) throw new Error("Spreadsheet envelope artifact is invalid");
  if (envelope.policyVersion !== binding.policyVersion) throw new Error("Spreadsheet envelope policy is invalid");
  if (!sameEvaluator(envelope.evaluator, binding.evaluator))
    throw new Error("Spreadsheet envelope evaluator is invalid");
  const expected = new Map(binding.checks.map((check) => [check.checkId, check.generation]));
  const seen = new Set<string>();
  for (const result of envelope.results) {
    if (seen.has(result.checkId)) throw new Error("Spreadsheet envelope contains a duplicate check");
    seen.add(result.checkId);
    const generation = expected.get(result.checkId);
    if (generation === undefined) throw new Error("Spreadsheet envelope contains an unknown check");
    if (result.generation !== generation) throw new Error("Spreadsheet envelope check generation is invalid");
  }
  if (seen.size !== expected.size) throw new Error("Spreadsheet envelope is missing a required check");
  const { envelopeDigest, ...payload } = envelope;
  if (digestEnvelope(payload) !== envelopeDigest) throw new Error("Spreadsheet envelope digest is invalid");
  return deepFreeze(envelope);
}

export function createDeterministicSpreadsheetWorker(engine: SpreadsheetCalculationEngine) {
  nonEmptyString(engine.name, "Spreadsheet engine name");
  nonEmptyString(engine.version, "Spreadsheet engine version");
  const engineEvaluator = validateEvaluatorRef(engine.evaluator);
  const engineName = engine.name;
  const engineVersion = engine.version;
  return Object.freeze({
    async run(input: SpreadsheetWorkerRunInput): Promise<SpreadsheetWorkerEnvelope> {
      const binding = createSpreadsheetWorkerBinding(input.binding);
      if (!sameEvaluator(engineEvaluator, binding.evaluator))
        throw new Error("Spreadsheet engine evaluator does not match the binding");
      const bytes = artifactBytes(input.artifactBytes);
      if (digestSpreadsheetArtifact(bytes) !== binding.artifactDigest) {
        throw new Error("Spreadsheet artifact does not match its binding");
      }
      const rawResults = await engine.evaluate(Object.freeze({ artifactBytes: bytes, binding }));
      if (!Array.isArray(rawResults)) throw new Error("Spreadsheet engine results are invalid");
      const results = rawResults
        .map((result) => {
          const cloned = canonicalClone(result);
          return validateResult(cloned);
        })
        .sort((left, right) => {
          const leftIndex = binding.checks.findIndex((check) => check.checkId === left.checkId);
          const rightIndex = binding.checks.findIndex((check) => check.checkId === right.checkId);
          return leftIndex - rightIndex;
        });
      const payload = {
        contractVersion,
        artifactDigest: binding.artifactDigest,
        policyVersion: binding.policyVersion,
        evaluator: binding.evaluator,
        engine: Object.freeze({ name: engineName, version: engineVersion }),
        results: Object.freeze(results),
      } satisfies Omit<SpreadsheetWorkerEnvelope, "envelopeDigest">;
      const envelope: SpreadsheetWorkerEnvelope = Object.freeze({
        ...payload,
        envelopeDigest: digestEnvelope(payload),
      });
      return verifySpreadsheetWorkerEnvelope(bytes, binding, envelope);
    },
  });
}

export function createPersistedDeterministicSpreadsheetWorker(deps: {
  engine: SpreadsheetCalculationEngine;
  files: Pick<FileArtifactStore, "put">;
  ids?: () => string;
}) {
  const worker = createDeterministicSpreadsheetWorker(deps.engine);
  const id = deps.ids ?? randomUUID;
  return {
    async run(input: SpreadsheetWorkerRunInput & { scopeId: ScopeId; jobId: string; evidenceFileId?: string }) {
      const envelope = await worker.run(input);
      const evidenceFileId = input.evidenceFileId ?? id();
      const name = "finny-spreadsheet-evidence.json";
      const data = new TextEncoder().encode(JSON.stringify(envelope));
      const expectedDigest = createHash("sha256").update(data).digest("hex");
      const stored = await deps.files.put({
        id: evidenceFileId,
        ownerScopeId: input.scopeId,
        createdBy: SPREADSHEET_WORKER_PRINCIPAL_ID,
        name,
        path: artifactPath(evidenceFileId, name),
        mimetype: "application/json",
        data,
        direction: "out",
        createdInScope: input.scopeId,
      });
      if (
        stored.artifact.id !== evidenceFileId ||
        stored.artifact.ownerScopeId !== input.scopeId ||
        stored.artifact.createdBy !== SPREADSHEET_WORKER_PRINCIPAL_ID ||
        stored.artifact.sha256 !== expectedDigest ||
        !stored.artifact.enabled
      ) {
        throw new Error("Spreadsheet worker evidence file authority is invalid");
      }
      return { evidenceFileId, envelopeDigest: envelope.envelopeDigest, results: envelope.results };
    },
  };
}
