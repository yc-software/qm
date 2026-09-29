import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sidebarFormatter } from "./sidebar-format.mjs";
import { projectSidebarResponse } from "./sidebar-response.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const encoded = (value) => JSON.stringify(value);
const normalized = (value) => value.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
const unique = (rows, key = "id") => [...new Map(rows.map((row) => [row[key], row])).values()];
const compareId = (a, b) => (a.id < b.id ? -1 : Number(a.id !== b.id));
const ordered = (rows, bounded) => [...rows].sort((a, b) => b.at - a.at || (bounded ? compareId(a, b) : 0));
const source = ({ entry }, section) => ({
  generation: entry.sidebarCapture.generation,
  sequence: entry.sidebarCapture.sequence,
  role: entry.sidebarCapture.role,
  responseAt: entry.responseAt,
  responseBodySha256: entry.responseBodySha256,
  projectionSha256: entry.sidebarProjection.projectionSha256,
  requestIntentSha256: entry.sidebarCapture.requestIntentSha256,
  ...(section ? entry.sidebarCapture.chains.find((binding) => binding.section === section) : {}),
});
const rawRows = (data) => [
  ...(data.sessions ?? []),
  ...(data.items ?? []),
  ...["recent", "pinned", "archived"].flatMap((section) => data[section]?.items ?? []),
  ...(data.references ?? []).flatMap((reference) => (reference.session ? [reference.session] : [])),
  ...(data.startup?.latest ? [data.startup.latest] : []),
];

