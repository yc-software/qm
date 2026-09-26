import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, cellsFor } from "./catalog.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

export function medianUpperBound(values, alpha = 0.05) {
  assert.ok(alpha > 0 && alpha < 0.5);
  const n = values.length;
  if (!n || n > 1000) return null;
  let probability = 2 ** -n;
  let cumulative = probability;
  for (let k = 1; k <= n; k++) {
    if (1 - cumulative <= alpha) return [...values].sort((a, b) => a - b)[k - 1];
    probability *= (n - k + 1) / k;
    cumulative += probability;
  }
  return null;
}

export function summarizeCell(samples, { minimumSamples = 31, thresholdMs = 1000, alpha = 0.05 } = {}) {
  const values = samples
    .filter((sample) => sample.status === "pass" && Number.isFinite(sample.durationMs))
    .map((sample) => sample.durationMs);
  const failures = samples.filter((sample) => sample.status !== "pass" || !Number.isFinite(sample.durationMs));
  const medianMs = quantile(values, 0.5);
  const medianUpperMs = medianUpperBound(values, alpha);
  const reasons = [];
  if (samples.length < minimumSamples) reasons.push(`Only ${samples.length}/${minimumSamples} observations`);
  if (failures.length) reasons.push(`${failures.length} failed/unsupported observations`);
  if (medianMs === null || medianMs >= thresholdMs) reasons.push("Median is not strictly below the threshold");
  if (medianUpperMs === null || medianUpperMs >= thresholdMs)
    reasons.push("Upper confidence bound for the median is not below the threshold");
  return {
    pass: reasons.length === 0,
    count: samples.length,
    successes: values.length,
    failures: failures.length,
    medianMs,
    medianUpperMs,
    p95Ms: quantile(values, 0.95),
    maxMs: values.length ? Math.max(...values) : null,
    thresholdMs,
    alpha,
    reasons,
  };
}

const REQUIRED_PARITY = [
  "dataset-cardinality",
  "dataset-distributions",
  "payload-compressibility",
  "database-working-set",
  "service-topology",
  "resource-limits",
  "schema-indexes",
  "production-build",
  "portal-auth-routing",
  "client-network",
  "feature-configuration",
];

