import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { navigationIntent, readDynamicSidebar, sidebarRequirements, validateSidebarEvidence } from "./run.mjs";
import { buildCatalog, cellsFor } from "./catalog.mjs";
import { sha256, validateQualification, verifyRun } from "./verify.mjs";

function model(directory) {
  const profiles = [
    { transport: "legacy-get", sourceRevision: "a".repeat(40) },
    { transport: "navigation-post", sourceRevision: "b".repeat(40) },
  ];
  const actor = {
    surface: "web",
    preparedWeb: [],
    preparedOffPageWeb: [],
    contexts: [],
    groups: { dynamicOrderScopes: ["empty"] },
  };
  const fixture = {
    cases: { short: { principalId: "actor", sessionId: "known" }, slack: { principalId: "actor", sessionId: "slack" } },
    viewReadinessBySource: profiles.map((profile) => ({
      profile,
      browser: { rootSidebarCases: {}, sidebarReadiness: { schemaVersion: 1, ...profile, actors: { actor } } },
      views: {},
      sidebarPagination: null,
      viewReadinessEvidence: {},
    })),
  };
  const fixtureRaw = Buffer.from(JSON.stringify(fixture));
  const fixturePath = join(directory, "fixture.json"),
    path = join(directory, "dynamic.json");
  const profile = profiles[1];
  const data = {
    schemaVersion: 1,
    qualified: false,
    commonFixture: { path: fixturePath, bytes: fixtureRaw.length, sha256: sha256(fixtureRaw) },
    profile,
    campaignId: "modeled-campaign",
    sourceProfile: "candidate",
    condition: "normal",
    epochAt: 100,
    evidence: Object.fromEntries(
      ["histories", "nativeConfig", "observations", "preparation", "slots", "snapshot"].map((role) => [
        role,
        { path: join(directory, role), bytes: 1, sha256: "c".repeat(64) },
      ]),
    ),
    actors: { actor: { preparedNonWeb: [], allowedOffPageRows: [], contexts: [], recurring: [], scopePolicy: [] } },
    missing: ["browser.sidebarReadiness.dynamic: response and native reconciliation required"],
  };
  writeFileSync(fixturePath, fixtureRaw);
  const write = (value = data) => writeFileSync(path, JSON.stringify(value));
  const read = () => readDynamicSidebar(path, fixtureRaw, profile, "normal", fixturePath);
  write();
  return { profiles, profile, fixture, fixtureRaw, fixturePath, data, path, read, write };
}

