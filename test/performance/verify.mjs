import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, cellsFor, INTERACTIVE_KINDS } from "./catalog.mjs";

import { pruneSidebarDomRecords } from "./sidebar-dom.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function validateSidebarCapture(entry, { principalId, profile }) {
  assert.ok(entry.sameOrigin && entry.completed && entry.status === 200);
  assert.ok(typeof principalId === "string" && principalId);
  assert.ok(
    [
      "/api/sessions",
      "/api/contexts",
      "/api/session-navigation",
      "/api/session-navigation/page",
      "/api/session-navigation/resolve",
    ].includes(entry.path),
  );
  assert.equal(entry.method, ["/api/sessions", "/api/contexts"].includes(entry.path) ? "GET" : "POST");
  const projection = entry.sidebarProjection,
    capture = entry.sidebarCapture;
  assert.equal(projection?.schemaVersion, 1);
  assert.equal(projection.qualified, false);
  assert.equal(projection.principalId, principalId);
  assert.deepEqual(projection.profile, profile);
  assert.ok(capture);
  const fields = {
    "/api/session-navigation": ["surface", "section", "cursorSha256", "references"],
    "/api/session-navigation/page": [
      "surface",
      "status",
      "scopeIdSha256",
      "parentSessionIdSha256",
      "querySha256",
      "titleSha256",
      "children",
      "actionable",
      "pinned",
      "archived",
      "cursorSha256",
    ],
    "/api/session-navigation/resolve": ["references"],
  }[entry.path];
  const intent = entry.navigation;
  if (fields) {
    assert.ok(intent && typeof intent === "object" && !Array.isArray(intent), "Normalized navigation intent required");
    assert.deepEqual(Object.keys(intent).sort(), [...fields].sort());
    for (const field of fields) {
      const value = intent[field];
      if (field === "references") {
        assert.ok(Array.isArray(value) && value.length <= 12);
        for (const ref of value) {
          assert.deepEqual(Object.keys(ref).sort(), ["kind", "valueSha256"]);
          assert.ok(["id", "thread"].includes(ref.kind));
          assert.match(ref.valueSha256, /^[a-f0-9]{64}$/);
        }
      } else if (field.endsWith("Sha256")) {
        if (value !== null) assert.match(value, /^[a-f0-9]{64}$/);
      } else if (["children", "actionable", "pinned", "archived"].includes(field)) {
        assert.ok(value === null || typeof value === "boolean");
      } else {
        assert.ok(
          value === null ||
            {
              surface: ["all", "web", "slack", "core"],
              section: ["recent", "pinned", "groups", "archived"],
              status: ["active", "waiting", "archived"],
            }[field].includes(value),
        );
      }
    }
    assert.equal(capture.cursorSha256, intent.cursorSha256 ?? null);
    if (entry.path === "/api/session-navigation") {
      assert.ok(intent.cursorSha256 === null || intent.section !== null);
      assert.equal(
        capture.role,
        intent.cursorSha256 === null && (intent.section === null || capture.referencesPresent)
          ? "navigation-refresh"
          : "navigation-section",
      );
    } else {
      assert.equal(capture.role, entry.path.endsWith("/page") ? "session-page" : "resolve");
      assert.equal(capture.referencesPresent, entry.path.endsWith("/resolve"));
    }
    if (intent.actionable === true) {
      assert.equal(intent.children, true);
      assert.match(intent.parentSessionIdSha256, /^[a-f0-9]{64}$/);
    }
  } else {
    assert.equal(intent, undefined);
    assert.equal(capture.role, entry.path === "/api/sessions" ? "legacy-sessions" : "legacy-contexts");
    assert.equal(capture.referencesPresent, false);
    assert.equal(capture.cursorSha256, null);
  }
  for (const digest of [
    entry.responseBodySha256,
    projection.responseBodySha256,
    projection.metadataSha256,
    projection.projectionSha256,
    projection.requestIntentSha256,
    capture.requestIntentSha256,
  ])
    assert.match(digest, /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(entry.responseBodyBytes) && entry.responseBodyBytes > 0 && entry.responseBodyBytes <= 4194304,
  );
  assert.equal(projection.responseBodySha256, entry.responseBodySha256);
  assert.equal(projection.bodyBytes, entry.responseBodyBytes);
  assert.equal(projection.requestIntentSha256, capture.requestIntentSha256);
  assert.ok(Number.isSafeInteger(entry.responseAt) && entry.responseAt > 0);
  assert.ok(Number.isSafeInteger(capture.generation) && capture.generation > 0);
  assert.ok(Number.isSafeInteger(capture.sequence) && capture.sequence > 0);
  assert.ok(
    [
      "legacy-sessions",
      "legacy-contexts",
      "navigation-refresh",
      "navigation-section",
      "session-page",
      "resolve",
    ].includes(capture.role),
  );
  assert.equal(typeof capture.referencesPresent, "boolean");
  if (capture.cursorSha256 !== null) assert.match(capture.cursorSha256, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(capture.chains));
  for (const chain of capture.chains) {
    assert.ok(["recent", "pinned", "groups", "archived", "page"].includes(chain.section));
    assert.match(chain.keySha256, /^[a-f0-9]{64}$/);
    assert.ok(
      Number.isSafeInteger(chain.chainSequence) && chain.chainSequence > 0 && chain.chainSequence <= capture.sequence,
    );
  }
  const actionable = entry.path === "/api/session-navigation/page" && entry.navigation?.actionable === true;
  assert.equal(entry.actionablePage !== undefined, actionable);
  assert.equal(projection.actionable !== undefined, actionable);
  if (actionable) assert.ok(entry.actionablePage && projection.actionable);
  assert.ok(
    profile.transport !== "navigation-post" || entry.path !== "/api/sessions",
    "Bounded navigation fell back to the full session list",
  );
}

