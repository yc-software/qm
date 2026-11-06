import { createHash } from "node:crypto";

export const SPREADSHEET_WORKER_CHECK_IDS = ["formula.recalculate", "summary.crossfoot", "artifact.structure"] as const;

export type SpreadsheetWorkerCheckId = (typeof SPREADSHEET_WORKER_CHECK_IDS)[number];

export interface SpreadsheetWorkerCheckBinding {
  readonly checkId: SpreadsheetWorkerCheckId;
  readonly generation: number;
}

export interface SpreadsheetWorkerBinding {
  readonly artifactDigest: string;
  readonly policyVersion: string;
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

export type SpreadsheetWorkerResult =
  | {
      readonly checkId: "formula.recalculate";
      readonly generation: number;
      readonly verdict: "pass" | "block";
      readonly evidence: FormulaRecalculationEvidence;
    }
  | {
      readonly checkId: "summary.crossfoot";
      readonly generation: number;
      readonly verdict: "pass" | "block";
      readonly evidence: CrossFootEvidence;
    }
  | {
      readonly checkId: "artifact.structure";
      readonly generation: number;
      readonly verdict: "pass" | "block";
      readonly evidence: StructureEvidence;
    };

export interface SpreadsheetWorkerEnvelope {
  readonly contractVersion: "finny.spreadsheet-worker.v1";
  readonly artifactDigest: string;
  readonly policyVersion: string;
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
  evaluate(input: SpreadsheetCalculationInput): Promise<readonly SpreadsheetWorkerResult[]>;
}

export interface SpreadsheetWorkerRunInput {
  readonly artifactBytes: Uint8Array | readonly number[];
  readonly binding: SpreadsheetWorkerBinding;
}

const checkIds = new Set<string>(SPREADSHEET_WORKER_CHECK_IDS);
const contractVersion = "finny.spreadsheet-worker.v1" as const;

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
    .digest("base64url");
}

export function createSpreadsheetWorkerBinding(input: SpreadsheetWorkerBinding): SpreadsheetWorkerBinding {
  const source = record(input, "Spreadsheet worker binding");
  exactKeys(source, ["artifactDigest", "policyVersion", "checks"], "Spreadsheet worker binding");
  nonEmptyString(source.artifactDigest, "Spreadsheet artifact digest");
  nonEmptyString(source.policyVersion, "Spreadsheet policy version");
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

function validateResult(value: unknown): SpreadsheetWorkerResult {
  const result = record(value, "Spreadsheet worker result");
  exactKeys(result, ["checkId", "generation", "verdict", "evidence"], "Spreadsheet worker result");
  if (typeof result.checkId !== "string" || !checkIds.has(result.checkId)) {
    throw new Error("Spreadsheet worker result contains an unknown check");
  }
  positiveGeneration(result.generation);
  if (result.verdict !== "pass" && result.verdict !== "block") throw new Error("Spreadsheet worker verdict is invalid");
  if (result.checkId === "formula.recalculate") validateFormulaEvidence(result.evidence);
  if (result.checkId === "summary.crossfoot") validateCrossFootEvidence(result.evidence);
  if (result.checkId === "artifact.structure") validateStructureEvidence(result.evidence);
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
    ["contractVersion", "artifactDigest", "policyVersion", "engine", "results", "envelopeDigest"],
    "Spreadsheet worker envelope",
  );
  if (envelope.contractVersion !== contractVersion) throw new Error("Spreadsheet worker contract version is invalid");
  nonEmptyString(envelope.artifactDigest, "Spreadsheet envelope artifact digest");
  nonEmptyString(envelope.policyVersion, "Spreadsheet envelope policy version");
  nonEmptyString(envelope.envelopeDigest, "Spreadsheet envelope digest");
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
  const engineName = engine.name;
  const engineVersion = engine.version;
  return Object.freeze({
    async run(input: SpreadsheetWorkerRunInput): Promise<SpreadsheetWorkerEnvelope> {
      const binding = createSpreadsheetWorkerBinding(input.binding);
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
