import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sidebarFormatter, sidebarSurface } from "./sidebar-format.mjs";

const CAP = 4194304;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const normalized = (value) => value.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
const textHash = (value) => (value === null ? null : hash(normalized(value)));
const object = (value) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Object required");
  return value;
};
const fields = (value, allowed) => {
  object(value);
  assert.ok(
    Object.keys(value).every((key) => allowed.includes(key)),
    "Unknown response/request field",
  );
};
const text = (value, max = CAP) => assert.ok(typeof value === "string" && value.length > 0 && value.length <= max);
const finite = (value) => assert.ok(typeof value === "number" && Number.isFinite(value));
const count = (value) => assert.ok(Number.isSafeInteger(value) && value >= 0);
const unique = (rows, key) => assert.equal(new Set(rows.map((row) => row[key])).size, rows.length, `Duplicate ${key}`);
const sorted = (rows) => [...rows].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : Number(a.id !== b.id)));
const after = (row, boundary) => !boundary || row.at < boundary.at || (row.at === boundary.at && row.id > boundary.id);
const root = (row) => row.parentSessionId === null;
const contextIdentity = (row) => ({
  scopeId: row.scopeId,
  kind: row.kind,
  name: row.name ?? null,
  project: row.project ? { id: row.project.id, name: row.project.name } : null,
});
const immutable = (row) =>
  Object.fromEntries(
    [
      "id",
      "threadRef",
      "scopeId",
      "createdAt",
      "parentSessionId",
      "type",
      "channelName",
      "surface",
      "archived",
      "pinned",
    ].map((key) => [key, row[key]]),
  );
const sessionFields = [
  "id",
  "type",
  "scopeId",
  "threadRef",
  "surface",
  "createdAt",
  "channelName",
  "title",
  "archived",
  "pinned",
  "color",
  "status",
  "forkedFrom",
  "forkBoundarySeq",
  "parentSessionId",
  "spawnMeta",
  "lastActivityAt",
  "hasEntries",
  "working",
  "awaitingInput",
  "lastTurnFailed",
  "subagents",
  "backgroundJobs",
  "watches",
  "crons",
];

function cursor(raw, key) {
  text(raw, 4096);
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(raw, "base64url")));
  assert.deepEqual(Object.keys(object(parsed)).sort(), ["at", "id", "key"]);
  assert.equal(parsed.key, key, "Cursor filter key changed");
  finite(parsed.at);
  text(parsed.id, 512);
  return parsed;
}

function requestBody(request) {
  fields(request, ["method", "path", "body"]);
  if (["/api/sessions", "/api/contexts"].includes(request.path)) {
    assert.equal(request.method, "GET");
    assert.equal(request.body, undefined);
    return {};
  }
  assert.equal(request.method, "POST");
  const body = object(request.body);
  if (request.path === "/api/session-navigation") {
    fields(body, ["surface", "section", "cursor", "references"]);
    assert.ok(body.surface === undefined || ["web", "all"].includes(body.surface));
    assert.ok(body.section === undefined || ["recent", "pinned", "groups", "archived"].includes(body.section));
    assert.ok(body.cursor === undefined || body.section, "Section required for cursor");
  } else if (request.path === "/api/session-navigation/resolve") {
    fields(body, ["references"]);
    assert.ok(Array.isArray(body.references));
  } else {
    assert.equal(request.path, "/api/session-navigation/page");
    fields(body, [
      "surface",
      "scopeId",
      "pinned",
      "archived",
      "children",
      "cursor",
      "query",
      "title",
      "status",
      "parentSessionId",
      "actionable",
    ]);
    assert.ok(body.surface === undefined || ["all", "web", "slack", "core"].includes(body.surface));
    for (const key of ["pinned", "archived", "children", "actionable"])
      assert.ok(body[key] === undefined || typeof body[key] === "boolean");
    if (body.actionable) {
      text(body.parentSessionId, 512);
      assert.equal(body.children, true, "Actionable parent requires children:true");
    } else assert.equal(body.parentSessionId, undefined, "Non-actionable parent page is outside this oracle");
    assert.ok(
      body.query === undefined && body.title === undefined && body.status === undefined,
      "Unsupported filter oracle: raw prepared titles/status not retained",
    );
    if (body.scopeId !== undefined) text(body.scopeId, 512);
  }
  if (body.cursor !== undefined) text(body.cursor, 4096);
  if (body.references !== undefined) {
    assert.ok(Array.isArray(body.references) && body.references.length <= 12, "Reference cap");
    for (const ref of body.references) {
      fields(ref, ["kind", "value"]);
      assert.ok(["id", "thread"].includes(ref.kind));
      text(ref.value, ref.kind === "id" ? 512 : 2048);
    }
  }
  return body;
}