export function validateSidebarDom(proof, entries, { principalId, profile, surface, finishedAt }) {
  assert.ok(Number.isSafeInteger(finishedAt) && finishedAt > 0);
  assert.equal(proof?.schemaVersion, 1);
  assert.equal(proof.qualified, false);
  assert.equal(proof.principalId, principalId);
  assert.deepEqual(proof.profile, profile);
  assert.equal(proof.surface, surface);
  assert.ok(["web", "all"].includes(surface));
  for (const key of ["generation", "version"]) assert.ok(Number.isSafeInteger(proof[key]) && proof[key] > 0);
  assert.match(proof.expectedSha256, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(proof)) <= 4194304);
  assert.ok(Array.isArray(proof.missing) && proof.missing.every((reason) => typeof reason === "string"));
  assert.ok(proof.missing.includes("Dynamic sidebar identities require admitted native history reconciliation"));
  const bounded = profile.transport === "navigation-post";
  const captured = new Map();
  const records = [];
  const chains = new Map();
  for (const entry of entries
    .filter((entry) => entry.sidebarCapture && entry.completed && entry.status === 200)
    .sort((a, b) => a.sidebarCapture.sequence - b.sidebarCapture.sequence)) {
    validateSidebarCapture(entry, { principalId, profile });
    assert.ok(entry.responseAt <= finishedAt);
    assert.ok(entry.sidebarCapture.generation <= proof.generation);
    const intent = entry.navigation;
    records.push({
      entry,
      projection: entry.sidebarProjection,
      request: {
        path: entry.path,
        body: intent
          ? { ...intent, scopeId: intent.scopeIdSha256, parentSessionId: intent.parentSessionIdSha256 }
          : undefined,
      },
    });
    for (const chain of entry.sidebarCapture.chains) chains.set(chain.keySha256, chain.chainSequence);
    const key = `${entry.sidebarCapture.generation}:${entry.sidebarCapture.sequence}`;
    assert.ok(!captured.has(key), "Duplicate sidebar request identity");
    captured.set(key, entry);
  }
  pruneSidebarDomRecords(records, chains, surface);
  const current = (record, section) =>
    record.entry.sidebarCapture.chains.some(
      (chain) => chain.section === section && chains.get(chain.keySha256) === chain.chainSequence,
    );
  const identity = ({ generation, sequence }) => `${generation}:${sequence}`;
  const sameSources = (sources, expected, ordered = true) => {
    const actual = sources.map(identity),
      wanted = expected.map((record) => identity(record.entry.sidebarCapture));
    assert.deepEqual(
      ordered ? actual : actual.sort(),
      ordered ? wanted : wanted.sort(),
      "Rendered sidebar sources omit or add an applied response",
    );
  };
  const full = records.findLast((record) =>
    bounded
      ? record.entry.sidebarCapture.role === "navigation-refresh" &&
        (record.entry.navigation.surface ?? "all") === surface
      : record.entry.path === "/api/sessions",
  );
  assert.ok(full);
  const join = (source, section, scopeId) => {
    assert.ok(source && typeof source === "object" && !Array.isArray(source));
    const keys = [
      "generation",
      "sequence",
      "role",
      "responseAt",
      "responseBodySha256",
      "projectionSha256",
      "requestIntentSha256",
    ];
    if (section) keys.push("section", "keySha256", "chainSequence");
    if (scopeId !== undefined) keys.push("scopeId");
    assert.deepEqual(Object.keys(source).sort(), keys.sort());
    const entry = captured.get(`${source.generation}:${source.sequence}`);
    assert.ok(entry, "Rendered sidebar source has no captured response");
    validateSidebarCapture(entry, { principalId, profile });
    assert.equal(source.generation, entry.sidebarCapture.generation);
    assert.equal(source.sequence, entry.sidebarCapture.sequence);
    assert.ok(source.generation <= proof.generation);
    assert.deepEqual(
      [source.role, source.responseAt, source.responseBodySha256, source.projectionSha256, source.requestIntentSha256],
      [
        entry.sidebarCapture.role,
        entry.responseAt,
        entry.responseBodySha256,
        entry.sidebarProjection.projectionSha256,
        entry.sidebarCapture.requestIntentSha256,
      ],
    );
    if (section) {
      assert.equal(source.section, section);
      assert.ok(
        entry.sidebarCapture.chains.some(
          (chain) =>
            chain.section === section &&
            chain.keySha256 === source.keySha256 &&
            chain.chainSequence === source.chainSequence,
        ),
      );
      assert.ok(entry.sidebarProjection.sections[section]);
    }
    if (scopeId !== undefined) {
      assert.ok(typeof scopeId === "string" && scopeId.length > 0);
      assert.equal(entry.navigation.scopeIdSha256, sha256(scopeId));
      assert.equal(entry.navigation.pinned, false);
      assert.equal(entry.navigation.archived, false);
      assert.ok(entry.navigation.actionable !== true && entry.navigation.children !== true);
      assert.equal(entry.navigation.parentSessionIdSha256, null);
      assert.equal(entry.navigation.surface ?? "all", surface);
    }
    return entry;
  };
  assert.deepEqual(Object.keys(proof.sectionSources).sort(), ["archived", "groups", "pinned", "recent"]);
  for (const section of ["recent", "pinned", "groups", "archived"]) {
    const sources = proof.sectionSources[section];
    assert.ok(Array.isArray(sources));
    if (section !== "archived" || !bounded) assert.ok(sources.length);
    const selected = bounded
      ? records.filter(
          (record) =>
            record.entry.path === "/api/session-navigation" &&
            (record.entry.navigation.surface ?? "all") === surface &&
            current(record, section) &&
            record.projection.sections[section],
        )
      : [full];
    sameSources(sources, selected);
    for (const source of sources) {
      const entry = join(source, bounded ? section : undefined);
      assert.equal(entry.path, bounded ? "/api/session-navigation" : "/api/sessions");
      if (bounded) assert.equal(entry.navigation.surface ?? "all", surface);
    }
  }
  for (const field of ["groupPageSources", "referenceSources", "entitySources"]) {
    assert.ok(Array.isArray(proof[field]));
    if (!bounded) assert.equal(proof[field].length, 0);
    const selected = !bounded
      ? []
      : records.filter((record) => {
          if (field === "referenceSources")
            return (
              (record === full || record.entry.sidebarCapture.role === "resolve") &&
              record.projection.references.length > 0
            );
          if (!current(record, "page") || !record.projection.sections.page) return false;
          if (field === "entitySources") return true;
          const input = record.entry.navigation;
          return (
            record.entry.sidebarCapture.sequence >= full.entry.sidebarCapture.sequence &&
            input.scopeIdSha256 !== null &&
            input.actionable !== true &&
            input.children !== true &&
            input.parentSessionIdSha256 === null &&
            input.archived === false &&
            input.pinned === false &&
            (input.surface ?? "all") === surface
          );
        });
    sameSources(proof[field], selected, field === "groupPageSources");
    for (const source of proof[field]) {
      const entry = join(
        source,
        field === "referenceSources" ? undefined : "page",
        field === "groupPageSources" ? source.scopeId : undefined,
      );
      if (field === "referenceSources") {
        assert.ok(["navigation-refresh", "resolve"].includes(entry.sidebarCapture.role));
        assert.ok(entry.sidebarProjection.references.length > 0);
      } else assert.equal(entry.path, "/api/session-navigation/page");
    }
  }
  if (bounded) {
    assert.equal(proof.contextSource, null);
    assert.equal(proof.legacyProjectionSha256, null);
  } else {
    assert.equal(join(proof.contextSource).path, "/api/contexts");
    sameSources([proof.contextSource], [records.findLast((record) => record.entry.path === "/api/contexts")]);
    assert.match(proof.legacyProjectionSha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(
    [...new Set(proof.missing)].sort(),
    [
      ...new Set([
        ...records.flatMap((record) => record.projection.missing),
        "Dynamic sidebar identities require admitted native history reconciliation",
      ]),
    ].sort(),
  );
  const dom = proof.dom;
  for (const section of ["recent", "pinned", "archived", "groups"]) {
    const rows = dom[section];
    assert.ok(Number.isSafeInteger(rows.count) && rows.count >= 0);
    assert.match(rows[section === "groups" ? "scopeIdsSha256" : "idsSha256"], /^[a-f0-9]{64}$/);
    assert.match(rows.rowsSha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof dom.more[section], "boolean");
    if (section !== "archived") {
      assert.ok(Number.isSafeInteger(dom.totals[section]) && dom.totals[section] >= 0);
      assert.ok(
        Number.isSafeInteger(dom.loaded[section]) &&
          dom.loaded[section] >= 0 &&
          dom.loaded[section] <= dom.totals[section],
      );
    }
  }
  assert.match(dom.topLevelSha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof dom.archivedOpen, "boolean");
  assert.ok(Number.isSafeInteger(dom.archivedCount) && dom.archivedCount >= 0);
  assert.equal(dom.groups.count, dom.loaded.groups);
  assert.ok(dom.pinned.count <= dom.loaded.pinned);
  const groupRows = proof.groupPageSources.reduce(
    (count, source) => count + captured.get(identity(source)).sidebarProjection.sections.page.count,
    0,
  );
  assert.ok(dom.recent.count <= dom.loaded.recent + groupRows + 12);
  if (!dom.archivedOpen) {
    assert.equal(dom.archived.count, 0);
    assert.equal(dom.more.archived, false);
  }
  if (bounded) {
    assert.equal(dom.archivedCount, full.projection.archivedCount);
    if (dom.archivedOpen && dom.archivedCount > 0) assert.ok(proof.sectionSources.archived.length);
    for (const section of ["recent", "pinned", "groups", "archived"]) {
      const sources = proof.sectionSources[section];
      const pages = sources.map((source) => captured.get(identity(source)).sidebarProjection.sections[section]);
      if (!pages.length) continue;
      for (const [index, source] of sources.entries()) {
        const token = captured.get(identity(source)).sidebarCapture.cursorSha256;
        assert.ok(
          index === 0
            ? token === null
            : token !== null && pages.slice(0, index).some((page) => page.nextCursorSha256 === token),
        );
      }
      const page = pages.at(-1);
      for (const value of pages) {
        assert.ok(Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= 50);
        assert.ok(Number.isSafeInteger(value.total) && value.total >= value.count);
        if (value.nextCursorSha256 !== null) assert.match(value.nextCursorSha256, /^[a-f0-9]{64}$/);
      }
      if (section !== "archived") {
        assert.equal(dom.totals[section], page.total);
        assert.ok(dom.loaded[section] >= Math.max(...pages.map((value) => value.count)));
        assert.ok(dom.loaded[section] <= pages.reduce((count, value) => count + value.count, 0));
      } else assert.ok(dom.archived.count <= pages.reduce((count, value) => count + value.count, 0) + 12);
      assert.equal(dom.more[section], (section !== "archived" || dom.archivedOpen) && page.nextCursorSha256 !== null);
    }
  }
}

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
  require(Array.isArray(fixture.viewReadinessBySource), "Prepared source pair is required for qualification");
  let catalog = [];
  try {
    catalog = buildCatalog(fixture, run.sourceRevision);
    const profile = fixture.viewReadinessBySource?.find(
      (record) => record.profile.sourceRevision === run.sourceRevision,
    )?.profile;
    require(profile &&
      Object.keys(run.sidebarProfile ?? {})
        .sort()
        .join(",") === "sourceRevision,transport" &&
      run.sidebarProfile?.sourceRevision === profile.sourceRevision &&
      run.sidebarProfile?.transport ===
        profile.transport, "Prepared source profile must match the recorded run profile");
    require(JSON.stringify(run.catalog) ===
      JSON.stringify(catalog), "Prepared source catalog must match the recorded run catalog");
    require(catalog.every(
      (scenario) => scenario.missing.length === 0,
    ), "Prepared source catalog is missing readiness data");
    if (catalog.some((scenario) => scenario.sidebarReadiness?.dynamic)) {
      require(false, "Dynamic sidebar identities require admitted native history reconciliation");
      const binding = run.dynamicSidebar;
      require(binding &&
        typeof binding.path === "string" &&
        resolve(binding.path) === binding.path &&
        Number.isSafeInteger(binding.bytes) &&
        binding.bytes > 0 &&
        binding.bytes <= 4194304 &&
        /^[a-f0-9]{64}$/.test(binding.sha256) &&
        binding.commonFixtureSha256 === run.fixtureSha256 &&
        binding.profile?.sourceRevision === profile.sourceRevision &&
        binding.profile?.transport === profile.transport &&
        binding.condition === run.loadCondition &&
        binding.sourceProfile === (profile.transport === "legacy-get" ? "baseline-observer" : "candidate") &&
        typeof binding.campaignId === "string" &&
        binding.campaignId.length > 0 &&
        Number.isSafeInteger(binding.epochAt) &&
        binding.epochAt > 0 &&
        /^[a-f0-9]{64}$/.test(binding.nativeConfigSha256), "Dynamic sidebar runtime input binding is required");
    }
  } catch {
    require(false, "Prepared source expectations must select one exact valid revision");
  }
  const requiredCells = cellsFor(catalog, run.loadCondition).map((cell) => cell.id);
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
  const scenarios = new Map((run.catalog ?? []).map((scenario) => [scenario.id, scenario]));
  const scenarioByCell = new Map(
    cellsFor(run.catalog ?? [], run.loadCondition).map((cell) => [
      cell.id,
      { scenario: scenarios.get(cell.scenarioId), cache: cell.cache },
    ]),
  );
  for (const sample of samples) {
    const key = `${sample.cellId}:${sample.iteration}`;
    if (keys.has(key)) reasons.push(`Duplicate observation: ${key}`);
    keys.add(key);
    if (!required.includes(sample.cellId)) reasons.push(`Unexpected cell: ${sample.cellId}`);
    if (!Number.isInteger(sample.iteration) || sample.iteration < 0 || sample.iteration >= run.samplesPerCell)
      reasons.push(`Invalid observation index: ${key}`);
    if (sample.status === "pass" && (sample.errors?.length || sample.readiness?.passed !== true))
      reasons.push(`Missing readiness proof or browser errors: ${key}`);
    const cell = scenarioByCell.get(sample.cellId);
    const scenario = cell?.scenario;
    if (scenario && sample.scenarioId !== scenario.id)
      reasons.push(`Observation scenario differs from its cell: ${key}`);
    if (sample.status === "pass" && scenario?.sidebarReadiness?.dynamic) {
      if (!run.dynamicSidebar || sample.dynamicSidebarSha256 !== run.dynamicSidebar.sha256)
        reasons.push(`Dynamic sidebar sample input changed: ${key}`);
      const entries = [...(sample.preparation?.requests ?? []), ...(sample.requests ?? [])].filter(
        (entry) =>
          entry.sameOrigin &&
          entry.completed &&
          entry.status === 200 &&
          [
            "/api/sessions",
            "/api/contexts",
            "/api/session-navigation",
            "/api/session-navigation/page",
            "/api/session-navigation/resolve",
          ].includes(entry.path),
      );
      try {
        assert.ok(entries.length);
        for (const entry of entries)
          validateSidebarCapture(entry, {
            principalId: scenario.principalId,
            profile: { transport: scenario.sidebarReadiness.transport, sourceRevision: run.sourceRevision },
          });
        const selection = {
          principalId: scenario.principalId,
          profile: { transport: scenario.sidebarReadiness.transport, sourceRevision: run.sourceRevision },
          surface: scenario.sidebarReadiness.surface,
          finishedAt: sample.finishedAt,
        };
        assert.equal(sample.identity, scenario.principalId);
        assert.deepEqual(sample.errors, []);
        if (cell.cache === "warm" || INTERACTIVE_KINDS.has(scenario.kind)) assert.ok(sample.preparation);
        if (sample.preparation) {
          assert.equal(sample.preparation.identity, scenario.principalId);
          assert.deepEqual(sample.preparation.errors, []);
          assert.ok(sample.preparation.finishedAt <= sample.startedAt);
          validateSidebarDom(
            sample.preparation.sidebar,
            sample.preparation.requests.filter((entry) => entry.completed && entry.status === 200),
            { ...selection, finishedAt: sample.preparation.finishedAt },
          );
          assert.ok(sample.sidebar.generation > sample.preparation.sidebar.generation);
          assert.ok(sample.sidebar.version > sample.preparation.sidebar.version);
        }
        const current = (sample.requests ?? []).filter(
          (entry) => entry.sidebarCapture && entry.completed && entry.status === 200,
        );
        for (const entry of current) {
          assert.equal(entry.sidebarCapture.generation, sample.sidebar.generation);
          assert.ok(entry.responseAt >= sample.startedAt);
        }
        validateSidebarDom(sample.sidebar, INTERACTIVE_KINDS.has(scenario.kind) ? entries : current, selection);
      } catch {
        reasons.push(`Dynamic sidebar response or rendered evidence missing or mismatched: ${key}`);
      }
    }
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
