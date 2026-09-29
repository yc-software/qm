import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function retainSidebarProjection(projection, state, responseAt) {
  assert.equal(projection.qualified, false);
  assert.ok(Number.isSafeInteger(responseAt) && responseAt > 0, "Observed response time required");
  assert.ok(state.identities instanceof Map && Number.isSafeInteger(state.bytes) && state.bytes >= 0);
  assert.ok(bytes(projection) <= 4194304, "Projection exceeds the existing response bound");
  const additions = [];
  assert.ok(state.unresolvedSets === undefined || state.unresolvedSets instanceof Map);
  const observed = new Set();
  for (const row of projection.unresolved) {
    const key = JSON.stringify([
      projection.profile.sourceRevision,
      projection.profile.transport,
      projection.principalId,
      row.id,
    ]);
    assert.ok(!observed.has(key), "Duplicate identity in one projection");
    observed.add(key);
    const { identityMapping: _identityMapping, ...facts } = row;
    const previous = state.identities.get(key);
    if (previous) assert.deepEqual(facts, previous.facts, "Observed native identity changed between responses");
    if (!previous) additions.push({ key, facts: structuredClone(facts) });
  }
  const unresolvedSha256 = sha(projection.unresolved);
  const setKey = JSON.stringify([
    projection.profile.sourceRevision,
    projection.profile.transport,
    projection.principalId,
    unresolvedSha256,
  ]);
  const earlier = state.unresolvedSets?.get(setKey);
  const includeSet = earlier === undefined || responseAt < earlier;
  const retained = {
    ...projection,
    projectionSha256: sha(projection),
    sections: Object.fromEntries(
      Object.entries(projection.sections).map(([name, { rows, ...section }]) => [
        name,
        { ...section, count: rows.length, rowsSha256: sha(rows) },
      ]),
    ),
    references: projection.references.map(({ row, ...reference }) => ({
      ...reference,
      rowSha256: row === null ? null : sha(row),
    })),
    unresolvedCount: projection.unresolved.length,
    unresolvedSha256,
    unresolved: includeSet ? projection.unresolved : [],
  };
  if (projection.contexts) {
    delete retained.contexts;
    retained.contextsCount = projection.contexts.length;
    retained.contextsSha256 = sha(projection.contexts);
  }
  if (projection.startup) {
    const { latest, ...startup } = projection.startup;
    retained.startup = { ...startup, latestSha256: latest === null ? null : sha(latest) };
  }
  const output = structuredClone(retained);
  const retainedBytes = bytes(output);
  assert.ok(retainedBytes <= 4194304, "Retained response exceeds the existing response bound");
  assert.ok(state.bytes + retainedBytes <= 134217728, "Retained responses exceed the existing output reader bound");
  for (const { key, facts } of additions) state.identities.set(key, { facts });
  state.unresolvedSets ??= new Map();
  if (includeSet) state.unresolvedSets.set(setKey, responseAt);
  state.bytes += retainedBytes;
  return output;
}
