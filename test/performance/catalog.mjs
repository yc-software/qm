export const ADMIN_VIEWS = [
  "governance",
  "models",
  "credentials",
  "connectors",
  "slack-settings",
  "customize",
  "users",
  "spend",
  "slack",
  "judgments",
  "errors",
  "audit",
  "egress",
  "files",
  "skills",
  "memory",
  "deployments",
  "crons",
];

export const BLOCKING_SELECTORS =
  '.chat-loading:visible, .loadingline:visible, #loading-view:visible, #governance-loading:visible, .welcome-load[role="status"]:visible, .chat-search-empty:has-text("Searching…"):visible, .chat-search-empty:has-text("Loading resources…"):visible, .chat-search-failed:visible';

const COMPOSIO_DISABLED_TEXT =
  "App connections aren’t available for your account yet. Ask your administrator to enable them.";
const SLACK_DISABLED_TEXT = "Connect your workspace";
export const WEB_VIEWS = [
  "contexts",
  "crons",
  "webhooks",
  "loops",
  "inbox",
  "files",
  "keychain",
  "deploys",
  "memory",
  "skills",
];
export const CALENDAR_EXCLUSION =
  "Calendar renders only the static Coming soon placeholder; no implemented data load flow exists.";
export const ATTACHMENT = {
  name: "performance-attachment.txt",
  mimeType: "text/plain",
  text: "Synthetic attachment load verification",
};

export function declaredDisabled(feature) {
  return (
    feature?.enabled === false &&
    feature?.mode === "disabled" &&
    typeof feature.evidence === "string" &&
    feature.evidence.length > 0
  );
}

export function secondaryRequests(scenario, orgScope, features = {}) {
  const scope = `/admin/api/scopes/${encodeURIComponent(orgScope ?? "MISSING")}`;
  const paths = {
    "web.settings": [
      "/api/user-model-auth/status",
      "/api/composio/slack",
      "/api/composio/toolkits",
      "/api/composio/connections",
    ],
    "web.search": ["/api/search", "/api/resources/search"],
    "web.contexts": ["/api/contexts"],
    "web.crons": ["/api/crons"],
    "web.webhooks": ["/api/webhooks"],
    "web.loops": declaredDisabled(features.loops) ? ["/me"] : ["/api/loops"],
    "web.inbox": declaredDisabled(features.inbox) ? ["/me"] : ["/api/inbox"],
    "web.files": ["/api/files", "/api/contexts"],
    "web.keychain": ["/api/keychain/overview", "/api/connectors"],
    "web.deploys": ["/api/deployments", "/api/contexts"],
    "web.memory": ["/api/memory"],
    "web.skills": ["/api/skills", "/api/contexts"],
    "admin.governance": [scope],
    "admin.models": [scope, "/admin/api/custom-providers"],
    "admin.credentials": [scope, "/admin/api/keychain"],
    "admin.connectors": [scope, "/admin/api/connector-catalog"],
    "admin.slack-settings": [scope, "/admin/api/slack-installation", "/admin/api/slack-emoji"],
    "admin.customize": [scope, "/admin/api/scopes"],
    "admin.users": ["/admin/api/users", "/admin/api/keychain"],
    "admin.history.next": [],
  };
  const selected = paths[scenario] ?? (scenario.startsWith("admin.") ? ["/admin/api/scopes"] : []);
  return selected.map((path) => ({
    path,
    paginated: ["/api/composio/toolkits", "/api/composio/connections"].includes(path),
    ...(path === scope ? { settledField: "modelCatalogRefreshing" } : {}),
    ...(path === scope && scenario === "admin.credentials"
      ? { followupWhenNonempty: "serviceCredentials", followupPath: `${scope}/credential-usage` }
      : {}),
    ...(path.startsWith("/api/composio/") && declaredDisabled(features.composio)
      ? { paginated: false, expectedStatuses: [403], expectedError: "composio_unavailable" }
      : {}),
    ...(path === "/admin/api/slack-emoji" && declaredDisabled(features.slack) && !features.slack.emojiCatalogAvailable
      ? { expectedStatuses: [404], expectedError: "not_configured" }
      : {}),
  }));
}

const pathPart = (value) => encodeURIComponent(value ?? "MISSING");
const chatPath = (session) => `/s/${pathPart(session?.sessionId)}`;
const sessionSelector = (session) => `[data-session-id=${JSON.stringify(session?.sessionId ?? "MISSING")}] a.session`;
const sessionMissing = (session) =>
  ["sessionId", "principalId", "expectedVisibleText"].filter((key) => !session?.[key]).map((key) => `session.${key}`);