test("runtime sidebar data joins exact common bytes/source/condition and cannot claim qualification", () => {
  const directory = mkdtempSync(join(tmpdir(), "qm-sidebar-input-"));
  try {
    const value = model(directory),
      accepted = value.read();
    assert.equal(accepted.binding.sha256, sha256(JSON.stringify(value.data)));
    assert.equal(accepted.binding.commonFixtureSha256, sha256(value.fixtureRaw));
    assert.ok(accepted.retention.identities instanceof Map);
    for (const mutate of [
      (data) => data.schemaVersion++,
      (data) => (data.qualified = true),
      (data) => (data.commonFixture.sha256 = "d".repeat(64)),
      (data) => data.commonFixture.bytes++,
      (data) => (data.commonFixture.path += ".other"),
      (data) => (data.profile = value.profiles[0]),
      (data) => (data.condition = "peak"),
      (data) => (data.sourceProfile = "baseline-observer"),
      (data) => (data.campaignId = ""),
      (data) => (data.epochAt = 0),
      (data) => (data.missing = []),
      (data) => delete data.evidence.histories,
      (data) => (data.evidence.nativeConfig.sha256 = "wrong"),
      (data) => (data.evidence.observations.bytes = 134217729),
      (data) => (data.actors.foreign = data.actors.actor),
      (data) => delete data.actors.actor.recurring,
    ]) {
      const changed = structuredClone(value.data);
      mutate(changed);
      value.write(changed);
      assert.throws(value.read);
    }
    for (const raw of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from("{}"), Buffer.alloc(4194305)]) {
      writeFileSync(value.path, raw);
      assert.throws(value.read);
    }
    for (const [role, limit] of [
      ["observations", 134217728],
      ["snapshot", 33554432],
      ["slots", 4194304],
    ]) {
      const valid = structuredClone(value.data);
      valid.evidence[role].bytes = limit;
      value.write(valid);
      value.read();
      valid.evidence[role].bytes++;
      value.write(valid);
      assert.throws(value.read);
    }
    value.write();
    const link = join(directory, "linked.json");
    symlinkSync(value.path, link);
    assert.throws(() => readDynamicSidebar(link, value.fixtureRaw, value.profile, "normal", value.fixturePath));
    assert.equal(value.read().retention.bytes, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("paired catalogs require dynamic evidence without consuming per-run data or changing coverage", () => {
  const directory = mkdtempSync(join(tmpdir(), "qm-sidebar-catalog-"));
  try {
    const value = model(directory),
      original = JSON.stringify(value.fixture);
    for (const profile of value.profiles) {
      const catalog = buildCatalog(value.fixture, profile.sourceRevision);
      assert.equal(catalog.length, 60);
      assert.equal(cellsFor(catalog, "normal").length, 109);
      for (const id of ["web.chat.short", "web.chat.slack"]) {
        const scenario = catalog.find((entry) => entry.id === id);
        assert.equal(scenario.sidebarReadiness.dynamic, true);
        assert.equal(scenario.sidebarReadiness.surface, id.endsWith("slack") ? "all" : "web");
        assert.ok(!scenario.missing.some((reason) => reason.includes("dynamic")));
        assert.ok(sidebarRequirements(scenario.sidebarReadiness).every((requirement) => requirement.captureSidebar));
      }
      const reasons = validateQualification(
        { sourceRevision: profile.sourceRevision, sidebarProfile: profile, catalog },
        value.fixture,
      );
      assert.ok(reasons.includes("Dynamic sidebar identities require admitted native history reconciliation"));
      assert.ok(reasons.includes("Dynamic sidebar runtime input binding is required"));
    }
    assert.equal(JSON.stringify(value.fixture), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dynamic response verification rejects dropped bodies, wrong inputs and scenario relabeling", () => {
  const scenario = {
    id: "web.chat.short",
    principalId: "actor",
    modes: ["cold"],
    sidebarReadiness: { dynamic: true, transport: "navigation-post", sourceRevision: "b".repeat(40), surface: "web" },
  };
  const bodySha256 = "d".repeat(64),
    intentSha256 = "e".repeat(64);
  const entry = {
    method: "POST",
    sameOrigin: true,
    completed: true,
    status: 200,
    path: "/api/session-navigation",
    responseAt: 110,
    navigation: navigationIntent("/api/session-navigation", JSON.stringify({ surface: "web", references: [] })),
    responseBodyBytes: 100,
    responseBodySha256: bodySha256,
    sidebarCapture: {
      generation: 1,
      sequence: 1,
      role: "navigation-refresh",
      referencesPresent: true,
      cursorSha256: null,
      chains: ["recent", "pinned", "groups"].map((section) => ({
        section,
        keySha256: "c".repeat(64),
        chainSequence: 1,
      })),
      requestIntentSha256: intentSha256,
    },
    sidebarProjection: {
      schemaVersion: 1,
      metadataSha256: "a".repeat(64),
      projectionSha256: "a".repeat(64),
      qualified: false,
      principalId: "actor",
      profile: { transport: "navigation-post", sourceRevision: "b".repeat(40) },
      responseBodySha256: bodySha256,
      bodyBytes: 100,
      sections: Object.fromEntries(
        ["recent", "pinned", "groups"].map((section) => [section, { count: 0, total: 0, nextCursorSha256: null }]),
      ),
      archivedCount: 0,
      references: [],
      missing: [],
      requestIntentSha256: intentSha256,
    },
  };
  const run = {
    runId: "modeled",
    mode: "diagnostic",
    sourceRevision: "b".repeat(40),
    loadCondition: "normal",
    catalog: [scenario],
    samplesPerCell: 1,
    requiredCells: ["web.chat.short:cold:normal"],
    measurementStartedAt: 100,
    measurementFinishedAt: 200,
    dynamicSidebar: { sha256: "f".repeat(64) },
  };
  const sample = {
    cellId: run.requiredCells[0],
    scenarioId: scenario.id,
    iteration: 0,
    status: "pass",
    startedAt: 100,
    finishedAt: 200,
    durationMs: 100,
    readiness: { passed: true },
    errors: [],
    identity: "actor",
    requests: [entry],
    dynamicSidebarSha256: run.dynamicSidebar.sha256,
    sidebar: {
      schemaVersion: 1,
      qualified: false,
      principalId: "actor",
      profile: entry.sidebarProjection.profile,
      surface: "web",
      generation: 1,
      version: 1,
      expectedSha256: "d".repeat(64),
      sectionSources: Object.fromEntries(
        ["recent", "pinned", "groups", "archived"].map((section) => [
          section,
          section === "archived"
            ? []
            : [
                {
                  generation: 1,
                  sequence: 1,
                  role: "navigation-refresh",
                  responseAt: 110,
                  responseBodySha256: bodySha256,
                  projectionSha256: "a".repeat(64),
                  requestIntentSha256: intentSha256,
                  section,
                  keySha256: "c".repeat(64),
                  chainSequence: 1,
                },
              ],
        ]),
      ),
      groupPageSources: [],
      referenceSources: [],
      entitySources: [],
      contextSource: null,
      legacyProjectionSha256: null,
      dom: {
        ...Object.fromEntries(
          ["recent", "pinned", "archived", "groups"].map((section) => [
            section,
            {
              count: 0,
              [section === "groups" ? "scopeIdsSha256" : "idsSha256"]: "d".repeat(64),
              rowsSha256: "d".repeat(64),
            },
          ]),
        ),
        totals: { recent: 0, pinned: 0, groups: 0 },
        loaded: { recent: 0, pinned: 0, groups: 0 },
        more: { recent: false, pinned: false, groups: false, archived: false },
        topLevelSha256: "d".repeat(64),
        archivedOpen: false,
        archivedCount: 0,
      },
      missing: ["Dynamic sidebar identities require admitted native history reconciliation"],
    },
  };
  assert.deepEqual(verifyRun(run, [sample], {}).structuralReasons, []);
  validateSidebarEvidence(sample, scenario.sidebarReadiness);
  for (const mutate of [
    (value) => {
      delete value.requests[0].sidebarCapture;
      delete value.requests[0].sidebarProjection.requestIntentSha256;
    },
    (value) => {
      value.requests[0].sidebarCapture.requestIntentSha256 = "malformed";
      value.requests[0].sidebarProjection.requestIntentSha256 = "malformed";
    },
    (value) => delete value.requests[0].navigation,
    (value) => delete value.requests[0].navigation.surface,
    (value) => (value.requests[0].navigation.surface = "foreign"),
    (value) => (value.requests[0].navigation.references = [{ kind: "id", valueSha256: "bad" }]),
    (value) => (value.requests[0].navigation.cursorSha256 = "a".repeat(64)),
    (value) => (value.requests[0].sidebarCapture.role = "navigation-section"),
    (value) => delete value.requests[0].sidebarProjection.projectionSha256,
    (value) => delete value.requests[0].sidebarProjection.metadataSha256,
    (value) => {
      value.requests[0].sidebarCapture.sequence = 0;
    },
    (value) => delete value.sidebar,
    (value) => delete value.sidebar.sectionSources.recent,
    (value) => value.sidebar.sectionSources.recent[0].responseAt++,
    (value) => delete value.dynamicSidebarSha256,
    (value) => (value.dynamicSidebarSha256 = "0".repeat(64)),
    (value) => (value.scenarioId = "admin.settings"),
    (value) => (value.requests = []),
    (value) => delete value.requests[0].sidebarProjection,
    (value) => (value.requests[0].responseAt = 0),
    (value) => (value.requests[0].responseBodySha256 = "0".repeat(64)),
    (value) => value.requests[0].sidebarProjection.bodyBytes++,
    (value) => (value.requests[0].sidebarProjection.principalId = "foreign"),
    (value) => (value.requests[0].sidebarProjection.qualified = true),
    (value) => (value.requests[0].sidebarCapture.requestIntentSha256 = "0".repeat(64)),
  ]) {
    const changed = structuredClone(sample);
    mutate(changed);
    assert.ok(verifyRun(run, [changed], {}).structuralReasons.length);
  }
  for (const invalid of [undefined, null, "malformed", "A".repeat(64)]) {
    const changed = structuredClone(sample);
    changed.requests[0].sidebarCapture.requestIntentSha256 = invalid;
    changed.requests[0].sidebarProjection.requestIntentSha256 = invalid;
    assert.throws(() => validateSidebarEvidence(changed, scenario.sidebarReadiness));
    assert.ok(verifyRun(run, [changed], {}).structuralReasons.length);
  }
  const fallback = structuredClone(sample);
  fallback.requests[0].path = "/api/sessions";
  assert.throws(() => validateSidebarEvidence(fallback, scenario.sidebarReadiness));
});