export function validateQualification(run, fixture, envelope, workload, producer) {
  const reasons = [];
  const require = (condition, reason) => {
    if (!condition) reasons.push(reason);
  };
  require(run.mode === "qualifying", "Diagnostic runs cannot qualify");
  require(run.status === "completed", "Interrupted runs cannot qualify");
  require(typeof run.browserVersion === "string" &&
    run.browserVersion.length > 0, "Observed browser version is required");
  require(run.samplesPerCell >= 31, "Qualification requires at least 31 observations per cell");
  require(run.samplesPerCell <= 1000, "At most 1000 observations per cell are supported");
  require(run.thresholdMs === 1000, "Qualification requires the fixed 1000 ms threshold");
  require(!run.filtered, "Filtered catalogs cannot qualify");
  const requiredCells = cellsFor(buildCatalog(fixture), run.loadCondition).map((cell) => cell.id);
  require(new Set(run.requiredCells ?? []).size === requiredCells.length &&
    requiredCells.every((cell) =>
      run.requiredCells?.includes(cell),
    ), "Qualification must measure every catalog cell for its load condition");
  require(fixture.scale === 1 && fixture.qualified === true, "Fixture must be a verified full-scale fixture");
  require(typeof fixture.profileSha256 === "string" &&
    fixture.profileSha256 === run.profileSha256, "Fixture and measured usage profile must match");
  const requested = fixture.requestedCounts ?? fixture.requestedTableCounts;
  const verified = fixture.verifiedCounts ?? fixture.verifiedTableCounts;
  require(requested &&
    verified &&
    Object.keys(requested).length >= 6 &&
    Object.entries(requested).every(
      ([table, count]) => Number(verified[table]) === Number(count) && Number(count) >= 0,
    ), "Verified table counts must match requested full-scale counts");
  require(envelope?.baseUrl === run.baseUrl &&
    envelope?.profileSha256 === run.profileSha256, "Environment proof must name the same origin and profile");
  require(envelope?.sourceRevision === run.sourceRevision, "Environment proof must identify the tested revision");
  require(envelope?.fixtureId === run.fixtureId, "Environment proof must identify this fixture");
  require(envelope?.isolated === true, "Environment must be explicitly isolated from production");
  require(Number(envelope?.observedAt) <= run.startedAt &&
    run.startedAt - Number(envelope?.observedAt) <=
      86_400_000, "Parity proof must be observed within the preceding 24 hours");
  for (const name of REQUIRED_PARITY) {
    const check = envelope?.checks?.find((entry) => entry.name === name);
    require(check?.pass === true &&
      check?.expected !== undefined &&
      check?.observed !== undefined &&
      typeof check?.evidence === "string" &&
      check.evidence.length > 0, `Missing passing parity evidence: ${name}`);
  }
  const features = fixture.browser?.features ?? {};
  const featureProof = envelope?.checks?.find((entry) => entry.name === "feature-configuration");
  for (const name of ["modelProvider", "slack", "composio", "loops", "inbox"]) {
    const feature = features[name];
    const enabledModes = ["loops", "inbox"].includes(name) ? ["enabled"] : ["real", "protocol-fixture"];
    require(typeof feature?.enabled === "boolean" &&
      typeof feature?.evidence === "string" &&
      feature.evidence.length > 0, `Fixture feature state needs evidence: ${name}`);
    require(feature?.enabled === true
      ? enabledModes.includes(feature.mode)
      : feature?.mode === "disabled", `Fixture feature mode is invalid: ${name}`);
    require(typeof featureProof?.expected?.[name] === "boolean" &&
      featureProof.expected[name] === feature?.enabled &&
      featureProof.observed?.[name] ===
        feature?.enabled, `Fixture feature configuration differs from production: ${name}`);
    if (feature?.enabled && feature.mode === "protocol-fixture")
      require(feature.protocolParity?.pass === true &&
        typeof feature.protocolParity?.evidence === "string" &&
        feature.protocolParity.evidence.length > 0, `External protocol fixture needs parity evidence: ${name}`);
  }
  require(workload?.pass === true, "Independent-arrival workload must pass");
  require(workload?.mode === "qualifying", "Diagnostic workload replays cannot qualify");
  require(workload?.profileSha256 === run.profileSha256 &&
    workload?.fixtureId === run.fixtureId, "Workload must identify the same profile and fixture");
  require(workload?.condition === run.loadCondition, "Workload condition must match");
  require(Number(workload?.startedAt ?? workload?.measurementStartedAt) <= run.measurementStartedAt &&
    Number(workload?.finishedAt ?? workload?.measurementFinishedAt) >=
      run.measurementFinishedAt, "Workload must cover the entire browser measurement interval");
  require(typeof workload?.workloadProfileSha256 === "string" &&
    workload.workloadProfileSha256.length === 64, "Workload must retain its workload profile hash");
  require(producer?.pass === true &&
    producer.qualified === true &&
    producer.mode === "qualifying", "Productive workload must pass and close its qualification gaps");
  require(producer?.fixtureId === run.fixtureId &&
    producer?.profileSha256 === run.profileSha256 &&
    producer?.condition === run.loadCondition, "Productive workload must match the fixture, profile and condition");
  require(/^[a-f0-9]{64}$/.test(
    producer?.workloadProfileSha256 ?? "",
  ), "Productive workload must retain its profile hash");
  require(Number(producer?.startedAt) <= run.measurementStartedAt &&
    Number(producer?.finishedAt) >=
      run.measurementFinishedAt, "Productive workload must cover the entire browser measurement interval");
  const pressure = producer?.producer;
  require(pressure?.kind === "controlled-envelope" &&
    ["scheduler", "counters", "running", "events", "bytes", "observers", "cleanup", "provider"].every(
      (name) => pressure.checks?.[name] === true,
    ), "Productive workload must achieve every measured pressure and correctness bound");
  require(Number(pressure?.counterStart) <= run.measurementStartedAt &&
    Number(pressure?.counterEnd) >= run.measurementFinishedAt &&
    pressure?.runningSamples > 0 &&
    pressure?.measuredEvents > 0 &&
    pressure?.measuredBytes >
      0, "Productive workload needs observed database and run-stream pressure throughout measurement");
  require(Array.isArray(pressure?.qualificationGaps) &&
    pressure.qualificationGaps.length === 0, "Productive workload has unclosed source or protocol coverage gaps");
  return reasons;
}