// ponytail: unseen dynamic membership needs the existing native history join; this checks lower bounds only.
export function projectSidebarResponse({
  data,
  responseBody,
  request,
  commonActor,
  dynamicActor,
  profile,
  principalId,
  previous = null,
  legacySurface,
  contextProjection = null,
}) {
  fields(responseBody, ["bytes", "sha256"]);
  assert.ok(
    Number.isSafeInteger(responseBody.bytes) && responseBody.bytes > 0 && responseBody.bytes <= CAP,
    "Full raw response exceeds 4 MiB or is absent",
  );
  assert.match(responseBody.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify({ commonActor, dynamicActor })) <= CAP, "Metadata cap");
  assert.ok(["legacy-get", "navigation-post"].includes(profile.transport));
  assert.match(profile.sourceRevision, /^[a-f0-9]{40}$/);
  text(principalId, 512);
  for (const actor of [commonActor, dynamicActor])
    for (const [name, path] of [
      ["me", "/me"],
      ["sessions", "/api/sessions"],
      ["contexts", "/api/contexts"],
    ]) {
      const evidence = actor.evidence?.[name];
      assert.ok(evidence, "Selected actor observation evidence absent");
      assert.equal(evidence.principalId, principalId, "Actor observation identity differs");
      assert.equal(evidence.path, path);
      assert.equal(evidence.status, 200);
      assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
    }
  const input = requestBody(request);
  if (request.path !== "/api/contexts")
    assert.equal(profile.transport === "legacy-get", request.path === "/api/sessions", "Transport/profile mismatch");
  if (request.path === "/api/sessions") {
    assert.ok(["web", "all"].includes(legacySurface), "Explicit legacy surface required");
    input.surface = legacySurface;
  }
  object(data);
  let contexts = dynamicActor.contexts;
  assert.ok(Array.isArray(contexts));
  unique(contexts, "scopeId");
  assert.deepEqual(contexts.map(contextIdentity), commonActor.contexts, "Common context identity changed");
  if (request.path === "/api/sessions") {
    assert.ok(contextProjection && contextProjection.kind === "contexts", "Legacy contexts response required");
    assert.deepEqual(contextProjection.profile, profile);
    assert.equal(contextProjection.principalId, principalId);
    assert.equal(contextProjection.qualified, false);
    assert.deepEqual(
      contextProjection.contexts.map((row) => row.scopeId).sort(),
      contexts.map((row) => row.scopeId).sort(),
    );
    const byScope = new Map(contexts.map((row) => [row.scopeId, row]));
    contexts = contextProjection.contexts.map((row) => {
      const prepared = byScope.get(row.scopeId);
      assert.equal(row.identitySha256, hash(JSON.stringify(contextIdentity(prepared))));
      finite(row.fallbackActivity);
      if (dynamicActor.scopePolicy.find((value) => value.scopeId === row.scopeId)?.mode === "static-disjoint")
        assert.equal(row.fallbackActivity, prepared.fallbackActivity);
      return { ...prepared, fallbackActivity: row.fallbackActivity };
    });
  }
  const contextByScope = new Map(contexts.map((row) => [row.scopeId, row]));
  const policy = new Map(dynamicActor.scopePolicy.map((row) => [row.scopeId, row]));
  assert.equal(policy.size, contexts.length);
  assert.ok(contexts.every((row) => policy.has(row.scopeId)));
  const formatter = sidebarFormatter(contexts, profile);
  const known = new Map();
  for (const row of [
    ...commonActor.preparedWeb,
    ...dynamicActor.preparedNonWeb,
    ...commonActor.preparedOffPageWeb,
    ...dynamicActor.allowedOffPageRows,
  ]) {
    assert.ok(contextByScope.has(row.scopeId), "Prepared context absent");
    if (known.has(row.id))
      assert.deepEqual(immutable(known.get(row.id)), immutable(row), "Conflicting prepared identity");
    else known.set(row.id, row);
  }
  unique([...known.values()], "threadRef");
  const roots = [...known.values()].filter(root);
  const familyFor = (row) =>
    dynamicActor.recurring.filter(
      (family) =>
        family.scopeId === row.scopeId &&
        family.audience.includes(principalId) &&
        family.permittedThreadFamily &&
        row.threadRef.startsWith(family.permittedThreadFamily) &&
        /^[a-f0-9]{12}$/.test(row.threadRef.slice(family.permittedThreadFamily.length)),
    );
  const writable = (row) =>
    row.surface !== "web" &&
    (policy.get(row.scopeId)?.writeEvidence ?? []).some(
      (write) =>
        ["direct", "approved-ask"].includes(write.kind) &&
        write.sessionId === row.id &&
        write.threadRef === row.threadRef,
    );
  const observed = new Map();
  const observedThreads = new Map();
  let rawRows;
  if (request.path === "/api/sessions") rawRows = data.sessions;
  else if (request.path.endsWith("/page")) rawRows = data.items;
  else
    rawRows = [
      ...(data.recent?.items ?? []),
      ...(data.pinned?.items ?? []),
      ...(data.archived?.items ?? []),
      ...(data.references ?? []).flatMap((value) => (value.session ? [value.session] : [])),
      ...(data.startup?.latest ? [data.startup.latest] : []),
    ];
  assert.ok(Array.isArray(rawRows));
  const rawById = new Map(rawRows.map((row) => [row.id, row]));
  const descendantFamilies = (row) => {
    let current = row;
    const seen = new Set();
    while (current.parentSessionId) {
      assert.ok(!seen.has(current.id), "Cyclic observed descendant ancestry");
      seen.add(current.id);
      current = rawById.get(current.parentSessionId) ?? known.get(current.parentSessionId);
      if (!current) return [];
    }
    return dynamicActor.recurring.filter(
      (family) =>
        family.audience.includes(principalId) &&
        family.children.some((child) => child.scopeId === row.scopeId) &&
        (familyFor(current).includes(family) ||
          family.origins.some((origin) => origin.sessionId === current.id && origin.threadRef === current.threadRef)),
    );
  };
  const unresolved = new Map();
  const compact = (row) => {
    fields(row, sessionFields);
    for (const key of ["id", "scopeId", "threadRef"]) text(row[key], key === "threadRef" ? 2048 : 512);
    finite(row.createdAt);
    if (row.lastActivityAt !== undefined) finite(row.lastActivityAt);
    assert.ok(["dm", "channel", "group"].includes(row.type));
    for (const key of ["title", "channelName"]) assert.ok(row[key] == null || typeof row[key] === "string");
    for (const key of ["archived", "pinned", "working", "awaitingInput", "lastTurnFailed", "hasEntries"])
      assert.ok(row[key] === undefined || typeof row[key] === "boolean");
    if (row.parentSessionId !== undefined) text(row.parentSessionId, 512);
    if (row.surface !== undefined) assert.ok(typeof row.surface === "string" && row.surface.length <= CAP);
    assert.ok(contextByScope.has(row.scopeId), "Unknown context scope");
    const result = {
      ...formatter.labeled(row),
      threadRef: row.threadRef,
      createdAt: row.createdAt,
      at: formatter.activity(row),
      parentSessionId: row.parentSessionId ?? null,
      type: row.type,
      channelName: row.channelName ?? null,
      surface: sidebarSurface(row),
      archived: Boolean(row.archived),
      pinned: Boolean(row.pinned),
    };
    const prepared = known.get(row.id);
    if (prepared) {
      assert.deepEqual(immutable(result), immutable(prepared), "Prepared identity/flags mutated");
      if (!writable(prepared))
        for (const key of ["title", "groupedTitle", "at"])
          assert.equal(result[key], prepared[key], `Static ${key} mutated`);
      result.identityMapping = { kind: "prepared", id: row.id };
    } else {
      assert.ok(!result.pinned && !result.archived, "Unknown pin/archive mutation");
      if (root(result)) {
        assert.equal(result.surface, "core", "Unknown static/web root");
        const matches = familyFor(result);
        assert.equal(matches.length, 1, "Unknown identity outside one admitted recurrence family");
        const family = matches[0];
        assert.match(family.finiteOccurrenceBinding, /^[a-f0-9]{64}$/);
        result.identityMapping = {
          kind: "unresolved-recurring",
          definitionId: family.definitionId,
          finiteOccurrenceBinding: family.finiteOccurrenceBinding,
        };
      } else {
        assert.ok(row.threadRef.startsWith("agent:main:subagent:"), "Unknown descendant thread shape");
        const allowed = dynamicActor.recurring.filter(
          (family) =>
            family.audience.includes(principalId) && family.children.some((child) => child.scopeId === row.scopeId),
        );
        assert.ok(allowed.length, "New descendant outside declared write closure");
        const matches = descendantFamilies(result);
        if (matches.length === 1)
          result.identityMapping = {
            kind: "unresolved-descendant",
            definitionId: matches[0].definitionId,
            finiteOccurrenceBinding: matches[0].finiteOccurrenceBinding,
            parentSessionId: row.parentSessionId,
          };
        else
          result.identityMapping = {
            kind: "unsupported-descendant",
            reason: "No unique observed admitted ancestry",
            declaredDefinitions: allowed.map((family) => ({
              definitionId: family.definitionId,
              finiteOccurrenceBinding: family.finiteOccurrenceBinding,
            })),
          };
      }
      unresolved.set(row.id, {
        id: row.id,
        threadRef: row.threadRef,
        threadRefSha256: hash(row.threadRef),
        scopeId: row.scopeId,
        parentSessionId: result.parentSessionId,
        createdAt: row.createdAt,
        type: result.type,
        surface: result.surface,
        archived: result.archived,
        pinned: result.pinned,
        identityMapping: result.identityMapping,
      });
    }
    if (observed.has(row.id)) assert.deepEqual(result, observed.get(row.id), "Conflicting repeated response identity");
    else {
      assert.ok(!observedThreads.has(result.threadRef), "Duplicate response thread identity");
      observedThreads.set(result.threadRef, result.id);
      observed.set(row.id, result);
    }
    return result;
  };
  const retained = (row) => ({
    id: row.id,
    scopeId: row.scopeId,
    at: row.at,
    createdAt: row.createdAt,
    parentSessionId: row.parentSessionId,
    type: row.type,
    surface: row.surface,
    archived: row.archived,
    pinned: row.pinned,
    threadRefSha256: hash(row.threadRef),
    titleSha256: textHash(row.title),
    groupedTitleSha256: textHash(row.groupedTitle),
    identityMapping: row.identityMapping ?? { kind: "prepared", id: row.id },
  });
  const outcome = {
    schemaVersion: 1,
    qualified: false,
    profile,
    principalId,
    requestIntentSha256: hash(JSON.stringify(request)),
    responseBodySha256: responseBody.sha256,
    bodyBytes: responseBody.bytes,
    metadataSha256: hash(JSON.stringify({ commonActor, dynamicActor, profile, principalId })),
    sections: {},
    references: [],
    unresolved: [],
    missing: [
      "Native response identity/workload reconciliation required",
      "Global status totals have no independent prepared status oracle",
    ],
  };
  const surface = (row) => !input.surface || input.surface === "all" || row.surface === input.surface;
  const navigationMatch = (section) => (row) =>
    root(row) &&
    surface(row) &&
    (section === "archived" ? row.archived : !row.archived && row.pinned === (section === "pinned"));
  const pageMatch = (row) =>
    (input.children || root(row)) &&
    surface(row) &&
    (!input.scopeId || row.scopeId === input.scopeId) &&
    (input.pinned === undefined || row.pinned === input.pinned) &&
    (input.archived === undefined || row.archived === input.archived);
  const navKey = (section) => JSON.stringify([section, input.surface ?? "all"]);
  const pageKey = JSON.stringify([
    input.surface ?? "all",
    null,
    input.scopeId ?? null,
    "",
    null,
    input.children ?? false,
    input.parentSessionId ?? null,
    input.pinned ?? null,
    input.archived ?? null,
    ...(input.actionable ? ["actionable"] : []),
  ]);
  const boundaryFor = (section, key, raw) => {
    if (!raw) return null;
    assert.ok(previous, "Continuation requires preceding retained projection");
    assert.deepEqual(previous.profile, profile);
    assert.equal(previous.principalId, principalId);
    const preceding = previous.sections[section];
    assert.ok(preceding && preceding.nextCursorSha256 === hash(raw), "Cursor does not match preceding response");
    const decoded = cursor(raw, key);
    assert.deepEqual(decoded, preceding.boundary, "Cursor boundary changed");
    return decoded;
  };
  const projectPage = (section, value, key, raw, matches) => {
    fields(value, ["items", "total", "nextCursor"]);
    assert.ok(Array.isArray(value.items) && value.items.length <= 50, "Page cap");
    count(value.total);
    const rows = value.items.map(compact);
    unique(rows, "id");
    assert.ok(rows.every(matches), "Response row outside requested page");
    const boundary = boundaryFor(section, key, raw);
    assert.ok(
      rows.every((row) => after(row, boundary)),
      "Response crossed cursor boundary",
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      sorted(rows).map((row) => row.id),
      "Page order",
    );
    const candidates = new Map(
      [...known.values()].filter((row) => !writable(row) && matches(row)).map((row) => [row.id, row]),
    );
    for (const row of observed.values()) if (matches(row)) candidates.set(row.id, row);
    const expected = sorted([...candidates.values()].filter((row) => after(row, boundary))).slice(0, 50);
    assert.deepEqual(
      rows.map((row) => row.id),
      expected.map((row) => row.id),
      "Immutable merge prefix differs",
    );
    const lower = new Set([...known.values()].filter(matches).map((row) => row.id));
    for (const row of observed.values()) if (matches(row)) lower.add(row.id);
    assert.ok(value.total >= lower.size && value.total >= rows.length, "Total below known identity lower bound");
    const exactMembership =
      (input.surface === "web" && !input.children) ||
      ["pinned", "archived"].includes(section) ||
      input.pinned === true ||
      input.archived === true;
    if (exactMembership) assert.equal(value.total, lower.size, "Immutable page total changed");
    const knownRemaining = [...candidates.values()].filter((row) => after(row, boundary)).length;
    assert.ok(rows.length === 50 || rows.length >= knownRemaining, "Page incomplete");
    if (!boundary && value.total > rows.length) assert.ok(value.nextCursor !== null, "Missing first-page continuation");
    if (knownRemaining > rows.length) assert.ok(value.nextCursor !== null, "Missing known continuation");
    if (exactMembership && (!boundary || [...known.values()].filter(matches).every((row) => !writable(row))))
      assert.equal(
        value.nextCursor !== null,
        (boundary ? knownRemaining : lower.size) > rows.length,
        "Immutable page continuation differs from exact remaining rows",
      );
    let next = null;
    if (value.nextCursor !== null) {
      assert.equal(rows.length, 50, "Continuation requires a full page");
      next = cursor(value.nextCursor, key);
      assert.deepEqual(next, { key, at: rows.at(-1).at, id: rows.at(-1).id }, "Next cursor not last row");
    }
    return {
      total: value.total,
      nextCursorSha256: value.nextCursor === null ? null : hash(value.nextCursor),
      boundary: next,
      rows: rows.map(retained),
    };
  };
  const verifyContexts = (values, selectedScopes, limit) => {
    assert.ok(Array.isArray(values) && values.length <= limit, "Selected context cap");
    unique(values, "scopeId");
    for (const value of values) {
      fields(value, ["scopeId", "kind", "name", "isPrivate", "sessionCount", "lastActivityAt", "project"]);
      assert.deepEqual(
        contextIdentity(value),
        contextIdentity(contextByScope.get(value.scopeId) ?? {}),
        "Context identity changed",
      );
      count(value.sessionCount);
      if (value.lastActivityAt !== null) finite(value.lastActivityAt);
      if (value.isPrivate !== undefined) assert.equal(typeof value.isPrivate, "boolean");
      if (value.project)
        fields(value.project, [
          "id",
          "name",
          "ownerId",
          "createdAt",
          "updatedAt",
          ...(request.path === "/api/contexts"
            ? ["orgId", "memberIds", "channelMemberIds", "slackChannel", "scopeId", "members"]
            : []),
        ]);
    }
    assert.deepEqual(
      values.map((row) => row.scopeId).sort(),
      [...new Set(selectedScopes)].filter((scope) => contextByScope.has(scope)).sort(),
      "Selected context membership changed",
    );
  };
  const verifyTotals = (value) => {
    fields(value, ["active", "waiting", "archived"]);
    for (const key of ["active", "waiting", "archived"]) count(value[key]);
    assert.equal(value.archived, roots.filter((row) => row.archived).length, "Archived status total changed");
    assert.ok(value.active + value.waiting >= roots.filter((row) => !row.archived).length);
    return { ...value };
  };
  const references = (values) => {
    assert.ok(Array.isArray(values) && values.length === (input.references ?? []).length && values.length <= 12);
    return values.map((value, i) => {
      fields(value, ["reference", "session"]);
      assert.deepEqual(value.reference, input.references[i]);
      const ref = value.reference;
      const knownMatch = [...known.values()].find((row) =>
        ref.kind === "id" ? row.id === ref.value : row.threadRef === ref.value,
      );
      if (value.session === null) assert.ok(!knownMatch, "Known authorized reference returned null");
      const row = value.session === null ? null : compact(value.session);
      if (row) assert.equal(ref.kind === "id" ? row.id : row.threadRef, ref.value);
      return { referenceHash: hash(JSON.stringify(ref)), id: row?.id ?? null, row: row ? retained(row) : null };
    });
  };
  const newRootsIn = (scopeId) =>
    dynamicActor.recurring.some(
      (family) => family.scopeId === scopeId && family.audience.includes(principalId) && family.permittedThreadFamily,
    );
  const groupRows = (sessions, dynamic) => {
    const recent = sessions.filter(navigationMatch("recent"));
    const order = [...new Set([...recent.map((row) => row.scopeId), ...contexts.map((row) => row.scopeId)])];
    return order.flatMap((scopeId) => {
      const context = contextByScope.get(scopeId);
      if (!context) return [];
      const rows = recent.filter((row) => row.scopeId === scopeId);
      const kind = context.project ? "project" : context.kind;
      if (!rows.length && ["channel", "group"].includes(kind)) return [];
      return [
        {
          id: scopeId,
          scopeId,
          name: formatter.groupName(context),
          kind,
          count: rows.length,
          at: rows.length ? Math.max(...rows.map((row) => row.at)) : context.fallbackActivity,
          dynamic:
            dynamic &&
            ((!rows.length && policy.get(scopeId).mode === "dynamic") ||
              (input.surface !== "web" && (rows.some(writable) || newRootsIn(scopeId)))),
          dynamicCount: dynamic && input.surface !== "web" && newRootsIn(scopeId),
        },
      ];
    });
  };
  const groupRetained = (row) => ({
    scopeId: row.scopeId,
    kind: row.kind,
    count: row.count,
    at: row.at,
    nameSha256: textHash(row.name),
  });

  if (request.path === "/api/contexts") {
    fields(data, ["contexts"]);
    verifyContexts(
      data.contexts,
      contexts.map((row) => row.scopeId),
      contexts.length,
    );
    outcome.kind = "contexts";
    outcome.contexts = data.contexts.map((row) => {
      const prepared = contextByScope.get(row.scopeId);
      const fallbackActivity = row.lastActivityAt ?? row.project?.createdAt ?? row.project?.updatedAt ?? 0;
      if (policy.get(row.scopeId).mode === "static-disjoint")
        assert.equal(fallbackActivity, prepared.fallbackActivity, "Static context activity changed");
      return {
        scopeId: row.scopeId,
        identitySha256: hash(JSON.stringify(contextIdentity(row))),
        fallbackActivity,
        sessionCount: row.sessionCount,
      };
    });
  } else if (request.path === "/api/sessions") {
    fields(data, ["sessions"]);
    outcome.contextResponseSha256 = contextProjection.responseBodySha256;
    outcome.legacySurface = legacySurface;
    assert.ok(Array.isArray(data.sessions));
    const rows = data.sessions.map(compact);
    unique(rows, "id");
    assert.ok(
      [...known.keys()].every((id) => observed.has(id)),
      "Legacy full list omitted prepared identity",
    );
    const web = [...rows].filter((row) => row.surface === "web").sort((a, b) => b.at - a.at);
    for (let i = 1; i < web.length; i++)
      if (web[i - 1].at === web[i].at)
        assert.ok(
          known.get(web[i - 1].id).legacyRank < known.get(web[i].id).legacyRank,
          "Legacy static tie rank changed",
        );
    const ordered = [...rows].sort((a, b) => b.at - a.at);
    for (const section of ["recent", "pinned", "archived"]) {
      const selected = ordered.filter(navigationMatch(section));
      outcome.sections[section] = {
        total: selected.length,
        nextCursorSha256: null,
        boundary: null,
        rows: selected.map(retained),
      };
    }
    const groups = groupRows(ordered, false).sort((a, b) => b.at - a.at);
    outcome.sections.groups = {
      total: groups.length,
      nextCursorSha256: null,
      boundary: null,
      rows: groups.map(groupRetained),
    };
    outcome.archivedCount = outcome.sections.archived.total;
    outcome.legacyIncomingIdsSha256 = hash(JSON.stringify(rows.map((row) => row.id)));
  } else if (request.path === "/api/session-navigation/resolve") {
    fields(data, ["references"]);
    outcome.references = references(data.references);
  } else if (request.path === "/api/session-navigation/page" && input.actionable) {
    fields(data, ["items", "total", "nextCursor", "contexts", "statusTotals", "actionable"]);
    const metadata = data.actionable;
    fields(metadata, ["parentSessionId", "parentSubagents", "depths"]);
    assert.equal(metadata.parentSessionId, input.parentSessionId, "Actionable parent differs from request");
    assert.ok(Array.isArray(data.items) && data.items.length <= 50, "Actionable page cap");
    count(data.total);
    assert.ok(data.total >= data.items.length);
    assert.ok(Array.isArray(metadata.depths) && metadata.depths.length === data.items.length);
    const rows = data.items.map(compact);
    unique(rows, "id");
    assert.ok(rows.every((row) => row.id !== input.parentSessionId && pageMatch(row)));
    assert.ok(
      data.items.every((row) => row.awaitingInput || row.working || row.lastTurnFailed),
      "Non-actionable row",
    );
    const boundary = boundaryFor("page", pageKey, input.cursor);
    assert.ok(
      rows.every((row) => after(row, boundary)),
      "Actionable cursor boundary crossed",
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      sorted(rows).map((row) => row.id),
      "Actionable order",
    );
    if (!boundary) assert.equal(data.nextCursor !== null, data.total > rows.length, "Actionable continuation mismatch");
    let next = null;
    if (data.nextCursor !== null) {
      assert.equal(rows.length, 50);
      next = cursor(data.nextCursor, pageKey);
      assert.deepEqual(next, { key: pageKey, at: rows.at(-1).at, id: rows.at(-1).id });
    }
    if (metadata.parentSubagents === null) {
      assert.equal(data.total, 0);
      assert.equal(data.nextCursor, null);
      assert.ok(!known.has(input.parentSessionId), "Prepared authorized parent unexpectedly absent");
    } else {
      fields(metadata.parentSubagents, ["running", "waiting"]);
      count(metadata.parentSubagents.running);
      count(metadata.parentSubagents.waiting);
      assert.ok(
        metadata.parentSubagents.running >= data.items.filter((row) => row.working && !row.awaitingInput).length,
      );
      assert.ok(metadata.parentSubagents.waiting >= data.items.filter((row) => row.awaitingInput).length);
    }
    const ancestry = rows.map((row, index) => {
      const depth = metadata.depths[index];
      assert.ok(Number.isSafeInteger(depth) && depth > 0, "Invalid actionable depth");
      const path = [row.id];
      const seen = new Set(path);
      let current = row;
      while (current.parentSessionId) {
        const parent = current.parentSessionId;
        assert.ok(!seen.has(parent), "Cyclic actionable ancestry");
        seen.add(parent);
        path.push(parent);
        if (parent === input.parentSessionId) {
          assert.equal(depth, path.length - 1, "Actionable depth differs from observed ancestry");
          return { id: row.id, depth, pathSha256: hash(JSON.stringify(path)), status: "observed-chain" };
        }
        current = observed.get(parent) ?? known.get(parent);
        if (!current) {
          assert.ok(depth > path.length - 1, "Missing intermediate cannot have the reported shallow depth");
          return {
            id: row.id,
            depth,
            pathSha256: hash(JSON.stringify(path)),
            status: "unsupported-missing-ancestor",
            missingParentSessionId: parent,
          };
        }
      }
      assert.fail("Actionable row belongs to another root/family");
    });
    outcome.sections.page = {
      total: data.total,
      nextCursorSha256: data.nextCursor === null ? null : hash(data.nextCursor),
      boundary: next,
      rows: rows.map(retained),
    };
    outcome.actionable = {
      parentSessionId: input.parentSessionId,
      parentIdentity: known.has(input.parentSessionId) ? retained(known.get(input.parentSessionId)) : null,
      parentSubagents: metadata.parentSubagents,
      ancestry,
    };
    verifyContexts(data.contexts, [...rows.map((row) => row.scopeId), ...(input.scopeId ? [input.scopeId] : [])], 51);
    outcome.statusTotals = verifyTotals(data.statusTotals);
    outcome.missing.push(
      "Actionable current membership/state and full parent summary require released response/native joins",
    );
    if (!known.has(input.parentSessionId))
      outcome.missing.push("Actionable parent identity absent from prepared observations");
    if (ancestry.some((row) => row.status !== "observed-chain"))
      outcome.missing.push("Unsupported actionable ancestry needs exact native mapping");
  } else if (request.path === "/api/session-navigation/page") {
    fields(data, ["items", "total", "nextCursor", "contexts", "statusTotals"]);
    outcome.sections.page = projectPage(
      "page",
      { items: data.items, total: data.total, nextCursor: data.nextCursor },
      pageKey,
      input.cursor,
      pageMatch,
    );
    verifyContexts(
      data.contexts,
      [...data.items.map((row) => row.scopeId), ...(input.scopeId ? [input.scopeId] : [])],
      51,
    );
    outcome.statusTotals = verifyTotals(data.statusTotals);
  } else {
    fields(data, [
      "recent",
      "pinned",
      "groups",
      "archived",
      "archivedCount",
      "contexts",
      "statusTotals",
      "references",
      "startup",
    ]);
    assert.equal(data.archived === undefined, input.section !== "archived");
    for (const section of ["recent", "pinned", ...(data.archived ? ["archived"] : [])]) {
      assert.ok(Array.isArray(data[section]?.items) && data[section].items.length <= 50);
      data[section].items.forEach(compact);
    }
    outcome.references = references(data.references);
    fields(data.startup, ["hasSessions", "hasNonCronSessions", "oldestPersonalThreadRef", "latest"]);
    const latest = data.startup.latest === null ? null : compact(data.startup.latest);
    for (const section of ["recent", "pinned", ...(data.archived ? ["archived"] : [])])
      outcome.sections[section] = projectPage(
        section,
        data[section],
        navKey(section),
        input.section === section ? input.cursor : undefined,
        navigationMatch(section),
      );
    fields(data.groups, ["items", "total", "nextCursor"]);
    assert.ok(Array.isArray(data.groups.items) && data.groups.items.length <= 50);
    count(data.groups.total);
    const knownGroups = groupRows([...known.values()], true);
    const lowerGroups = groupRows([...new Map([...known, ...observed]).values()], true);
    const byScope = new Map(lowerGroups.map((row) => [row.scopeId, row]));
    const groups = data.groups.items.map((value) => {
      fields(value, ["scopeId", "name", "kind", "count", "lastActivityAt"]);
      let expected = byScope.get(value.scopeId);
      if (!expected && input.surface !== "web" && newRootsIn(value.scopeId)) {
        const context = contextByScope.get(value.scopeId);
        assert.ok(context, "New group context absent");
        expected = {
          id: value.scopeId,
          scopeId: value.scopeId,
          name: formatter.groupName(context),
          kind: context.project ? "project" : context.kind,
          count: 0,
          at: 0,
          dynamic: true,
          dynamicCount: true,
        };
      }
      assert.ok(expected, "Unknown or ineligible group");
      assert.equal(value.name, expected.name);
      assert.equal(value.kind, expected.kind);
      count(value.count);
      if (["channel", "group"].includes(value.kind)) assert.ok(value.count > 0, "Empty ordinary group must be omitted");
      finite(value.lastActivityAt);
      if (!expected.dynamicCount) assert.equal(value.count, expected.count, "Group count changed");
      else assert.ok(value.count >= expected.count, "Group count below known identities");
      if (!expected.dynamic) assert.equal(value.lastActivityAt, expected.at, "Static group activity changed");
      else if (expected.count) assert.ok(value.lastActivityAt >= expected.at, "Group activity below known members");
      return { ...expected, count: value.count, at: value.lastActivityAt };
    });
    unique(groups, "scopeId");
    const key = navKey("groups");
    const boundary = boundaryFor("groups", key, input.section === "groups" ? input.cursor : undefined);
    assert.ok(groups.every((row) => after(row, boundary)));
    const candidates = new Map(knownGroups.filter((row) => !row.dynamic).map((row) => [row.id, row]));
    for (const row of groups) candidates.set(row.id, row);
    const expected = sorted([...candidates.values()].filter((row) => after(row, boundary)));
    assert.deepEqual(
      groups.map((row) => row.id),
      expected.slice(0, 50).map((row) => row.id),
      "Immutable group merge order",
    );
    assert.ok(data.groups.total >= new Set([...lowerGroups, ...groups].map((row) => row.id)).size);
    const exactGroups = input.surface === "web" || !contexts.some((context) => newRootsIn(context.scopeId));
    if (exactGroups) assert.equal(data.groups.total, knownGroups.length, "Immutable group total changed");
    if ((!boundary && data.groups.total > groups.length) || expected.length > groups.length)
      assert.ok(data.groups.nextCursor !== null, "Missing group continuation");
    if (exactGroups && (!boundary || knownGroups.every((row) => !row.dynamic)))
      assert.equal(
        data.groups.nextCursor !== null,
        (boundary ? expected.length : knownGroups.length) > groups.length,
        "Immutable group continuation differs from exact remaining groups",
      );
    let next = null;
    if (data.groups.nextCursor !== null) {
      assert.equal(groups.length, 50);
      next = cursor(data.groups.nextCursor, key);
      assert.deepEqual(next, { key, at: groups.at(-1).at, id: groups.at(-1).id });
    }
    outcome.sections.groups = {
      total: data.groups.total,
      nextCursorSha256: data.groups.nextCursor === null ? null : hash(data.groups.nextCursor),
      boundary: next,
      rows: groups.map(groupRetained),
    };
    count(data.archivedCount);
    const archivedLower = [...known.values()].filter(navigationMatch("archived")).length;
    assert.equal(data.archivedCount, archivedLower, "Archived count changed without an admitted mutation");
    outcome.archivedCount = data.archivedCount;
    verifyContexts(
      data.contexts,
      [...observed.values()].map((row) => row.scopeId).concat(groups.map((row) => row.scopeId)),
      data.archived ? 213 : 163,
    );
    outcome.statusTotals = verifyTotals(data.statusTotals);
    for (const key of ["hasSessions", "hasNonCronSessions"]) {
      assert.equal(typeof data.startup[key], "boolean");
      const actualLower =
        key === "hasSessions"
          ? observed.size > 0
          : [...observed.values()].some((row) => !row.threadRef.startsWith("cron:"));
      if (commonActor.startup[key] || actualLower)
        assert.equal(data.startup[key], true, "Startup truth lower bound changed");
    }
    assert.equal(
      data.startup.oldestPersonalThreadRef,
      commonActor.startup.oldestPersonalThreadRef,
      "Immutable oldest personal web changed",
    );
    if (known.size) assert.ok(latest, "Latest omitted");
    if (latest)
      assert.equal(
        sorted([...new Map([...known].filter(([, row]) => !writable(row)).concat([...observed])).values()])[0].id,
        latest.id,
        "Latest below known immutable row",
      );
    outcome.startup = {
      hasSessions: data.startup.hasSessions,
      hasNonCronSessions: data.startup.hasNonCronSessions,
      oldestPersonalThreadRefSha256:
        data.startup.oldestPersonalThreadRef === null ? null : hash(data.startup.oldestPersonalThreadRef),
      latestId: latest?.id ?? null,
      latest: latest ? retained(latest) : null,
    };
  }
  outcome.unresolved = [...unresolved.values()];
  if (outcome.unresolved.length)
    outcome.missing.push(
      "Provisional recurring/descendant identities require exact native history/audience reconciliation",
    );
  if (outcome.unresolved.some((row) => row.identityMapping.kind === "unsupported-descendant"))
    outcome.missing.push("Unsupported observed descendant ancestry: cannot qualify before explicit native mapping");
  assert.ok(Buffer.byteLength(JSON.stringify(outcome)) <= CAP, "Retained projection output exceeds 4 MiB");
  return outcome;
}
