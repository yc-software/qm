import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, cellsFor, CALENDAR_EXCLUSION, validateSidebarProfile } from "./catalog.mjs";
import { sha256 } from "./verify.mjs";
import { sidebarFormatter, sidebarSurface } from "./sidebar-format.mjs";

const compareIdentity = (a, b) => (a < b ? -1 : Number(a !== b));

function retainedSidebarArtifact({ raw, descriptor }, cap) {
  assert.ok(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= cap, "Bounded actual retained bytes required");
  assert.equal(typeof descriptor.path, "string");
  assert.equal(resolve(descriptor.path), descriptor.path);
  assert.equal(sha256(raw), descriptor.sha256);
  if (descriptor.bytes !== undefined) assert.equal(descriptor.bytes, raw.length);
  return {
    descriptor: { path: descriptor.path, bytes: raw.length, sha256: descriptor.sha256 },
    data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
  };
}

function dynamicSidebarInputs(fixture, observations, profile, input) {
  assert.deepEqual(Object.keys(input.artifacts).sort(), [
    "histories",
    "nativeConfig",
    "observations",
    "preparation",
    "slots",
    "snapshot",
  ]);
  assert.deepEqual(input.profile, profile, "Exact dynamic source selection required");
  assert.equal(input.sourceProfiles.length, 2);
  input.sourceProfiles.forEach(validateSidebarProfile);
  assert.equal(new Set(input.sourceProfiles.map((row) => row.transport)).size, 2);
  assert.equal(new Set(input.sourceProfiles.map((row) => row.sourceRevision)).size, 2);
  assert.equal(
    input.sourceProfiles.filter(
      (row) => row.transport === profile.transport && row.sourceRevision === profile.sourceRevision,
    ).length,
    1,
  );
  const one = (rows) => {
    assert.equal(rows.length, 1, "One exact prepared identity required");
    return rows[0];
  };
  const unique = (rows, key) => assert.equal(new Set(rows.map((row) => row[key])).size, rows.length);
  const evidence = {};
  const read = (name, cap) => {
    const { descriptor, data } = retainedSidebarArtifact(input.artifacts[name], cap);
    evidence[name] = descriptor;
    return data;
  };
  const native = read("nativeConfig", 4194304);
  const preparation = read("preparation", 4194304);
  const snapshot = read("snapshot", 33554432);
  const slots = read("slots", 4194304);
  const histories = read("histories", 134217728);
  assert.deepEqual(read("observations", 134217728), observations, "Observed actor data changed");
  assert.equal(native.fixture.fixtureId, fixture.fixtureId);
  assert.match(fixture.profileSha256, /^[a-f0-9]{64}$/);
  assert.equal(native.fixture.profileSha256, fixture.profileSha256);
  assert.ok(typeof native.campaignId === "string" && native.campaignId);
  assert.ok(Number.isSafeInteger(native.recurrence.epochAt) && native.recurrence.epochAt > 0);
  assert.equal(native.sourceProfile, profile.transport === "legacy-get" ? "baseline-observer" : "candidate");
  assert.equal(native.recurrence.receiptSourceBindings.publicRevision, profile.sourceRevision);
  for (const key of ["helperSourceSha256", "verifierSha256"])
    assert.match(native.recurrence.receiptSourceBindings[key], /^[a-f0-9]{64}$/);
  assert.ok(["normal", "peak"].includes(native.schedule.condition));
  assert.equal(native.schedule.fixtureId, fixture.fixtureId);
  assert.equal(native.schedule.profileSha256, fixture.profileSha256);
  assert.equal(preparation.pressureAt, native.recurrence.epochAt + 120000);
  for (const name of ["preparation", "snapshot", "slots"])
    one(
      native.sourceBindings.filter((row) => row.path === evidence[name].path && row.sha256 === evidence[name].sha256),
    );
  for (const value of [snapshot, slots]) {
    assert.equal(value.fixtureId, fixture.fixtureId);
    assert.equal(value.profileSha256, fixture.profileSha256);
  }
  assert.equal(snapshot.payloadRepairPlanSha256, native.fixture.payloadRepair.planSha256);
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.directoryMembers.length, 213);
  unique(snapshot.directoryMembers, "principal_id");
  assert.equal(slots.definitions.length, 111);
  assert.equal(slots.loops.length, 5);
  const expected = [...slots.definitions, ...slots.loops];
  unique(expected, "fixtureCronId");
  assert.deepEqual(
    preparation.prepared.crons.map((row) => row.id).sort(),
    expected.map((row) => row.fixtureCronId).sort(),
  );
  assert.deepEqual(
    preparation.prepared.loops.map((row) => row.id).sort(),
    slots.loops.map((row) => row.fixtureLoopId).sort(),
  );
  assert.deepEqual(
    preparation.policies.map((row) => row.cronId).sort(),
    expected.map((row) => row.fixtureCronId).sort(),
  );
  assert.deepEqual(
    preparation.cadences.map((row) => row.cronId).sort(),
    expected.map((row) => row.fixtureCronId).sort(),
  );
  assert.ok(preparation.cadences.every((row) => typeof row.conditionActive === "boolean"));
  assert.deepEqual(
    native.recurrence.definitions.map((row) => row.definition.cron.id).sort(),
    preparation.cadences
      .filter((row) => row.conditionActive)
      .map((row) => row.cronId)
      .sort(),
    "Complete native active definition set required",
  );
  const definitions = new Map();
  for (const slot of expected) {
    const cron = one(preparation.prepared.crons.filter((row) => row.id === slot.fixtureCronId)).json;
    const policy = one(preparation.policies.filter((row) => row.cronId === cron.id));
    assert.deepEqual(
      one(snapshot.tables.crons.filter((row) => row.id === cron.id)).json,
      cron,
      "Prepared cron needs actual complete readback",
    );
    assert.equal(cron.id, slot.fixtureCronId);
    assert.equal(cron.owner, slot.fixturePrincipalId);
    assert.equal(cron.ownerScopeId, slot.fixtureScopeId);
    assert.equal(cron.enabled, false);
    assert.equal(cron.archived, false);
    assert.equal(cron.destination, undefined);
    assert.equal(cron.message, undefined);
    assert.equal(policy.principalId, cron.owner);
    assert.equal(policy.scopeId, cron.ownerScopeId);
    assert.equal(policy.runAs, cron.runAs ?? "owner");
    assert.ok(["owner", "scopeFloor", "scopeShared"].includes(policy.runAs));
    const [kind, ...parts] = policy.scopeId.split(":");
    const ref = parts.join(":");
    let members;
    if (kind === "personal") {
      assert.equal(ref, cron.owner);
      members = [ref];
    } else {
      assert.ok(["channel", "group"].includes(kind), "Unproven current scope membership");
      const shared = snapshot.shared[kind];
      assert.equal(one(shared.records.filter((row) => row[`${kind}_id`] === ref)).roster_known, true);
      members = shared.roster.filter((row) => row[`${kind}_id`] === ref).map((row) => row.principal_id);
      assert.equal(new Set(members).size, members.length);
      members = members.filter(
        (id) => one(snapshot.directoryMembers.filter((row) => row.principal_id === id)).type === "internal",
      );
    }
    assert.deepEqual(
      policy.currentMembers.map((row) => row.id).sort(),
      [...members].sort(),
      "Actual audience differs from prepared policy",
    );
    assert.ok(
      members.every(
        (id) => one(snapshot.directoryMembers.filter((row) => row.principal_id === id)).type === "internal",
      ),
    );
    assert.ok(policy.currentMembers.every((row) => row.type === "internal"));
    assert.equal(
      policy.effectiveActorId,
      policy.runAs === "scopeFloor" && !members.includes(cron.owner) ? members[0] : cron.owner,
    );
    assert.ok(members.includes(policy.effectiveActorId));
    if (policy.runAs === "scopeShared") assert.ok(members.includes(cron.owner));
    assert.deepEqual(cron.members, policy.currentMembers);
    if (slot.fixtureLoopId) {
      const loop = one(preparation.prepared.loops.filter((row) => row.id === slot.fixtureLoopId)).json;
      assert.deepEqual(one(snapshot.tables.loops.filter((row) => row.id === loop.id)).json, loop);
      assert.equal(loop.id, cron.loopId);
      assert.equal(loop.cronId, cron.id);
      assert.equal(loop.owner, cron.owner);
      assert.equal(loop.ownerScopeId, policy.scopeId);
      assert.equal(loop.runAs ?? "owner", policy.runAs);
      assert.deepEqual(loop.members, policy.currentMembers);
      assert.equal(loop.destination, undefined);
      assert.equal(loop.message, undefined);
      assert.equal(loop.enabled, false);
      assert.equal(loop.state, "paused");
    } else assert.equal(cron.loopId, undefined);
    definitions.set(cron.id, {
      cron,
      slot,
      policy,
      audience: policy.runAs === "owner" ? [policy.effectiveActorId] : members,
    });
  }
  assert.equal(histories.phase, "before");
  assert.equal(histories.readOnly, true);
  assert.equal(histories.campaignId, native.campaignId);
  assert.equal(histories.sourceProfile, native.sourceProfile);
  assert.equal(histories.nativeConfigSha256, evidence.nativeConfig.sha256);
  assert.equal(histories.fixtureManifestSha256, sha256(JSON.stringify(native.fixture)));
  assert.ok(Number.isSafeInteger(histories.finishedAt) && histories.finishedAt <= native.recurrence.epochAt);
  assert.ok(
    Number.isSafeInteger(histories.startedAt) &&
      histories.startedAt <= histories.finishedAt &&
      histories.finishedAt - histories.startedAt <= 30000,
  );
  assert.ok(Number.isSafeInteger(observations.at) && observations.at <= native.recurrence.epochAt);
  assert.ok(observations.rows.length <= 512);
  assert.ok(observations.rows.every((row) => Buffer.byteLength(JSON.stringify(row.data)) <= 4194304));
  unique(
    histories.sessions.map((row) => row.session),
    "id",
  );
  unique(
    histories.sessions.map((row) => row.session),
    "thread_ref",
  );
  const history = (threadRef, sessionId) =>
    one(
      histories.sessions.filter(
        (row) => row.session.thread_ref === threadRef && (!sessionId || row.session.id === sessionId),
      ),
    );
  const writes = [];
  const write = (scopeId, origin) => {
    assert.ok(typeof scopeId === "string" && scopeId);
    writes.push({ scopeId, ...origin });
  };
  for (const { cron } of definitions.values()) write(cron.ownerScopeId, { kind: "definition", id: cron.id });
  assert.deepEqual(Object.keys(native.bindings.turns).sort(), native.schedule.turns.map((row) => row.id).sort());
  for (const turn of native.schedule.turns.filter((row) => ["web", "slack"].includes(row.source))) {
    const binding = native.bindings.turns[turn.id];
    const threadRef = turn.source === "web" ? binding.history.threadRef : `dm:${binding.slack.channelId}`;
    const row = history(threadRef, turn.source === "web" ? binding.history.sessionId : undefined);
    assert.equal(row.session.scope_id, `personal:${turn.principalId}`);
    assert.ok(row.participants.some((member) => member.principal_id === turn.principalId && member.valid_to === null));
    write(row.session.scope_id, {
      kind: "direct",
      id: turn.id,
      sessionId: row.session.id,
      threadRef,
    });
  }
  const recurring = [];
  unique(native.recurrence.definitions, "id");
  for (const row of native.recurrence.definitions) {
    const bound = definitions.get(row.definition.cron.id);
    assert.ok(bound, "Native definition outside complete prepared identity set");
    assert.deepEqual(row.definition.cron, bound.cron);
    for (const key of ["principalId", "effectiveActorId", "scopeId", "runAs", "currentMembers"])
      assert.deepEqual(row[key], bound.policy[key]);
    assert.equal(row.source, bound.slot.fixtureLoopId ? "loop" : "cron");
    if (row.source === "loop") assert.equal(row.effectiveActorId, row.principalId);
    if (row.source === "loop")
      assert.deepEqual(
        row.definition.loop,
        one(preparation.prepared.loops.filter((loop) => loop.id === bound.slot.fixtureLoopId)).json,
      );
    assert.match(row.preparationReceiptSha256, /^[a-f0-9]{64}$/);
    one(native.sourceBindings.filter((binding) => binding.sha256 === row.preparationReceiptSha256));
    assert.ok(Number.isSafeInteger(row.maxFires) && row.maxFires > 0 && row.maxFires <= 1000);
    assert.ok(row.occurrences.length >= row.maxFires && row.occurrences.length <= row.maxFires + 1);
    unique(row.occurrences, "id");
    const children = [];
    for (const [index, occurrence] of row.occurrences.entries()) {
      assert.equal(occurrence.index, index);
      for (const child of occurrence.children) {
        const stage = occurrence.stages[child.parentStageIndex];
        const shape = one(native.companion.nativeShapes.filter((shape) => shape.name === stage.shape));
        const operation = shape.operations[child.operationIndex];
        assert.ok(["session-open", "session-followup"].includes(operation.kind));
        assert.equal(operation.shape, child.shape);
        const openIndex = operation.kind === "session-open" ? child.operationIndex : operation.openOperation;
        const open = shape.operations[openIndex];
        assert.equal(open.kind, "session-open");
        assert.deepEqual(Object.keys(open).sort(), ["kind", "model", "name", "shape"]);
        children.push({
          occurrenceId: occurrence.id,
          parentStageIndex: child.parentStageIndex,
          operationIndex: child.operationIndex,
          openOperationIndex: openIndex,
          scopeId: row.scopeId,
        });
        write(row.scopeId, {
          kind: "descendant",
          id: row.id,
          occurrenceId: occurrence.id,
          operationIndex: child.operationIndex,
        });
      }
    }
    const origins = row.mechanism === "approved-keychain-ask" ? row.approvedAsk.preparation.origins : [];
    if (row.mechanism === "approved-keychain-ask") {
      assert.equal(native.schedule.condition, "peak");
      assert.equal(origins.length, row.maxFires);
    }
    for (const origin of origins) {
      const actual = history(origin.threadRef, origin.sessionId);
      assert.equal(actual.session.scope_id, row.scopeId);
      assert.deepEqual(actual.participants, origin.participants);
      assert.equal(sha256(JSON.stringify(origin.participants)), origin.participantsSha256);
      assert.equal(one(histories.runs.filter((run) => run.id === origin.runId)).session_id, origin.threadRef);
      write(actual.session.scope_id, {
        kind: "approved-ask",
        id: row.id,
        sessionId: origin.sessionId,
        threadRef: origin.threadRef,
      });
    }
    recurring.push({
      definitionId: row.id,
      cronId: bound.cron.id,
      ...(bound.slot.fixtureLoopId ? { loopId: bound.slot.fixtureLoopId } : {}),
      effectiveActorId: row.effectiveActorId,
      scopeId: row.scopeId,
      audience: bound.audience,
      audienceEvidence: evidence.snapshot,
      preparationReceiptSha256: row.preparationReceiptSha256,
      permittedThreadFamily: origins.length ? null : `${row.source}:${bound.slot.fixtureLoopId ?? bound.cron.id}:fire:`,
      finiteOccurrenceBinding: sha256(JSON.stringify(row.occurrences)),
      origins: origins.map((origin) => ({
        sessionId: origin.sessionId,
        threadRef: origin.threadRef,
      })),
      children,
    });
  }
  return {
    evidence,
    native,
    preparation,
    snapshot,
    slots,
    histories,
    writes,
    recurring,
  };
}