function sidebarDomExpected(
  state,
  sidebar,
  { limit = 50, retainedIds = [], archived = false, archivedLimit = 50 } = {},
) {
  for (const count of [limit, archivedLimit])
    assert.ok(Number.isSafeInteger(count) && count >= 50 && count <= 5000 && count % 50 === 0);
  assert.ok(
    Array.isArray(retainedIds) &&
      retainedIds.length <= 12 &&
      retainedIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 512),
  );
  assert.equal(typeof archived, "boolean");
  assert.ok(["web", "all"].includes(sidebar.surface));
  const bounded = sidebar.profile.transport === "navigation-post";
  const records = state.records
    .filter((record) => record.entry.completed && record.entry.status === 200)
    .sort((a, b) => a.entry.sidebarCapture.sequence - b.entry.sidebarCapture.sequence);
  for (const record of records) {
    assert.deepEqual(record.projection.profile, sidebar.profile, "Current sidebar source profile changed");
    assert.equal(record.projection.principalId, sidebar.principalId, "Current sidebar actor changed");
  }
  const current = (record, section) => {
    const binding = record.entry.sidebarCapture.chains.find((item) => item.section === section);
    return binding && state.chains.get(binding.keySha256) === binding.chainSequence;
  };
  const sections = {},
    sectionSources = {},
    groupPages = new Map(),
    groupPageSources = [],
    referenceSources = [],
    entitySources = [];
  let full,
    contextSource = null,
    legacyProjection = null;
  if (bounded) {
    full = records.findLast((record) => record.entry.sidebarCapture.role === "navigation-refresh");
    if (!full || (full.request.body.surface ?? "all") !== sidebar.surface) return null;
    for (const section of ["recent", "pinned", "groups", "archived"]) {
      const relevant = records.filter(
        (record) =>
          record.request.path === "/api/session-navigation" &&
          (record.request.body.surface ?? "all") === sidebar.surface &&
          current(record, section) &&
          record.projection.sections[section],
      );
      sectionSources[section] = relevant.map((record) => source(record, section));
      for (const record of relevant) {
        const page = record.projection.sections[section];
        sections[section] = {
          ...page,
          rows: unique(
            [...(record.request.body.cursor ? (sections[section]?.rows ?? []) : []), ...page.rows],
            section === "groups" ? "scopeId" : "id",
          ),
        };
      }
    }
    if (!["recent", "pinned", "groups"].every((section) => sections[section])) return null;
    if (archived && full.projection.archivedCount > 0 && !sections.archived) return null;
    for (const record of records) {
      const input = record.request.body;
      if (
        record.entry.sidebarCapture.role !== "session-page" ||
        !current(record, "page") ||
        record.entry.sidebarCapture.sequence < full.entry.sidebarCapture.sequence ||
        input.actionable ||
        !input.scopeId ||
        input.children ||
        input.parentSessionId ||
        input.archived !== false ||
        input.pinned !== false ||
        (input.surface ?? "all") !== sidebar.surface
      )
        continue;
      const prior = groupPages.get(input.scopeId),
        page = record.projection.sections.page;
      groupPages.set(input.scopeId, {
        ...page,
        rows: unique([...(input.cursor ? (prior?.rows ?? []) : []), ...page.rows]),
      });
      groupPageSources.push({ scopeId: input.scopeId, ...source(record, "page") });
    }
  } else {
    full = records.findLast((record) => record.request.path === "/api/sessions");
    const context = records.findLast((record) => record.request.path === "/api/contexts");
    if (!full || !context) return null;
    legacyProjection = projectSidebarResponse({
      data: full.data,
      responseBody: { bytes: full.entry.responseBodyBytes, sha256: full.entry.responseBodySha256 },
      request: full.request,
      commonActor: sidebar.commonActor,
      dynamicActor: sidebar.dynamicActor,
      profile: sidebar.profile,
      principalId: sidebar.principalId,
      legacySurface: sidebar.surface,
      contextProjection: context.projection,
    });
    Object.assign(sections, legacyProjection.sections);
    for (const section of Object.keys(sections)) sectionSources[section] = [source(full)];
    contextSource = source(context);
  }
  const formatter = sidebarFormatter(sidebar.dynamicActor.contexts, sidebar.profile);
  const entities = new Map();
  const stable = [
    ...sidebar.commonActor.preparedWeb,
    ...sidebar.commonActor.preparedOffPageWeb,
    ...sidebar.dynamicActor.preparedNonWeb.filter((row) => !row.mutableFields?.length),
  ];
  for (const row of stable)
    entities.set(row.id, {
      ...row,
      threadRefSha256: hash(row.threadRef),
      titleSha256: hash(normalized(row.title)),
      groupedTitleSha256: hash(normalized(row.groupedTitle)),
      labels: { title: normalized(row.title), groupedTitle: normalized(row.groupedTitle) },
    });
  const remember = (record, rows) => {
    const raw = new Map(rawRows(record.data).map((row) => [row.id, row]));
    for (const row of rows) {
      const actual = raw.get(row.id);
      assert.ok(actual, "Applied row has no captured raw source");
      const labels = formatter.labeled(actual);
      assert.equal(hash(normalized(labels.title)), row.titleSha256);
      assert.equal(hash(normalized(labels.groupedTitle)), row.groupedTitleSha256);
      entities.set(row.id, {
        ...row,
        labels: { title: normalized(labels.title), groupedTitle: normalized(labels.groupedTitle) },
      });
    }
  };
  for (const record of state.records.filter((item) => item.entry.completed && item.entry.status === 200)) {
    if (!bounded) {
      if (record === full)
        remember(
          record,
          ["recent", "pinned", "archived"].flatMap((key) => record.projection.sections[key].rows),
        );
      continue;
    }
    for (const section of ["recent", "pinned", "archived", "page"]) {
      if (current(record, section) && record.projection.sections[section]) {
        remember(record, record.projection.sections[section].rows);
        if (section === "page") entitySources.push(source(record, "page"));
      }
    }
    if (current(record, "page") && record.projection.actionable?.parentSubagents === null)
      entities.delete(record.projection.actionable.parentSessionId);
    if (record === full || record.entry.sidebarCapture.role === "resolve") {
      const refs = record.projection.references;
      remember(
        record,
        refs.flatMap((ref) => (ref.row ? [ref.row] : [])),
      );
      if (refs.length) referenceSources.push(source(record));
      if (record === full && record.projection.startup?.latest) remember(record, [record.projection.startup.latest]);
      for (const [index, ref] of refs.entries())
        if (ref.row === null) {
          const input = record.request.body.references[index];
          for (const [id, row] of entities)
            if (input.kind === "id" ? id === input.value : row.threadRefSha256 === hash(input.value))
              entities.delete(id);
        }
    }
  }
  const visible = (row) => row.parentSessionId === null && (sidebar.surface !== "web" || row.surface === "web");
  const kept = retainedIds
    .map((id) => {
      const row = entities.get(id);
      assert.ok(row, "Unobserved retained sidebar identity");
      return row;
    })
    .filter(visible);
  const readRows = (section) =>
    (sections[section]?.rows ?? []).flatMap((row) => (entities.has(row.id) ? [entities.get(row.id)] : []));
  const recentAll = readRows("recent").filter((row) => !row.archived && !row.pinned),
    pinned = readRows("pinned").filter((row) => row.pinned && !row.archived),
    archivedAll = readRows("archived").filter((row) => row.archived);
  if (bounded && sections.recent.rows.length !== Math.min(limit, sections.recent.total)) return null;
  if (
    bounded &&
    archived &&
    sections.archived &&
    sections.archived.rows.length !== Math.min(archivedLimit, sections.archived.total)
  )
    return null;
  const recentPage = bounded ? recentAll : recentAll.slice(0, limit);
  const groupRows = [...groupPages.values()].flatMap((page) =>
    page.rows.flatMap((row) => (entities.has(row.id) ? [entities.get(row.id)] : [])),
  );
  const shown = unique(
    [...recentPage, ...groupRows, ...kept.filter((row) => !row.archived && !row.pinned)],
    "threadRefSha256",
  );
  const groups = sections.groups.rows.filter(
    (group) => bounded || group.count === 0 || shown.some((row) => row.scopeId === group.scopeId),
  );
  const scopes = new Set(groups.map((group) => group.scopeId));
  const contextByScope = new Map(sidebar.dynamicActor.contexts.map((context) => [context.scopeId, context]));
  const groupName = (group) => {
    const name = formatter.groupName(contextByScope.get(group.scopeId));
    assert.equal(name === null ? null : hash(normalized(name)), group.nameSha256);
    return normalized((name ?? { channel: "Channel", group: "Group DM" }[group.kind] ?? "Project").replace(/^#/, ""));
  };
  const groupByScope = new Map(groups.map((group) => [group.scopeId, group]));
  const top = [];
  if (bounded) {
    top.push(
      ...groups.map((group) => ({ kind: "group", id: group.scopeId, at: group.at })),
      ...shown.filter((row) => !scopes.has(row.scopeId)).map((row) => ({ kind: "row", id: row.id, at: row.at })),
    );
  } else {
    const seen = new Set();
    for (const row of recentAll) {
      const group = groupByScope.get(row.scopeId);
      if (group && !seen.has(group.scopeId)) {
        top.push({ kind: "group", id: group.scopeId, at: group.at });
        seen.add(group.scopeId);
      } else if (!group && shown.some((shownRow) => shownRow.id === row.id))
        top.push({ kind: "row", id: row.id, at: row.at });
    }
    for (const group of groups)
      if (!seen.has(group.scopeId)) top.push({ kind: "group", id: group.scopeId, at: group.at });
  }
  top.sort((a, b) => b.at - a.at);
  const title = (row, grouped = false) => ({ id: row.id, title: row.labels[grouped ? "groupedTitle" : "title"] });
  const recent = [];
  for (const item of top) {
    if (item.kind === "row") recent.push({ ...title(entities.get(item.id)), group: "" });
    else
      for (const row of ordered(
        shown.filter((row) => row.scopeId === item.id),
        bounded,
      ))
        recent.push({ ...title(row, true), group: item.id });
  }
  const archivedRows = archived
    ? unique(
        [
          ...(bounded ? archivedAll : archivedAll.slice(0, archivedLimit)),
          ...kept.filter((row) => row.archived && archivedAll.some((entry) => entry.id === row.id)),
        ],
        "threadRefSha256",
      )
    : [];
  let legacyEmptyMessage = null;
  if (!bounded && sections.recent.total + sections.pinned.total + sections.archived.total === 0)
    legacyEmptyMessage = full.data.sessions.length ? "Slack conversations hidden." : "No conversations yet.";
  const expected = {
    transport: sidebar.profile.transport,
    ...(!bounded ? { legacyEmptyMessage } : {}),
    recent,
    pinned: pinned.map((row) => title(row)),
    archived: archivedRows.map((row) => title(row)),
    groups: top
      .filter((item) => item.kind === "group")
      .map((item) => groupByScope.get(item.id))
      .map((group) => {
        const more =
          bounded &&
          (groupPages.has(group.scopeId)
            ? Boolean(groupPages.get(group.scopeId).nextCursorSha256)
            : group.count > shown.filter((row) => row.scopeId === group.scopeId).length);
        const rawName =
          formatter.groupName(contextByScope.get(group.scopeId)) ??
          { channel: "Channel", group: "Group DM" }[group.kind] ??
          "Project";
        return {
          scopeId: group.scopeId,
          name: groupName(group),
          count: group.count,
          more,
          moreLabel: more ? normalized(`Show more in ${rawName}`) : null,
        };
      }),
    top: top.map(({ kind, id }) => ({ kind, id })),
    archivedOpen: archived,
    archivedCount: bounded ? full.projection.archivedCount : sections.archived.total,
    totals: Object.fromEntries(["recent", "pinned", "groups"].map((section) => [section, sections[section].total])),
    loaded: {
      recent: bounded ? sections.recent.rows.length : recentPage.length,
      pinned: bounded ? sections.pinned.rows.length : pinned.length,
      groups: bounded ? sections.groups.rows.length : groups.length,
    },
    more: {
      recent: bounded
        ? Boolean(sections.recent.nextCursorSha256)
        : recentAll.some((row, index) => index >= limit && !retainedIds.includes(row.id)),
      pinned: bounded && Boolean(sections.pinned.nextCursorSha256),
      groups: bounded && Boolean(sections.groups.nextCursorSha256),
      archived:
        archived &&
        (bounded
          ? Boolean(sections.archived?.nextCursorSha256)
          : archivedAll.some((row, index) => index >= archivedLimit && !retainedIds.includes(row.id))),
    },
  };
  assert.ok(Buffer.byteLength(encoded(expected)) <= 4194304, "Rendered sidebar projection exceeds response bound");
  return {
    expected,
    sectionSources,
    groupPageSources,
    referenceSources,
    entitySources,
    contextSource,
    legacyProjectionSha256: legacyProjection ? hash(encoded(legacyProjection)) : null,
    missing: [...new Set(records.flatMap((record) => record.projection.missing))],
  };
}

function sidebarDomMatches(expected) {
  const root = globalThis.document.querySelector("#sidebar-body");
  const visible = (element) => Boolean(element?.getClientRects().length);
  if (!visible(root)) return false;
  const label = (value) => value?.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const bounded = expected.transport === "navigation-post";
  if (bounded) {
    if (
      root.dataset.sessionNavigation !== "ready" ||
      root.dataset.sessionNavigationMode !== "bounded" ||
      root.getAttribute("aria-busy") !== "false" ||
      root.dataset.sessionNavigationPending !== ""
    )
      return false;
    for (const section of ["recent", "pinned", "groups"]) {
      const suffix = section[0].toUpperCase() + section.slice(1);
      if (
        root.dataset[`session${suffix}Loaded`] !== String(expected.loaded[section]) ||
        root.dataset[`session${suffix}Total`] !== String(expected.totals[section])
      )
        return false;
    }
  }
  const scope = (element) => {
    if (!element) return "";
    if (bounded) return element.dataset.scopeId;
    const key = element.querySelector(".recent-project-menu [data-menu-id]")?.getAttribute("data-menu-id");
    return key?.startsWith("project:") ? key.slice(8) : undefined;
  };
  const rows = [...root.querySelectorAll(".session-row[data-session-id]")].filter(visible);
  if (new Set(rows.map((row) => row.dataset.sessionId)).size !== rows.length) return false;
  const actual = { recent: [], pinned: [], archived: [], groups: [], top: [] };
  for (const row of rows) {
    const link = row.querySelector("a.session");
    if (!visible(link) || link.getAttribute("aria-busy") === "true") return false;
    const item = { id: row.dataset.sessionId, title: label(row.querySelector(".tl")?.textContent) };
    if (row.closest(".archived-children")) actual.archived.push(item);
    else if (row.closest(".pinned-children")) actual.pinned.push(item);
    else actual.recent.push({ ...item, group: scope(row.closest("section.recent-project")) });
  }
  for (const element of [...root.querySelectorAll("section.recent-project")].filter(visible)) {
    const toggle = element.querySelector(".recent-project-toggle");
    if (!visible(toggle) || toggle.getAttribute("aria-expanded") !== "true") return false;
    const scopeId = scope(element);
    const controls = [...element.querySelectorAll('[data-session-page="group"]')].filter(visible);
    if (
      controls.length > 1 ||
      controls.some(
        (button) =>
          button.dataset.scopeId !== scopeId || button.disabled || button.getAttribute("aria-disabled") === "true",
      )
    )
      return false;
    const countText = label(element.querySelector(".recent-project-count")?.textContent);
    if (countText !== String(Number(countText))) return false;
    actual.groups.push({
      scopeId,
      name: label(element.querySelector(".recent-project-name")?.textContent),
      count: Number(countText),
      more: controls.length === 1,
      moreLabel: controls.length ? label(controls[0].textContent) : null,
    });
  }
  for (const element of [...root.querySelectorAll("section.recent-project,.session-row[data-session-id]")].filter(
    visible,
  )) {
    if (element.closest(".pinned-children,.archived-children")) continue;
    if (element.matches("section.recent-project")) actual.top.push({ kind: "group", id: scope(element) });
    else if (!element.closest("section.recent-project"))
      actual.top.push({ kind: "row", id: element.dataset.sessionId });
  }
  for (const key of ["recent", "pinned", "archived", "groups", "top"])
    if (!same(actual[key], expected[key])) return false;
  for (const section of ["recent", "pinned", "groups", "archived"]) {
    const controls = bounded
      ? [...root.querySelectorAll(`[data-session-page="${section}"]`)].filter(visible)
      : [...root.querySelectorAll("button")].filter(
          (button) =>
            visible(button) &&
            ["recent", "archived"].includes(section) &&
            button.textContent.trim() ===
              (section === "recent" ? "Show more conversations" : "Show more archived conversations"),
        );
    const text = {
      recent: "Show more conversations",
      pinned: "Show more pinned conversations",
      groups: "Show more conversation groups",
      archived: "Show more archived conversations",
    }[section];
    if (
      controls.length !== Number(expected.more[section]) ||
      controls.some(
        (button) =>
          button.disabled || button.getAttribute("aria-disabled") === "true" || label(button.textContent) !== text,
      )
    )
      return false;
  }
  const archiveCounts = [...root.querySelectorAll(".archived-count")].filter(visible);
  if (archiveCounts.length !== Number(expected.archivedCount > 0)) return false;
  if (archiveCounts.length) {
    const toggle = archiveCounts[0].closest("button.archived-toggle");
    if (
      !toggle ||
      toggle.disabled ||
      toggle.classList.contains("open") !== expected.archivedOpen ||
      archiveCounts[0].textContent.trim() !== String(expected.archivedCount)
    )
      return false;
  }
  if (
    [...root.querySelectorAll(".archived-children")].filter(visible).length !==
    Number(expected.archivedOpen && expected.archivedCount > 0)
  )
    return false;
  if ([...root.querySelectorAll('[role="alert"]')].some(visible)) return false;
  if (!bounded) {
    const messages = [...root.querySelectorAll(".empty")].filter(visible).map((element) => label(element.textContent));
    if (!same(messages, expected.legacyEmptyMessage === null ? [] : [expected.legacyEmptyMessage])) return false;
  }
  return actual;
}

export async function waitSidebarDom(page, snapshot, sidebar, options = {}) {
  const { timeoutMs = 15000, ...view } = options;
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
  const deadline = performance.now() + timeoutMs;
  let prepared, preparedVersion, preparedGeneration;
  for (;;) {
    const remaining = deadline - performance.now();
    assert.ok(remaining > 0, "Dynamic sidebar responses and rendered contents did not settle");
    const state = snapshot();
    assert.deepEqual(state.errors, [], "Sidebar readiness observed a request error");
    if (!state.ready) prepared = null;
    else if (!prepared || preparedVersion !== state.version || preparedGeneration !== state.generation) {
      prepared = sidebarDomExpected(state, sidebar, view);
      preparedVersion = state.version;
      preparedGeneration = state.generation;
    }
    if (!prepared) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
      continue;
    }
    let actual;
    try {
      const handle = await page.waitForFunction(sidebarDomMatches, prepared.expected, {
        timeout: Math.min(100, remaining),
      });
      try {
        actual = await handle.jsonValue();
      } finally {
        await handle.dispose();
      }
    } catch (error) {
      if (error.name === "TimeoutError") continue;
      throw error;
    }
    const after = snapshot();
    assert.deepEqual(after.errors, [], "Sidebar readiness observed a request error");
    if (!after.ready || after.version !== state.version || after.generation !== state.generation) continue;
    const rows = (values) => ({
      count: values.length,
      idsSha256: hash(encoded(values.map((row) => row.id))),
      rowsSha256: hash(encoded(values)),
    });
    const result = {
      schemaVersion: 1,
      qualified: false,
      profile: sidebar.profile,
      principalId: sidebar.principalId,
      surface: sidebar.surface,
      generation: state.generation,
      version: state.version,
      sectionSources: prepared.sectionSources,
      groupPageSources: prepared.groupPageSources,
      referenceSources: prepared.referenceSources,
      entitySources: prepared.entitySources,
      contextSource: prepared.contextSource,
      legacyProjectionSha256: prepared.legacyProjectionSha256,
      expectedSha256: hash(encoded(prepared.expected)),
      dom: {
        recent: rows(actual.recent),
        pinned: rows(actual.pinned),
        archived: rows(actual.archived),
        groups: {
          count: actual.groups.length,
          scopeIdsSha256: hash(encoded(actual.groups.map((row) => row.scopeId))),
          rowsSha256: hash(encoded(actual.groups)),
        },
        topLevelSha256: hash(encoded(actual.top)),
        totals: prepared.expected.totals,
        loaded: prepared.expected.loaded,
        more: prepared.expected.more,
        archivedOpen: prepared.expected.archivedOpen,
        archivedCount: prepared.expected.archivedCount,
      },
      missing: [
        ...new Set([...prepared.missing, "Dynamic sidebar identities require admitted native history reconciliation"]),
      ],
    };
    assert.ok(
      Buffer.byteLength(encoded(result)) <= 4194304,
      "Sidebar DOM evidence exceeds the existing response bound",
    );
    return structuredClone(result);
  }
}

