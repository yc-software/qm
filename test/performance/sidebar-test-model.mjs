import { projectSidebarResponse } from "./sidebar-response.mjs";
import { createHash } from "node:crypto";
import { sidebarFormatter, sidebarSurface } from "./sidebar-format.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const profile = (transport = "navigation-post") => ({
  transport,
  sourceRevision: (transport === "navigation-post" ? "a" : "b").repeat(40),
});
const captured = (data) => {
  const raw = Buffer.from(JSON.stringify(data));
  return {
    data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
    responseBody: { bytes: raw.length, sha256: sha(raw) },
  };
};
const order = (rows, key = "id", at = "lastActivityAt") =>
  [...rows].sort((a, b) => b[at] - a[at] || (a[key] < b[key] ? -1 : Number(a[key] !== b[key])));
const page = (items, key, raw) => {
  const boundary = raw ? JSON.parse(Buffer.from(raw, "base64url").toString()) : null;
  const sorted = order(items);
  const remaining = sorted.filter(
    (row) =>
      !boundary || row.lastActivityAt < boundary.at || (row.lastActivityAt === boundary.at && row.id > boundary.id),
  );
  const selected = remaining.slice(0, 50);
  return {
    items: selected,
    total: items.length,
    nextCursor:
      remaining.length > 50
        ? Buffer.from(JSON.stringify({ key, at: selected.at(-1).lastActivityAt, id: selected.at(-1).id })).toString(
            "base64url",
          )
        : null,
  };
};
function model(transport = "navigation-post", recentCount = 115) {
  const contexts = Array.from({ length: 62 }, (_, i) => ({
    scopeId: i ? `project:${String(i).padStart(3, "0")}` : "personal:actor",
    kind: "personal",
    name: null,
    sessionCount: 0,
    lastActivityAt: 100 - i,
    ...(i ? { project: { id: `p${i}`, name: ` Project ${i} `, ownerId: "actor", createdAt: 1, updatedAt: 2 } } : {}),
  }));
  contexts.push({ scopeId: "channel:new", kind: "channel", name: "shared", sessionCount: 0, lastActivityAt: 0 });
  const row = (id, extra = {}) => ({
    id,
    type: "dm",
    scopeId: "personal:actor",
    threadRef: `web:actor:${id}`,
    title: `Title ${id}`,
    createdAt: 10,
    lastActivityAt: 1000,
    ...extra,
  });
  const rows = Array.from({ length: recentCount }, (_, i) =>
    row(`web-${String(i).padStart(3, "0")}`, {
      scopeId: contexts[i % 62].scopeId,
      lastActivityAt: 1000 - Math.floor(i / 3),
    }),
  );
  rows.push(
    ...Array.from({ length: 55 }, (_, i) =>
      row(`pin-${String(i).padStart(3, "0")}`, { pinned: true, lastActivityAt: 700 - i }),
    ),
  );
  rows.push(
    ...Array.from({ length: 53 }, (_, i) =>
      row(`archive-${String(i).padStart(3, "0")}`, { archived: true, lastActivityAt: 500 - i }),
    ),
  );
  rows.push(
    row("child", {
      parentSessionId: "web-000",
      threadRef: "agent:main:subagent:old",
      surface: "web",
      lastActivityAt: 900,
    }),
  );
  rows.push(row("slack", { threadRef: "dm:D1", lastActivityAt: 1100 }));
  rows.push(row("unwritten", { threadRef: "cron:old:fire:000000000000", lastActivityAt: 800 }));
  const selected = profile(transport);
  const formatter = sidebarFormatter(contexts, selected);
  const webRows = rows.filter(formatter.isWeb);
  const compact = (value) => ({
    ...formatter.labeled(value),
    threadRef: value.threadRef,
    createdAt: value.createdAt,
    at: value.lastActivityAt,
    legacyRank: (formatter.isWeb(value) ? webRows : rows).indexOf(value),
    archived: !!value.archived,
    pinned: !!value.pinned,
    parentSessionId: value.parentSessionId ?? null,
    type: value.type,
    channelName: value.channelName ?? null,
    surface: sidebarSurface(value),
  });
  const stable = contexts
    .map((value) => ({
      scopeId: value.scopeId,
      kind: value.kind,
      name: value.name,
      project: value.project ? { id: value.project.id, name: value.project.name } : null,
    }))
    .sort((a, b) => (a.scopeId < b.scopeId ? -1 : 1));
  const family = (id, scopeId) => ({
    definitionId: id,
    scopeId,
    audience: ["actor"],
    permittedThreadFamily: `cron:${id}:fire:`,
    finiteOccurrenceBinding: sha(id),
    origins: [],
    children: [{ occurrenceId: `${id}:0`, scopeId }],
  });
  const recurring = [family("definition", "personal:actor"), family("channel", "channel:new")];
  const commonActor = {
    preparedWeb: webRows.map(compact),
    preparedOffPageWeb: [compact(webRows.find((value) => value.id === "child"))],
    contexts: stable,
    startup: { hasSessions: true, hasNonCronSessions: true, oldestPersonalThreadRef: "web:actor:archive-000" },
  };
  const dynamicActor = {
    preparedNonWeb: rows
      .filter((value) => !formatter.isWeb(value))
      .map((value) => ({ ...compact(value), mutableFields: ["at", "title", "groupedTitle"] })),
    allowedOffPageRows: [compact(rows.find((value) => value.id === "child"))],
    contexts: stable.map((value) => ({
      ...value,
      fallbackActivity: contexts.find((raw) => raw.scopeId === value.scopeId).lastActivityAt,
    })),
    recurring,
    scopePolicy: stable.map((value) => ({
      scopeId: value.scopeId,
      mode: recurring.some((family) => family.scopeId === value.scopeId) ? "dynamic" : "static-disjoint",
      writeEvidence:
        value.scopeId === "personal:actor"
          ? [
              { kind: "direct", id: "write", sessionId: "slack", threadRef: "dm:D1" },
              { kind: "definition", id: "definition" },
              { kind: "descendant", id: "definition" },
            ]
          : [],
    })),
  };
  const evidence = Object.fromEntries(
    [
      ["me", "/me"],
      ["sessions", "/api/sessions"],
      ["contexts", "/api/contexts"],
    ].map(([name, path]) => [name, { path, principalId: "actor", status: 200, sha256: sha(path) }]),
  );
  commonActor.evidence = evidence;
  dynamicActor.evidence = structuredClone(evidence);
  const facts = { commonActor, dynamicActor, profile: selected, principalId: "actor" };
  return { contexts, rows, row, facts, formatter };
}
function nav(model, input = { surface: "web" }, rows = model.rows) {
  const roots = rows.filter((row) => !row.parentSessionId && (input.surface !== "web" || model.formatter.isWeb(row)));
  const active = roots.filter((row) => !row.archived);
  const selectedPage = (section, values) =>
    page(
      values,
      JSON.stringify([section, input.surface ?? "all"]),
      input.section === section ? input.cursor : undefined,
    );
  const recent = selectedPage(
    "recent",
    active.filter((row) => !row.pinned),
  );
  const pinned = selectedPage(
    "pinned",
    active.filter((row) => row.pinned),
  );
  const groupValues = model.contexts.flatMap((context) => {
    const members = active.filter((row) => !row.pinned && row.scopeId === context.scopeId);
    if (!members.length && ["group", "channel"].includes(context.kind)) return [];
    return [
      {
        id: context.scopeId,
        scopeId: context.scopeId,
        name: model.formatter.groupName(context),
        kind: context.project ? "project" : context.kind,
        count: members.length,
        lastActivityAt: members.length ? Math.max(...members.map((row) => row.lastActivityAt)) : context.lastActivityAt,
      },
    ];
  });
  const groups = selectedPage("groups", groupValues);
  groups.items = groups.items.map(({ id: _id, ...row }) => row);
  const references = (input.references ?? []).map((reference) => ({
    reference,
    session:
      rows.find((row) => (reference.kind === "id" ? row.id === reference.value : row.threadRef === reference.value)) ??
      null,
  }));
  const latest = order(rows)[0] ?? null;
  const archive =
    input.section === "archived"
      ? selectedPage(
          "archived",
          roots.filter((row) => row.archived),
        )
      : null;
  const scopes = new Set(
    [
      ...recent.items,
      ...pinned.items,
      ...(archive?.items ?? []),
      ...references.flatMap((ref) => (ref.session ? [ref.session] : [])),
      ...(latest ? [latest] : []),
      ...groups.items,
    ].map((row) => row.scopeId),
  );
  return {
    recent,
    pinned,
    groups,
    ...(archive ? { archived: archive } : {}),
    contexts: model.contexts.filter((row) => scopes.has(row.scopeId)),
    archivedCount: roots.filter((row) => row.archived).length,
    references,
    statusTotals: {
      active: rows.filter((row) => !row.parentSessionId && !row.archived).length,
      waiting: 0,
      archived: rows.filter((row) => !row.parentSessionId && row.archived).length,
    },
    startup: {
      hasSessions: true,
      hasNonCronSessions: true,
      oldestPersonalThreadRef: model.facts.commonActor.startup.oldestPersonalThreadRef,
      latest,
    },
  };
}