function sidebarReadiness(fixture, observations, profile, dynamic) {
  validateSidebarProfile(profile);
  assert.equal(observations.fixtureId, fixture.fixtureId);
  const catalog = buildCatalog(fixture, profile.sourceRevision).filter((row) => !row.admin);
  const actors = Object.create(null);
  for (const principalId of new Set(catalog.map((row) => row.principalId).filter(Boolean))) {
    const evidence = {};
    const read = (path, name) => {
      const rows = (observations.rows ?? []).filter(
        (row) =>
          row.path === path &&
          (row.principalId ?? fixture.adminPrincipalId ?? fixture.browser?.adminPrincipalId) === principalId,
      );
      assert.equal(rows.length, 1, `One sidebar observation required: ${principalId} ${path}`);
      const row = rows[0];
      assert.equal(row.status, 200);
      evidence[name] = { path, principalId, status: 200, sha256: sha256(JSON.stringify(row.data)) };
      return row.data;
    };
    assert.equal(read("/me", "me").user, principalId);
    const sessions = read("/api/sessions", "sessions").sessions;
    const contexts = read("/api/contexts", "contexts").contexts;
    assert.ok(Array.isArray(sessions) && Array.isArray(contexts));
    for (const row of sessions) {
      for (const field of ["id", "threadRef", "scopeId"]) assert.ok(typeof row[field] === "string" && row[field]);
      assert.ok(
        Number.isFinite(row.createdAt) && (row.lastActivityAt === undefined || Number.isFinite(row.lastActivityAt)),
      );
      assert.ok(row.title == null || typeof row.title === "string");
      for (const field of ["archived", "pinned"])
        assert.ok(row[field] === undefined || typeof row[field] === "boolean");
    }
    assert.equal(new Set(sessions.map((row) => row.id)).size, sessions.length);
    assert.equal(new Set(sessions.map((row) => row.threadRef)).size, sessions.length);
    assert.equal(new Set(contexts.map((row) => row.scopeId)).size, contexts.length);
    for (const row of contexts) {
      assert.ok(typeof row.scopeId === "string" && row.scopeId);
      assert.ok(["personal", "channel", "group"].includes(row.kind));
      assert.ok(row.name == null || typeof row.name === "string");
      assert.ok(row.lastActivityAt == null || Number.isFinite(row.lastActivityAt));
      if (row.project) {
        assert.equal(typeof row.project.name, "string");
        assert.ok(Number.isFinite(row.project.createdAt) && Number.isFinite(row.project.updatedAt));
      }
    }
    const { activity, ordered, isWeb, labeled, groupName } = sidebarFormatter(contexts, profile);
    const roots = ordered(sessions.filter((row) => !row.parentSessionId && isWeb(row)));
    const recent = roots.filter((row) => !row.archived && !row.pinned);
    const pinned = roots.filter((row) => !row.archived && row.pinned);
    const byScope = new Map(contexts.map((row) => [row.scopeId, row]));
    const ranks = new Map(sessions.map((row, index) => [row.id, index]));
    const webRanks = new Map(sessions.filter(isWeb).map((row, index) => [row.id, index]));
    const compact = (row) => ({
      ...labeled(row),
      threadRef: row.threadRef,
      createdAt: row.createdAt,
      at: activity(row),
      legacyRank: (isWeb(row) ? webRanks : ranks).get(row.id),
      archived: Boolean(row.archived),
      pinned: Boolean(row.pinned),
      parentSessionId: row.parentSessionId ?? null,
      type: row.type,
      channelName: row.channelName ?? null,
      surface: sidebarSurface(row),
    });
    const stableContexts = contexts
      .map((row) => ({
        scopeId: row.scopeId,
        kind: row.kind,
        name: row.name ?? null,
        project: row.project ? { id: row.project.id, name: row.project.name } : null,
      }))
      .sort((a, b) => compareIdentity(a.scopeId, b.scopeId));
    const scopeOrder = [...new Set([...recent.map((row) => row.scopeId), ...contexts.map((row) => row.scopeId)])];
    const groups = ordered(
      scopeOrder.flatMap((scopeId) => {
        const context = byScope.get(scopeId);
        if (!context) return [];
        const rows = recent.filter((row) => row.scopeId === scopeId);
        const kind = context.project ? "project" : context.kind;
        if (!rows.length && ["channel", "group"].includes(kind)) return [];
        return [
          {
            scopeId,
            name: groupName(context),
            kind,
            count: rows.length,
            lastActivityAtAtPreparation: rows.length
              ? activity(rows[0])
              : (context.lastActivityAt ?? context.project?.createdAt ?? context.project?.updatedAt ?? 0),
          },
        ];
      }),
      (row) => row.scopeId,
      (row) => row.lastActivityAtAtPreparation,
    );
    const items = profile.transport === "navigation-post" ? groups.slice(0, 50) : groups;
    const renderedGroups = (count) =>
      profile.transport === "navigation-post"
        ? items
        : items.filter(
            (group) => group.count === 0 || recent.slice(0, count).some((row) => row.scopeId === group.scopeId),
          );
    const selected = catalog.filter((row) => row.principalId === principalId);
    const retainedIds = new Set(
      selected
        .flatMap((row) => [
          row.session?.sessionId,
          ...(row.sessions ?? []).map((session) => session.sessionId),
          ...(row.kind === "sidebar-switch" ? [fixture.cases?.long?.sessionId] : []),
        ])
        .filter(Boolean),
    );
    const retained = sessions.filter((row) => retainedIds.has(row.id));
    assert.equal(retained.length, retainedIds.size, "Every retained sidebar identity needs authorized observation");
    const personal = sessions.filter(
      (row) =>
        row.scopeId === `personal:${principalId}` &&
        row.threadRef.startsWith(`web:${principalId}:`) &&
        !row.threadRef.startsWith(`web:${principalId}:ideas:`),
    );
    personal.sort(
      (a, b) =>
        a.createdAt - b.createdAt ||
        (profile.transport === "navigation-post" ? compareIdentity(a.threadRef, b.threadRef) : 0),
    );
    actors[principalId] = {
      surface: "web",
      evidence,
      preparedWeb: ordered(sessions.filter(isWeb)).map(compact),
      preparedOffPageWeb: retained.filter(isWeb).map(compact),
      contexts: stableContexts,
      recent: {
        total: recent.length,
        allRows: recent.map(labeled),
        firstRows: recent.slice(0, 50).map(labeled),
        secondRows: recent.slice(50, 100).map(labeled),
        firstHasMore: recent.length > 50,
        secondHasMore: recent.length > 100,
      },
      pinned: {
        total: pinned.length,
        rows: (profile.transport === "navigation-post" ? pinned.slice(0, 50) : pinned).map(labeled),
        hasMore: profile.transport === "navigation-post" && pinned.length > 50,
      },
      groups: {
        total: groups.length,
        items,
        firstItems: renderedGroups(50),
        secondItems: renderedGroups(100),
        hasMore: profile.transport === "navigation-post" && groups.length > 50,
        dynamicOrderScopes: groups.filter((row) => row.count === 0).map((row) => row.scopeId),
      },
      archivedCount: roots.filter((row) => row.archived).length,
      startup: {
        hasSessions: sessions.some((row) => row.id),
        hasNonCronSessions: sessions.some((row) => row.id && !row.threadRef.startsWith("cron:")),
        oldestPersonalThreadRef: personal[0]?.threadRef ?? null,
        latestIdAtPreparation: ordered(sessions)[0]?.id ?? null,
      },
      allowedOffPageRows: retained.map((row) => {
        const surface = sidebarSurface(row);
        return {
          ...labeled(row),
          threadRef: row.threadRef,
          archived: Boolean(row.archived),
          pinned: Boolean(row.pinned),
          parentSessionId: row.parentSessionId ?? null,
          surface,
        };
      }),
    };
    if (dynamic) {
      const writtenScopes = new Set(dynamic.writes.map((row) => row.scopeId));
      const writtenThreads = new Set(dynamic.writes.map((row) => row.threadRef).filter(Boolean));
      assert.ok(sessions.every((row) => ["dm", "channel", "group"].includes(row.type)));
      assert.ok(
        sessions.every(
          (row) => row.parentSessionId == null || (typeof row.parentSessionId === "string" && row.parentSessionId),
        ),
      );
      assert.ok(contexts.every((row) => !row.project || (typeof row.project.id === "string" && row.project.id)));
      assert.ok(
        sessions.filter(isWeb).every((row) => !writtenThreads.has(row.threadRef)),
        "Prepared web rows overlap the admitted workload",
      );
      const recurring = dynamic.recurring.filter((row) => row.audience.includes(principalId));
      assert.ok(
        recurring.every((row) => byScope.has(row.scopeId)),
        "New recurring scope outside the observed authorized context universe",
      );
      actors[principalId].dynamic = {
        preparedNonWeb: sessions
          .filter((row) => !isWeb(row))
          .map((row) => ({
            ...compact(row),
            mutableFields: writtenThreads.has(row.threadRef) ? ["at", "title", "groupedTitle"] : [],
          })),
        allowedOffPageRows: retained.map(compact),
        contexts: stableContexts.map((context) => {
          const row = byScope.get(context.scopeId);
          return {
            ...context,
            fallbackActivity: row.lastActivityAt ?? row.project?.createdAt ?? row.project?.updatedAt ?? 0,
          };
        }),
        recurring,
        scopePolicy: contexts.map((row) => ({
          scopeId: row.scopeId,
          mode: writtenScopes.has(row.scopeId) ? "dynamic" : "static-disjoint",
          writeEvidence: dynamic.writes.filter((write) => write.scopeId === row.scopeId),
        })),
      };
    }
  }
  const result = { schemaVersion: 1, ...profile, actors };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4194304, "Sidebar metadata output bound");
  return result;
}