export function pruneSidebarDomRecords(records, chains, surface) {
  const latest = (predicate) =>
    records
      .filter(predicate)
      .reduce(
        (found, record) =>
          !found || record.entry.sidebarCapture.sequence > found.entry.sidebarCapture.sequence ? record : found,
        null,
      );
  const legacy = latest((record) => record.request.path === "/api/sessions");
  const contexts = latest((record) => record.request.path === "/api/contexts");
  const refresh = latest(
    (record) =>
      record.entry.sidebarCapture.role === "navigation-refresh" && (record.request.body.surface ?? "all") === surface,
  );
  const refs = new Map();
  for (const record of [...records].sort((a, b) => a.entry.sidebarCapture.sequence - b.entry.sidebarCapture.sequence)) {
    if (record.entry.sidebarCapture.role === "resolve")
      for (const reference of record.projection.references) refs.set(reference.referenceHash, record);
  }
  const referenced = new Set(refs.values());
  const kept = records.filter((record) => {
    if (record === legacy || record === contexts || referenced.has(record)) return true;
    const page = record.entry.sidebarCapture.role === "session-page";
    if (!page && (record.request.body?.surface ?? "all") !== surface) return false;
    if (
      page &&
      record.request.body.scopeId &&
      !record.request.body.children &&
      !record.request.body.parentSessionId &&
      record.request.body.archived === false &&
      record.request.body.pinned === false &&
      record.entry.sidebarCapture.sequence < (refresh?.entry.sidebarCapture.sequence ?? 0)
    )
      return false;
    return record.entry.sidebarCapture.chains.some(
      (binding) => chains.get(binding.keySha256) === binding.chainSequence,
    );
  });
  records.splice(0, records.length, ...kept);
}