function addPrepared(m, value) {
  m.rows.push(value);
  const surface = sidebarSurface(value);
  const compact = {
    ...m.formatter.labeled(value),
    threadRef: value.threadRef,
    createdAt: value.createdAt,
    at: value.lastActivityAt,
    legacyRank: m.rows.length - 1,
    archived: !!value.archived,
    pinned: !!value.pinned,
    parentSessionId: value.parentSessionId ?? null,
    type: value.type,
    channelName: value.channelName ?? null,
    surface,
    mutableFields: [],
  };
  (surface === "web" ? m.facts.commonActor.preparedWeb : m.facts.dynamicActor.preparedNonWeb).push(compact);
  return value;
}
function actionable(m, rows, parent = "web-000", options = {}) {
  const input = { parentSessionId: parent, children: true, actionable: true, ...options.input };
  const key = JSON.stringify([
    input.surface ?? "all",
    null,
    input.scopeId ?? null,
    "",
    null,
    true,
    parent,
    input.pinned ?? null,
    input.archived ?? null,
    "actionable",
  ]);
  const selected = page(rows, key, input.cursor);
  const scopes = new Set(selected.items.map((row) => row.scopeId).concat(input.scopeId ? [input.scopeId] : []));
  const data = {
    ...selected,
    contexts: m.contexts.filter((row) => scopes.has(row.scopeId)),
    statusTotals: nav(m).statusTotals,
    actionable: {
      parentSessionId: parent,
      parentSubagents:
        options.summary === undefined
          ? {
              running: rows.filter((row) => row.working && !row.awaitingInput).length,
              waiting: rows.filter((row) => row.awaitingInput).length,
            }
          : options.summary,
      depths: selected.items.map((row) => options.depths?.[row.id] ?? 1),
    },
  };
  return {
    input,
    data,
    project: (change = {}) =>
      projectSidebarResponse({
        ...m.facts,
        ...captured(data),
        request: { method: "POST", path: "/api/session-navigation/page", body: input },
        ...(options.previous ? { previous: options.previous } : {}),
        ...change,
      }),
  };
}

export { model, nav, sha, page, addPrepared, actionable, profile, captured };
