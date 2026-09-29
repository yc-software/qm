import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { retainSidebarProjection as retain } from "./sidebar-retention.mjs";

const retainSidebarProjection = (projection, state) => retain(projection, state, 200);
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const state = () => ({ identities: new Map(), bytes: 0 });
const identity = (id) => ({
  id,
  threadRef: `cron:job:fire:${id}`,
  threadRefSha256: "1".repeat(64),
  scopeId: "personal:actor",
  parentSessionId: null,
  createdAt: 100,
  type: "dm",
  surface: "core",
  archived: false,
  pinned: false,
  identityMapping: { kind: "unresolved-recurring", definitionId: "job", finiteOccurrenceBinding: "2".repeat(64) },
});
const model = () => ({
  schemaVersion: 1,
  qualified: false,
  principalId: "actor",
  profile: { sourceRevision: "a".repeat(40), transport: "legacy-get" },
  responseBodySha256: "3".repeat(64),
  bodyBytes: 333012,
  metadataSha256: "4".repeat(64),
  sections: {
    recent: {
      total: 2254,
      nextCursorSha256: null,
      boundary: null,
      rows: Array.from({ length: 2254 }, (_, i) => ({
        id: `s${i}`,
        scopeId: "personal:actor",
        at: 10000 - i,
        createdAt: 1,
        parentSessionId: null,
        type: "dm",
        surface: "web",
        archived: false,
        pinned: false,
        threadRefSha256: "a".repeat(64),
        titleSha256: "b".repeat(64),
        groupedTitleSha256: "c".repeat(64),
        identityMapping: { kind: "prepared", id: `s${i}` },
      })),
    },
  },
  references: [{ referenceHash: "5".repeat(64), id: "s0", row: { id: "s0" } }],
  contexts: [{ scopeId: "personal:actor", identitySha256: "6".repeat(64), fallbackActivity: 100, sessionCount: 2254 }],
  startup: { latestId: "s0", latest: { id: "s0" }, hasSessions: true },
  unresolved: [identity("000000000001"), identity("000000000002")],
  missing: ["Native response identity/workload reconciliation required"],
});