export function chatReady(session, paneId) {
  return {
    root: paneId ? `[data-pane-id=${JSON.stringify(paneId)}]` : ".custom-chat",
    texts: [session?.expectedVisibleText].filter(Boolean),
    editable: session?.readOnly ? undefined : "textarea",
    visible: session?.readOnly ? ".chat-scroll" : undefined,
    missing: sessionMissing(session),
  };
}

export function multiviewState(sessions, updatedAt, visibleGroups = 4) {
  const panels = Object.fromEntries(
    sessions.map((session, i) => [
      `perf-pane-${i}`,
      {
        id: `perf-pane-${i}`,
        contentComponent: "pane",
        tabComponent: "pane",
        title: session.title ?? `Performance ${i}`,
        params: { sessionId: session.sessionId, threadRef: session.threadRef, scopeId: session.scopeId },
      },
    ]),
  );
  const leaves = Array.from({ length: visibleGroups }, (_, i) => {
    const start = Math.floor((i * sessions.length) / visibleGroups);
    const end = Math.floor(((i + 1) * sessions.length) / visibleGroups);
    const views = Array.from({ length: end - start }, (_, offset) => `perf-pane-${start + offset}`);
    return {
      type: "leaf",
      size: 1440 / visibleGroups,
      data: { views, activeView: views.at(-1), id: `perf-group-${i}` },
    };
  });
  return {
    v: 2,
    active: true,
    updatedAt,
    layout: {
      grid: {
        root: { type: "branch", size: 1000, data: leaves },
        width: 1440,
        height: 1000,
        orientation: "HORIZONTAL",
      },
      panels,
      activeGroup: "perf-group-0",
    },
  };
}