export function deriveSidebarReadiness(fixture, observations, profile) {
  assert.equal(arguments.length, 3, "Dynamic inputs belong in a separately bound sidecar");
  return sidebarReadiness(fixture, observations, profile);
}

export function deriveDynamicSidebarAdmission({ commonFixture, profile, sourceProfiles, artifacts }) {
  const { data: fixture, descriptor } = retainedSidebarArtifact(commonFixture, 4194304);
  validateSidebarProfile(profile);
  const catalog = buildCatalog(fixture, profile.sourceRevision);
  assert.equal(catalog.length, 60);
  for (const condition of ["normal", "peak"]) assert.equal(cellsFor(catalog, condition).length, 109);
  assert.ok(Array.isArray(fixture.viewReadinessBySource) && fixture.viewReadinessBySource.length === 2);
  assert.deepEqual(
    sourceProfiles,
    fixture.viewReadinessBySource.map((row) => row.profile),
  );
  const selected = fixture.viewReadinessBySource.find((row) => row.profile.sourceRevision === profile.sourceRevision);
  assert.deepEqual(selected.profile, profile);
  const prepared = selected.browser.sidebarReadiness;
  assert.ok(prepared, "Complete common prepared sidebar identities required");
  for (const record of fixture.viewReadinessBySource) {
    assert.ok(record.browser.sidebarReadiness, "Both common prepared source records are required");
    assert.deepEqual(Object.keys(record.browser.sidebarReadiness.actors).sort(), Object.keys(prepared.actors).sort());
    for (const actor of Object.values(record.browser.sidebarReadiness.actors)) {
      assert.equal(actor.dynamic, undefined, "Run-specific data cannot be common fixture authority");
      for (const key of ["preparedWeb", "preparedOffPageWeb", "contexts"]) assert.ok(Array.isArray(actor[key]));
    }
  }
  const { data: observations } = retainedSidebarArtifact(artifacts.observations, 134217728);
  const dynamic = dynamicSidebarInputs(fixture, observations, profile, { profile, sourceProfiles, artifacts });
  assert.deepEqual(
    catalog.map((row) => [row.id, row.principalId]),
    buildCatalog(dynamic.native.fixture, profile.sourceRevision).map((row) => [row.id, row.principalId]),
    "Common scenario actor binding differs from the native fixture",
  );
  const actual = sidebarReadiness(fixture, observations, profile, dynamic);
  assert.deepEqual(Object.keys(actual.actors).sort(), Object.keys(prepared.actors).sort(), "Common actor set changed");
  const actors = Object.fromEntries(
    Object.entries(actual.actors).map(([principalId, actor]) => {
      const common = prepared.actors[principalId];
      for (const key of ["preparedWeb", "preparedOffPageWeb", "contexts"])
        assert.deepEqual(actor[key], common[key], `Common ${principalId} ${key} changed`);
      return [principalId, { evidence: actor.evidence, ...actor.dynamic }];
    }),
  );
  const result = {
    schemaVersion: 1,
    qualified: false,
    commonFixture: descriptor,
    profile: structuredClone(profile),
    campaignId: dynamic.native.campaignId,
    sourceProfile: dynamic.native.sourceProfile,
    condition: dynamic.native.schedule.condition,
    epochAt: dynamic.native.recurrence.epochAt,
    evidence: dynamic.evidence,
    actors,
    missing: ["browser.sidebarReadiness.dynamic: response and native reconciliation required"],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4194304, "Sidebar metadata output bound");
  return result;
}

