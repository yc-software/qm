import assert from "node:assert/strict";
import test from "node:test";
import { validateQualification, verifyCampaign } from "./verify.mjs";
import { buildCatalog, cellsFor } from "./catalog.mjs";

const run = {
  fixtureId: "fixture",
  profileSha256: "a".repeat(64),
  loadCondition: "peak",
  measurementStartedAt: 1000,
  measurementFinishedAt: 2000,
};
const producer = () => ({
  pass: true,
  qualified: true,
  mode: "qualifying",
  fixtureId: run.fixtureId,
  profileSha256: run.profileSha256,
  workloadProfileSha256: "b".repeat(64),
  condition: "peak",
  startedAt: 500,
  finishedAt: 2500,
  producer: {
    kind: "controlled-envelope",
    checks: Object.fromEntries(
      ["scheduler", "counters", "running", "events", "bytes", "observers", "cleanup", "provider"].map((key) => [
        key,
        true,
      ]),
    ),
    counterStart: 500,
    counterEnd: 2500,
    runningSamples: 2,
    measuredEvents: 20,
    measuredBytes: 2000,
    qualificationGaps: [],
  },
});
const reasons = (evidence) =>
  validateQualification(run, {}, undefined, { pass: true }, evidence).filter((reason) =>
    reason.startsWith("Productive workload"),
  );

test("passing HTTP traffic cannot substitute for measured turns, writes and run streams", () => {
  assert.ok(reasons(undefined).length > 0);
  assert.deepEqual(reasons(producer()), []);
  for (const mutate of [
    (p) => (p.qualified = false),
    (p) => (p.mode = "diagnostic"),
    (p) => (p.fixtureId = "other"),
    (p) => (p.profileSha256 = "c".repeat(64)),
    (p) => (p.condition = "normal"),
    (p) => (p.startedAt = 1001),
    (p) => (p.finishedAt = 1999),
    (p) => (p.producer.counterStart = 1001),
    (p) => (p.producer.counterEnd = 1999),
    (p) => (p.producer.checks.counters = false),
    (p) => delete p.producer.checks.provider,
    (p) => (p.producer.runningSamples = 0),
    (p) => (p.producer.measuredEvents = 0),
    (p) => (p.producer.qualificationGaps = ["native-cron-scheduling"]),
    (p) => delete p.producer.qualificationGaps,
  ]) {
    const evidence = producer();
    mutate(evidence);
    assert.ok(reasons(evidence).length > 0, String(mutate));
  }
});

test("qualification checks the complete catalog independently of a run's declared cells", () => {
  const fixture = {};
  const requiredCells = cellsFor(buildCatalog(fixture), "peak").map((cell) => cell.id);
  const missing = (cells) =>
    validateQualification({ ...run, requiredCells: cells }, fixture).includes(
      "Qualification must measure every catalog cell for its load condition",
    );
  assert.equal(missing(requiredCells.slice(1)), true);
  assert.equal(missing([...requiredCells, "invented"]), true);
  assert.equal(missing(requiredCells), false);
});

test("campaign retains measured baseline failures without accepting missing evidence or candidate failures", () => {
  const features = Object.fromEntries(
    ["modelProvider", "slack", "composio", "loops", "inbox"].map((key) => [
      key,
      { enabled: false, mode: "disabled", evidence: "unit fixture" },
    ]),
  );
  const counts = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`table${i}`, 1]));
  const fixture = {
    scale: 1,
    qualified: true,
    profileSha256: run.profileSha256,
    requestedCounts: counts,
    verifiedCounts: counts,
    browser: { features },
  };
  const requiredCells = cellsFor(buildCatalog(fixture), "peak").map((cell) => cell.id);
  const make = (runId, durationMs) => ({
    run: {
      ...run,
      runId,
      mode: "qualifying",
      status: "completed",
      samplesPerCell: 31,
      thresholdMs: 1000,
      requiredCells,
      browserVersion: "unit-browser",
      startedAt: 1000,
      baseUrl: "https://fixture.invalid",
      sourceRevision: "unit-revision",
    },
    samples: requiredCells.flatMap((cellId) =>
      Array.from({ length: 31 }, (_, iteration) => ({
        cellId,
        iteration,
        status: "pass",
        durationMs,
        startedAt: 1100,
        finishedAt: 1900,
        readiness: { passed: true },
        errors: [],
      })),
    ),
    fixture,
    envelope: {
      baseUrl: "https://fixture.invalid",
      profileSha256: run.profileSha256,
      sourceRevision: "unit-revision",
      fixtureId: run.fixtureId,
      isolated: true,
      observedAt: 900,
      checks: [
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
      ].map((name) => ({
        name,
        pass: true,
        evidence: "unit proof",
        expected: Object.fromEntries(Object.keys(features).map((key) => [key, false])),
        observed: Object.fromEntries(Object.keys(features).map((key) => [key, false])),
      })),
    },
    workload: { ...producer(), workloadProfileSha256: "c".repeat(64) },
    producer: producer(),
  });
  const baseline = make("before", 1400);
  const candidate = [make("after-one", 600), make("after-two", 600)];
  const check = () => verifyCampaign({ baseline: [baseline], candidate }, ["peak"]);
  assert.equal(check().qualified, true);
  baseline.samples[0] = {
    ...baseline.samples[0],
    status: "failed",
    durationMs: 15000,
    readiness: { passed: false },
    errors: [{ type: "timeout" }],
  };
  const result = check();
  assert.equal(result.qualified, true, result.reasons.join("\n"));
  assert.equal(result.comparison[0].baselineFailures, 1);
  assert.equal(result.comparison[0].baselineMedianMs, null);
  assert.equal(result.comparison[0].baselineP95Ms, null);
  assert.equal(result.comparison[0].medianDeltaMs, null);
  for (const change of [{ durationMs: null }, { status: "unsupported" }]) {
    const original = baseline.samples[0];
    baseline.samples[0] = { ...original, ...change };
    assert.equal(check().qualified, false);
    baseline.samples[0] = original;
  }
  const missing = baseline.samples.pop();
  assert.equal(check().qualified, false);
  baseline.samples.push(missing);
  candidate[0].samples[0].status = "failed";
  assert.equal(check().qualified, false);
  candidate[0].samples[0].status = "pass";
  const extra = make("extra-condition", 600);
  extra.run.loadCondition = extra.workload.condition = extra.producer.condition = "unrequested";
  extra.run.requiredCells = extra.run.requiredCells.map((id) => id.replace(/:peak$/, ":unrequested"));
  for (const sample of extra.samples) sample.cellId = sample.cellId.replace(/:peak$/, ":unrequested");
  extra.samples[0].status = "failed";
  candidate.push(extra);
  assert.equal(check().qualified, false);
});