export function verifyRun(run, samples, fixture, envelope, workload, producer) {
  const reasons = [];
  const required = run.requiredCells ?? [];
  if (!required.length || new Set(required).size !== required.length)
    reasons.push("Required cell catalog is empty or duplicated");
  const keys = new Set();
  for (const sample of samples) {
    const key = `${sample.cellId}:${sample.iteration}`;
    if (keys.has(key)) reasons.push(`Duplicate observation: ${key}`);
    keys.add(key);
    if (!required.includes(sample.cellId)) reasons.push(`Unexpected cell: ${sample.cellId}`);
    if (!Number.isInteger(sample.iteration) || sample.iteration < 0 || sample.iteration >= run.samplesPerCell)
      reasons.push(`Invalid observation index: ${key}`);
    if (sample.status === "pass" && (sample.errors?.length || sample.readiness?.passed !== true))
      reasons.push(`Missing readiness proof or browser errors: ${key}`);
    if (!(
      sample.startedAt >= run.measurementStartedAt &&
      sample.finishedAt <= run.measurementFinishedAt &&
      sample.finishedAt >= sample.startedAt
    ))
      reasons.push(`Invalid observation timestamps: ${key}`);
  }
  const alpha = 0.05 / Math.max(1, required.length);
  const cells = Object.fromEntries(
    required.map((cellId) => {
      const observations = samples.filter((sample) => sample.cellId === cellId);
      const result = summarizeCell(observations, {
        minimumSamples: run.mode === "qualifying" ? Math.max(31, run.samplesPerCell) : run.samplesPerCell,
        thresholdMs: 1000,
        alpha,
      });
      if (observations.length !== run.samplesPerCell)
        result.reasons.push(`Expected exactly ${run.samplesPerCell} observations`);
      result.pass = result.reasons.length === 0;
      return [cellId, result];
    }),
  );
  const structuralReasons = [...reasons];
  if (Object.values(cells).some((cell) => !cell.pass)) reasons.push("One or more cells failed");
  const qualificationReasons = validateQualification(run, fixture, envelope, workload, producer);
  return {
    schemaVersion: 1,
    runId: run.runId,
    mode: run.mode,
    pass: reasons.length === 0,
    qualified: reasons.length === 0 && qualificationReasons.length === 0,
    confidence: {
      familyWise: 0.95,
      method: "Exact binomial order-statistic bound with Bonferroni correction",
      perCellAlpha: alpha,
    },
    reasons,
    structuralReasons,
    qualificationReasons,
    cells,
  };
}

export function verifyCampaign({ baseline, candidate }, conditions = ["normal", "peak"]) {
  const reasons = [];
  const checked = (items) =>
    items.map((item) => ({
      ...item,
      result: verifyRun(item.run, item.samples, item.fixture, item.envelope, item.workload, item.producer),
    }));
  const before = checked(baseline);
  const after = checked(candidate);
  const reference = after[0]?.run;
  if (!reference) reasons.push("No candidate evidence");
  for (const item of [...before, ...after]) {
    if (
      item.result.structuralReasons.length ||
      item.result.qualificationReasons.length ||
      Object.values(item.result.cells).some((cell) => cell.count !== item.run.samplesPerCell) ||
      item.samples.some(
        (sample) =>
          !["pass", "failed"].includes(sample.status) || !Number.isFinite(sample.durationMs) || sample.durationMs < 0,
      )
    )
      reasons.push(`Incomplete or non-equivalent evidence: ${item.run.runId}`);
    for (const key of [
      "fixtureId",
      "fixtureSha256",
      "profileSha256",
      "catalogSha256",
      "runnerSha256",
      "browserVersion",
    ])
      if (item.run[key] !== reference?.[key]) reasons.push(`Campaign mismatch ${key}: ${item.run.runId}`);
    if (JSON.stringify(item.run.browser) !== JSON.stringify(reference?.browser))
      reasons.push(`Different browser/network budget: ${item.run.runId}`);
  }
  const ids = [...before, ...after].map((item) => item.run.runId);
  if (new Set(ids).size !== ids.length) reasons.push("Campaign repeats a run instead of independently measuring it");
  for (const condition of conditions) {
    if (!before.some((item) => item.run.loadCondition === condition))
      reasons.push(`Missing baseline under ${condition} load`);
    const repeats = after.filter((item) => item.run.loadCondition === condition);
    if (repeats.length < 2) reasons.push(`Need two independent candidate runs under ${condition} load`);
  }
  for (const item of after) if (!item.result.qualified) reasons.push(`Candidate failed: ${item.run.runId}`);
  if (after.some((item) => item.run.sourceRevision !== reference?.sourceRevision))
    reasons.push("Candidate runs use different source revisions");
  const comparison = after.flatMap((item) =>
    Object.entries(item.result.cells).map(([cellId, cell]) => {
      const previous = before.find((entry) => entry.run.loadCondition === item.run.loadCondition)?.result.cells[cellId];
      const baselineMedianMs = previous?.failures === 0 ? previous.medianMs : null;
      return {
        runId: item.run.runId,
        cellId,
        baselineFailures: previous?.failures ?? null,
        baselineMedianMs,
        candidateMedianMs: cell.medianMs,
        medianDeltaMs: baselineMedianMs === null || cell.medianMs === null ? null : cell.medianMs - baselineMedianMs,
        baselineP95Ms: previous?.failures === 0 ? previous.p95Ms : null,
        candidateP95Ms: cell.p95Ms,
      };
    }),
  );
  return { qualified: reasons.length === 0, reasons, comparison };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? ".");
  const read = (name) => JSON.parse(readFileSync(resolve(directory, name), "utf8"));
  const run = read("run.json");
  const samples = readFileSync(resolve(directory, "samples.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const optional = (name) => {
    try {
      return read(name);
    } catch {
      return undefined;
    }
  };
  const result = verifyRun(
    run,
    samples,
    read("fixture.json"),
    optional("envelope.json"),
    optional("workload.json"),
    optional("producer.json"),
  );
  writeFileSync(resolve(directory, "summary.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = (run.mode === "qualifying" ? result.qualified : result.pass) ? 0 : 1;
}