export function deriveViewFixtures(fixture, observations, options = {}) {
  assert.ok(Object.keys(options).every((key) => ["sidebarProfiles", "sidebarProfile"].includes(key)));
  assert.equal(observations.fixtureId, fixture.fixtureId, "View evidence belongs to another fixture");
  const output = structuredClone(fixture);
  delete output.viewReadinessBySource;
  if (options.sidebarProfiles !== undefined) {
    assert.deepEqual(Object.keys(options), ["sidebarProfiles"]);
    assert.ok(Array.isArray(options.sidebarProfiles) && options.sidebarProfiles.length === 2);
    options.sidebarProfiles.forEach(validateSidebarProfile);
    assert.equal(new Set(options.sidebarProfiles.map((profile) => profile.sourceRevision)).size, 2);
    assert.equal(new Set(options.sidebarProfiles.map((profile) => profile.transport)).size, 2);
    const derived = options.sidebarProfiles.map((profile) =>
      deriveViewFixtures(output, observations, {
        sidebarProfile: profile,
      }),
    );
    const common = structuredClone(output);
    common.browser = structuredClone(derived[0].browser);
    common.views = structuredClone(derived[0].views);
    delete common.browser.sidebarReadiness;
    delete common.browser.rootSidebarCases;
    common.viewReadinessBySource = options.sidebarProfiles.map((profile, index) => {
      const selected = derived[index];
      assert.deepEqual(selected.browser.features, common.browser.features);
      return {
        profile: structuredClone(profile),
        browser: {
          rootSidebarCases: selected.browser.rootSidebarCases,
          sidebarReadiness: selected.browser.sidebarReadiness ?? null,
        },
        views: selected.views,
        sidebarPagination: selected.sidebarPagination ?? null,
        viewReadinessEvidence: selected.viewReadinessEvidence,
      };
    });
    return common;
  }
  output.browser ??= {};
  delete output.browser.sidebarReadiness;
  const views = (output.views = {});
  const gaps = [];
  const evidence = [];
  const normalizations = [];
  const scope = fixture.orgScopeId ?? fixture.browser?.orgScopeId;
  const admin = fixture.adminPrincipalId ?? fixture.browser?.adminPrincipalId;
  const adminHistoryCohorts = fixture.adminHistoryCohorts ?? fixture.cohorts;
  const rows = observations.rows ?? [];
  const read = (path, principalId = admin, expectedStatus = 200) => {
    const row = rows.find((entry) => entry.path === path && (entry.principalId ?? admin) === principalId);
    assert.equal(row?.status, expectedStatus, `Missing successful fixture observation: ${path}`);
    evidence.push({
      path,
      principalId: row.principalId ?? admin,
      status: row.status,
      sha256: sha256(JSON.stringify(row.data)),
    });
    return row.data;
  };
  const attempt = (name, action) => {
    try {
      action();
    } catch (error) {
      gaps.push({ scenario: name, reason: String(error.message ?? error) });
    }
  };
  const text = (name, expectedText, extra = {}) => {
    assert.ok([expectedText].flat().length > 0);
    assert.ok([expectedText].flat().every((value) => typeof value === "string" && value.trim()));
    views[name] = { expectedText: [expectedText].flat(), ...extra };
  };
  const data = read("/admin/api/me");
  assert.equal(data.principal, admin);
  assert.equal(data.scopeId, scope);
  assert.equal(data.isAdmin, true);
  const directory = read("/admin/api/scopes");
  assert.equal(directory.scopeId, scope);
  const shortName = (id) => {
    assert.ok(typeof id === "string" && id.includes(":"), "Resource has no valid owner scope");
    const [kind, ...pieces] = id.split(":");
    if (kind === "org") return "org";
    const label = directory.scopes.find((row) => row.scopeId === id)?.label;
    if (label) return label;
    const rest = pieces.join(":");
    if (["channel", "group"].includes(kind)) return rest.startsWith("#") ? rest : `#${rest}`;
    const local = rest.split("@")[0];
    return kind === "personal" && /^[a-z]/.test(local) ? local[0].toUpperCase() + local.slice(1) : rest;
  };
  const scoped = (view) => `/admin/api/${view}?scope=${encodeURIComponent(scope)}`;
  const settings = (view) => `/admin/api/scopes/${encodeURIComponent(scope)}?view=${view}`;
  const historyPath = (cohort, offset = 0) =>
    `/admin/api/sessions?scope=${encodeURIComponent(cohort.scopeId)}&limit=50&offset=${offset}&category=conversation`;
  const historyView = (name, cohort, offset = 0) => {
    const page = read(historyPath(cohort, offset));
    assert.equal(page.scopeId, cohort.scopeId);
    assert.equal(page.offset, offset, "History pagination did not reach its requested offset");
    if (Number.isSafeInteger(cohort.conversationCount))
      assert.equal(page.total, cohort.conversationCount, "Admin conversation count differs from its fixture cohort");
    assert.equal(page.limit, 50, "History pagination changed its requested page size");
    assert.ok(Number.isSafeInteger(page.total) && page.total > offset);
    assert.equal(page.sessions.length, Math.min(50, page.total - offset), "History page has an incomplete row count");
    assert.equal(new Set(page.sessions.map((entry) => entry.id)).size, page.sessions.length);
    assert.ok(
      page.sessions.every((entry) => entry.scopeId === cohort.scopeId),
      "History row has the wrong scope",
    );
    assert.ok(page.sessions.length > 0, "History fixture has no rows on the requested page");
    const declared = cohort.rootCase?.sessionId;
    const seeded = (entry) =>
      entry.firstMessage?.startsWith(`QM PERF ${entry.id} first`) ||
      entry.firstMessage?.startsWith("QM performance fixture ");
    const row = offset
      ? page.sessions[0]
      : (page.sessions.find((entry) => entry.id === declared) ?? page.sessions.find(seeded));
    assert.ok(row, "History page is missing its fixture conversation");
    let sentinel = `QM PERF ${row.id} first`;
    if (row.firstMessage?.startsWith("QM performance fixture ")) sentinel = row.firstMessage;
    assert.ok(row.firstMessage?.startsWith(sentinel), "Fixture history first-message sentinel is missing");
    if (offset) assert.ok(!read(historyPath(cohort)).sessions.some((entry) => entry.id === row.id));
    if (!offset && row.id !== declared)
      normalizations.push({
        view: name,
        scopeId: cohort.scopeId,
        offset,
        declaredSessionId: declared,
        renderedSessionId: row.id,
      });
    text(name, sentinel, {
      rows: { selector: ".dense-row", minimum: page.sessions.length },
      controlSelector: `a.dense-row[href^="/admin/history/s/${encodeURIComponent(row.id)}"]`,
    });
  };
  attempt("scopes", () => {
    const row = directory.scopes.find((entry) => entry.scopeId === adminHistoryCohorts.max.scopeId);
    assert.ok(row && row.sessions > 0, "Scope directory is missing the max cohort");
    text("scopes", shortName(row.scopeId), { rows: { selector: ".dense-row", minimum: 1 } });
  });
  for (const name of ["median", "p95", "max"])
    attempt(`history.${name}`, () => historyView(`history.${name}`, adminHistoryCohorts[name]));
  attempt("history.next", () => historyView("history.next", adminHistoryCohorts.max, 50));
  attempt("audit", () => {
    const result = read(scoped("audit"));
    assert.equal(result.scopeId, scope, "Audit response has the wrong scope");
    assert.ok(
      result.events?.some(
        (row) => row.principalId === admin && row.action === "audit.read" && row.resource === "audit",
      ),
    );
    text("audit", [admin, "audit.read"], {
      rows: { selector: "tbody tr", minimum: result.events.length },
      rowTexts: [{ selector: "tbody tr", texts: [admin, "audit.read", "audit"] }],
    });
  });
  for (const [view, key, marker] of [
    ["errors", "errors", "QM performance error"],
    ["egress", "records", "fixture.example.invalid"],
  ])
    attempt(view, () => {
      const result = read(scoped(view));
      assert.ok(
        result[key]?.some((row) => JSON.stringify(row).includes(marker)),
        "Seeded log rows are missing",
      );
      text(view, marker, { rows: { selector: "tbody tr", minimum: 1 } });
    });
  for (const [view, key, field, marker] of [
    ["files", "files", "name", "QM performance file"],
    ["skills", "skills", "name", "perf-skill-"],
    ["crons", "crons", "title", "QM performance cron"],
  ])
    attempt(view, () => {
      const result = read(scoped(view));
      const item = result[key]?.find((row) => row[field]?.startsWith(marker));
      assert.ok(item, `Seeded ${view} item is missing`);
      const owner = item.ownerScopeId ?? item.scopeId;
      const count = result[key].filter((row) => (row.ownerScopeId ?? row.scopeId) === owner).length;
      const noun = { files: "file", skills: "skill", crons: "cron" }[view];
      text(view, [shortName(owner), `${count} ${noun}${count === 1 ? "" : "s"}`], {
        rows: { selector: ".dense-row", minimum: 1 },
      });
    });
  attempt("memory", () => {
    const result = read("/admin/api/memory/scopes");
    const item = result.scopes?.find((row) => row.hasMemory && row.bytes > 0);
    assert.ok(item, "No seeded nonempty notebook is exposed by the API");
    let size = `${item.bytes} B`;
    if (item.bytes >= 1048576) size = `${(item.bytes / 1048576).toFixed(1)} MB`;
    else if (item.bytes >= 1024) size = `${(item.bytes / 1024).toFixed(1)} KB`;
    text("memory", [shortName(item.scopeId), size], { rows: { selector: ".memory-notebooks .dense-row", minimum: 1 } });
  });
  attempt("judgments", () => {
    const result = read("/admin/api/ambient-judgments?decision=act,ignore");
    assert.ok(result.judgments?.some((row) => row.reason === "QM performance decision"));
    text("judgments", "QM performance decision");
  });
  attempt("slack", () => {
    const result = read("/admin/api/slack-mirror");
    const row = result.containers?.find((entry) => entry.container?.startsWith("perf-") && entry.messageCount > 0);
    assert.ok(row, "Seeded Slack messages are not exposed in the mirror index");
    const label = row.kind === "channel" ? `#${row.name || row.container}` : row.name || row.container;
    text("slack", label, { rows: { selector: ".dense-row", minimum: 1 } });
  });
  attempt("deployments", () => {
    const result = read(scoped("deployments"));
    assert.ok(result.deployments?.length, "Deployment data was not seeded; an empty index does not prove parity");
    text("deployments", shortName(result.deployments[0].ownerScopeId), {
      rows: { selector: ".dense-row", minimum: 1 },
    });
  });
  attempt("users", () => {
    const result = read("/admin/api/users");
    assert.ok(
      result.users?.some((row) => row.principalId === admin && row.sessionCount === fixture.cohorts.max.sessionCount),
    );
    text("users", admin, { rows: { selector: ".users-roster tbody tr", minimum: result.users.length } });
  });
  attempt("governance", () => {
    const result = read(settings("governance"));
    assert.equal(result.scopeId, scope);
    views.governance = {
      values: [
        { selector: "#security-posture", value: result.securityPosture },
        { selector: "#sharing-posture", value: result.sharingPosture },
      ],
    };
  });
  attempt("models", () => {
    const result = read(settings("models"));
    const configuredHarness = result.runtime?.harnessId || result.harnessDefault || "pi";
    const harnesses = result.harnessOptions?.length ? result.harnessOptions : [result.harnessDefault || "pi"];
    const harness = harnesses.includes(configuredHarness) ? configuredHarness : harnesses[0];
    const configuredModel = result.runtime?.modelId || result.baseModel || result.baseModelDefault;
    const choices = result.modelsByHarness?.[harness] ?? result.baseModelOptions;
    const model = choices.some((row) => row.id === configuredModel) ? configuredModel : choices[0]?.id;
    assert.ok(harness && model, "Model settings have no selectable runtime");
    if (harness !== configuredHarness || model !== configuredModel)
      normalizations.push({
        view: "models",
        configuredHarness,
        configuredModel,
        renderedHarness: harness,
        renderedModel: model,
      });
    const providers = read("/admin/api/custom-providers").providers;
    assert.ok(providers.length === 0, "Provide a provider-specific sentinel for configured custom providers");
    text("models", "No custom providers.", {
      values: [
        { selector: "#base-harness", value: harness },
        { selector: "#base-model", value: model },
      ],
    });
  });
  attempt("credentials", () => {
    const result = read(settings("credentials"));
    assert.ok(Array.isArray(result.serviceCredentials));
    read("/admin/api/keychain?summary=1");
    text(
      "credentials",
      result.serviceCredentials.length
        ? result.serviceCredentials[0].name || result.serviceCredentials[0].slug
        : "No credentials configured.",
      { absentTexts: ["Loading credentials…", "Loading usage…"] },
    );
  });
  attempt("connectors", () => {
    const result = read(settings("connectors"));
    const catalog = read("/admin/api/connector-catalog").catalog;
    assert.ok(
      result.connectors.length === 0 && !catalog.some((row) => row.configured),
      "Provide configured-connector sentinels for this fixture",
    );
    text("connectors", "No connectors configured. Add one below to make it linkable in the web UI.");
  });
  attempt("customize", () => {
    const result = read(settings("customize"));
    assert.ok(result.soul?.trim());
    text("customize", result.soul, { values: [{ selector: "#soul", value: result.soul }] });
  });
  attempt("slack-settings", () => {
    const result = read("/admin/api/slack-installation");
    const settingsData = read(settings("slack-settings"));
    const emojiStatus = rows.find((row) => row.path === "/admin/api/slack-emoji")?.status;
    assert.ok([200, 404].includes(emojiStatus), "Slack emoji state needs an observed response");
    const emoji = read("/admin/api/slack-emoji", admin, emojiStatus);
    if (emojiStatus === 404) assert.equal(emoji.error, "not_configured");
    else assert.ok(emoji.emoji && Array.isArray(emoji.standard) && emoji.standard.length);
    output.browser.features ??= {};
    output.browser.features.slack = {
      ...output.browser.features.slack,
      emojiCatalogAvailable: emojiStatus === 200,
    };
    text(
      "slack-settings",
      result.configured ? result.teamName || result.teamId || "Slack workspace" : "Connect your workspace",
      { values: [{ selector: "#internal-member-overrides", value: settingsData.internalMemberOverrides.join("\n") }] },
    );
  });
  for (const range of ["7d", "30d", "90d"])
    attempt(`spend.${range}`, () => {
      const row = rows.find((entry) => {
        if (!entry.path.startsWith("/admin/api/spend?")) return false;
        const params = new URL(entry.path, "http://fixture.invalid").searchParams;
        return (Date.parse(params.get("to")) - Date.parse(params.get("from"))) / 86400000 === parseInt(range);
      });
      assert.ok(row, `No spend observation for ${range}`);
      const result = read(row.path);
      assert.ok(result.org?.calls > 0 && result.series?.length && result.models?.length);
      const person = result.people.find((entry) => entry.principalId?.startsWith("perf-"));
      assert.ok(person, "Spend is missing synthetic principal data");
      text(
        range === "30d" ? "spend" : `spend.${range}`,
        [
          result.models[0].model,
          person.displayName || person.principalId,
          `$${Number(result.models[0].costUsd).toFixed(2)}`,
        ],
        { rows: { selector: ".spend-models tbody tr", minimum: result.models.length } },
      );
    });
  const webPrincipal = fixture.cases?.short?.principalId;
  const webRead = (path) => {
    assert.ok(webPrincipal, "Web surface fixture has no principal");
    return read(path, webPrincipal);
  };
  attempt("web.settings", () => {
    const me = webRead("/me");
    assert.equal(me.user, fixture.cases.short.principalId);
    const result = webRead("/api/user-model-auth/status");
    assert.ok(["company", "anthropic", "openai"].includes(result.account));
    text("web.settings", `${me.displayName?.trim() || me.user} · ${me.org}`, {
      controlSelector: '[aria-label="AI access"] button[aria-pressed="true"]',
    });
  });
  attempt("web.browse", () => {
    const me = webRead("/me");
    const labels = ["Projects", "Files", "Crons", "Webhooks", "Keychain", "Apps", "Memory", "Skills"];
    if (me.permissions.includes("loops")) labels.push("Loops");
    if (me.permissions.includes("admin")) labels.push("Admin");
    text("web.browse", labels, {
      rows: { selector: "a.browse-tile", minimum: labels.length },
      controlSelector: "a.browse-tile.selected",
    });
  });
  attempt("web.search", () => {
    const chats = webRead("/api/search?q=performance");
    const resources = webRead("/api/resources/search?q=performance");
    assert.deepEqual(resources.failed ?? [], [], "Resource search returned partial results");
    const hit = resources.hits?.find((row) => row.snippet?.includes("QM performance"));
    const chat = chats.hits?.find((row) => row.surface === "web" && row.snippet?.trim());
    assert.ok(chat && hit, "Search needs both indexed web chat and resource fixture results");
    text("web.search", [chat.snippet, hit.title, hit.snippet], {
      query: "performance",
      rows: { selector: ".chat-search-row", minimum: 2 },
    });
  });
  const webList = (name, selector, items, expectedText, rowSelector, controlSelector) => {
    assert.ok(Array.isArray(items) && items.length > 0, `${name} needs populated API-observed fixture rows`);
    text(name, expectedText, {
      selector,
      rows: { selector: rowSelector, minimum: items.length },
      rowTexts: [{ selector: rowSelector, texts: [expectedText] }],
      controlSelector,
    });
  };
  attempt("web.contexts", () => {
    const items = webRead("/api/contexts").contexts.filter(
      (row) => row.kind === "personal" || row.project || row.sessionCount,
    );
    const row = items.find((item) => item.project?.name || (item.kind !== "personal" && item.name));
    assert.ok(row, "Projects needs an observed named project or active shared context");
    webList("web.contexts", ".contexts-pane", items, row.project?.name || row.name, ".context-row", ".context-row");
  });
  attempt("web.crons", () => {
    const items = webRead("/api/crons").crons.filter((row) => !row.archived);
    const enabled = items.filter((row) => row.enabled);
    const disabled = items.filter((row) => !row.enabled);
    assert.ok(disabled.length, "The safe cron fixture must have disabled owned rows");
    assert.ok(
      disabled.every((row) => row.title?.trim()),
      "Disabled cron rows need explicit observed titles",
    );
    const extra = {
      selector: ".crons-page",
      controlSelector: ".cron-disabled-toggle",
      rowTexts: [{ selector: ".cron-disabled-toggle", texts: ["Show disabled", String(disabled.length)] }],
      absentTexts: ["Loading crons…"],
    };
    if (enabled.length)
      webList("web.crons", ".crons-page", enabled, enabled[0].title, ".cron-row", 'input[aria-label="Search crons"]');
    else text("web.crons", ["Show disabled", String(disabled.length)], extra);
    webList("web.crons.disabled", ".crons-page", items, disabled[0].title, ".cron-row", ".cron-disabled-toggle");
  });
  attempt("web.webhooks", () => {
    const items = webRead("/api/webhooks").webhooks;
    const action = items[0]?.action?.trim().replace(/\s+/g, " ");
    assert.ok(action);
    webList(
      "web.webhooks",
      ".webhooks-page",
      items,
      action.length > 48 ? `${action.slice(0, 47)}…` : action,
      "a.list-row",
      'input[aria-label="Search webhooks"]',
    );
  });
  for (const feature of ["loops", "inbox"]) {
    if (output.browser.features) delete output.browser.features[feature];
    attempt(`web.${feature}`, () => {
      const me = webRead("/me");
      assert.equal(me.user, webPrincipal);
      assert.ok(Array.isArray(me.permissions), "Feature availability needs observed account permissions");
      const enabled = me.permissions.includes(feature);
      output.browser.features ??= {};
      output.browser.features[feature] = {
        enabled,
        mode: enabled ? "enabled" : "disabled",
        principalId: webPrincipal,
        evidence: `Observed /me permissions SHA-256 ${sha256(JSON.stringify(me.permissions))}`,
      };
      if (!enabled) return;
      if (feature === "loops") {
        const items = webRead("/api/loops").loops;
        webList("web.loops", ".loops-page", items, items[0]?.name, ".loop-row", ".loop-row");
      } else {
        const inboxWindow = (handled) => {
          const params = new URLSearchParams(handled ? { view: "handled" } : {});
          let page = webRead(`/api/inbox${params.size ? `?${params}` : ""}`);
          const items = [...page.items];
          const seen = new Set();
          while (page.nextCursor && items.length < 40) {
            assert.ok(!seen.has(page.nextCursor), "Inbox cursor did not advance");
            seen.add(page.nextCursor);
            params.set("cursor", page.nextCursor);
            page = webRead(`/api/inbox?${params}`);
            items.push(...page.items);
          }
          assert.equal(
            new Set(items.map((row) => row.id)).size,
            items.length,
            "Inbox window contains duplicate entries",
          );
          return { ...page, items };
        };
        const page = inboxWindow(false);
        inboxWindow(true);
        assert.equal(page.migrationPending, false, "Inbox fixture migration is not complete");
        const items = page.items.filter(
          (row) =>
            (row.state === "held" || (row.state === "failed" && row.parkedReason)) &&
            !row.sourcePayload?.probablyResolved &&
            !row.sourcePayload?.sentChat,
        );
        const row = items[0];
        webList(
          "web.inbox",
          ".inbox-page",
          items,
          row?.sourcePayload?.snippet || row?.parkedReason || row?.summary,
          ".inbox-item-row",
          ".inbox-item-row",
        );
      }
    });
  }
  attempt("web.files", () => {
    const page = webRead("/api/files?limit=60");
    const items = [...(page.owned ?? []), ...(page.shared ?? [])];
    webRead("/api/contexts");
    webList("web.files", ".files-page", items, items[0]?.name, ".file-row", 'input[aria-label="Search files"]');
  });
  attempt("web.keychain", () => {
    const items = webRead("/api/keychain/overview").credentials;
    webRead("/api/connectors");
    webList("web.keychain", ".keychain-page", items, items[0]?.service, ".kc-credential", ".list-page-action");
    views["web.keychain"].absentSelectors = [".kc-loading"];
  });
  attempt("web.deploys", () => {
    const items = webRead("/api/deployments").deployments.filter(
      (row) =>
        row.status !== "archived" &&
        (row.ownerScopeId === `personal:${webPrincipal}` ||
          (!row.ownerScopeId?.startsWith("personal:") && row.createdBy === webPrincipal)),
    );
    webRead("/api/contexts");
    webList(
      "web.deploys",
      ".deploys-page",
      items,
      items[0]?.displayName || items[0]?.name,
      ".deploy-row",
      'input[aria-label="Search apps"]',
    );
  });
  attempt("web.memory", () => {
    const content = webRead("/api/memory").content;
    assert.ok(typeof content === "string" && content.trim(), "Memory needs populated API-observed content");
    views["web.memory"] = {
      selector: ".pane:has(.memory-editor)",
      values: [{ selector: "textarea.memory-text", value: content }],
      editable: "textarea.memory-text",
      absentTexts: ["Loading…"],
    };
  });
  attempt("web.memory.facts", () => {
    const content = webRead("/api/memory").content;
    assert.ok(typeof content === "string");
    const facts = content.split("\n").flatMap((line) => {
      const match = line.match(/^\s*[-*]\s+(?:\((\d{4}-\d{2}-\d{2})\)\s*)?(.*\S)\s*$/);
      return match ? [match[2]] : [];
    });
    webList(
      "web.memory.facts",
      ".pane:has(.memory-editor)",
      facts,
      facts[0],
      ".memory-fact",
      'input[aria-label="Search memory"]',
    );
    views["web.memory.facts"].absentSelectors = ["textarea.memory-text"];
    views["web.memory.facts"].absentTexts = ["Loading…"];
  });
  attempt("web.skills", () => {
    const items = webRead("/api/skills?includeShadowed=1").skills.filter((row) => row.status !== "archived");
    webRead("/api/contexts");
    webList(
      "web.skills",
      ".skills-page",
      items,
      items[0]?.description,
      ".skill-variant",
      'input[aria-label="Search skills"]',
    );
  });
  output.browser.exclusions = [{ id: "web.calendar", reason: CALENDAR_EXCLUSION }];
  output.browser ??= {};
  output.browser.rootSidebarCases = {};
  delete output.browser.earlierPage;
  delete output.browser.mixedEarlierPage;
  delete output.sidebarPagination;
  delete output.browser.sidebarPagination;
  const sidebarWebSessions = (principalId) => {
    assert.equal(read("/me", principalId).user, principalId);
    const sessions = read("/api/sessions", principalId).sessions;
    assert.ok(
      sessions.every(
        (row) => typeof row.id === "string" && row.id && typeof row.threadRef === "string" && row.threadRef,
      ),
    );
    assert.equal(new Set(sessions.map((row) => row.id)).size, sessions.length);
    assert.equal(new Set(sessions.map((row) => row.threadRef)).size, sessions.length);
    return sessions
      .filter(
        (row) =>
          !row.parentSessionId &&
          !row.archived &&
          !row.pinned &&
          (row.threadRef.startsWith("web:") ||
            (row.threadRef.startsWith("agent:main:subagent:") && row.surface === "web")),
      )
      .sort(
        (a, b) =>
          (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt) ||
          (options.sidebarProfile?.transport === "navigation-post" ? compareIdentity(a.id, b.id) : 0),
      );
  };
  for (const name of ["median", "p95", "max"])
    attempt(`web.root.${name}`, () => {
      const cohort = (fixture.cohorts ?? fixture.principalCohorts)[name];
      const sessions = sidebarWebSessions(cohort.principalId).slice(0, 50);
      assert.ok(sessions.length, "Homepage fixture has no visible web conversations");
      const row = sessions.find((entry) => entry.id === cohort.rootCase?.sessionId) ?? sessions[0];
      output.browser.rootSidebarCases[name] = { sessionId: row.id, principalId: cohort.principalId };
    });
  for (const feature of ["loops", "inbox"])
    if (output.browser.features?.[feature]?.enabled === false) {
      const root = output.browser.rootSidebarCases.max;
      if (root?.principalId === webPrincipal)
        views[`web.${feature}`] = {
          selector: "body",
          expectedText: [],
          visible: `[data-session-id=${JSON.stringify(root.sessionId)}] a.session`,
          editable: ".custom-chat textarea",
          absentSelectors: [
            feature === "loops" ? ".loops-page" : ".inbox-page",
            `[data-view=${JSON.stringify(feature)}]`,
          ],
        };
      else
        gaps.push({
          scenario: `web.${feature}`,
          reason: "Disabled route needs an observed authenticated fallback homepage",
        });
    }
  attempt("web.chat.earlier", () => {
    const session = fixture.cases.long;
    const initial = read(`/api/sessions/${session.sessionId}?tailTurns=25`, session.principalId);
    assert.equal(initial.session.id, session.sessionId);
    assert.ok(initial.entries.length && initial.earlierEntries > 0, "Long fixture has no previous transcript page");
    const initialFirstSeq = initial.entries[0].seq;
    const previous = read(
      `/api/sessions/${session.sessionId}?beforeSeq=${initialFirstSeq}&tailTurns=25`,
      session.principalId,
    );
    assert.equal(previous.session.id, session.sessionId);
    assert.ok(previous.entries.length && previous.entries.every((entry) => entry.seq < initialFirstSeq));
    const row = previous.entries.findLast((entry) => entry.type === "user" && entry.payload?.text?.trim());
    assert.ok(row, "Previous page needs a visible user message with its entry identity");
    const expectedVisibleText = row.payload.text.split("\n")[0].trim().slice(0, 120);
    assert.ok(expectedVisibleText.length >= 8, "Previous-page text is too short for a content assertion");
    output.browser.earlierPage = {
      sessionId: session.sessionId,
      initialFirstSeq,
      firstSeq: previous.entries[0].seq,
      lastSeq: previous.entries.at(-1).seq,
      entrySeq: row.seq,
      expectedVisibleText,
    };
  });
  attempt("web.chat.mixed-earlier", () => {
    const session = fixture.cases.mixed;
    const boundary = session.transcriptBoundarySeq;
    assert.ok(
      Number.isSafeInteger(boundary) && boundary > 0 && boundary < session.messageCount,
      "Mixed fixture must declare its actual canonical-prefix boundary",
    );
    let page = read(`/api/sessions/${session.sessionId}?tailTurns=25`, session.principalId);
    assert.equal(page.session.id, session.sessionId);
    const initialFirstSeq = page.entries[0]?.seq;
    assert.ok(
      initialFirstSeq >= boundary && page.earlierEntries > 0,
      "Mixed initial page must be entirely after the canonical boundary",
    );
    const preparePages = [];
    for (let count = 0; count < 100; count++) {
      const before = page.entries[0].seq;
      const previous = read(`/api/sessions/${session.sessionId}?beforeSeq=${before}&tailTurns=25`, session.principalId);
      assert.equal(previous.session.id, session.sessionId);
      assert.ok(
        previous.entries.length && previous.entries.every((entry) => entry.seq < before),
        "Earlier mixed page did not advance",
      );
      const visible = previous.entries.filter((entry) => entry.type === "user" && entry.payload?.text?.trim());
      const ready = (entry) => {
        assert.ok(entry, "Boundary page needs a visible user entry from each storage cohort");
        const expected = entry.payload.text.split("\n")[0].trim().slice(0, 120);
        assert.ok(expected.length >= 8, "Mixed boundary text is too short");
        return { root: `.custom-chat [data-entry-seqs~=${JSON.stringify(String(entry.seq))}]`, texts: [expected] };
      };
      if (previous.entries[0].seq < boundary) {
        assert.ok(previous.entries.at(-1).seq >= boundary, "The measured earlier page must span both stores");
        const canonical = visible.findLast((entry) => entry.seq < boundary);
        const legacy = visible.find((entry) => entry.seq >= boundary);
        const canonicalReady = ready(canonical);
        output.browser.mixedEarlierPage = {
          sessionId: session.sessionId,
          initialFirstSeq,
          boundarySeq: boundary,
          firstSeq: previous.entries[0].seq,
          lastSeq: previous.entries.at(-1).seq,
          entrySeq: canonical.seq,
          expectedVisibleText: canonicalReady.texts[0],
          preparePages,
          boundaryReady: [ready(legacy)],
        };
        return;
      }
      preparePages.push(ready(visible.at(-1)));
      assert.ok(previous.earlierEntries > 0, "Mixed pagination ended before its boundary");
      page = previous;
    }
    throw new Error("Mixed boundary needs more than 100 preparation pages");
  });
  attempt("sidebarPagination", () => {
    const sessions = sidebarWebSessions(admin);
    assert.ok(sessions.length > 50, "Sidebar fixture has fewer than two pages of visible web conversations");
    const declared = fixture.browser?.sidebarPagination ?? fixture.sidebarPagination;
    if (declared) assert.equal(declared.principalId, admin);
    const ordinal = sessions.findIndex((row) => row.id === declared?.sessionId);
    const selected = ordinal >= 50 && ordinal < 100 ? ordinal : 50;
    output.sidebarPagination = { principalId: admin, sessionId: sessions[selected].id };
    if (output.sidebarPagination.sessionId !== declared?.sessionId)
      normalizations.push({
        view: "sidebarPagination",
        principalId: admin,
        declaredSessionId: declared?.sessionId,
        declaredOrdinal: ordinal,
        renderedSessionId: output.sidebarPagination.sessionId,
        renderedOrdinal: selected,
      });
  });
  attempt("web.sidebarReadiness", () => {
    output.browser.sidebarReadiness = deriveSidebarReadiness(output, observations, options.sidebarProfile);
  });
  output.viewReadinessEvidence = {
    fixtureId: fixture.fixtureId,
    observedAt: observations.at,
    evidence,
    gaps,
    normalizations,
  };
  output.viewReadinessEvidence.missing = buildCatalog(output)
    .filter((scenario) => scenario.missing.length)
    .map((scenario) => ({ id: scenario.id, missing: scenario.missing }));
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fixturePath, observationsPath, outputPath, profilePath] = process.argv.slice(2);
  assert.ok(
    fixturePath && observationsPath && outputPath,
    "Usage: fixture-views.mjs FIXTURE OBSERVATIONS OUTPUT [SIDEBAR_PROFILE_OR_PAIR]",
  );
  assert.notEqual(resolve(fixturePath), resolve(outputPath), "Preserve the original fixture manifest");
  const profile = profilePath ? JSON.parse(readFileSync(profilePath, "utf8")) : undefined;
  const output = deriveViewFixtures(
    JSON.parse(readFileSync(fixturePath, "utf8")),
    JSON.parse(readFileSync(observationsPath, "utf8")),
    Array.isArray(profile) ? { sidebarProfiles: profile } : { sidebarProfile: profile },
  );
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
  console.log(
    JSON.stringify(
      {
        outputPath,
        sources: (output.viewReadinessBySource ?? [output]).map((record) => ({
          profile: record.profile ?? profile,
          views: Object.keys(record.views).length,
          missing: record.viewReadinessEvidence.missing,
          gaps: record.viewReadinessEvidence.gaps,
        })),
      },
      null,
      2,
    ),
  );
}
