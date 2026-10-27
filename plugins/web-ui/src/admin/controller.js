import * as governanceUI from "./admin.ts";
import * as settings from "./settings.ts";
import * as artifacts from "./artifacts.ts";
import * as activity from "./activity.ts";
import { ADMIN_SECTIONS, LOG_VIEWS, SCOPED_VIEWS, SETTINGS_VIEWS, VIEW_TITLE } from "./sections.ts";
import { ADMIN_MARKUP } from "./markup.ts";
import { adminApi, scopeUrl } from "./api.ts";
import { startSettings } from "./settings-controller.ts";
import { scopeMultiSelect } from "./scope-picker.ts";
import * as routes from "./routes.ts";
import { watchCustomDropdowns } from "./dropdown.ts";
import { backArrow, el, kpis, linkClick, searchField } from "./dom.ts";
import { stacked } from "./shared.ts";
import { KIND_LABEL, fileName, historyCategory, relTime, scopeKind, titleCase } from "./format.ts";

export function startAdmin(host, adminEnv) {
  env = adminEnv;
  host.innerHTML = ADMIN_MARKUP;
  governanceUI.mountCards();
  root = $("app-view");
  scAddButton = $("sc-add");
  $("card-feature-flags").classList.remove("hidden");
  $("connector-dm-tip").firstChild.textContent =
    "Tip: the easiest way to change these settings is to ask " +
    env.productName +
    " in a DM. It can make the edit for you and confirm what changed.";
  document.querySelectorAll("#view-governance section.card > .foot > .viewlink").forEach((link) => {
    link.closest("section.card").querySelector(":scope > .head").appendChild(link);
  });
  orgId = env.org;
  scope = "org:" + orgId;
  API_BASE = env.apiBase;
  PAGE_BASE = env.pageBase;
  api = adminApi(API_BASE);
  document.querySelectorAll("[data-viewlink]").forEach((button) => {
    button.onclick = () => setView(button.dataset.viewlink);
  });
  $("add-custom-provider").onclick = () => settings.openProvider(null);
  $("onboarding-add-custom-provider").onclick = () => settings.openProvider(null);
  window.addEventListener("popstate", () => {
    if (!root.isConnected) return;
    if (allowGovernancePop) {
      allowGovernancePop = false;
      return render(urlToState());
    }
    const next = urlToState();
    if (!hasGovernanceDraft()) return render(next);
    if (next.view === view && next.scope === scope) return;
    const current = { view, scope, session: null, page };
    history.pushState(current, "", stateToUrl(current));
    void reviewLeave(next.view).then((confirmed) => {
      if (!confirmed) return;
      allowGovernancePop = true;
      history.back();
    });
  });
  window.addEventListener("beforeunload", (event) => {
    if (!hasGovernanceDraft()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("focus", () => {
    if (!root.isConnected) return;
    if (view === "slack-settings") return void governanceUI.integrations.loadSlackInstallation();
    if (isGovLike(view) || view === "connectors" || view === "user") return;
    if (Date.now() - (viewLoadedAt[view] || 0) < 60000) return;
    if (view === "memory" && !(orgWideView() && urlToState().mem !== "edit")) return;
    if (view === "history" && urlToState().session) return;
    if (view === "onboarding") return void governanceUI.onboarding.load();
    if (view === "crons" && cronDestinationEditId) return;
    renderData();
  });
  settingsUi = startSettings({
    api,
    scope: () => scope,
    view: () => view,
    scopeDir: () => scopeDir,
    dirLabel,
    shortName,
    scopeName: governanceScopeName,
    go,
    hasDraft: hasGovernanceDraft,
  });
  settings.configureFlags({
    buildSelector: (choices, selected, onChange) => scopeMultiSelect(choices, selected, onChange, dirLabel),
    loadChoices: async () => {
      if (!scopeDir) await loadScopeDirectory();
      return (scopeDir || []).map((row) => ({ scopeId: row.scopeId, label: row.label || row.scopeId }));
    },
    save: (targetScope, body) => api("PUT", scopeUrl(targetScope, "/feature-flags"), body),
  });
  governanceUI.onboarding.configure({
    api,
    orgScope: () => orgScope(),
    connectorName: (id) => connectorName(id),
    view: () => view,
    loadCustomProviders: () => settings.loadProviders(),
    loaded: () => {
      viewLoadedAt.onboarding = Date.now();
    },
    navigate: (target) => openOnboardingTarget(target),
  });
  governanceUI.integrations.configure({ api, orgScope, connectorName, save: (key) => settingsUi.save(key) });
  governanceUI.integrations.mountBuiltIns();
  watchCustomDropdowns($("app-view"));
  governanceUI.slackActivity.configure({
    ...helpers(),
    containers: () => slackContainers,
    view: () => view,
  });
  route();
  return {
    route,
    show: (v) => (v === "general" ? go({ view: "general", scope, session: null }) : setView(v)),
  };
}
const $ = (id) => document.getElementById(id);
let env, root, scAddButton, orgId, API_BASE, PAGE_BASE, api, settingsUi, scope;
const ERRORS_PAGE_SIZE = 50;
const brandSelfLabel = () => env.productName;
let view = routes.DEFAULT_VIEW;
let page = 1;
let historyCursor = null;
const viewLoadedAt = {};
let cronDestinationEditId = null;
const transcriptVisibility = { thinking: true, toolResults: true };
async function openWebUiAs(target) {
  if (!target) return;
  try {
    const res = await fetch("/auth/impersonate?target=" + encodeURIComponent(target), {
      method: "POST",
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      return alert("Couldn't start impersonation: " + ((j && j.message) || "Failed (" + res.status + ")"));
    }
  } catch (e) {
    return alert("Couldn't start impersonation: " + (e && e.message ? e.message : e));
  }
  window.open("/web-ui/", "_blank", "noopener");
}
function webUiAsButton(target) {
  const title = "View the assistant web UI as " + target + " (audited)";
  return el(
    "button.link",
    { type: "button", title, onclick: () => openWebUiAs(target) },
    "Open web UI as this person ↗",
  );
}
const stateToUrl = (st) => routes.stateToUrl(st, PAGE_BASE);
const urlToState = () => routes.urlToState(PAGE_BASE, orgId, scope);
let transcriptObserver = null;
function render(st) {
  governanceUI.transcript.cancel();
  transcriptObserver?.disconnect();
  transcriptObserver = null;
  $("header-controls").textContent = "";
  view = st.view;
  scope = st.scope;
  page = st.page || 1;
  historyCursor = st.cursor || null;
  historyKind = st.historyKind || "conversation";
  for (const v of ["history", "judgments", "errors", "deployments", "crons"])
    root.classList.toggle(v + "-view", view === v);
  root.classList.toggle("governance-view", isGovLike(view));
  root.dataset.subview = view;
  settingsUi.setPending(view === "governance" && settingsUi.readyScope() !== scope);
  root.dataset.adminKit = String(ADMIN_SECTIONS.some((section) => section.views.includes(view)));
  root.classList.toggle("context-fullpage", view === "history" && !!st.session && st.turn != null);
  if (!isGovLike(view) && !["general", "connectors", "onboarding"].includes(view) && !scopeDir)
    void loadScopeDirectory();
  defaultShell();
  env.onView(view);
  $("view-governance").classList.toggle("hidden", !isGovLike(view));
  $("view-onboarding").classList.toggle("hidden", view !== "onboarding");
  $("connector-dm-tip").classList.toggle("hidden", view !== "connectors");
  $("view-connectors").classList.toggle("hidden", view !== "connectors");
  $("view-data").classList.toggle("hidden", ["general", "onboarding", "connectors"].includes(view) || isGovLike(view));
  if (view === "general") return;
  if (view === "onboarding") return void governanceUI.onboarding.load();
  if (isGovLike(view)) {
    if (view === "slack-settings") void governanceUI.integrations.loadSlackInstallation();
    return void settingsUi.loadScope();
  }
  if (view === "connectors") return void governanceUI.integrations.loadConnectors();
  if (view === "user") return void showUserDetail(st.principal);
  if (view === "judgments") return void governanceUI.slackActivity.renderAmbientJudgments(st);
  if (view === "ackemoji") return void governanceUI.slackActivity.renderAckEmojiPicks(st);
  if (view === "history" && st.session && st.turn != null)
    return void governanceUI.transcript.contextPage(st.session, st.turn, transcriptServices());
  if (view === "history" && st.session)
    return void governanceUI.transcript.show(st.session, undefined, undefined, transcriptServices());
  renderData();
}
const isGovLike = (v) => SETTINGS_VIEWS.has(v);
const hasGovernanceDraft = () => isGovLike(view) && !!$("view-governance").querySelector(".card.dirty");
function governanceScopeName(scopeId = scope) {
  return scopeKind(scopeId) === "org" ? "Organization · " + scopeId.split(":").slice(1).join(":") : shortName(scopeId);
}
function commitGo(st) {
  history.pushState(st, "", stateToUrl(st));
  render(st);
}
function reviewLeave(destination) {
  const facts = [
    ["Current scope", governanceScopeName()],
    ["Destination", VIEW_TITLE[destination] || titleCase(destination)],
  ];
  if (isGovLike(view) && $("view-governance").querySelector(".status.saving")) {
    void settingsUi.review({
      title: "Governance save in progress",
      subtitle: "Wait for the current save to finish before leaving.",
      facts,
      warning: "The change may already be committing and cannot be safely discarded.",
      confirmLabel: null,
    });
    return Promise.resolve(false);
  }
  return settingsUi.review({
    title: "Discard unsaved governance changes?",
    subtitle: "This page has a draft that has not been applied.",
    facts,
    warning: "Leaving now discards every unsaved setting on this Governance page.",
    confirmLabel: "Discard and leave",
    danger: true,
  });
}
function go(st) {
  if (!hasGovernanceDraft() || (st.view === view && st.scope === scope)) return commitGo(st);
  void reviewLeave(st.view).then((confirmed) => {
    if (!confirmed) return;
    if (view === "governance") settingsUi.forgetReady();
    commitGo(st);
  });
}
function setView(v) {
  go({
    view: v,
    scope: v === "history" || v === "errors" ? "org:" + orgId : scope,
    session: null,
    historyKind: "conversation",
  });
}
function route() {
  const st = urlToState();
  if (st.view === "history" && st.session) {
    const list = { ...st, session: null, turn: null };
    history.replaceState(list, "", stateToUrl(list));
    if (st.turn != null)
      history.pushState({ ...st, turn: null, deepLink: true }, "", stateToUrl({ ...st, turn: null }));
    history.pushState({ ...st, deepLink: true }, "", stateToUrl(st));
  } else if (st.view === "user" && st.principal) {
    const list = { ...st, view: "users", principal: null };
    history.replaceState(list, "", stateToUrl(list));
    history.pushState(st, "", stateToUrl(st));
  } else {
    history.replaceState(st, "", stateToUrl(st));
  }
  render(st);
}
let allowGovernancePop = false;
let scopeDir = null;
let environmentDir = [];
async function loadScopeDirectory() {
  const r = await api("GET", "/api/scopes");
  if (!r.ok) return;
  viewLoadedAt.history = Date.now();
  scopeDir = r.data.scopes || [];
  environmentDir = r.data.environments || [];
  if (SCOPED_VIEWS.has(view) && !urlToState().session) {
    const memoryEditor = view === "memory" && !(orgWideView() && urlToState().mem !== "edit");
    if (!(memoryEditor && orgWideView())) defaultShell();
    if (view !== "governance" && !memoryEditor) renderData();
  }
}
const dirLabel = (id) => (scopeDir || []).find((x) => x.scopeId === id)?.label || "";
function shortName(scopeId) {
  if (!scopeId) return "";
  const kind = scopeKind(scopeId);
  if (kind === "org") return "org";
  const lbl = dirLabel(scopeId);
  if (lbl) return lbl;
  const rest = String(scopeId).slice(kind.length + 1);
  if (kind === "channel" || kind === "group") return rest.startsWith("#") ? rest : "#" + rest;
  if (kind === "personal") {
    const local = rest.split("@")[0];
    return /^[a-z]/.test(local) ? local[0].toUpperCase() + local.slice(1) : local || rest;
  }
  return rest || scopeId;
}
function scopeCell(id, extraCls) {
  const lbl = dirLabel(id);
  return { node: stacked(lbl || id, lbl ? id : ""), cls: "mono" + (extraCls ? " " + extraCls : "") };
}
const orgWideView = () => scopeKind(scope) === "org";
function scopeRows() {
  const rows = (scopeDir || []).filter((s) => scopeKind(s.scopeId) !== "org");
  if (scopeKind(scope) !== "org" && !rows.some((s) => s.scopeId === scope)) rows.unshift({ scopeId: scope });
  return rows;
}
function selectScope(id) {
  if (id !== scope) {
    const next = { view, scope: id, session: null, page: 1 };
    if (view === "history") next.historyKind = historyKind;
    go(next);
  }
}
function pageShell(opts = {}) {
  const bar = $("shellbar");
  bar.textContent = "";
  const logView = LOG_VIEWS.has(view);
  bar.classList.toggle("logs-shell", logView);
  const counts = el("div.log-counts");
  const countText = (label, value) => {
    const number = Number(value);
    const noun = number === 1 ? label.replace(/s$/, "") : label;
    const amount = Number.isFinite(number) ? number.toLocaleString() : String(value);
    return el("span.log-count", amount + " " + noun.toLowerCase());
  };
  const back = opts.back && el("button.back", { type: "button", onclick: opts.back.onClick }, backArrow());
  back?.append(el("span", opts.back.label.replace(/^←\s*/, "")));
  if (back) bar.appendChild(el("div.shell-back-row", {}, back));
  if (opts.title) bar.appendChild(el("h2.shell-title", opts.title));
  if (logView) bar.appendChild(counts);
  if (opts.context) {
    const c = opts.contextGo ? navLink(opts.context, opts.contextGo) : el("span", opts.context);
    c.classList.add("shell-context");
    bar.appendChild(c);
  }
  if (opts.tabs && opts.tabs.length) {
    const wrap = el("div.shell-tabs" + (view === "judgments" ? " judgment-filters" : ""));
    for (const tab of opts.tabs)
      wrap.appendChild(
        el("button.shell-tab" + (tab.active ? " active" : ""), {
          type: "button",
          "aria-pressed": String(!!tab.active),
          textContent: logView || tab.count == null ? tab.label : tab.label + " " + Number(tab.count).toLocaleString(),
          onclick: tab.onClick,
        }),
      );
    const active = opts.tabs.find((tab) => tab.active);
    if (logView && active?.count != null) {
      let noun = active.label;
      if (view === "judgments") noun = "judgments";
      else if (active.label === "Background") noun = "background runs";
      counts.appendChild(countText(noun, active.count));
    }
    bar.appendChild(wrap);
  } else if (opts.tally) counts.appendChild(countText(opts.tally[1], opts.tally[0]));
  else if (opts.count != null && opts.count !== "") bar.appendChild(el("span.shell-count", String(opts.count)));
  if (logView) (opts.stats || []).forEach(([value, label]) => counts.appendChild(countText(label, value)));
  bar.appendChild(el("span.shell-spacer"));
  if (!logView && opts.stats && opts.stats.length) bar.appendChild(kpis(opts.stats, "shell-stats"));
  if (opts.search) bar.appendChild(searchField(opts.search));
  (opts.actions || []).forEach((n) => bar.appendChild(n));
}
function transcriptEntryHidden(kinds, visibility = transcriptVisibility) {
  return (
    (!visibility.thinking && kinds.includes("Reasoning")) ||
    (!visibility.toolResults && kinds.some((kind) => kind === "ToolCall" || kind === "ToolResult"))
  );
}
function navLink(label, target) {
  return el("a.link", { textContent: label, href: stateToUrl(target), onclick: linkClick(() => go(target)) });
}
function defaultShell(extras = {}) {
  extras = { actions: view === "credentials" ? [scAddButton] : [], ...extras };
  const title = VIEW_TITLE[view] || titleCase(view);
  if (!SCOPED_VIEWS.has(view) || orgWideView()) return pageShell({ title, ...extras });
  const back = () =>
    go({ view, scope: "org:" + orgId, session: null, page: 1, ...(view === "history" && { historyKind }) });
  pageShell({ back: { label: "← " + title, onClick: back }, title: shortName(scope), ...extras });
}
const orgOwnView = () => orgWideView() && urlToState().own === "1";
function openScopeRow(scopeId, extra = {}) {
  if (scopeKind(scopeId) === "org") return go({ view, scope: scopeId, own: "1", session: null, page: 1, ...extra });
  selectScope(scopeId);
}
function openOnboardingTarget(target) {
  setView(target === "slack" ? "slack-settings" : "connectors");
  const card = target === "slack" ? "card-slack-installation" : "card-connectors";
  setTimeout(() => $(card)?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
}
const connectorName = (id) => (id === "x" ? "X" : id.charAt(0).toUpperCase() + id.slice(1));
const orgScope = () => "org:" + orgId;
let dataReq = 0;
let historyKind = "conversation";
const dataCache = new Map();
function paintData(root, data) {
  root.textContent = "";
  if (["files", "memory", "skills", "crons", "deployments"].includes(view))
    return artifacts[view](root, data, artifactContext());
  if (["errors", "audit", "egress"].includes(view))
    return activity[view](root, data, {
      ...helpers(),
      all: orgWideView(),
      scope,
      errorsPageSize: ERRORS_PAGE_SIZE,
    });
  ({ spend: renderSpend, history: renderHistory, users: renderUsers, keychain: renderKeychain })[view](root, data);
}
async function renderData() {
  const root = $("view-data");
  const reqId = ++dataReq;
  const ep = view === "history" ? "sessions" : view;
  let path = !SCOPED_VIEWS.has(view) ? `/api/${ep}` : `/api/${ep}?scope=${encodeURIComponent(scope)}`;
  if (view === "memory" && orgWideView() && urlToState().mem !== "edit") path = "/api/memory/scopes";
  if (view === "history") {
    path += `&limit=50&category=${encodeURIComponent(historyCategory(historyKind))}`;
    if (historyCursor) path += `&cursor=${encodeURIComponent(historyCursor)}`;
    const cronSel = urlToState().cron;
    if (historyKind === "cron") path += `&origin=cron` + (cronSel ? `&cron=${encodeURIComponent(cronSel)}` : "");
    if (historyKind === "background") path += "&origin=other_background";
  }
  if (view === "errors") path += `&limit=${ERRORS_PAGE_SIZE}&offset=${(page - 1) * ERRORS_PAGE_SIZE}`;
  if (view === "spend") path += `?${spendQuery(urlToState())}`;
  const cacheable = view !== "memory";
  const cached = cacheable ? dataCache.get(path) : undefined;
  if (cached !== undefined) paintData(root, cached);
  else root.replaceChildren(el("div.loadingline", "Loading " + (VIEW_TITLE[view] || view).toLowerCase() + "..."));
  const r = await api("GET", path);
  if (reqId !== dataReq) return;
  if (!r.ok) {
    const message =
      r.status === 403 ? "You don't administer this scope." : r.data?.message || `Failed to load (${r.status}).`;
    if (cached === undefined) root.replaceChildren(el("p.empty", message));
    return;
  }
  if (cacheable) dataCache.set(path, r.data);
  viewLoadedAt[view] = Date.now();
  paintData(root, r.data);
}
function spendQuery(st) {
  const { from, to, bucket } = governanceUI.spend.spendWindow(st);
  return new URLSearchParams({ from, to, bucket }).toString();
}
function clickLink(props) {
  const a = el("a", { rel: "noreferrer", ...props });
  document.body.appendChild(a);
  a.click();
  a.remove();
}
const openUser = (principal) => go({ view: "user", scope, session: null, principal });
function renderSpend(root, d) {
  governanceUI.spend.spend(root, d, {
    ...helpers(),
    window: governanceUI.spend.spendWindow(urlToState()),
    openCronRuns: (cron, cronScope) =>
      go({ view: "history", scope: cronScope, session: null, historyKind: "cron", cron }),
    setRange: (range) => go({ ...urlToState(), view: "spend", range, from: null, to: null }),
    setCustomRange: (from, to) => go({ ...urlToState(), view: "spend", range: null, from, to }),
    downloadCsv: (breakdown = "entity") =>
      clickLink({
        href:
          API_BASE + "/spend?format=csv&breakdown=" + encodeURIComponent(breakdown) + "&" + spendQuery(urlToState()),
      }),
  });
}
async function adminErrors(query) {
  const r = await api("GET", "/api/errors?" + query);
  return r.ok ? r.data?.errors || [] : null;
}
async function adminErrorCount(query) {
  const r = await api("GET", "/api/errors?count=1&" + query);
  return r.ok ? Number(r.data?.total || 0) : null;
}
let artifactRenderGeneration = 0;
function artifactContext() {
  const capturedScope = scope;
  const capturedView = view;
  const capturedRequest = dataReq;
  const generation = ++artifactRenderGeneration;
  const current = () =>
    scope === capturedScope &&
    view === capturedView &&
    dataReq === capturedRequest &&
    generation === artifactRenderGeneration;
  return {
    ...helpers(),
    view,
    scope: capturedScope,
    scopeDir,
    orgWide: orgWideView(),
    index: orgWideView() && !orgOwnView(),
    own: orgOwnView(),
    cron: urlToState().cron,
    apiBase: API_BASE,
    fmtHistoryTime: relTime,
    deploymentHref: (dep) => dep.publicUrl || "",
    invalidate: () => dataCache.clear(),
    reload: () => (current() ? renderData() : Promise.resolve()),
    setCronEditing: (id) => {
      if (current()) cronDestinationEditId = id;
    },
  };
}
const renderKeychain = (root, d) => governanceUI.keychain.keychain(root, d, helpers());
function renderUsers(root, d) {
  governanceUI.users.users(root, d, {
    ...helpers(),
    confirm: (message) => window.confirm(message),
    orgScope: "org:" + orgId,
    clearCache: () => dataCache.clear(),
  });
}
function renderHistory(root, d) {
  governanceUI.history.history(root, d, {
    ...helpers(),
    historyKind,
    cron: urlToState().cron,
    cursor: historyCursor,
    scope,
    orgScope: "org:" + orgId,
    environments: environmentDir,
    title: VIEW_TITLE.history,
    kindLabels: KIND_LABEL,
  });
}
let userDetailRequest = 0;
async function showUserDetail(principalId) {
  const request = ++userDetailRequest;
  const root = $("view-data");
  root.textContent = "";
  return governanceUI.userDetail.detail(root, principalId, {
    ...helpers(),
    confirm: (message) => window.confirm(message),
    current: (principal) => request === userDetailRequest && view === "user" && urlToState().principal === principal,
    reload: showUserDetail,
  });
}
let slackContainers = null;
async function loadSlackContainers() {
  const r = await api("GET", "/api/ambient-context");
  if (r.ok) slackContainers = r.data.containers || [];
  return r;
}
function slackContainerLabel(id) {
  const c = (slackContainers || []).find((x) => x.container === id) || {};
  const nm = c.name || null;
  const kind = c.kind || (nm ? "channel" : "");
  if (kind === "channel") return "#" + (nm || id);
  if (kind === "dm") return nm || id;
  if (kind === "group") return nm || ((c.members || []).length ? c.members.length + " people" : id);
  return nm ? "#" + nm : id;
}
function slackContainerScope(id) {
  const kind = ((slackContainers || []).find((x) => x.container === id) || {}).kind;
  if (kind === "channel") return "channel:" + id;
  if (kind === "group") return "group:" + id;
  return null;
}
function transcriptServices() {
  return {
    ...helpers(),
    scope,
    historyKind,
    pageSize: 500,
    visibility: transcriptVisibility,
    entryHidden: transcriptEntryHidden,
    current: (id, turn) => {
      const st = urlToState();
      return view === "history" && st.session === id && (turn == null ? !st.turn : String(st.turn) === String(turn));
    },
    setObserver: (observer) => {
      transcriptObserver = observer;
    },
  };
}
async function downloadFile(f) {
  if (!f.openable) return;
  const check = await api("GET", "/api/files/read?id=" + encodeURIComponent(f.id));
  if (!check.ok) {
    alert(check.data?.message || `Couldn't open file (${check.status}).`);
    return;
  }
  const href = API_BASE + "/files/download?id=" + encodeURIComponent(f.id);
  const mime = (f.mimetype || "").split(";")[0].trim().toLowerCase();
  if (/^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain)$/.test(mime)) {
    window.open(href, "_blank", "noreferrer");
    return;
  }
  clickLink({ href, download: f.name || fileName(f.path) });
}
function helpers() {
  return {
    orgId,
    api,
    pageShell,
    defaultShell,
    go,
    stateToUrl,
    urlToState,
    navLink,
    openScopeRow,
    selectScope,
    openUser,
    shortName,
    dirLabel,
    scopeCell,
    scopeRows,
    webUiAsButton,
    openWebUiAs,
    adminErrors,
    adminErrorCount,
    downloadFile,
    brandSelfLabel,
    slackContainerLabel,
    slackContainerScope,
    loadSlackContainers,
  };
}