test("compact retention covers complete projections and preserves every new native identity without repetition", () => {
  const full = model();
  const before = structuredClone(full);
  const ledger = state();
  const first = retainSidebarProjection(full, ledger);
  assert.deepEqual(full, before);
  assert.deepEqual(first.unresolved, full.unresolved);
  assert.equal(first.projectionSha256, sha(full));
  assert.equal(first.sections.recent.rowsSha256, sha(full.sections.recent.rows));
  assert.equal(first.sections.recent.count, 2254);
  assert.equal(first.sections.recent.rows, undefined);
  assert.equal(first.references[0].row, undefined);
  assert.equal(first.references[0].rowSha256, sha(full.references[0].row));
  assert.equal(first.contexts, undefined);
  assert.equal(first.contextsSha256, sha(full.contexts));
  assert.equal(first.startup.latest, undefined);
  assert.equal(first.startup.latestSha256, sha(full.startup.latest));
  assert.deepEqual(first.missing, full.missing);
  const repeat = retainSidebarProjection(full, ledger);
  assert.deepEqual(repeat.unresolved, []);
  assert.equal(repeat.unresolvedCount, 2);
  assert.equal(repeat.unresolvedSha256, sha(full.unresolved));
  assert.equal(repeat.qualified, false);
  assert.equal(ledger.identities.size, 2);
  const independentViewer = { ...full, principalId: "other" };
  assert.equal(retainSidebarProjection(independentViewer, ledger).unresolved.length, 2);
  const nextProfile = { ...full, profile: { ...full.profile, sourceRevision: "b".repeat(40) } };
  assert.equal(retainSidebarProjection(nextProfile, ledger).unresolved.length, 2);
  for (const key of [
    "threadRef",
    "threadRefSha256",
    "scopeId",
    "parentSessionId",
    "createdAt",
    "type",
    "surface",
    "pinned",
    "archived",
  ]) {
    const changed = structuredClone(full);
    let value = "changed";
    if (key === "createdAt") value = 101;
    if (key === "pinned" || key === "archived") value = true;
    changed.unresolved[0][key] = value;
    const oldBytes = ledger.bytes;
    assert.throws(() => retainSidebarProjection(changed, ledger), /identity changed/);
    assert.equal(ledger.bytes, oldBytes);
  }
  const changedMapping = structuredClone(full);
  changedMapping.unresolved[0].identityMapping = {
    kind: "unsupported-descendant",
    reason: "No unique observed admitted ancestry",
    declaredDefinitions: [],
  };
  assert.deepEqual(retainSidebarProjection(changedMapping, ledger).unresolved, changedMapping.unresolved);
  const atomic = structuredClone(full);
  atomic.unresolved.unshift(identity("000000000003"));
  atomic.unresolved[1].scopeId = "changed";
  const ledgerBefore = structuredClone(ledger);
  assert.throws(() => retainSidebarProjection(atomic, ledger));
  assert.deepEqual(ledger, ledgerBefore);
  const duplicate = structuredClone(full);
  duplicate.unresolved.push(duplicate.unresolved[0]);
  assert.throws(() => retainSidebarProjection(duplicate, ledger), /Duplicate identity/);
  const exhausted = { identities: new Map(), bytes: 134217728 };
  assert.throws(() => retainSidebarProjection(full, exhausted), /output reader bound/);
  assert.equal(exhausted.identities.size, 0);
  assert.equal(exhausted.bytes, 134217728);
  assert.throws(() => retainSidebarProjection({ ...full, extra: "x".repeat(4194304) }, state()), /response bound/);
  const outputBefore = structuredClone(first);
  full.profile.sourceRevision = "c".repeat(40);
  full.missing.push("mutated input");
  full.sections.recent.boundary = { at: 1, id: "x" };
  full.references[0].referenceHash = "7".repeat(64);
  assert.deepEqual(first, outputBefore);
  first.profile.sourceRevision = "d".repeat(40);
  first.missing.push("mutated output");
  assert.equal(full.profile.sourceRevision, "c".repeat(40));
  assert.deepEqual(full.missing, [...before.missing, "mutated input"]);
  const outOfOrder = state();
  assert.equal(retain(before, outOfOrder, 200).unresolved.length, 2);
  assert.equal(retain(before, outOfOrder, 300).unresolved.length, 0);
  assert.equal(retain(before, outOfOrder, 100).unresolved.length, 2);
  assert.equal(retain(before, outOfOrder, 150).unresolved.length, 0);
  assert.equal(retain(before, outOfOrder, 100).unresolved.length, 0);
  for (const time of [undefined, null, 0, -1, 1.5, Infinity, NaN])
    assert.throws(() => retain(before, state(), time), /response time/);
  first.unresolved[0].scopeId = "mutated caller output";
  assert.doesNotThrow(() => retainSidebarProjection(before, ledger));
  const fullBytes = Buffer.byteLength(JSON.stringify(before));
  const firstBytes = Buffer.byteLength(JSON.stringify(outputBefore));
  const repeatBytes = Buffer.byteLength(JSON.stringify(repeat));
  assert.ok(repeatBytes * 31 * 109 * 2 < 134217728);
  console.log(
    JSON.stringify({
      modeledRows: 2254,
      fullBytes,
      firstBytes,
      repeatBytes,
      twoResponsesPerCellRunEstimate: firstBytes + repeatBytes * (31 * 109 * 2 - 1),
      excludesOtherSampleEvidence: true,
    }),
  );
});

test("each complete membership set retains a complete first witness and its earliest header", () => {
  const full = model(),
    ledger = state();
  const first = retain(full, ledger, 100);
  assert.equal(first.unresolved.length, first.unresolvedCount);
  const subset = { ...full, unresolved: full.unresolved.slice(0, 1) };
  assert.deepEqual(retain(subset, ledger, 200).unresolved, subset.unresolved);
  assert.deepEqual(retain(subset, ledger, 300).unresolved, []);
  const reverse = { ...full, unresolved: [...full.unresolved].reverse() };
  assert.deepEqual(retain(reverse, ledger, 400).unresolved, reverse.unresolved);
  const later = retain(full, ledger, 500);
  assert.deepEqual(later.unresolved, []);
  assert.equal(later.unresolvedSha256, sha(first.unresolved));
  assert.deepEqual(retain(full, ledger, 50).unresolved, full.unresolved);
  assert.deepEqual(retain(full, ledger, 60).unresolved, []);
  const other = { ...full, principalId: "different" };
  assert.deepEqual(retain(other, ledger, 200).unresolved, other.unresolved);
  const exhausted = { identities: new Map(), bytes: 134217728 };
  assert.throws(() => retain(full, exhausted, 100));
  assert.equal(exhausted.unresolvedSets, undefined);
});