export function buildCatalog(fixture) {
  const cases = fixture.cases ?? {};
  const cohorts = fixture.cohorts ?? fixture.principalCohorts ?? {};
  const adminHistoryCohorts = fixture.adminHistoryCohorts ?? cohorts;
  const browser = fixture.browser ?? {};
  const features = browser.features ?? {};
  const views = fixture.views ?? browser.views ?? {};
  const orgScope = fixture.orgScopeId ?? browser.orgScopeId;
  const adminPrincipalId = fixture.adminPrincipalId ?? browser.adminPrincipalId;
  const scenarios = [];
  const add = (scenario) => scenarios.push({ modes: ["cold", "warm"], missing: [], ...scenario });
  const readyView = (key, root = "#view-data") => {
    const view = views[key];
    const texts = [view?.expectedText].flat().filter(Boolean);
    if (key === "web.settings" && declaredDisabled(features.composio)) texts.push(COMPOSIO_DISABLED_TEXT);
    if (key === "slack-settings" && declaredDisabled(features.slack)) texts.push(SLACK_DISABLED_TEXT);
    return {
      root: view?.selector ?? root,
      texts,
      enabled: view?.controlSelector,
      values: view?.values,
      absentTexts: view?.absentTexts,
      absentSelectors: view?.absentSelectors,
      editable: view?.editable,
      visible: view?.visible,
      rowTexts: view?.rowTexts,
      missing: view?.expectedText || view?.values?.length ? [] : [`views.${key}.expectedText`],
      rows: view?.rows,
    };
  };
  for (const name of ["median", "p95", "max"]) {
    const cohort = cohorts[name];
    const rootCase = browser.rootSidebarCases?.[name];
    add({
      id: `web.root.${name}`,
      principalId: cohort?.principalId,
      path: "/",
      kind: "root",
      ready: { root: "body", visible: sessionSelector(rootCase), editable: ".custom-chat textarea", texts: [] },
      missing: [
        ...(!cohort?.principalId ? [`cohorts.${name}.principalId`] : []),
        ...(!rootCase?.sessionId ? [`browser.rootSidebarCases.${name}`] : []),
      ],
    });
  }
  for (const name of ["short", "long", "dense", "slack", "legacy", "mixed"]) {
    const session = cases[name];
    add({
      id: `web.chat.${name}`,
      principalId: session?.principalId,
      path: chatPath(session),
      kind: "chat",
      session,
      ready: chatReady(session),
    });
  }
  const long = cases.long;
  for (const name of ["long", "mixed"]) {
    const session = cases[name];
    const earlier = name === "long" ? browser.earlierPage : browser.mixedEarlierPage;
    const earlierSelector = `[data-entry-seqs~=${JSON.stringify(String(earlier?.entrySeq ?? "MISSING"))}]`;
    add({
      id: name === "long" ? "web.chat.earlier" : "web.chat.mixed-earlier",
      modes: ["warm"],
      principalId: session?.principalId,
      path: chatPath(session),
      kind: "earlier",
      session,
      preparePages: earlier?.preparePages ?? [],
      prepareReady: { ...chatReady(session), absentSelectors: [earlierSelector] },
      ready: [
        { ...chatReady(session), texts: [], visible: earlierSelector },
        {
          root: `.custom-chat ${earlierSelector}`,
          texts: [earlier?.expectedVisibleText].filter(Boolean),
          missing:
            earlier?.sessionId === session?.sessionId && Number.isSafeInteger(earlier?.entrySeq)
              ? []
              : [`browser.${name === "long" ? "earlierPage" : "mixedEarlierPage"}`],
        },
        ...(earlier?.boundaryReady ?? []),
      ],
      missing:
        earlier?.sessionId === session?.sessionId && Number.isSafeInteger(earlier?.entrySeq)
          ? []
          : [`browser.${name === "long" ? "earlierPage" : "mixedEarlierPage"}`],
    });
  }
  const short = cases.short;
  add({
    id: "web.sidebar.switch",
    modes: ["warm"],
    principalId: short?.principalId,
    path: chatPath(long),
    kind: "sidebar-switch",
    session: short,
    prepareReady: chatReady(long),
    ready: chatReady(short),
    missing:
      short?.principalId === long?.principalId && short?.sessionId !== long?.sessionId
        ? []
        : ["short and long cases must be distinct and share a principal"],
  });
  const pagination = browser.sidebarPagination ?? fixture.sidebarPagination;
  add({
    id: "web.sidebar.more",
    modes: ["warm"],
    principalId: pagination?.principalId,
    path: "/settings",
    kind: "sidebar-more",
    ready: { root: "body", visible: sessionSelector(pagination), texts: [], enabled: sessionSelector(pagination) },
    missing: pagination?.sessionId && pagination?.principalId ? [] : ["sidebarPagination.{principalId,sessionId}"],
  });
  for (const view of ["settings"]) {
    const configured = readyView(`web.${view}`, ".settings-page");
    add({ id: `web.${view}`, principalId: short?.principalId, path: `/${view}`, kind: "view", ready: configured });
  }
  for (const view of WEB_VIEWS)
    add({
      id: `web.${view}`,
      principalId: short?.principalId,
      path: `/${view === "deploys" ? "apps" : view}`,
      kind: "view",
      ready: readyView(`web.${view}`),
    });
  add({
    id: "web.crons.disabled",
    modes: ["warm"],
    principalId: short?.principalId,
    path: "/crons",
    kind: "disabled-crons",
    prepareReady: readyView("web.crons"),
    ready: readyView("web.crons.disabled"),
  });
  add({
    id: "web.memory.facts",
    modes: ["warm"],
    principalId: short?.principalId,
    path: "/memory",
    kind: "memory-facts",
    prepareReady: readyView("web.memory"),
    ready: readyView("web.memory.facts"),
  });
  add({
    id: "web.attachment.stage",
    modes: ["warm"],
    principalId: short?.principalId,
    path: chatPath(short),
    kind: "attachment",
    session: short,
    prepareReady: chatReady(short),
    ready: [
      {
        ...chatReady(short),
        texts: [],
        visible: ".attachment-strip",
        absentSelectors: [".composer-error", '.composer-note:has-text("Preparing files...")'],
      },
      { root: ".custom-chat .attachment-strip", texts: [ATTACHMENT.name] },
    ],
  });
  for (const view of ["search", "browse"]) {
    add({
      id: `web.${view}`,
      modes: ["warm"],
      principalId: short?.principalId,
      path: chatPath(short),
      kind: "web-overlay",
      overlay: view,
      query: views[`web.${view}`]?.query,
      ready: readyView(
        `web.${view}`,
        view === "search" ? '.chat-search-palette[aria-label="Search QM"]' : ".browse-palette",
      ),
      missing: view === "search" && !views["web.search"]?.query ? ["views.web.search.query"] : [],
    });
  }
  const multiview = fixture.multiview ?? browser.multiview ?? [];
  const maxPanels = browser.maxPanels ?? 12;
  const visibleGroups = browser.visibleGroups ?? 4;
  const multiMissing =
    multiview.length === maxPanels &&
    new Set(multiview.map((session) => session.sessionId)).size === maxPanels &&
    new Set(multiview.map((session) => session.principalId)).size === 1 &&
    Number.isInteger(visibleGroups) &&
    visibleGroups > 0 &&
    visibleGroups < maxPanels
      ? []
      : [
          "multiview must match declared maximum tabs and visible groups with distinct sessions belonging to one principal",
        ];
  const visibleIndices = Array.from(
    { length: visibleGroups },
    (_, i) => Math.floor(((i + 1) * multiview.length) / visibleGroups) - 1,
  );
  const visiblePanes = visibleIndices.map((i) => chatReady(multiview[i], `perf-pane-${i}`));
  add({
    id: "web.multiview.restore",
    principalId: multiview[0]?.principalId,
    path: "/",
    kind: "multiview",
    sessions: multiview,
    visibleGroups,
    visibleIndices,
    ready: visiblePanes,
    missing: multiMissing,
  });
  add({
    id: "web.multiview.hidden-return",
    modes: ["warm"],
    principalId: multiview[0]?.principalId,
    path: "/",
    kind: "hidden-tab",
    sessions: multiview,
    visibleGroups,
    visibleIndices,
    ready: chatReady(multiview[0], "perf-pane-0"),
    missing: multiMissing,
  });
  const adminMissing = [...(!adminPrincipalId ? ["adminPrincipalId"] : []), ...(!orgScope ? ["orgScopeId"] : [])];
  const addAdmin = (scenario) =>
    add({ principalId: adminPrincipalId, admin: true, missing: adminMissing, ...scenario });
  addAdmin({ id: "admin.scopes", path: "/admin/history", kind: "view", ready: readyView("scopes") });
  for (const name of ["median", "p95", "max"]) {
    const scope = adminHistoryCohorts[name]?.scopeId;
    addAdmin({
      id: `admin.history.${name}`,
      path: `/admin/history/scopes/${pathPart(scope)}`,
      kind: "view",
      ready: readyView(`history.${name}`),
      missing: [...adminMissing, ...(!scope ? [`adminHistoryCohorts.${name}.scopeId`] : [])],
    });
  }
  const pageScope = adminHistoryCohorts.max?.scopeId;
  addAdmin({
    id: "admin.history.next",
    modes: ["warm"],
    path: `/admin/history/scopes/${pathPart(pageScope)}`,
    kind: "admin-next",
    ready: readyView("history.next"),
    prepareReady: { ...readyView("history.max"), absentSelectors: [readyView("history.next").enabled].filter(Boolean) },
    missing: [...adminMissing, ...(!pageScope ? ["adminHistoryCohorts.max.scopeId"] : [])],
  });
  for (const name of ["short", "long", "dense", "slack"]) {
    const session = cases[name];
    addAdmin({
      id: `admin.transcript.${name}`,
      path: `/admin/history/s/${pathPart(session?.sessionId)}`,
      kind: "view",
      ready: {
        root: "#view-data",
        texts: [session?.adminVisibleText ?? session?.expectedVisibleText].filter(Boolean),
        missing: sessionMissing(session),
      },
    });
  }
  for (const view of ADMIN_VIEWS) {
    const settings = ["governance", "models", "credentials", "slack-settings", "customize"].includes(view);
    const dataRoot = view === "connectors" ? "#view-connectors" : "#view-data";
    addAdmin({
      id: `admin.${view}`,
      path: `/admin/${view}?scope=${pathPart(orgScope)}`,
      kind: "view",
      ready: readyView(view, settings ? "#view-governance" : dataRoot),
    });
  }
  for (const range of ["7d", "90d"])
    addAdmin({
      id: `admin.spend.${range}`,
      path: `/admin/spend?range=${range}`,
      kind: "view",
      ready: readyView(`spend.${range}`),
    });
  return scenarios.map((scenario) => ({
    ...scenario,
    requiredResponses: secondaryRequests(scenario.id, orgScope, features),
    missing: [
      ...scenario.missing,
      ...[scenario.ready, scenario.prepareReady]
        .flat()
        .filter(Boolean)
        .flatMap((ready) => ready.missing ?? []),
      ...(!scenario.principalId ? ["principalId"] : []),
    ],
  }));
}

export function cellsFor(catalog, condition) {
  return catalog.flatMap((scenario) =>
    scenario.modes.map((cache) => ({
      id: `${scenario.id}:${cache}:${condition}`,
      scenarioId: scenario.id,
      cache,
      condition,
    })),
  );
}
