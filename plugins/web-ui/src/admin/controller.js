import * as governanceUI from "./admin.ts";
import { ADMIN_VIEWS, VIEW_TITLE } from "./sections.ts";
import { ADMIN_MARKUP } from "./markup.ts";

function backArrow() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({
    width: "15",
    height: "15",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(k, v);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m12 19-7-7 7-7M5 12h14");
  svg.appendChild(path);
  return svg;
}

export function startAdmin(host, env) {
  host.innerHTML = ADMIN_MARKUP;
  governanceUI.mountCards();
  const $ = (id) => document.getElementById(id);
  const root = $("app-view");
  const EFFECT_LABELS = { allow: "Allow", deny: "Deny", require_approval: "Require approval" };
  const VIEWS = [...ADMIN_VIEWS];
  function prepareParityCards() {
    const content = document.querySelector("#view-governance .governance-content");
    const anchor = $("governance-credentials");
    $("card-approval-grant-modes").classList.add("reference-omitted");

    const providers = document.createElement("section");
    providers.className = "card sv-models";
    providers.id = "card-custom-providers";
    providers.innerHTML =
      '<div class="head"><h2>Custom providers</h2><p>OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages endpoints. Their models join the pickers above and below.</p></div><div class="body"><div class="tablewrap" id="model-custom-provider-table"><table><thead><tr><th>Provider</th><th>Protocol</th><th>Endpoint</th><th>Models</th><th>Key</th><th></th></tr></thead><tbody id="model-custom-provider-rows"></tbody></table></div><div id="custom-provider-summary" class="hint">Loading providers…</div></div><div class="foot"><button type="button" id="add-custom-provider">+ Add provider</button></div>';

    const governanceAmbient = governanceUI.createCard("card-governance-org-ambient");
    $("card-command-policy").after(governanceAmbient);

    const keychains = document.createElement("section");
    keychains.className = "card sv-credentials";
    keychains.id = "card-personal-keychains";
    keychains.innerHTML =
      '<div class="head"><h2>Personal keychains</h2></div><div class="body"><div class="keychain-summary"><strong id="keychain-user-count">—</strong> users with keychain entries · <strong id="keychain-standing-count">—</strong> standing grants</div></div><div class="foot"><button type="button" class="viewlink" data-viewlink="users">View users ›</button></div>';
    $("card-feature-flags").classList.remove("hidden");

    [
      $("card-runtimes"),
      providers,
      $("card-webui-models"),
      $("card-soul"),
      $("card-branding"),
      $("card-feature-flags"),
      $("card-decisions"),
      $("card-service-credentials"),
      keychains,
    ].forEach((card) => content.insertBefore(card, anchor));
    content.insertBefore(anchor, $("card-service-credentials"));
    [
      $("card-security-posture"),
      $("card-auto-flagger"),
      $("card-sharing-posture"),
      governanceAmbient,
      $("card-external-slack"),
      $("card-command-policy"),
      $("card-egress"),
    ].forEach((card) => content.appendChild(card));

    const connectorView = $("view-connectors");
    const connectorTip = document.createElement("aside");
    connectorTip.className = "connector-dm-tip admin-notice hidden";
    connectorTip.id = "connector-dm-tip";
    connectorTip.setAttribute("role", "note");
    connectorTip.appendChild(document.createElement("p"));
    connectorTip.querySelector("p").textContent =
      "Tip: the easiest way to change these settings is to ask " +
      env.productName +
      " in a DM. It can make the edit for you and confirm what changed.";
    connectorView.before(connectorTip);
    const builtIns = document.createElement("section");
    builtIns.className = "card";
    builtIns.id = "card-built-in-connectors";
    builtIns.innerHTML =
      '<div class="head"><h2>Built-in connectors</h2></div><div class="body" id="built-in-connectors">Loading connectors…</div>';
    $("card-slack-installation").classList.add("sv-slack-settings");
    ["card-slack-installation", "card-external-slack", "card-channel-header-pin-default", "card-ack-emoji"].forEach(
      (id) => content.appendChild($(id)),
    );
    connectorView.appendChild(builtIns);
    document.querySelectorAll("#view-governance section.card > .foot > .viewlink").forEach((link) => {
      link.closest("section.card").querySelector(":scope > .head").appendChild(link);
    });
  }
  prepareParityCards();
  const scAddButton = $("sc-add");
  const scStatusHome = $("st-service-credentials").parentElement;
  const dialog = document.createElement("dialog");
  dialog.id = "sc-dialog";
  dialog.className = "custom-provider-dialog credential-dialog";
  dialog.setAttribute("aria-labelledby", "sc-dialog-title");
  dialog.setAttribute("aria-describedby", "sc-dialog-description");
  dialog.innerHTML =
    '<div class="project-dialog-head"><div><h2 id="sc-dialog-title">Add credential</h2><p id="sc-dialog-description">Connect a service securely, then choose what the agent can access.</p></div><button class="project-icon-button" type="button" id="sc-dialog-close" aria-label="Close credential dialog">×</button></div><div class="project-dialog-actions" id="sc-dialog-actions"></div>';
  $("card-service-credentials").appendChild(dialog);
  dialog.insertBefore($("sc-editor"), $("sc-dialog-actions"));
  $("sc-dialog-actions").append($("sc-reset"), $("sc-save"));
  const dismiss = () => {
    if (!$("st-service-credentials").classList.contains("saving")) resetScForm();
  };
  $("sc-dialog-close").onclick = dismiss;
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener("click", (event) => {
    const rect = dialog.getBoundingClientRect();
    if (
      event.target === dialog &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom)
    )
      dismiss();
  });
  function openScDialog() {
    const dialog = $("sc-dialog");
    $("sc-dialog-title").textContent = scEditing ? "Edit credential" : "Add credential";
    setStatus("st-service-credentials", "", "");
    $("sc-dialog-actions").prepend($("st-service-credentials"));
    if (!dialog.open) dialog.showModal();
  }

  document.querySelectorAll("[data-choice-for]").forEach((input) => {
    if (input.closest(".sv-governance, .sv-slack-settings, .sv-models, .sv-customize")) return;
    input.onchange = () => {
      const select = $(input.dataset.choiceFor);
      select.value = input.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
  });
  document.querySelectorAll("[data-checkbox-for]").forEach((input) => {
    if (input.closest(".sv-slack-settings")) return;
    input.onchange = () => {
      const checkbox = $(input.dataset.checkboxFor);
      checkbox.checked = input.value === "on";
      checkbox.dispatchEvent(new Event("input", { bubbles: true }));
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    };
  });
  const SCOPED = new Set([
    "governance",
    "egress",
    "history",
    "files",
    "memory",
    "live",
    "audit",
    "errors",
    "skills",
    "crons",
    "deployments",
  ]);
  const ORG_WIDE = new Set([
    "retention",
    "users",
    "spend",
    "keychain",
    "connectors",
    "judgments",
    "ackemoji",
    "models",
    "credentials",
    "customize",
    "slack-settings",
  ]);
  const ENDPOINT = { history: "sessions", files: "files", live: "runs" };
  const HISTORY_PAGE_SIZE = 50;
  const ERRORS_PAGE_SIZE = 50;

  const TRANSCRIPT_PAGE_SIZE = 500;
  const brandSelfLabel = () => env.productName;
  const DEFAULT_VIEW = "history";
  const orgId = env.org;
  let scope = "org:" + orgId;
  let view = DEFAULT_VIEW;

  let page = 1;
  let historyCursor = null;

  const FOCUS_STALE_MS = 60000;
  const viewLoadedAt = {};
  let cronDestinationEditId = null;
  const transcriptVisibility = { thinking: true, toolResults: true };

  const API_BASE = env.apiBase;
  const PAGE_BASE = env.pageBase;

  async function api(method, path, body) {
    try {
      const res = await fetch(API_BASE + path.replace(/^\/api(?=\/)/, ""), {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (error) {
        console.warn("[swallowed] admin api: non-JSON response", method, path, res.status, error);
      }
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      console.warn("[swallowed] admin api: request failed", method, path, error);
      return { ok: false, status: 0, data: { message: "Network request failed." } };
    }
  }

  async function openWebUiAs(target) {
    if (!target) return;
    try {
      const res = await fetch("/auth/impersonate?target=" + encodeURIComponent(target), {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        let msg = "Failed (" + res.status + ")";
        const j = await res.json().catch(() => null);
        if (j && j.message) msg = j.message;
        alert("Couldn't start impersonation: " + msg);
        return;
      }
    } catch (e) {
      alert("Couldn't start impersonation: " + (e && e.message ? e.message : e));
      return;
    }
    window.open("/web-ui/", "_blank", "noopener");
  }
  function webUiAsButton(target) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link";
    b.textContent = "Open web UI as this person ↗";
    b.title = "View the assistant web UI as " + target + " (audited)";
    b.onclick = () => openWebUiAs(target);
    return b;
  }
  const fmtTime = (ts) => new Date(ts).toLocaleString();
  const sameLocalDate = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const fmtClock = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  function relTime(ts) {
    if (!ts) return "Never";
    const d = new Date(ts);
    const now = new Date();
    const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
    if (mins >= 0 && mins < 1) return "now";
    if (mins >= 0 && mins < 60) return mins + (mins === 1 ? " min" : " mins");
    if (sameLocalDate(d, now)) return "Today " + fmtClock(d);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (sameLocalDate(d, yesterday)) return "Yesterday " + fmtClock(d);
    return (
      d.toLocaleDateString(
        [],
        d.getFullYear() === now.getFullYear()
          ? { month: "short", day: "numeric" }
          : { month: "short", day: "numeric", year: "numeric" },
      ) +
      ", " +
      fmtClock(d)
    );
  }
  const fmtHistoryTime = relTime;
  function fmtHistoryCreated(createdAt, lastActivity) {
    if (!createdAt) return "Never";
    const created = new Date(createdAt);
    return lastActivity && sameLocalDate(created, new Date(lastActivity))
      ? fmtClock(created)
      : fmtHistoryTime(createdAt);
  }
  const fmtMs = (n) => {
    if (n == null) return "n/a";
    if (n >= 1000) return (n / 1000).toFixed(2) + " s";
    return Math.round(n) + " ms";
  };
  const fmtPct = (n) => ((n || 0) * 100).toFixed(1) + "%";
  const statusTimers = new Map();
  function setStatus(id, msg, kind, sticky = false) {
    if (id === "st-service-credentials") {
      governanceUI.settings.credentialStatus(msg, kind || "");
      return;
    }
    const governanceKey = governanceUI.statusKey(id);
    if (governanceKey) {
      governanceUI.status(governanceKey, msg, kind || "");
      return;
    }
    const el = $(id);
    if (!el) return;
    if (statusTimers.has(id)) {
      clearTimeout(statusTimers.get(id));
      statusTimers.delete(id);
    }
    el.textContent = msg;
    el.className = "status " + (kind || "");
    if (msg && !sticky) {
      const timer = setTimeout(() => {
        if (el.textContent === msg) {
          el.textContent = "";
          el.className = "status";
        }
        statusTimers.delete(id);
      }, 4000);
      statusTimers.set(id, timer);
    }
  }
  let governanceReviewResolve = null;
  function finishGovernanceReview(confirmed) {
    const dialog = $("governance-review");
    if (dialog.open) dialog.close();
    const resolve = governanceReviewResolve;
    governanceReviewResolve = null;
    if (resolve) resolve(confirmed);
  }
  function reviewGovernanceChange({ title, subtitle, facts, warning, confirmLabel, danger = false }) {
    if (governanceReviewResolve) finishGovernanceReview(false);
    const dialog = $("governance-review");
    $("governance-review-title").textContent = title;
    $("governance-review-subtitle").textContent = subtitle;
    const list = $("governance-review-facts");
    list.textContent = "";
    facts.forEach(([key, value]) => {
      const term = document.createElement("dt");
      term.textContent = key;
      const detail = document.createElement("dd");
      detail.textContent = value;
      list.append(term, detail);
    });
    $("governance-review-warning").textContent = warning;
    const confirm = $("governance-review-confirm");
    confirm.textContent = confirmLabel || "";
    confirm.classList.toggle("hidden", !confirmLabel);
    confirm.classList.toggle("danger", danger);
    dialog.showModal();
    $("governance-review-cancel").focus();
    return new Promise((resolve) => {
      governanceReviewResolve = resolve;
    });
  }
  $("governance-review-cancel").onclick = () => finishGovernanceReview(false);
  $("governance-review-confirm").onclick = () => finishGovernanceReview(true);
  $("governance-review").addEventListener("cancel", (event) => {
    event.preventDefault();
    finishGovernanceReview(false);
  });
  function setCardDirty(card, dirty, statusId, saveSelector) {
    if (!card) return;
    const save = saveSelector ? card.querySelector(saveSelector) : card.querySelector("[data-save], #sc-save");
    if (save) {
      save.classList.toggle("dirty", dirty);
      save.disabled = !dirty;
    }
    card.classList.toggle("dirty", !!card.querySelector("button.dirty"));
    const st = statusId ? $(statusId) : null;
    if (dirty && statusId) setStatus(statusId, "Unsaved changes", "dirty", true);
    else if (
      st &&
      (st.classList.contains("dirty") || st.classList.contains("saving") || st.classList.contains("muted"))
    )
      setStatus(statusId, "", "");
  }
  function badge(text, kind) {
    const s = document.createElement("span");
    s.className = "badge" + (kind ? " " + kind : "");
    s.textContent = text;
    return s;
  }
  function deliveryFileBadges(filesPayload) {
    const filesWithNames = (filesPayload || []).filter((f) => f && f.name);
    if (!filesWithNames.length) return null;
    const files = document.createElement("div");
    files.className = "badges";
    for (const f of filesWithNames) {
      const label = `${f.name}${f.sizeBytes ? " · " + fmtBytes(f.sizeBytes) : ""}`;
      if (f.artifactId) {
        const link = document.createElement("button");
        link.className = "badge info";
        link.textContent = label;
        link.onclick = () =>
          downloadFile({ id: f.artifactId, name: f.name, size: f.sizeBytes, mimetype: f.mimetype, openable: true });
        files.appendChild(link);
      } else {
        files.appendChild(badge(label, "muted"));
      }
    }
    return files;
  }
  function nodeCell(node, cls) {
    return { node, cls };
  }
  function stacked(primary, secondary, cls) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    const p = document.createElement("div");
    p.className = "primaryline";
    p.textContent = primary;
    d.appendChild(p);
    if (secondary) {
      const s = document.createElement("div");
      s.className = "subline";
      s.textContent = secondary;
      d.appendChild(s);
    }
    return d;
  }
  function deploymentHref(dep) {
    return dep.publicUrl || "";
  }
  const shortId = (id, len = 8) => String(id || "").slice(0, len) || "-";
  const titleCase = (s) =>
    String(s || "")
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
  function labelRole(role) {
    return role === "org_admin" ? "admin" : String(role || "").replace(/_/g, " ");
  }
  function scopeKind(scopeId) {
    return String(scopeId || "").split(":")[0] || "scope";
  }
  function statusKind(status) {
    if (status === "done") return "ok";
    if (status === "failed") return "err";
    if (status === "running") return "info";
    if (status === "pending") return "warn";
    return "muted";
  }
  function statusBadge(status) {
    return badge(titleCase(status || "unknown"), statusKind(status));
  }
  function typeBadge(type) {
    let kind = "warn";
    if (type === "dm") kind = "info";
    else if (type) kind = "muted";
    return badge(titleCase(type || "unknown"), kind);
  }
  function entryIsNoise(e) {
    return ["tool_call", "tool_result", "soul", "system"].includes(e.type);
  }
  function fileKind(path) {
    const name = String(path || "");
    const ext = name.includes(".") ? name.split(".").pop() : "";
    return ext ? "." + ext.toLowerCase() : "file";
  }
  function fileName(path) {
    return (
      String(path || "")
        .split("/")
        .filter(Boolean)
        .pop() || "download"
    );
  }
  async function fileSha256(file) {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function uploadErrorMessage(text, fallback) {
    try {
      const parsed = JSON.parse(text);
      return parsed.message || parsed.error || fallback;
    } catch {
      return text.trim() || fallback;
    }
  }
  function fmtDuration(start, end) {
    if (start == null) return "-";
    return fmtMs((end ?? Date.now()) - start);
  }

  function stateToUrl(st) {
    const p = new URLSearchParams();
    if ((st.view || DEFAULT_VIEW) === "history") {
      if (st.session) {
        if (st.turn != null) p.set("turn", String(st.turn));
        const q = p.toString();
        const path = PAGE_BASE + "/history/s/" + encodeURIComponent(st.session);
        return q ? path + "?" + q : path;
      }
      const scopeSegment = st.scope && scopeKind(st.scope) !== "org" ? encodeURIComponent(st.scope) : null;
      const scopeInPath = scopeSegment && !/%2F|%5C/i.test(scopeSegment);
      if (scopeSegment && !scopeInPath) p.set("scope", st.scope);
      if (st.own) p.set("own", st.own);
      if (st.cron) p.set("cron", st.cron);
      if (st.historyKind && st.historyKind !== "conversation") p.set("kind", st.historyKind);
      if (st.cursor) p.set("cursor", st.cursor);
      const q = p.toString();
      const path = scopeInPath ? PAGE_BASE + "/history/scopes/" + scopeSegment : PAGE_BASE + "/history";
      return q ? path + "?" + q : path;
    }
    if (["connectors", "slack-settings"].includes(st.view) && st.setup === "slack") p.set("setup", "slack");
    if (["connectors", "slack-settings"].includes(st.view) && ["setup", "install", "connected"].includes(st.slack))
      p.set("slack", st.slack);
    if (st.scope && SCOPED.has(st.view)) p.set("scope", st.scope);
    if (st.view === "errors" && st.page > 1) p.set("page", st.page);
    if (st.principal) p.set("principal", st.principal);
    if (st.view === "crons" && st.cron) p.set("cron", st.cron);
    if (st.own && SCOPED.has(st.view)) p.set("own", st.own);
    if (st.view === "memory" && st.mem) p.set("mem", st.mem);
    const spendWindow = st.view === "spend" ? governanceUI.spend.spendWindow(st) : null;
    if (spendWindow && spendWindow.preset === null) {
      p.set("from", spendWindow.from);
      p.set("to", spendWindow.to);
    } else if (spendWindow && st.range) p.set("range", spendWindow.preset);
    if (st.view === "slack" && st.container) p.set("container", st.container);
    if (st.view === "slack" && st.container && st.ts) p.set("ts", st.ts);
    if (st.view === "judgments" && st.container) p.set("container", st.container);
    if (st.view === "judgments" && st.decision) p.set("decision", st.decision);
    if (st.view === "judgments" && st.jid) p.set("jid", st.jid);
    if (st.view === "ackemoji" && st.container) p.set("container", st.container);
    if (st.view === "ackemoji" && st.decision) p.set("decision", st.decision);
    if (st.view === "ackemoji" && st.jid) p.set("jid", st.jid);
    const q = p.toString();

    const path = st.view === "general" ? PAGE_BASE : PAGE_BASE + "/" + encodeURIComponent(st.view || DEFAULT_VIEW);
    return q ? path + "?" + q : path;
  }
  function decodePathSegment(seg) {
    if (!seg) return null;
    try {
      return decodeURIComponent(seg);
    } catch {
      return null;
    }
  }
  function urlToState() {
    const p = new URLSearchParams(location.search);

    const rel = location.pathname.startsWith(PAGE_BASE) ? location.pathname.slice(PAGE_BASE.length) : location.pathname;
    const segs = rel.replace(/^\/+/, "").split("/");
    const fromPath = decodePathSegment(segs[0] ?? "");
    let pathSession = null;
    let pathScope = null;
    if (fromPath === "history") {
      if (segs[1] === "s") pathSession = decodePathSegment(segs[2] ?? "");
      else if (segs[1] === "scopes") pathScope = decodePathSegment(segs[2] ?? "");
    }
    const slackStep = ["setup", "install", "connected"].includes(p.get("slack"));
    const raw = p.get("setup") === "slack" || slackStep ? "slack-settings" : p.get("view") || fromPath;

    const v = raw === "skill-packs" ? "skills" : raw;
    const session = pathSession || p.get("session") || null;
    const kindRaw = p.get("kind");
    const normalizedHistoryKind = ["conversation", "cron", "background"].includes(kindRaw) ? kindRaw : "conversation";

    const turnRaw = p.get("turn");
    let resolvedView = DEFAULT_VIEW;
    if (VIEWS.includes(v)) resolvedView = v;
    else if (session) resolvedView = "history";
    else if (!raw) resolvedView = "general";
    return {
      view: resolvedView,
      setup: p.get("setup"),
      slack: p.get("slack"),
      scope:
        pathScope ||
        p.get("scope") ||
        (resolvedView === "history" || resolvedView === "errors" ? "org:" + orgId : scope),
      session,
      turn: turnRaw == null || turnRaw === "" ? null : turnRaw,
      principal: p.get("principal") || null,
      cron: p.get("cron") || null,
      own: p.get("own") || null,
      mem: p.get("mem") || null,
      range: p.get("range") || null,
      from: p.get("from") || null,
      to: p.get("to") || null,
      historyKind: normalizedHistoryKind,
      page: Math.max(1, parseInt(p.get("page"), 10) || 1),
      cursor: p.get("cursor") || null,
      container: p.get("container") || null,
      ts: p.get("ts") || null,
      decision: p.get("decision") || null,
      jid: p.get("jid") || null,
    };
  }

  let transcriptObserver = null;
  function render(st) {
    governanceUI.transcript.cancel();
    if (transcriptObserver) {
      transcriptObserver.disconnect();
      transcriptObserver = null;
    }
    $("header-controls").textContent = "";
    view = st.view;
    scope = st.scope;
    page = st.page || 1;
    historyCursor = st.cursor || null;
    historyKind = st.historyKind || "conversation";
    root.classList.toggle("history-view", view === "history");
    root.classList.toggle("slack-view", view === "slack");
    root.classList.toggle("judgments-view", view === "judgments");
    root.classList.toggle("errors-view", view === "errors");
    root.classList.toggle("deployments-view", view === "deployments");
    root.classList.toggle("crons-view", view === "crons");
    root.classList.toggle("governance-view", isGovLike(view));
    root.dataset.subview = view;
    setGovernancePending(view === "governance" && governanceReadyScope !== scope);
    root.dataset.adminKit = [
      "crons",
      "deployments",
      "files",
      "skills",
      "memory",
      "audit",
      "egress",
      "history",
      "slack",
      "judgments",
      "errors",
      "governance",
      "models",
      "credentials",
      "connectors",
      "customize",
      "slack-settings",
      "users",
      "spend",
    ].includes(view)
      ? "true"
      : "false";
    root.classList.toggle("context-fullpage", view === "history" && !!st.session && st.turn != null);
    if (!isGovLike(view) && !["general", "connectors", "onboarding"].includes(view) && !scopeDir)
      void loadScopeDirectory();
    defaultShell();
    env.onView(view);
    $("view-governance").classList.toggle("hidden", !isGovLike(view));
    $("view-onboarding").classList.toggle("hidden", view !== "onboarding");
    $("connector-dm-tip").classList.toggle("hidden", view !== "connectors");
    $("view-connectors").classList.toggle("hidden", view !== "connectors");
    $("view-data").classList.toggle(
      "hidden",
      view === "general" || view === "onboarding" || isGovLike(view) || view === "connectors",
    );
    if (view === "general") return;
    if (view === "onboarding") return void loadOnboarding();
    if (isGovLike(view)) {
      if (view === "slack-settings") void loadSlackInstallation();
      return void loadScope();
    }
    if (view === "connectors") return void loadConnectors();
    if (view === "user") return void showUserDetail(st.principal);
    if (view === "slack") return void renderSlackMirror(st);
    if (view === "judgments") return void renderAmbientJudgments(st);
    if (view === "ackemoji") return void renderAckEmojiPicks(st);
    if (view === "history" && st.session && st.turn != null) return void showContextPage(st.session, st.turn);
    if (view === "history" && st.session) return void showTranscript(st.session);
    renderData();
  }

  const GOV_LIKE = new Set(["governance", "models", "credentials", "customize", "slack-settings"]);
  function isGovLike(v) {
    return GOV_LIKE.has(v);
  }
  function hasGovernanceDraft() {
    return isGovLike(view) && !!$("view-governance").querySelector(".card.dirty");
  }
  function governanceSaveInFlight() {
    return isGovLike(view) && !!$("view-governance").querySelector(".status.saving");
  }
  function governanceScopeName(scopeId = scope) {
    return scopeKind(scopeId) === "org"
      ? "Organization · " + scopeId.split(":").slice(1).join(":")
      : shortName(scopeId);
  }
  function commitGo(st) {
    history.pushState(st, "", stateToUrl(st));
    render(st);
  }
  function go(st) {
    const leavingDraft = hasGovernanceDraft() && (st.view !== view || st.scope !== scope);
    if (!leavingDraft) return commitGo(st);
    if (governanceSaveInFlight()) {
      void reviewGovernanceChange({
        title: "Governance save in progress",
        subtitle: "Wait for the current save to finish before leaving.",
        facts: [
          ["Current scope", governanceScopeName()],
          ["Destination", VIEW_TITLE[st.view] || titleCase(st.view)],
        ],
        warning: "The change may already be committing and cannot be safely discarded.",
        confirmLabel: null,
      });
      return;
    }
    void reviewGovernanceChange({
      title: "Discard unsaved governance changes?",
      subtitle: "This page has a draft that has not been applied.",
      facts: [
        ["Current scope", governanceScopeName()],
        ["Destination", VIEW_TITLE[st.view] || titleCase(st.view)],
      ],
      warning: "Leaving now discards every unsaved setting on this Governance page.",
      confirmLabel: "Discard and leave",
      danger: true,
    }).then((confirmed) => {
      if (confirmed) {
        if (view === "governance") governanceReadyScope = null;
        commitGo(st);
      }
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
  document.querySelectorAll("[data-viewlink]").forEach((button) => {
    button.onclick = () => setView(button.dataset.viewlink);
  });
  $("add-custom-provider").onclick = () => openCustomProviderEditor();
  $("onboarding-add-custom-provider").onclick = () => openCustomProviderEditor();
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
    if (governanceSaveInFlight()) {
      void reviewGovernanceChange({
        title: "Governance save in progress",
        subtitle: "Wait for the current save to finish before leaving.",
        facts: [
          ["Current scope", governanceScopeName()],
          ["Destination", VIEW_TITLE[next.view] || titleCase(next.view)],
        ],
        warning: "The change may already be committing and cannot be safely discarded.",
        confirmLabel: null,
      });
      return;
    }
    void reviewGovernanceChange({
      title: "Discard unsaved governance changes?",
      subtitle: "This page has a draft that has not been applied.",
      facts: [
        ["Current scope", governanceScopeName()],
        ["Destination", VIEW_TITLE[next.view] || titleCase(next.view)],
      ],
      warning: "Leaving now discards every unsaved setting on this Governance page.",
      confirmLabel: "Discard and leave",
      danger: true,
    }).then((confirmed) => {
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

  let scopeDir = null;
  let environmentDir = [];
  async function loadScopeDirectory() {
    const r = await api("GET", "/api/scopes");
    if (!r.ok) return;
    viewLoadedAt.history = Date.now();
    scopeDir = r.data.scopes || [];
    environmentDir = r.data.environments || [];

    if (SCOPED.has(view) && !urlToState().session) {
      const memoryEditor = view === "memory" && !(orgWideView() && urlToState().mem !== "edit");

      if (!(memoryEditor && orgWideView())) defaultShell();
      if (view !== "governance" && !memoryEditor) renderData();
    }
  }
  function dirLabel(id) {
    const s = (scopeDir || []).find((x) => x.scopeId === id);
    return (s && s.label) || "";
  }

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
    return nodeCell(stacked(lbl || id, lbl ? id : ""), "mono" + (extraCls ? " " + extraCls : ""));
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
    const logView = ["history", "slack", "judgments", "errors", "audit", "egress", "memory"].includes(view);
    bar.classList.toggle("logs-shell", logView);
    const counts = document.createElement("div");
    counts.className = "log-counts";
    const countText = (label, value) => {
      const count = document.createElement("span");
      count.className = "log-count";
      const number = Number(value);
      const noun = number === 1 ? label.replace(/s$/, "") : label;
      count.textContent =
        (Number.isFinite(number) ? number.toLocaleString() : String(value)) + " " + noun.toLowerCase();
      return count;
    };
    if (opts.back) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "back";
      const label = document.createElement("span");
      label.textContent = opts.back.label.replace(/^←\s*/, "");
      b.append(backArrow(), label);
      b.onclick = opts.back.onClick;
      const row = document.createElement("div");
      row.className = "shell-back-row";
      row.appendChild(b);
      bar.appendChild(row);
    }
    if (opts.title) {
      const h = document.createElement("h2");
      h.className = "shell-title";
      h.textContent = opts.title;
      bar.appendChild(h);
    }
    if (logView) bar.appendChild(counts);
    if (opts.context) {
      const c = opts.contextGo ? navLink(opts.context, opts.contextGo) : document.createElement("span");
      c.classList.add("shell-context");
      if (!opts.contextGo) c.textContent = opts.context;
      bar.appendChild(c);
    }
    if (opts.tabs && opts.tabs.length) {
      const wrap = document.createElement("div");
      wrap.className = "shell-tabs" + (view === "judgments" ? " judgment-filters" : "");
      opts.tabs.forEach((tab) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "shell-tab" + (tab.active ? " active" : "");
        b.setAttribute("aria-pressed", String(!!tab.active));
        if (logView) b.textContent = tab.label;
        else b.textContent = tab.count != null ? tab.label + " " + Number(tab.count).toLocaleString() : tab.label;
        b.onclick = tab.onClick;
        wrap.appendChild(b);
      });
      if (logView) {
        const active = opts.tabs.find((tab) => tab.active);
        if (active?.count != null) {
          let noun = active.label;
          if (view === "judgments") noun = "judgments";
          else if (active.label === "Background") noun = "background runs";
          counts.appendChild(countText(noun, active.count));
        }
      }
      bar.appendChild(wrap);
    } else if (opts.count != null && opts.count !== "") {
      const c = document.createElement("span");
      c.className = "shell-count";
      c.textContent = String(opts.count);
      if (logView) {
        const match = String(opts.count).match(/^([\d,.]+\+?)\s*(.*)$/);
        counts.appendChild(match ? countText(match[2] || "records", match[1].replaceAll(",", "")) : c);
      } else bar.appendChild(c);
    }
    if (logView && opts.stats?.length) {
      opts.stats.forEach(([value, label]) => counts.appendChild(countText(label, value)));
    }
    const spacer = document.createElement("span");
    spacer.className = "shell-spacer";
    bar.appendChild(spacer);
    if (!logView && opts.stats && opts.stats.length) bar.appendChild(kpis(opts.stats, "shell-stats"));
    if (opts.search) {
      bar.appendChild(searchField(opts.search));
    }
    (opts.actions || []).forEach((n) => bar.appendChild(n));
  }
  function searchField({ placeholder = "Search…", onInput = () => {}, value = "", disabled = false }) {
    const wrap = document.createElement("div");
    wrap.className = "shell-search admin-search";
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = placeholder;
    input.setAttribute("aria-label", placeholder.replace(/[…]+$/, ""));
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "none");
    input.value = value;
    input.disabled = disabled;
    input.oninput = () => onInput(input.value);
    wrap.appendChild(input);
    const icon = document.createElement("span");
    icon.className = "admin-search-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "icon-button admin-search-clear";
    clear.setAttribute("aria-label", "Clear search");
    clear.textContent = "×";
    clear.disabled = disabled;
    clear.onclick = () => {
      input.value = "";
      onInput("");
      input.focus();
    };
    wrap.append(icon, clear);
    return wrap;
  }
  function transcriptEntryHidden(entryTypes, hasDelivery, visibility = transcriptVisibility) {
    return (
      (!visibility.thinking && entryTypes.includes("thinking")) ||
      (!visibility.toolResults &&
        !hasDelivery &&
        entryTypes.some((type) => type === "tool_call" || type === "tool_result"))
    );
  }

  function navLink(label, target) {
    const a = document.createElement("a");
    a.className = "link";
    a.textContent = label;
    a.href = stateToUrl(target);
    a.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      go(target);
    };
    return a;
  }

  function defaultShell(extras = {}) {
    extras = { actions: view === "credentials" ? [scAddButton] : [], ...extras };
    const title = VIEW_TITLE[view] || titleCase(view);
    if (SCOPED.has(view) && !orgWideView()) {
      pageShell({
        back: {
          label: "← " + title,
          onClick: () =>
            go({
              view,
              scope: "org:" + orgId,
              session: null,
              page: 1,
              ...(view === "history" ? { historyKind } : {}),
            }),
        },
        title: shortName(scope),
        ...extras,
      });
    } else {
      pageShell({ title, ...extras });
    }
  }

  const orgOwnView = () => orgWideView() && urlToState().own === "1";
  function openScopeRow(scopeId, extra = {}) {
    if (scopeKind(scopeId) === "org") return go({ view, scope: scopeId, own: "1", session: null, page: 1, ...extra });
    selectScope(scopeId);
  }

  const FOCUS_REFRESH_EXEMPT = new Set(["governance", "connectors", "slack-settings", "user"]);
  window.addEventListener("focus", () => {
    if (!root.isConnected) return;
    if (view === "slack-settings") {
      void loadSlackInstallation();
      return;
    }
    if (isGovLike(view) || FOCUS_REFRESH_EXEMPT.has(view)) return;
    if (Date.now() - (viewLoadedAt[view] || 0) < FOCUS_STALE_MS) return;
    if (view === "memory" && !(orgWideView() && urlToState().mem !== "edit")) return;
    if (view === "history" && urlToState().session) return;
    if (view === "onboarding") {
      loadOnboarding();
      return;
    }
    if (view === "slack") {
      if (!urlToState().container) renderSlackMirror(urlToState());
      return;
    }
    if (view === "crons" && cronDestinationEditId) return;
    renderData();
  });

  let loadedGovernanceScope = null;
  let governanceReadyScope = null;
  let loadedCommandPolicyPresent = false;
  let serviceCredDirectory = [];
  let serviceCredChannels = [];
  governanceUI.settings.configureSoul({
    formatTime: fmtTime,
    restore: async (revision) => {
      const immutable = { ...revision };
      const targetScope = scope;
      const targetGeneration = governanceReq;
      const draftBefore = JSON.stringify(governanceUI.settings.collect("soul"));
      const expectedVersion = governanceUI.settings.collect("soul").expectedVersion;
      const confirmed = await reviewGovernanceChange({
        title: "Restore SOUL version " + immutable.version + "?",
        subtitle: "The saved instructions from this revision will replace the current SOUL.",
        facts: [
          ["Scope", governanceScopeName(targetScope)],
          ["Current", "Version " + expectedVersion],
          ["Restore", "Version " + immutable.version],
        ],
        warning:
          "This does not erase history. A new revision will be created, and future turns will use it immediately.",
        confirmLabel: "Restore version " + immutable.version,
        danger: true,
      });
      if (!confirmed || scope !== targetScope || governanceReq !== targetGeneration) return;
      setStatus("st-soul", "Restoring…", "saving", true);
      const r = await api("PUT", "/api/scopes/" + encodeURIComponent(targetScope) + "/soul", {
        content: immutable.content,
        expectedVersion,
      });
      if (scope !== targetScope || governanceReq !== targetGeneration) return;
      if (!r.ok) {
        if (r.status === 409) await refreshSoulConflict();
        return setStatus(
          "st-soul",
          r.status === 409
            ? "SOUL changed; latest revision loaded and your draft was preserved."
            : r.data?.message || "Restore failed.",
          "err",
          true,
        );
      }
      const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(targetScope) + "?view=customize");
      if (scope !== targetScope || governanceReq !== targetGeneration) return;
      if (!fresh.ok)
        return setStatus("st-soul", "Restored, but the latest version could not be refreshed.", "warn", true);
      if (JSON.stringify(governanceUI.settings.collect("soul")) === draftBefore)
        governanceUI.settings.load(fresh.data, targetScope, "soul");
      else governanceUI.settings.refreshSoul(fresh.data);
      sectionSnapshots.set("soul", governanceUI.settings.states.get("soul").baseline);
      if (!governanceUI.settings.states.get("soul").dirty)
        setStatus("st-soul", "Version " + immutable.version + " restored as a new revision", "ok", true);
    },
  });
  function setGovernanceStatus(id, value, detail, tone) {
    const root = $(id);
    root.dataset.tone = tone || "neutral";
    root.querySelector(".v").textContent = value;
    root.querySelector(".detail").textContent = detail;
  }
  function renderGovernanceOverview(data) {
    const posture = data.securityPosture || "auto";
    let postureTone = "ok";
    if (posture === "dangerous") postureTone = "danger";
    else if (posture === "auto") postureTone = "warn";
    setGovernanceStatus("governance-status-posture", titleCase(posture), "Effective security posture", postureTone);
    const sharingPosture = data.sharingPosture || "isolated";
    setGovernanceStatus(
      "governance-status-sharing",
      titleCase(sharingPosture),
      "Effective sharing posture",
      sharingPosture === "open" ? "danger" : "ok",
    );
    const allowCount = (data.egress?.allowedHosts || []).length;
    const denyCount = (data.egress?.deniedHosts || []).length;
    const enforcement = data.egressEnforcement || {
      active: false,
      fidelity: "none",
      backend: "unknown",
      reason: "backend_unsupported",
    };
    const policyCount = allowCount + denyCount;
    const inactiveEgressDetail =
      enforcement.reason === "control_plane_unconfigured"
        ? "Backend supports policy; control plane inactive"
        : "Backend cannot enforce host policy";
    let egressDetail = inactiveEgressDetail;
    if (enforcement.active) {
      egressDetail = policyCount ? plural(policyCount, "effective rule") : "Policy enforced by " + enforcement.backend;
    } else if (policyCount) {
      egressDetail = plural(policyCount, "draft rule") + " · " + inactiveEgressDetail;
    }
    setGovernanceStatus(
      "governance-status-egress",
      enforcement.active ? titleCase(enforcement.fidelity) + " enforced" : "Unavailable",
      egressDetail,
      enforcement.active ? "ok" : "warn",
    );
    if ("externalSlackParticipants" in data) {
      const external = !!data.externalSlackParticipants;
      setGovernanceStatus(
        "governance-status-audience",
        external ? "External enabled" : "Internal only",
        external ? "Guests may see agent output" : "Organization boundary",
        external ? "danger" : "ok",
      );
    } else {
      setGovernanceStatus("governance-status-audience", "Inherited", "Resolved at organization scope", "neutral");
    }
    const model = data.baseModel || data.baseModelDefault || "Deployment default";
    const option = (data.baseModelOptions || []).find((candidate) => candidate.id === model);
    setGovernanceStatus(
      "governance-status-model",
      option?.name || model,
      data.baseModel ? "Local override" : "Effective default",
      "neutral",
    );
  }
  function syncGovernanceSectionNav() {
    if (view !== "governance") return;
    const links = [...document.querySelectorAll(".governance-sections a")];
    const groups = links.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);
    const threshold = Math.min(innerHeight * 0.34, 220);
    let active = groups[0];
    groups.forEach((group) => {
      if (group.getBoundingClientRect().top <= threshold) active = group;
    });
    links.forEach((link) =>
      link.setAttribute("aria-current", link.getAttribute("href") === "#" + active?.id ? "true" : "false"),
    );
  }
  document.addEventListener("scroll", syncGovernanceSectionNav, { passive: true, capture: true });
  function renderEnvironmentNotice(data) {
    const notice = $("environment-notice");
    const attachment = data?.environmentAttachment;
    notice.classList.toggle("hidden", !attachment);
    if (!attachment) return;
    const name = attachment.environmentName || shortName(attachment.environmentId);
    $("environment-notice-title").textContent = "Uses named environment " + name;
    $("environment-notice-detail").textContent =
      "Computer files and working memory resolve to this environment. Governance and conversation history remain scoped here.";
    $("environment-notice-open").textContent = "Open " + name;
    $("environment-notice-open").onclick = () =>
      go({ view: "governance", scope: attachment.environmentId, session: null, page: 1 });
  }
  function setGovernancePending(pending) {
    const root = $("view-governance");
    if (pending) $("governance-loading").textContent = "Loading settings…";
    root.classList.toggle("governance-pending", pending);
    root.setAttribute("aria-busy", String(pending));
    $("governance-loading").classList.toggle("hidden", !pending);
  }
  let governanceReq = 0;
  async function loadScope() {
    const requestedScope = scope;
    const requestedView = view;
    const requestId = ++governanceReq;
    const scopeChanged = scope !== loadedGovernanceScope;
    if (requestedView === "credentials") {
      serviceCredList = [];
      governanceUI.settings.credentialLoading();
      void loadPersonalKeychainSummary(requestId, requestedScope);
    }
    const r = await api(
      "GET",
      "/api/scopes/" + encodeURIComponent(scope) + "?view=" + encodeURIComponent(requestedView),
    );
    if (requestId !== governanceReq || requestedScope !== scope || requestedView !== view) return;
    if (!r.ok) {
      if (requestedView === "credentials") {
        governanceUI.settings.credentialLoading(
          r.status === 403 ? "You don't administer this scope." : "Could not load credentials.",
          true,
        );
      }
      if (requestedView === "governance" && governanceReadyScope !== requestedScope) {
        $("governance-loading").textContent =
          r.status === 403
            ? "You don't administer this scope."
            : "Could not load settings. Select Governance to retry.";
      }
      setStatus(
        "st-policy",
        r.status === 403 ? "You don't administer this scope." : r.data?.message || "Failed to load.",
        "err",
      );
      return;
    }
    const refreshModelChoices = [];
    if (requestedView === "governance") {
      renderEnvironmentNotice(r.data);
      renderGovernanceOverview(r.data);
      syncGovernanceSectionNav();
      loadedCommandPolicyPresent = r.data.commandPolicy != null;
      governanceUI.load(r.data, scope);
      if (scopeChanged) $("auto-flagger-test-result").hidden = true;
    }
    if (requestedView === "customize") governanceUI.settings.load(r.data, scope, "soul");
    if (requestedView === "slack-settings") governanceUI.integrations.loadScope(r.data, scope);

    const opts = r.data.baseModelOptions || [];
    const modelsByHarness = r.data.modelsByHarness || {};
    if (requestedView === "models") {
      governanceUI.settings.load(r.data, scope, "runtime");
      governanceUI.settings.load(r.data, scope, "cron-runtime");
      governanceUI.settings.load(r.data, scope, "subagent-runtime");
      governanceUI.settings.load(r.data, scope, "fallback-runtime");
      governanceUI.settings.load(r.data, scope, "webui-models");
      governanceUI.settings.load(r.data, scope, "memory-embedding-model");
    }
    refreshModelChoices.push(() => governanceUI.settings.updateCatalog(r.data));
    if (requestedView === "customize") {
      savedBranding = r.data.branding || {};
      governanceUI.settings.load(r.data, scope, "branding");
    }

    if (requestedView === "credentials") {
      serviceCredDirectory = r.data.directoryMembers || [];
      serviceCredChannels = r.data.directoryChannels || [];
      const options = $("sc-people-options");
      options.textContent = "";
      serviceCredDirectory.forEach((member) => {
        const option = document.createElement("option");
        option.value = member.principalId;
        option.label = member.displayName;
        options.appendChild(option);
      });
    }
    if (requestedView === "customize") void governanceUI.settings.loadFlags(r.data, scope);
    if (requestedView === "customize") governanceUI.settings.loadDecisions(r.data, scope);
    if (requestedView === "credentials") renderServiceCreds(r.data.serviceCredentials || []);
    if (view === "models") void loadCustomProviders();
    if (view === "credentials") {
      void loadServiceCredentialUsage(requestedScope, requestId);
    }
    if (scopeChanged) resetScForm();
    if (requestedView === "governance") {
      governanceReadyScope = requestedScope;
      setGovernancePending(false);
      flattenGovernanceCards();
    }
    loadedGovernanceScope = scope;
    initCustomDropdowns($("view-governance"));
    captureGovernanceSnapshots();
    if (r.data.modelCatalogRefreshing) {
      void api(
        "GET",
        "/api/scopes/" +
          encodeURIComponent(requestedScope) +
          "?view=" +
          encodeURIComponent(requestedView) +
          "&catalog=refresh",
      )
        .then((fresh) => {
          if (!fresh.ok || requestId !== governanceReq || requestedScope !== scope || requestedView !== view) return;
          const append = (target, incoming) => {
            for (const model of incoming || []) {
              const existing = target.findIndex((candidate) => candidate.id === model.id);
              if (existing < 0) target.push(model);
              else target[existing] = model;
            }
          };
          append(opts, fresh.data.baseModelOptions);
          for (const [harness, models] of Object.entries(fresh.data.modelsByHarness || {})) {
            append((modelsByHarness[harness] ||= []), models);
          }
          if (requestedView === "governance") governanceUI.updateCatalog(fresh.data);
          refreshModelChoices.forEach((refresh) => refresh());
          initCustomDropdowns($("view-governance"));
        })
        .catch((error) => console.warn("[swallowed] admin: model catalog refresh", error));
    }
  }
  async function refreshSoulConflict() {
    const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(scope) + "?view=" + encodeURIComponent(view));
    if (!fresh.ok) return false;
    governanceUI.settings.refreshSoul(fresh.data);
    sectionSnapshots.set("soul", governanceUI.settings.states.get("soul").baseline);
    return true;
  }
  async function refreshServiceCredentialConflict() {
    const requestedScope = scope;
    const requestedView = view;
    const requestId = ++governanceReq;
    const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(scope) + "?view=" + encodeURIComponent(view));
    if (requestId !== governanceReq || requestedScope !== scope || requestedView !== view || !fresh.ok) return false;
    serviceCredDirectory = fresh.data.directoryMembers || [];
    serviceCredChannels = fresh.data.directoryChannels || [];
    const options = $("sc-people-options");
    options.textContent = "";
    serviceCredDirectory.forEach((member) => {
      const option = document.createElement("option");
      option.value = member.principalId;
      option.label = member.displayName;
      options.appendChild(option);
    });
    const credentials = fresh.data.serviceCredentials || [];
    const refreshedEditing = credentials.find((credential) => credential.slug === scEditing);
    if (refreshedEditing) {
      scEditVersion = refreshedEditing.updatedAt;
      governanceUI.settings.credentialState.version = scEditVersion;
    }
    renderServiceCreds(credentials);
    void loadServiceCredentialUsage(requestedScope, requestId);
    renderServiceCredentialCapability();
    updateScFormDirty();
    return refreshedEditing ? "present" : "missing";
  }
  let savedBranding = {};
  governanceUI.settings.configureDecisions({
    save: (targetScope, body) => api("PUT", "/api/scopes/" + encodeURIComponent(targetScope) + "/decisions", body),
  });
  governanceUI.settings.configureFlags({
    buildSelector: buildScopeMultiSelect,
    loadChoices: async () => {
      if (!scopeDir) await loadScopeDirectory();
      return (scopeDir || []).map((row) => ({ scopeId: row.scopeId, label: row.label || row.scopeId }));
    },
    save: (targetScope, body) => api("PUT", "/api/scopes/" + encodeURIComponent(targetScope) + "/feature-flags", body),
  });

  let scEditing = null;
  let scEditVersion = null;
  let serviceCredList = [];
  async function loadServiceCredentialUsage(requestedScope, requestId) {
    if (!serviceCredList.length) return;
    const result = await api("GET", "/api/scopes/" + encodeURIComponent(requestedScope) + "/credential-usage");
    if (requestId !== governanceReq || requestedScope !== scope || view !== "credentials") return;
    const summaries = new Map((result.data?.summaries || []).map((summary) => [summary.slug, summary]));
    renderServiceCreds(
      serviceCredList.map((credential) => ({
        ...credential,
        ...(result.ok ? summaries.get(credential.slug) : {}),
        usageUnavailable: !result.ok || !summaries.has(credential.slug),
      })),
    );
  }
  governanceUI.settings.configureCredentials({
    label: serviceCredentialPrincipalLabel,
    formatTime: fmtTime,
    edit: loadScForm,
    remove: deleteSc,
    reload: loadScope,
  });
  function renderServiceCreds(list) {
    serviceCredList = list;
    governanceUI.settings.loadCredentials(list, serviceCredDirectory, serviceCredChannels, scopeDir || [], scope);
  }
  function loadScForm(c) {
    scEditing = c.slug;
    scEditVersion = c.updatedAt;
    governanceUI.settings.credentialState.begin(c);
    openScDialog();
    $("sc-name").focus();
  }
  function resetScForm() {
    const dialog = $("sc-dialog");
    const wasOpen = dialog.open;
    if (wasOpen) dialog.close();
    scStatusHome.appendChild($("st-service-credentials"));
    scEditing = null;
    scEditVersion = null;
    governanceUI.settings.credentialState.reset();
    if (wasOpen) scAddButton.focus();
  }
  function serviceCredentialPrincipalLabel(grantee) {
    if (grantee.startsWith("org:")) return "Everyone in this organization";
    if (grantee.startsWith("channel:")) {
      const label = dirLabel(grantee);
      return label ? "#" + label + " (" + grantee + ")" : grantee;
    }
    const id = grantee.startsWith("personal:") ? grantee.slice("personal:".length) : grantee;
    const member = serviceCredDirectory.find((candidate) => candidate.principalId === id || candidate.slackId === id);
    return member ? member.displayName + " (" + id + ")" : grantee;
  }
  function renderServiceCredentialCapability() {
    governanceUI.settings.credentialState.render();
  }
  function serviceCredentialBody() {
    return governanceUI.settings.credentialState.collect();
  }
  function updateScFormDirty() {
    governanceUI.settings.credentialState.changed();
  }
  function validateServiceCredential(body) {
    return governanceUI.settings.credentialState.validate(body);
  }
  async function deleteSc(credential) {
    const c = {
      ...credential,
      grantees: [...(credential.grantees || [])],
      recentUsagePrincipals: [...(credential.recentUsagePrincipals || [])],
    };
    const targetScope = scope;
    const principals = c.grantees.some((g) => g.startsWith("org:"))
      ? "everyone in the organization"
      : c.grantees.map(serviceCredentialPrincipalLabel).join(", ");
    let recent = " No successful use appears in the retained window.";
    if (c.usageCount == null || c.usageUnavailable) recent = " Recent usage is unavailable.";
    else if (c.recentUsagePrincipals.length)
      recent =
        " Recent users in the retained window: " +
        c.recentUsagePrincipals.map((id) => serviceCredentialPrincipalLabel("personal:" + id)).join(", ") +
        ".";
    const confirmed = await reviewGovernanceChange({
      title: "Delete “" + (c.name || c.slug) + "”?",
      subtitle: "This credential currently grants broker access to " + principals + "." + recent,
      facts: [
        ["Scope", governanceScopeName(targetScope)],
        ["Credential", c.name || c.slug],
        ["Slug", c.slug],
      ],
      warning:
        "Deletion immediately revokes every grant and removes the stored secret. Existing agent work that depends on “" +
        c.slug +
        "” will fail. This cannot be undone.",
      confirmLabel: "Delete credential",
      danger: true,
    });
    if (!confirmed || targetScope !== scope) return;
    const r = await api("PUT", "/api/scopes/" + encodeURIComponent(targetScope) + "/service-credentials", {
      slug: c.slug,
      delete: true,
      expectedUpdatedAt: c.updatedAt,
    });
    if (targetScope !== scope) return;
    if (r.ok) {
      resetScForm();
      await loadScope();
      setStatus("st-service-credentials", "Deleted", "ok");
    } else {
      const conflictState = r.status === 409 ? await refreshServiceCredentialConflict() : false;
      let message = r.data?.message || "Delete failed.";
      if (r.status === 409) {
        message = conflictState
          ? "Credential changed; the latest state is shown. Review it before deleting."
          : "Credential changed, but the latest state could not be loaded. Refresh the page before deleting.";
      }
      setStatus("st-service-credentials", message, "err");
    }
  }
  scAddButton.onclick = () => {
    resetScForm();
    governanceUI.settings.credentialState.begin(null);
    openScDialog();
    $("sc-name").focus();
  };
  $("sc-reset").onclick = () => {
    if (!$("st-service-credentials").classList.contains("saving")) resetScForm();
  };
  $("sc-save").onclick = async () => {
    const body = serviceCredentialBody();
    const targetScope = scope;
    const invalid = validateServiceCredential(body);
    if (invalid) {
      setStatus("st-service-credentials", invalid, "err");
      return;
    }
    $("sc-save").disabled = true;
    setStatus("st-service-credentials", "Saving...", "saving", true);
    let r;
    try {
      r = await api("PUT", "/api/scopes/" + encodeURIComponent(targetScope) + "/service-credentials", body);
    } catch {
      if (targetScope !== scope) return;
      updateScFormDirty();
      setStatus(
        "st-service-credentials",
        "Save failed because the admin service could not be reached. Your draft is preserved; try again.",
        "err",
        true,
      );
      return;
    }
    if (scope !== targetScope) return;
    if (r.ok) {
      await loadScope();
      if (scope !== targetScope) return;
      governanceUI.settings.credentialState.commit(body);
      if (!governanceUI.settings.credentialState.dirty) resetScForm();
      setStatus("st-service-credentials", "Saved", "ok");
    } else {
      let conflictState;
      try {
        conflictState = r.status === 409 ? await refreshServiceCredentialConflict() : false;
      } catch {
        updateScFormDirty();
        setStatus(
          "st-service-credentials",
          "Save failed because the admin service could not be reached. Your draft is preserved; try again.",
          "err",
          true,
        );
        return;
      }
      updateScFormDirty();
      let message = r.data?.message || "Save failed.";
      if (r.status === 403) {
        message = "Not authorized for this scope.";
      } else if (r.status === 409) {
        if (conflictState === "missing") {
          message =
            "This credential was deleted elsewhere. Your draft is preserved, but it remains an edit and cannot recreate the credential. Cancel the edit before creating a new credential.";
        } else if (conflictState === "present") {
          message = "Credential changed; latest revision loaded and your draft was preserved.";
        } else {
          message =
            "Credential changed, but the latest revision could not be loaded. Your draft is preserved; refresh the page before retrying.";
        }
      }
      setStatus("st-service-credentials", message, "err");
    }
  };

  governanceUI.onboarding.configure({
    api,
    orgScope: () => orgScope(),
    connectorName: (id) => connectorName(id),
    view: () => view,
    loadCustomProviders: () => loadCustomProviders(),
    loaded: () => {
      viewLoadedAt.onboarding = Date.now();
    },
    navigate: (target) => openOnboardingTarget(target),
  });
  function loadOnboarding() {
    return governanceUI.onboarding.load();
  }

  governanceUI.settings.configureProviders({
    api,
    refresh: async () => {
      await loadCustomProviders();
      if (view !== "models") return;
      const requestedScope = scope;
      const requestedGeneration = governanceReq;
      const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(requestedScope) + "?view=models");
      if (fresh.ok && scope === requestedScope && view === "models" && governanceReq === requestedGeneration)
        governanceUI.settings.updateCatalog(fresh.data);
    },
  });
  function openCustomProviderEditor(provider = null) {
    governanceUI.settings.openProvider(provider);
  }
  async function loadCustomProviders() {
    await governanceUI.settings.loadProviders();
  }
  async function loadPersonalKeychainSummary(requestId, requestedScope) {
    governanceUI.settings.keychainSummary(null);
    const res = await api("GET", "/api/keychain?summary=1");
    if (requestId !== governanceReq || requestedScope !== scope || view !== "credentials") return;
    governanceUI.settings.keychainSummary(res.ok ? res.data : null);
  }
  function openOnboardingTarget(target) {
    setView(target === "slack" ? "slack-settings" : "connectors");
    setTimeout(
      () =>
        $(target === "slack" ? "card-slack-installation" : "card-connectors")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        }),
      100,
    );
  }

  const connectorName = (id) => (id === "x" ? "X" : id.charAt(0).toUpperCase() + id.slice(1));
  const orgScope = () => "org:" + orgId;

  governanceUI.integrations.configure({ api, orgScope, connectorName, fmtTime });
  governanceUI.integrations.mountBuiltIns();
  async function loadConnectors() {
    return governanceUI.integrations.loadConnectors();
  }
  async function loadSlackInstallation() {
    return governanceUI.integrations.loadSlackInstallation();
  }
  function collectPolicy() {
    return governanceUI.collect("command-policy");
  }
  $("policy-test-open").onclick = () => {
    $("policy-test-dialog").showModal();
    $("policy-sample").focus();
  };
  $("policy-test-close").onclick = () => $("policy-test-dialog").close();
  async function simulatePolicy() {
    const command = $("policy-sample").value;
    const result = $("policy-result");
    if (!command.trim()) {
      result.dataset.tone = "";
      result.textContent = "Enter a sample command first.";
      return;
    }
    let policy;
    try {
      policy = collectPolicy();
    } catch (err) {
      result.dataset.tone = "danger";
      result.textContent = err instanceof Error ? err.message : "Policy is invalid.";
      return;
    }
    $("policy-simulate").disabled = true;
    result.dataset.tone = "";
    result.textContent = "Evaluating with the server’s command scanner…";
    const simulateBody = { command };
    if (loadedCommandPolicyPresent || $("card-command-policy").classList.contains("dirty"))
      simulateBody.policy = policy;
    const response = await api(
      "PUT",
      "/api/scopes/" + encodeURIComponent(scope) + "/command-policy-simulate",
      simulateBody,
    );
    $("policy-simulate").disabled = false;
    if (!response.ok) {
      result.dataset.tone = "danger";
      result.textContent = response.data?.message || "Simulation failed.";
      return;
    }
    const decision = response.data.decision;
    let tone = "warn";
    if (decision === "allow") tone = "ok";
    else if (decision === "deny") tone = "danger";
    result.dataset.tone = tone;
    let ruleLabel = null;
    if (response.data.ruleSource === "organization") {
      ruleLabel = "Organization rule " + (response.data.ruleIndex + 1);
    } else if (response.data.ruleSource === "scope") {
      ruleLabel = "This scope’s rule " + (response.data.ruleIndex + 1);
    }
    result.textContent = ruleLabel
      ? ruleLabel +
        " matches" +
        (response.data.matched ? " “" + response.data.matched + "”" : "") +
        " → " +
        (EFFECT_LABELS[decision] || decision) +
        (response.data.reason ? " · " + response.data.reason : "")
      : "No scope-policy rule matches → " +
        (EFFECT_LABELS[decision] || decision) +
        (response.data.reason ? " · " + response.data.reason : "");
  }
  $("policy-simulate").onclick = simulatePolicy;
  $("policy-sample").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      simulatePolicy();
    }
  });
  const SAVE = Object.fromEntries([...governanceUI.states.keys()].map((key) => [key, () => governanceUI.collect(key)]));
  const SAVE_ST = {
    "security-posture": "st-security-posture",
    "auto-flagger": "st-auto-flagger",
    "sharing-posture": "st-sharing-posture",
    "approval-grant-modes": "st-approval-grant-modes",
    "command-policy": "st-policy",
    soul: "st-soul",
    "ambient-policy": "st-ambient-policy",
    egress: "st-egress",
    "external-slack-participants": "st-external-slack-participants",
    "org-ambient": "st-governance-org-ambient",
    "channel-header-pin-default": "st-channel-header-pin-default",
    runtime: "st-runtime",
    "cron-runtime": "st-cron-runtime",
    "subagent-runtime": "st-subagent-runtime",
    "fallback-runtime": "st-fallback-runtime",
    "webui-models": "st-webui-models",
    "memory-embedding-model": "st-memory-embedding-model",
    "ack-emoji": "st-ack-emoji",
    branding: "st-branding",
  };
  const SAVE_RELOADS = new Set([
    "auto-flagger",
    "soul",
    "external-slack-participants",
    "runtime",
    "cron-runtime",
    "subagent-runtime",
    "fallback-runtime",
    "webui-models",
    "ack-emoji",
    "branding",
  ]);
  const sectionSnapshots = new Map();
  function autoFlaggerTestSummary(data) {
    if (!data.sampled) return data.message || "No past screenings to replay yet.";
    const pct = (value) => (value == null ? "n/a" : (value * 100).toFixed(1) + "%");
    const parts = ["Flagged " + data.flagged + " of " + data.scored + " scored (" + pct(data.flagRate) + ")"];
    if (data.baseline) {
      parts.push(
        "current rubric flags " +
          pct(data.baseline.flagRate) +
          " · " +
          plural(data.baseline.changed, "verdict") +
          " changed",
      );
    }
    if (data.unscreened) parts.push(plural(data.unscreened, "sample") + " came back unscreened");
    if (data.errors) parts.push(plural(data.errors, "sample") + " errored");
    if (data.partial) parts.push("stopped at the time limit — partial result");
    parts.push("sampled " + data.sampled + " · " + Math.round(data.durationMs / 100) / 10 + "s");
    return parts.join(" · ");
  }
  function sectionButton(key) {
    return document.querySelector('[data-save="' + key + '"]');
  }
  function serializeSection(key) {
    return JSON.stringify(SAVE[key]());
  }
  function setSectionDirty(key, dirty) {
    if (governanceUI.owns(key)) return;
    const btn = sectionButton(key);
    setCardDirty(btn?.closest(".card"), dirty, SAVE_ST[key], '[data-save="' + key + '"]');
    if (key === "egress" && $("card-egress").classList.contains("egress-disabled")) btn.disabled = true;
  }
  function captureSection(key) {
    if (governanceUI.owns(key)) {
      sectionSnapshots.set(key, JSON.stringify(governanceUI.states.get(key).collect(false)));
      governanceUI.capture(key);
      return;
    }
    if (!SAVE[key] || !sectionButton(key)) return;
    try {
      sectionSnapshots.set(key, serializeSection(key));
      setSectionDirty(key, false);
    } catch {
      setSectionDirty(key, true);
    }
  }
  function updateSectionDirty(key) {
    if (governanceUI.owns(key)) return;
    if (!SAVE[key] || !sectionButton(key)) return;
    if (!sectionSnapshots.has(key)) return captureSection(key);
    let dirty;
    try {
      dirty = serializeSection(key) !== sectionSnapshots.get(key);
    } catch {
      dirty = true;
    }
    setSectionDirty(key, dirty);
  }
  function captureGovernanceSnapshots() {
    Object.keys(SAVE_ST).forEach(captureSection);
  }
  function saveKeyForTarget(target) {
    const card = target.closest(".card");
    const btn = card?.querySelector("[data-save]");
    return btn?.dataset.save || "";
  }
  function governanceSaveReview(key, body) {
    if (key === "security-posture") {
      const before = JSON.parse(sectionSnapshots.get(key) || "{}").posture || "auto";
      const dangerous = body.posture === "dangerous";
      return reviewGovernanceChange({
        title: dangerous ? "Enable Dangerous autonomy?" : "Change security posture?",
        subtitle: "Review the immutable change below before it is applied.",
        facts: [
          ["Scope", governanceScopeName()],
          ["Current", titleCase(before)],
          ["Proposed", titleCase(body.posture)],
        ],
        warning: dangerous
          ? "Dangerous disables posture-based content screening and tool approval gates. Deployment-required screening still applies. Predeclared command approvals, hard denials, identity, authorization, credential scope, revocation, and audit remain enforced."
          : "This changes the effective tools and approval behavior for future turns in this scope.",
        confirmLabel: dangerous ? "Enable Dangerous" : "Apply posture",
        danger: dangerous,
      });
    }
    if (key === "sharing-posture") {
      const before = JSON.parse(sectionSnapshots.get(key) || "{}").posture || "isolated";
      const open = body.posture === "open";
      return reviewGovernanceChange({
        title: open ? "Enable Open sharing?" : "Return to Isolated sharing?",
        subtitle: "This applies to future live human turns in the selected scope.",
        facts: [
          ["Scope", governanceScopeName()],
          ["Current", titleCase(before)],
          ["Proposed", titleCase(body.posture)],
        ],
        warning: open
          ? "Open can reveal a speaker's private information in shared replies. It does not carry credentials, history, writes, automation, or another person's resources. Organization, personal, and room policy must all allow it."
          : "Cross-context resources will again require explicit shares or grants.",
        confirmLabel: open ? "Enable Open" : "Use Isolated",
        danger: open,
      });
    }
    if (key === "external-slack-participants") {
      const before = !!JSON.parse(sectionSnapshots.get(key) || "{}").on;
      return reviewGovernanceChange({
        title: body.on ? "Allow external Slack audiences?" : "Return Slack to internal-only?",
        subtitle: "This organization-wide audience boundary applies to future Slack turns.",
        facts: [
          ["Scope", governanceScopeName()],
          ["Current", before ? "External audiences enabled" : "Internal only"],
          ["Proposed", body.on ? "External audiences enabled" : "Internal only"],
        ],
        warning: body.on
          ? "Agent replies and anything read in a mixed Slack room can be visible to guests or Slack Connect participants. External users still cannot drive the agent."
          : "Mixed-audience Slack rooms will stop receiving agent replies after this change.",
        confirmLabel: body.on ? "Allow external audiences" : "Require internal audiences",
        danger: !!body.on,
      });
    }
    return Promise.resolve(true);
  }
  $("sharing-posture-inherit").onclick = async () => {
    const requestedScope = scope;
    const requestedGeneration = governanceReq;
    const draftBefore = JSON.stringify(governanceUI.collect("sharing-posture"));
    if (
      !(await reviewGovernanceChange({
        title: "Follow organization sharing?",
        subtitle: "Remove this scope's sharing override.",
        facts: [["Scope", governanceScopeName()]],
        warning:
          "The organization's sharing setting will apply. A personal or room Isolated override still takes precedence.",
        confirmLabel: "Follow organization",
      })) ||
      requestedScope !== scope ||
      requestedGeneration !== governanceReq
    )
      return;
    const result = await api("PUT", "/api/scopes/" + encodeURIComponent(requestedScope) + "/sharing-posture", {
      inherit: true,
    });
    if (requestedScope !== scope || requestedGeneration !== governanceReq) return;
    if (result.ok)
      await refreshPolicySetting("sharing-posture", requestedScope, requestedGeneration, draftBefore, "Saved");
    else setStatus("st-sharing-posture", "Could not reset sharing.", "err");
  };
  async function refreshPolicySetting(key, requestedScope, requestedGeneration, draftBefore, message) {
    const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(requestedScope) + "?view=governance");
    if (requestedScope !== scope || requestedGeneration !== governanceReq) return;
    if (!fresh.ok) return governanceUI.status(key, "Saved, but the current setting could not be refreshed.", "warn");
    const state = governanceUI.states.get(key);
    const currentDraft = state.collect();
    const changed = JSON.stringify(currentDraft) !== draftBefore;
    governanceUI.load(fresh.data, requestedScope, key);
    sectionSnapshots.set(key, state.baseline);
    if (changed) {
      state.draft = currentDraft;
      state.changed();
    } else governanceUI.status(key, message, "ok");
  }
  let governanceSaveSeq = 0;
  $("auto-flagger-test").onclick = async () => {
    const requestedScope = scope;
    const button = $("auto-flagger-test");
    $("auto-flagger-test-result").hidden = false;
    const windowField = $("auto-flagger-window");
    const requested = Number(windowField.value);
    if (!Number.isInteger(requested) || requested < 1 || requested > 500) {
      return setStatus("st-auto-flagger-test", "Window must be a whole number between 1 and 500.", "err", true);
    }
    setStatus("st-auto-flagger-test", "Replaying the last " + requested + " screenings through this rubric…", "", true);
    button.disabled = true;
    try {
      const r = await api("POST", "/api/scopes/" + encodeURIComponent(requestedScope) + "/auto-flagger/test", {
        window: requested,
        compare: $("auto-flagger-compare").checked,
        harnessId: $("auto-flagger-harness").value,
        modelId: $("auto-flagger-model").value,
        rubric: $("auto-flagger-rubric").value,
      });
      if (requestedScope !== scope) return;
      if (!r.ok) {
        return setStatus("st-auto-flagger-test", r.data?.message || "Test run failed.", "err", true);
      }
      setStatus("st-auto-flagger-test", autoFlaggerTestSummary(r.data), r.data.errors ? "warn" : "ok", true);
    } finally {
      button.disabled = false;
    }
  };
  $("auto-flagger-reset").onclick = async () => {
    const requestedScope = scope;
    const requestedGeneration = governanceReq;
    const draftBefore = JSON.stringify(governanceUI.collect("auto-flagger"));
    const r = await api("PUT", "/api/scopes/" + encodeURIComponent(requestedScope) + "/auto-flagger", {
      reset: true,
    });
    if (requestedScope !== scope || requestedGeneration !== governanceReq) return;
    if (!r.ok) return setStatus("st-auto-flagger", r.data?.message || "Reset failed.", "err");
    await refreshPolicySetting("auto-flagger", requestedScope, requestedGeneration, draftBefore, "Default restored");
  };

  async function saveSetting(key, btn) {
    const requestedScope = scope;
    const requestedGeneration = governanceReq;
    let body;
    try {
      body = SAVE[key]();
    } catch (err) {
      setStatus(SAVE_ST[key], err instanceof Error ? err.message : "Could not save.", "err");
      return;
    }
    if (!(await governanceSaveReview(key, body)) || requestedScope !== scope || requestedGeneration !== governanceReq)
      return;
    const saveRequest = String(++governanceSaveSeq);
    if (btn) {
      btn.dataset.saveRequest = saveRequest;
      btn.disabled = true;
    }
    setStatus(SAVE_ST[key], "Saving...", "saving", true);
    const isBranding = key === "branding";
    const brandingBody = isBranding ? { ...savedBranding, ...body } : body;
    const r = await api(
      "PUT",
      "/api/scopes/" + encodeURIComponent(requestedScope) + "/" + (isBranding ? "branding" : key),
      brandingBody,
    );
    if (requestedGeneration !== governanceReq) return;
    if (requestedScope !== scope) {
      if (!btn || btn.dataset.saveRequest === saveRequest) {
        if (btn) {
          delete btn.dataset.saveRequest;
          btn.disabled = !btn.classList.contains("dirty");
        }
        setStatus(SAVE_ST[key], "", "");
      }
      return;
    }
    if (btn?.dataset.saveRequest === saveRequest) delete btn.dataset.saveRequest;
    if (r.ok) {
      if (governanceUI.owns(key)) {
        governanceUI.commit(key, body);
        sectionSnapshots.set(key, JSON.stringify(body));
        if (isBranding) {
          savedBranding = brandingBody;
          if (!hasGovernanceDraft()) location.reload();
          return;
        }
        if (key === "soul") {
          const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(requestedScope) + "?view=customize");
          if (requestedScope !== scope || requestedGeneration !== governanceReq) return;
          if (fresh.ok) {
            governanceUI.settings.refreshSoul(fresh.data);
            sectionSnapshots.set(key, governanceUI.states.get(key).baseline);
            if (!governanceUI.states.get(key).dirty) governanceUI.status(key, "Saved", "ok");
          } else governanceUI.status(key, "Saved, but the latest version could not be refreshed.", "warn");
          return;
        }
        if (key === "command-policy") loadedCommandPolicyPresent = true;
        if (["security-posture", "sharing-posture", "ambient-policy", "auto-flagger"].includes(key)) {
          const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(requestedScope) + "?view=governance");
          if (requestedScope !== scope || requestedGeneration !== governanceReq) return;
          if (fresh.ok && !governanceUI.states.get(key).dirty) {
            governanceUI.load(fresh.data, requestedScope, key);
            sectionSnapshots.set(key, JSON.stringify(governanceUI.collect(key)));
            governanceUI.status(key, "Saved", "ok");
          }
        }
        return;
      } else if (SAVE_RELOADS.has(key)) await loadScope();
      else {
        if (key === "command-policy") loadedCommandPolicyPresent = true;
        captureSection(key);
      }
      setStatus(SAVE_ST[key], "Saved", "ok");
    } else {
      if (key === "soul" && r.status === 409) await refreshSoulConflict();
      updateSectionDirty(key);
      let message = r.data?.message || "Save failed.";
      if (key === "soul" && r.status === 409) {
        message = "SOUL changed; latest revision loaded and your draft was preserved.";
      } else if (r.status === 403) {
        message = "Not authorized for this scope.";
      }
      setStatus(SAVE_ST[key], message, "err");
    }
  }
  document.querySelectorAll("[data-save]").forEach((btn) => {
    btn.onclick = () => saveSetting(btn.dataset.save, btn);
  });
  governanceUI.settings.configureRuntimes({ save: (key) => saveSetting(key) });
  $("view-governance").addEventListener("input", (e) => {
    if (!(
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement
    ))
      return;
    if (e.target.closest("#card-service-credentials")) updateScFormDirty();
    else updateSectionDirty(saveKeyForTarget(e.target));
  });
  $("view-governance").addEventListener("change", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
      if (e.target.closest("#card-service-credentials")) updateScFormDirty();
      else updateSectionDirty(saveKeyForTarget(e.target));
    }
  });

  const DD_CHEVRON =
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const ddNativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  let openDropdown = null;
  let dropdownSequence = 0;
  function closeDropdown(dd) {
    if (!dd) return;
    dd.classList.remove("open");
    const btn = dd.querySelector(".dd-btn");
    btn?.setAttribute("aria-expanded", "false");
    btn?.removeAttribute("aria-activedescendant");
  }
  function upgradeCustomDropdown(sel) {
    if (
      !(sel instanceof HTMLSelectElement) ||
      sel.dataset.ddHost ||
      sel.hasAttribute("hidden") ||
      sel.multiple ||
      sel.size > 1 ||
      sel.closest(".loadout-control")
    )
      return;
    sel.dataset.ddHost = "1";
    const dd = document.createElement("div");
    dd.className = "dd";
    if (sel.getAttribute("style")) dd.setAttribute("style", sel.getAttribute("style"));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    const lab = document.createElement("span");
    btn.appendChild(lab);
    btn.insertAdjacentHTML("beforeend", DD_CHEVRON);
    const menu = document.createElement("div");
    menu.className = "dd-menu";
    menu.setAttribute("role", "listbox");
    menu.id = "dd-menu-" + ++dropdownSequence;
    btn.setAttribute("aria-controls", menu.id);
    dd.append(btn, menu);
    sel.after(dd);
    let activeIndex = -1;
    const syncLabel = () => {
      const o = sel.selectedOptions[0];
      lab.textContent = o ? o.textContent : "";
      const label = sel.getAttribute("aria-label") || sel.labels?.[0]?.textContent?.trim() || "";
      btn.setAttribute("aria-label", label ? label + ": " + lab.textContent : lab.textContent);
      btn.className = ["dd-btn", ...sel.classList].join(" ");
      btn.disabled = sel.disabled;
    };
    const commit = (value) => {
      if (ddNativeValue.get.call(sel) === value) return;
      ddNativeValue.set.call(sel, value);
      syncLabel();
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const enabledOptions = () => Array.from(sel.options).filter((o) => !o.disabled);
    const setActive = (index) => {
      const items = Array.from(menu.querySelectorAll(".dd-item:not(.dis)"));
      if (!items.length) {
        activeIndex = -1;
        return;
      }
      activeIndex = Math.max(0, Math.min(items.length - 1, index));
      items.forEach((it, i) => {
        it.classList.toggle("active", i === activeIndex);
        if (i === activeIndex) {
          btn.setAttribute("aria-activedescendant", it.id);
          it.scrollIntoView({ block: "nearest" });
        }
      });
    };
    const buildMenu = () => {
      menu.textContent = "";
      activeIndex = -1;
      let enabledIndex = 0;
      Array.from(sel.options).forEach((o) => {
        const it = document.createElement("div");
        it.className = "dd-item" + (o.selected ? " sel" : "") + (o.disabled ? " dis" : "");
        it.id = menu.id + "-option-" + menu.children.length;
        it.setAttribute("role", "option");
        if (o.selected) it.setAttribute("aria-selected", "true");
        it.textContent = o.textContent;
        if (!o.disabled) {
          if (o.selected) activeIndex = enabledIndex;
          enabledIndex += 1;
        }
        it.onclick = (e) => {
          e.stopPropagation();
          if (o.disabled) return;
          closeDropdown(dd);
          openDropdown = null;
          commit(o.value);
          btn.focus();
        };
        menu.appendChild(it);
      });
      setActive(activeIndex);
    };
    const open = () => {
      if (sel.disabled) return;
      if (openDropdown && openDropdown !== dd) closeDropdown(openDropdown);
      buildMenu();
      dd.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      openDropdown = dd;
    };
    const toggle = () => {
      const wasOpen = dd.classList.contains("open");
      closeDropdown(openDropdown);
      openDropdown = null;
      if (!wasOpen) {
        open();
      }
    };
    btn.onclick = (e) => {
      e.stopPropagation();
      toggle();
    };
    btn.onkeydown = (e) => {
      if (e.key === "Escape") {
        closeDropdown(dd);
        openDropdown = null;
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!dd.classList.contains("open")) {
          open();
          return;
        }
        const option = enabledOptions()[activeIndex];
        if (option) commit(option.value);
        closeDropdown(dd);
        openDropdown = null;
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const enabled = enabledOptions();
      if (!enabled.length) return;
      if (!dd.classList.contains("open")) {
        open();
        return;
      }
      setActive(activeIndex + (e.key === "ArrowDown" ? 1 : -1));
    };
    Object.defineProperty(sel, "value", {
      get() {
        return ddNativeValue.get.call(sel);
      },
      set(v) {
        ddNativeValue.set.call(sel, v);
        syncLabel();
      },
    });
    new MutationObserver(() => {
      syncLabel();
      if (dd.classList.contains("open")) buildMenu();
    }).observe(sel, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "disabled", "label", "selected", "value"],
    });
    sel.addEventListener("change", syncLabel);
    syncLabel();
  }
  document.addEventListener("click", () => {
    closeDropdown(openDropdown);
    openDropdown = null;
  });
  function initCustomDropdowns(root) {
    if (!(root instanceof Element)) return;
    if (root instanceof HTMLSelectElement) upgradeCustomDropdown(root);
    root.querySelectorAll("select").forEach((sel) => upgradeCustomDropdown(sel));
  }
  initCustomDropdowns($("app-view"));
  new MutationObserver((muts) => {
    muts.forEach((m) => {
      m.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (n instanceof HTMLSelectElement) upgradeCustomDropdown(n);
        else initCustomDropdowns(n);
      });
    });
  }).observe($("app-view"), { childList: true, subtree: true });

  const govFlatContent = document.querySelector("#view-governance .governance-content");
  function flattenGovernanceCards() {
    if (!govFlatContent) return;
    const setFlag = (el, cls, on) => {
      if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
    };
    let run = [];
    const flush = () => {
      run.forEach((card, i) => {
        setFlag(card, "flat-first", i === 0);
        setFlag(card, "flat-last", i === run.length - 1);
      });
      run = [];
    };
    Array.from(govFlatContent.children).forEach((el) => {
      const visible = getComputedStyle(el).display !== "none";
      if (el.matches("section.card")) {
        if (visible) run.push(el);
        else {
          setFlag(el, "flat-first", false);
          setFlag(el, "flat-last", false);
        }
      } else if (visible) {
        flush();
      }
    });
    flush();
  }
  let govFlatRaf = 0;
  function scheduleGovFlatten() {
    cancelAnimationFrame(govFlatRaf);
    govFlatRaf = requestAnimationFrame(flattenGovernanceCards);
  }
  if (govFlatContent) {
    new MutationObserver(scheduleGovFlatten).observe(root, {
      attributes: true,
      attributeFilter: ["data-subview"],
    });
    new MutationObserver(scheduleGovFlatten).observe(govFlatContent, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
    });
    flattenGovernanceCards();
  }

  resetScForm();

  let dataReq = 0;
  let historyKind = "conversation";

  const dataCache = new Map();
  function paintData(root, data) {
    root.textContent = "";
    ({
      spend: renderSpend,
      egress: renderEgress,
      history: renderHistory,
      files: renderFiles,
      memory: renderMemory,
      live: renderLive,
      errors: renderErrors,
      audit: renderAudit,
      skills: renderSkills,
      crons: renderCrons,
      deployments: renderDeployments,
      retention: renderRetention,
      users: renderUsers,
      keychain: renderKeychain,
    })[view](root, data);
  }
  async function renderData() {
    const root = $("view-data");
    const reqId = ++dataReq;
    const q = "scope=" + encodeURIComponent(scope);
    const ep = ENDPOINT[view] || view;
    let path = ORG_WIDE.has(view) ? `/api/${ep}` : `/api/${ep}?${q}`;

    if (view === "memory" && orgWideView() && urlToState().mem !== "edit") path = "/api/memory/scopes";
    if (view === "history") {
      path += `&limit=${HISTORY_PAGE_SIZE}&category=${encodeURIComponent(historyCategory(historyKind))}`;
      if (historyCursor) path += `&cursor=${encodeURIComponent(historyCursor)}`;
      if (historyKind === "cron") {
        path += `&origin=${encodeURIComponent(historyKind)}`;
        const cronSel = urlToState().cron;
        if (cronSel) path += `&cron=${encodeURIComponent(cronSel)}`;
      }
      if (historyKind === "background") path += "&origin=other_background";
    }
    if (view === "errors") path += `&limit=${ERRORS_PAGE_SIZE}&offset=${(page - 1) * ERRORS_PAGE_SIZE}`;
    if (view === "spend") path += `?${spendQuery(urlToState())}`;
    const cacheable = view !== "memory";
    const cached = cacheable ? dataCache.get(path) : undefined;
    if (cached !== undefined) {
      paintData(root, cached);
    } else {
      root.textContent = "";
      const loading = document.createElement("div");
      loading.className = "loadingline";
      loading.textContent = "Loading " + (VIEW_TITLE[view] || view).toLowerCase() + "...";
      root.appendChild(loading);
    }
    const r = await api("GET", path);
    if (reqId !== dataReq) return;
    if (!r.ok) {
      if (cached !== undefined) return;
      root.textContent = "";
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent =
        r.status === 403 ? "You don't administer this scope." : r.data?.message || `Failed to load (${r.status}).`;
      root.appendChild(p);
      return;
    }
    if (cacheable) dataCache.set(path, r.data);
    viewLoadedAt[view] = Date.now();
    paintData(root, r.data);
  }
  function kpis(items, className = "") {
    const wrap = document.createElement("div");
    wrap.className = "kpis";
    if (className) wrap.classList.add(className);
    items.forEach(([n, k]) => {
      const d = document.createElement("div");
      d.className = "kpi";
      const a = document.createElement("div");
      a.className = "n";
      a.textContent = n;
      const b = document.createElement("div");
      b.className = "k";
      b.textContent = k;
      d.append(a, b);
      wrap.appendChild(d);
    });
    return wrap;
  }

  function spendQuery(st) {
    const { from, to, bucket } = governanceUI.spend.spendWindow(st);
    return new URLSearchParams({ from, to, bucket }).toString();
  }
  function renderSpend(root, d) {
    governanceUI.spend.spend(root, d, {
      defaultShell,
      fmtPct,
      fmtTokens,
      shortName,
      shortSchedule,
      cronName,
      plural,
      window: governanceUI.spend.spendWindow(urlToState()),
      openUser: (principal) => go({ view: "user", scope, session: null, principal }),
      openCronRuns: (cron, cronScope) =>
        go({ view: "history", scope: cronScope, session: null, historyKind: "cron", cron }),
      setRange: (range) => go({ ...urlToState(), view: "spend", range, from: null, to: null }),
      setCustomRange: (from, to) => go({ ...urlToState(), view: "spend", range: null, from, to }),
      downloadCsv: (breakdown = "entity") => {
        const a = document.createElement("a");
        a.href =
          API_BASE + "/spend?format=csv&breakdown=" + encodeURIComponent(breakdown) + "&" + spendQuery(urlToState());
        a.rel = "noreferrer";
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
    });
  }
  function renderErrors(root, d) {
    governanceUI.activity.errors(root, d, {
      all: orgWideView(),
      scope,
      defaultShell,
      plural,
      firstLine,
      navLink,
      shortName,
      fmtTime,
      relTime,
      go,
      egressDetail,
      errorsPageSize: ERRORS_PAGE_SIZE,
    });
  }
  function renderAudit(root, d) {
    governanceUI.activity.audit(root, d, {
      all: orgWideView(),
      scope,
      defaultShell,
      plural,
      firstLine,
      navLink,
      shortName,
      fmtTime,
      relTime,
      go,
      egressDetail,
      errorsPageSize: ERRORS_PAGE_SIZE,
    });
  }
  async function adminErrors(query) {
    const r = await api("GET", "/api/errors?" + query);
    return r.ok ? r.data?.errors || [] : [];
  }
  async function adminErrorCount(query) {
    const r = await api("GET", "/api/errors?count=1&" + query);
    return r.ok ? Number(r.data?.total || 0) : 0;
  }
  function errorStripBox(errs, headText, max, rowLink) {
    const box = document.createElement("div");
    box.className = "error-strip";
    const head = document.createElement("div");
    head.className = "error-strip-head";
    head.textContent = headText;
    box.appendChild(head);
    errs.slice(0, max).forEach((e) => {
      const link = rowLink ? rowLink(e) : null;
      const row = document.createElement(link ? "a" : "div");
      row.className = "error-strip-row";
      if (link) {
        row.href = link.href;
        row.onclick = (ev) => {
          if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
          ev.preventDefault();
          link.go();
        };
      }
      const msg = document.createElement("span");
      msg.className = "mono";
      msg.textContent = firstLine(e.message || "(no message)", 160);
      msg.title = e.message || "";
      const meta = document.createElement("span");
      meta.className = "subline";
      meta.textContent = [e.category || "uncategorized", e.code, relTime(e.ts)].filter(Boolean).join(" · ");
      row.append(msg, meta);
      box.appendChild(row);
    });
    if (errs.length > max) {
      const more = document.createElement("div");
      more.className = "subline";
      more.textContent = "…and " + (errs.length - max) + " more";
      box.appendChild(more);
    }
    return box;
  }
  function egressDetail(r) {
    const bits = [];
    if (r.source === "broker") {
      if (r.slug) bits.push("cred:" + r.slug);
      if (r.upstreamStatus != null) bits.push("↑" + r.upstreamStatus);
    } else {
      if (r.via) bits.push(r.via);
      if (r.port != null) bits.push(":" + r.port);
      if (r.peerIp) bits.push(r.peerIp);
    }
    return bits.join(" · ") || "None";
  }
  function renderEgress(root, d) {
    governanceUI.activity.egress(root, d, {
      all: orgWideView(),
      scope,
      defaultShell,
      plural,
      firstLine,
      navLink,
      shortName,
      fmtTime,
      relTime,
      go,
      egressDetail,
      errorsPageSize: ERRORS_PAGE_SIZE,
    });
  }
  function cronName(c, previewAction = false) {
    if (!c) return "Cron";
    if (c.title || c.message) return c.title || c.message;
    if (previewAction && c.action) return firstLine(c.action, 96);
    return "Cron " + shortId(c.id);
  }
  function wakeOriginLabel(trigger) {
    switch (String(trigger || "").toLowerCase()) {
      case "cron":
        return "Cron";
      case "monitor":
        return "Monitor wake";
      case "webhook":
        return "Webhook wake";
      default:
        return "Background wake";
    }
  }
  function plural(n, one, many = one + "s") {
    return `${Number(n || 0).toLocaleString()} ${Number(n || 0) === 1 ? one : many}`;
  }
  function historyCategory(kind) {
    return kind === "cron" || kind === "background" ? "background" : kind;
  }

  const KIND_LABEL = { conversation: "Conversations", cron: "Cron runs", background: "Background" };
  function historyModeLabel(kind) {
    return KIND_LABEL[kind] || KIND_LABEL.conversation;
  }
  function historyKindMatches(s, kind) {
    if (kind === "conversation") return s.category !== "background";
    if (kind === "cron") return s.origin?.kind === "cron";
    if (kind === "background") return s.category === "background" && s.origin?.kind !== "cron";
    return true;
  }
  function cronFieldSet(raw, min, max, dow = false) {
    const values = new Set();
    const pieces = String(raw || "").split(",");
    let any = raw === "*";
    for (const piece of pieces) {
      if (!piece) return null;
      const [base, stepRaw] = piece.split("/");
      const step = stepRaw == null ? 1 : Number(stepRaw);
      if (!Number.isInteger(step) || step <= 0) return null;
      let start, end;
      if (base === "*") {
        start = min;
        end = max;
        any = pieces.length === 1 && step === 1;
      } else if (base.includes("-")) {
        const [a, b] = base.split("-").map(Number);
        if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
        start = a;
        end = b;
      } else {
        const n = Number(base);
        if (!Number.isInteger(n)) return null;
        start = dow && n === 7 ? 0 : n;
        end = start;
      }
      if (start < min || end > max || start > end) return null;
      for (let n = start; n <= end; n += step) values.add(dow && n === 7 ? 0 : n);
    }
    const normalized = [...values].filter((n) => n >= min && n <= (dow ? 6 : max)).sort((a, b) => a - b);
    return normalized.length ? { any, values: normalized } : null;
  }
  function humanCron(expr) {
    const clean = String(expr || "")
      .trim()
      .replace(/\s+/g, " ");
    const parts = clean.split(" ");
    if (parts.length !== 5) return "cron " + clean;
    const minutes = cronFieldSet(parts[0], 0, 59);
    const hours = cronFieldSet(parts[1], 0, 23);
    const dom = cronFieldSet(parts[2], 1, 31);
    const months = cronFieldSet(parts[3], 1, 12);
    const dow = cronFieldSet(parts[4], 0, 7, true);
    if (!minutes || !hours || !dom || !months || !dow) return "cron " + clean;
    const minute = minutes.values.length === 1 ? minutes.values[0] : null;
    const hour = hours.values.length === 1 ? hours.values[0] : null;
    if (minute != null && hour != null && dom.any && months.any) {
      const suffix = hour < 12 ? "AM" : "PM";
      const time = (hour % 12 || 12) + ":" + String(minute).padStart(2, "0") + " " + suffix;
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const full = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
      if (dow.any) return "daily " + time;
      if (dow.values.join(",") === "1,2,3,4,5") return "weekdays " + time;
      return (dow.values.length === 1 ? full[dow.values[0]] : dow.values.map((d) => days[d]).join(", ")) + " " + time;
    }
    if (minute != null && hours.any && dom.any && months.any && dow.any)
      return minute === 0 ? "hourly" : "hourly at :" + String(minute).padStart(2, "0");
    return "cron " + clean;
  }
  function fmtSchedule(sch) {
    if (!sch) return "None";
    if (sch.cron) {
      const label = humanCron(sch.cron);
      return (
        label +
        (sch.timezone ? " (" + sch.timezone + ")" : " (default timezone)") +
        (label === "cron " + sch.cron ? "" : " · " + sch.cron)
      );
    }
    if (sch.everyMs != null) return shortSchedule(sch);
    return sch.firstFireAt ? "once at " + fmtTime(sch.firstFireAt) : "Never";
  }

  function shortSchedule(sch) {
    if (!sch) return "Never";
    if (sch.cron) {
      const label = humanCron(sch.cron);
      return label.startsWith("cron ") ? sch.cron : label;
    }
    if (sch.everyMs != null) {
      const units = [
        [86400000, "d"],
        [3600000, "h"],
        [60000, "m"],
        [1000, "s"],
      ];
      for (const [n, u] of units) if (sch.everyMs >= n && sch.everyMs % n === 0) return "every " + sch.everyMs / n + u;
      return "every " + sch.everyMs + " ms";
    }
    return sch.firstFireAt ? "once" : "Never";
  }
  function destinationSummary(dest) {
    if (!dest) return "None";
    return (dest.type || "destination") + " -> " + (dest.target || "-");
  }
  function destinationDetails(dest) {
    if (!dest) return "No delivery destination";
    const bits = [];
    if (dest.audienceScopeId) bits.push(dest.audienceScopeId);
    if (dest.onBehalfOf) bits.push("on behalf of " + dest.onBehalfOf);
    return bits.join(" / ");
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
      view,
      scope: capturedScope,
      orgId,
      scopeDir,
      orgWide: orgWideView(),
      index: orgWideView() && !orgOwnView(),
      own: orgOwnView(),
      cron: urlToState().cron,
      apiBase: API_BASE,
      api,
      pageShell,
      go,
      stateToUrl,
      openScopeRow,
      scopeKind,
      shortName,
      dirLabel,
      plural,
      relTime,
      fmtTime,
      fmtHistoryTime,
      fmtBytes,
      fmtDuration,
      shortId,
      titleCase,
      firstLine,
      fileName,
      fileKind,
      fileSha256,
      uploadErrorMessage,
      downloadFile,
      deploymentHref,
      cronName,
      shortSchedule,
      fmtSchedule,
      destinationSummary,
      destinationDetails,
      createdByCell,
      packRepoLabel,
      scopeCell,
      statusBadge,
      typeBadge,
      stacked,
      scopeRows,
      buildScopeMultiSelect,
      invalidate: () => dataCache.clear(),
      reload: () => (current() ? renderData() : Promise.resolve()),
      setCronEditing: (id) => {
        if (current()) cronDestinationEditId = id;
      },
    };
  }
  function renderCrons(root, d) {
    governanceUI.artifacts.crons(root, d, artifactContext());
  }
  function renderDeployments(root, d) {
    governanceUI.artifacts.deployments(root, d, artifactContext());
  }

  function packRepoLabel(url) {
    try {
      return (
        (url || "")
          .replace(/\.git$/, "")
          .split("/")
          .filter(Boolean)
          .slice(-2)
          .join("/") ||
        url ||
        ""
      );
    } catch {
      return url || "";
    }
  }
  function createdByCell(s) {
    if (s.pack) return { text: packRepoLabel(s.pack.url) || "pack " + shortId(s.pack.id, 8), cls: "mono" };
    if (s.createdBy && s.createdBy.indexOf("system:") === 0) return { text: "built-in", cls: "subline" };
    return { text: s.createdBy || "None", cls: "mono" };
  }

  function renderSkills(root, d) {
    governanceUI.artifacts.skills(root, d, artifactContext());
  }

  let openOvMenu = null;
  const closeOvMenus = () => {
    if (!openOvMenu) return;
    openOvMenu.menu.classList.add("hidden");
    openOvMenu.btn.setAttribute("aria-expanded", "false");
    openOvMenu = null;
  };
  document.addEventListener("click", closeOvMenus);
  document.addEventListener("scroll", closeOvMenus, true);
  window.addEventListener("resize", closeOvMenus);
  function buildScopeMultiSelect(choices, selected, onChange) {
    const pick = document.createElement("div");
    pick.className = "scopepick";
    pick.style.cssText = "display:flex; align-items:center; gap:6px; flex-wrap:wrap;";
    const labelOf = (id) => (choices.find((c) => c.scopeId === id) || {}).label || dirLabel(id) || id;
    const orgFirst = (ids) =>
      ids.sort((a, b) => {
        if (scopeKind(a) === "org") return -1;
        if (scopeKind(b) === "org") return 1;
        return a.localeCompare(b);
      });

    const chips = document.createElement("div");
    chips.style.cssText = "display:flex; align-items:center; gap:6px; flex-wrap:wrap;";
    const renderChips = () => {
      chips.textContent = "";
      if (!selected.size) {
        const none = document.createElement("span");
        none.style.cssText = "font-size:12px; color:var(--muted);";
        none.textContent = "no scopes selected";
        chips.appendChild(none);
        return;
      }
      for (const id of orgFirst([...selected])) {
        const chip = document.createElement("span");
        chip.style.cssText =
          "display:inline-flex; align-items:center; gap:5px; padding:2px 5px 2px 9px; border:1px solid var(--border); border-radius:12px; background:var(--subtle); font-size:12px; white-space:nowrap;";
        chip.title = id;
        const t = document.createElement("span");
        t.textContent = labelOf(id);
        chip.appendChild(t);
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "✕";
        x.setAttribute("aria-label", "Remove " + labelOf(id));
        x.style.cssText =
          "border:none; background:transparent; cursor:pointer; color:var(--muted); font-size:11px; line-height:1; padding:0 1px;";
        x.onclick = (e) => {
          e.stopPropagation();
          selected.delete(id);
          renderChips();
          renderList();
          onChange();
        };
        chip.appendChild(x);
        chips.appendChild(chip);
      }
    };

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "rowbtn";
    addBtn.textContent = "+ Add scope ▾";
    addBtn.setAttribute("aria-haspopup", "listbox");
    addBtn.setAttribute("aria-expanded", "false");

    const menu = document.createElement("div");
    menu.className = "scope-menu hidden";
    menu.style.cssText = "left:0; right:auto; width:min(320px, 80vw);";
    const filterWrap = document.createElement("div");
    filterWrap.className = "scope-filter";
    const filter = document.createElement("input");
    filter.type = "text";
    filter.placeholder = "Filter scopes…";
    filter.spellcheck = false;
    filter.setAttribute("autocapitalize", "none");
    filter.style.cssText =
      "width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid var(--border); border-radius:var(--radius); font:inherit;";
    filterWrap.appendChild(filter);
    const list = document.createElement("div");
    list.className = "scope-list";
    list.setAttribute("role", "listbox");
    const bulk = document.createElement("div");
    bulk.style.cssText = "display:flex; gap:14px; padding:8px 10px; border-top:1px solid var(--border);";
    const mkLink = (text, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.style.cssText =
        "border:none; background:transparent; cursor:pointer; color:var(--text); font:inherit; font-size:12px; text-decoration:underline; text-underline-offset:2px; padding:0;";
      b.onclick = fn;
      return b;
    };
    bulk.append(
      mkLink("Select all", () => {
        choices.forEach((c) => selected.add(c.scopeId));
        renderChips();
        renderList();
        onChange();
      }),
      mkLink("Clear", () => {
        selected.clear();
        renderChips();
        renderList();
        onChange();
      }),
    );

    const renderList = () => {
      const q = filter.value.trim().toLowerCase();
      list.textContent = "";
      const shown = choices.filter(
        (c) => !q || c.label.toLowerCase().includes(q) || c.scopeId.toLowerCase().includes(q),
      );
      if (!shown.length) {
        const p = document.createElement("div");
        p.className = "scope-note";
        p.textContent = "No scopes match.";
        list.appendChild(p);
        return;
      }
      for (const c of shown) {
        const on = selected.has(c.scopeId);
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "scope-option" + (on ? " selected" : "");
        opt.setAttribute("role", "option");
        opt.setAttribute("aria-selected", String(on));
        opt.title = c.scopeId;
        const name = document.createElement("span");
        name.className = "scope-name";
        name.appendChild(stacked(c.label, c.label === c.scopeId ? "" : c.scopeId));
        const mark = document.createElement("span");
        mark.className = "count";
        mark.textContent = on ? "✓" : "";
        opt.append(name, mark);
        opt.onclick = () => {
          if (selected.has(c.scopeId)) selected.delete(c.scopeId);
          else selected.add(c.scopeId);
          renderChips();
          renderList();
          onChange();
          filter.focus();
        };
        list.appendChild(opt);
      }
    };

    let onDocClick = null;
    const setOpen = (open) => {
      menu.classList.toggle("hidden", !open);
      addBtn.setAttribute("aria-expanded", String(open));
      if (open) {
        filter.value = "";
        renderList();
        filter.focus();
        onDocClick = (e) => {
          if (!pick.contains(e.target)) setOpen(false);
        };
        document.addEventListener("click", onDocClick);
      } else if (onDocClick) {
        document.removeEventListener("click", onDocClick);
        onDocClick = null;
      }
    };
    addBtn.onclick = (e) => {
      e.stopPropagation();
      setOpen(menu.classList.contains("hidden"));
    };
    filter.addEventListener("input", renderList);
    filter.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        addBtn.focus();
      }
    });

    menu.append(filterWrap, list, bulk);
    pick.append(chips, addBtn, menu);
    renderChips();
    return pick;
  }
  function renderMemory(root, d) {
    governanceUI.artifacts.memory(root, d, artifactContext());
  }
  function renderRetention(root, d) {
    governanceUI.artifacts.retention(root, d);
  }
  function renderKeychain(root, d) {
    governanceUI.keychain.keychain(root, d, {
      defaultShell,
      fmtTime,
      scopeKind,
      openUser: (principal) => go({ view: "user", scope, session: null, principal }),
    });
  }
  function renderUsers(root, d) {
    governanceUI.users.users(root, d, {
      api,
      copyText,
      defaultShell,
      fmtTime,
      relTime,
      labelRole,
      confirm: (message) => window.confirm(message),
      openWebUiAs,
      orgScope: "org:" + orgId,
      clearCache: () => dataCache.clear(),
      openUser: (principal) => go({ view: "user", scope, session: null, principal }),
    });
  }

  const fmtBytes = (n) => {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  };
  function payloadText(p) {
    if (p == null) return "";
    if (typeof p === "string") return p;
    if (typeof p === "object" && typeof p.text === "string") return p.text;

    if (typeof p === "object" && typeof p.thinking === "string")
      return p.thinking || (p.redacted ? "[redacted thinking]" : "");
    try {
      return JSON.stringify(p, null, 2);
    } catch {
      return String(p);
    }
  }
  const stringify = (x) => {
    try {
      return JSON.stringify(x, null, 2);
    } catch {
      return String(x);
    }
  };
  const TOOL_PREVIEW_CHARS = 1800;
  function appendInlineMarkdown(parent, text) {
    const pushText = (s) => {
      if (s) parent.appendChild(document.createTextNode(s));
    };
    const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*]+)\*)/g;
    let last = 0;
    for (const m of String(text || "").matchAll(re)) {
      pushText(text.slice(last, m.index));
      if (m[2]) {
        const strong = document.createElement("strong");
        strong.textContent = m[2];
        parent.appendChild(strong);
      } else if (m[3]) {
        const code = document.createElement("code");
        code.textContent = m[3];
        parent.appendChild(code);
      } else if (m[4] && m[5]) {
        const a = document.createElement("a");
        a.href = m[5];
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = m[4];
        parent.appendChild(a);
      } else if (m[6]) {
        const em = document.createElement("em");
        em.textContent = m[6];
        parent.appendChild(em);
      }
      last = m.index + m[0].length;
    }
    pushText(text.slice(last));
  }
  function renderMarkdown(text) {
    const root = document.createElement("div");
    root.className = "message-body";
    const lines = String(text || "")
      .replace(/\r\n/g, "\n")
      .split("\n");
    let para = [];
    let list = null;
    let quote = [];
    let fence = null;
    const flushPara = () => {
      if (!para.length) return;
      const p = document.createElement("p");
      appendInlineMarkdown(p, para.join(" "));
      root.appendChild(p);
      para = [];
    };
    const flushList = () => {
      if (list) {
        root.appendChild(list.node);
        list = null;
      }
    };
    const flushQuote = () => {
      if (!quote.length) return;
      const bq = document.createElement("blockquote");
      const p = document.createElement("p");
      appendInlineMarkdown(p, quote.join(" "));
      bq.appendChild(p);
      root.appendChild(bq);
      quote = [];
    };
    for (const line of lines) {
      const fenceMatch = line.match(/^```/);
      if (fence) {
        if (fenceMatch) {
          const pre = document.createElement("pre");
          const code = document.createElement("code");
          code.textContent = fence.lines.join("\n");
          pre.appendChild(code);
          root.appendChild(pre);
          fence = null;
        } else {
          fence.lines.push(line);
        }
        continue;
      }
      if (fenceMatch) {
        flushPara();
        flushList();
        flushQuote();
        fence = { lines: [] };
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        flushPara();
        flushList();
        flushQuote();
        continue;
      }
      const quoteMatch = trimmed.match(/^>\s?(.*)$/);
      if (quoteMatch) {
        flushPara();
        flushList();
        quote.push(quoteMatch[1]);
        continue;
      }
      const listMatch = trimmed.match(/^([-*]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        flushPara();
        flushQuote();
        const ordered = /\d+\./.test(listMatch[1]);
        if (!list || list.ordered !== ordered) {
          flushList();
          list = { ordered, node: document.createElement(ordered ? "ol" : "ul") };
        }
        const li = document.createElement("li");
        appendInlineMarkdown(li, listMatch[2]);
        list.node.appendChild(li);
        continue;
      }
      flushList();
      flushQuote();
      para.push(trimmed);
    }
    if (fence) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = fence.lines.join("\n");
      pre.appendChild(code);
      root.appendChild(pre);
    }
    flushPara();
    flushList();
    flushQuote();
    if (!root.childNodes.length) {
      const p = document.createElement("p");
      p.textContent = "";
      root.appendChild(p);
    }
    return root;
  }

  const isXmlishText = (text) => /^\s*<[A-Za-z][\w-]*(\s|\/?>)/.test(String(text || ""));
  function renderXmlish(text) {
    const root = document.createElement("div");
    root.className = "message-body xml-body";
    const unescape = (s) =>
      s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
    const row = (cls, depth) => {
      const div = document.createElement("div");
      div.className = cls;
      div.style.paddingLeft = Math.min(depth, 8) * 18 + "px";
      root.appendChild(div);
      return div;
    };
    const addText = (s, depth) => {
      const t = s.replace(/^[\s\n]+|[\s\n]+$/g, "");
      if (t) appendInlineMarkdown(row("xml-text", depth), unescape(t));
    };
    const tagRe = /<\/?[A-Za-z][\w-]*(?:\s+[\w-]+(?:="[^"]*")?)*\s*\/?>/g;
    let depth = 0,
      last = 0;
    for (const m of String(text || "").matchAll(tagRe)) {
      addText(text.slice(last, m.index), depth);
      const tok = m[0];
      const closing = tok.startsWith("</");
      if (closing) depth = Math.max(0, depth - 1);
      row("xml-tag" + (closing ? " closing" : ""), depth).textContent = tok;
      if (!closing && !tok.endsWith("/>")) depth += 1;
      last = m.index + tok.length;
    }
    addText(text.slice(last), depth);
    return root;
  }
  function firstLine(text, max = 120) {
    const line =
      String(text || "")
        .split("\n")
        .find((x) => x.trim()) ||
      String(text || "").split("\n")[0] ||
      "";
    const compact = line.trim().replace(/\s+/g, " ");
    return compact.length > max ? compact.slice(0, Math.max(0, max - 3)) + "..." : compact;
  }
  function payloadName(p) {
    return p && typeof p === "object" && typeof p.name === "string" ? p.name.trim() : "";
  }
  function toolName(callPayload, resultPayload) {
    return String(callPayload.tool || resultPayload.tool || callPayload.name || resultPayload.name || "tool");
  }
  function toolLabelText(tool, callPayload, resultPayload) {
    if (tool === "background") {
      const action = callPayload.action || resultPayload.action;
      return action ? `background ${action}` : "background";
    }
    return tool;
  }
  function toolStatusMeta(tool, resultPayload, hasResult) {
    if (!hasResult) return [metaChip("pending result")];
    if (resultPayload.blocked === "needs_approval") return [metaChip("approval needed", "danger")];
    if (resultPayload.denied === true) return [metaChip("denied", "danger")];
    if (resultPayload.error) return [metaChip("error", "danger")];
    const out = [];
    if (tool === "execute" && typeof resultPayload.code === "number") {
      out.push(metaChip("exit " + resultPayload.code, resultPayload.code === 0 ? "" : "danger"));
      if (resultPayload.timedOut) out.push(metaChip("timed out", "danger"));
    } else if (resultPayload.status) {
      const status =
        typeof resultPayload.status === "object" && resultPayload.status !== null
          ? resultPayload.status.state || resultPayload.status.status || stringify(resultPayload.status)
          : resultPayload.status;
      out.push(metaChip(titleCase(String(status)), status === "error" || status === "failed" ? "danger" : ""));
    } else if (typeof resultPayload.found === "boolean") {
      out.push(metaChip(resultPayload.found ? "found" : "missing", resultPayload.found ? "" : "danger"));
    }
    if (typeof resultPayload.bytes === "number") out.push(metaChip(fmtBytes(resultPayload.bytes)));
    if (typeof resultPayload.count === "number")
      out.push(metaChip(resultPayload.count + " result" + (resultPayload.count === 1 ? "" : "s")));
    return out;
  }
  function toolTextValue(v) {
    if (v == null) return "";
    if (Array.isArray(v)) return v.map(toolTextValue).filter(Boolean).join("\n");
    if (typeof v === "object") return stringify(v);
    return String(v);
  }
  function toolPrimaryText(callPayload, resultPayload, hasCall, hasResult) {
    if (hasCall) {
      for (const key of ["command", "path", "query", "url", "name", "id"]) {
        const text = toolTextValue(callPayload[key]);
        if (text) return text;
      }
    }
    if (hasResult) {
      for (const key of ["stdout", "stderr", "output", "chunks", "result", "error", "reason"]) {
        const text = toolTextValue(resultPayload[key]);
        if (text) return text;
      }
    }
    const fallback = hasResult ? resultPayload : callPayload;
    return toolTextValue(fallback);
  }
  function toolTextCard(text) {
    const pre = document.createElement("pre");
    pre.className = "tool-command";
    pre.textContent = text;
    return pre;
  }
  function toolCopyText(callEntry, resultEntry) {
    const parts = [];
    if (callEntry)
      parts.push(`tool_call #${callEntry.seq} · ${fmtTime(callEntry.createdAt)}\n${payloadText(callEntry.payload)}`);
    if (resultEntry)
      parts.push(
        `tool_result #${resultEntry.seq} · ${fmtTime(resultEntry.createdAt)}\n${payloadText(resultEntry.payload)}`,
      );
    return parts.join("\n\n");
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      void 0;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
  function copyButton(label, getText) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = label;
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const ok = await copyText(getText());
      btn.textContent = ok ? "Copied" : "Copy failed";
      if (ok) btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("copied");
      }, 1200);
    };
    return btn;
  }
  function renderToolEntry(callEntry, resultEntry, contextBtn = null, timingEl = null, delivery = null) {
    const callPayload = callEntry?.payload ?? {};
    const resultPayload = resultEntry?.payload ?? {};
    const tool = toolName(callPayload, resultPayload);
    const block = document.createElement("div");
    block.className = "entry tool-entry";
    const who = document.createElement("div");
    who.className = "who";
    const label = document.createElement("span");
    label.className = "tool-label";
    label.textContent = toolLabelText(tool, callPayload, resultPayload);
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = resultEntry
      ? `#${callEntry?.seq ?? "?"}→#${resultEntry.seq} · ${fmtTime(callEntry?.createdAt ?? resultEntry.createdAt)}`
      : `#${callEntry?.seq ?? resultEntry?.seq ?? "?"} · ${fmtTime(callEntry?.createdAt ?? resultEntry?.createdAt)}`;
    const status = document.createElement("div");
    status.className = "meta-row";
    toolStatusMeta(tool, resultPayload, !!resultEntry).forEach((item) => status.appendChild(item));
    if (contextBtn) who.appendChild(contextBtn);
    who.append(label);

    if (timingEl) who.appendChild(timingEl);
    who.append(
      when,
      status,
      copyButton("Copy", () => toolCopyText(callEntry, resultEntry)),
    );
    const body = document.createElement("div");
    body.className = "tool-body";
    const primaryText = toolPrimaryText(callPayload, resultPayload, !!callEntry, !!resultEntry);
    if (primaryText) {
      const truncated = primaryText.length > TOOL_PREVIEW_CHARS;
      const preview = truncated ? primaryText.slice(0, TOOL_PREVIEW_CHARS) + "…" : primaryText;
      const card = toolTextCard(preview);
      const syncExpanded = () => {
        const expanded = block.classList.contains("expanded");
        card.setAttribute("aria-expanded", String(expanded));
        card.title = expanded ? "Click to collapse tool text" : "Click to expand tool text";
        if (truncated) card.textContent = expanded ? primaryText : preview;
      };
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.onclick = () => {
        block.classList.toggle("expanded");
        syncExpanded();
      };
      card.onkeydown = (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        block.classList.toggle("expanded");
        syncExpanded();
      };
      syncExpanded();
      body.appendChild(card);
    }

    if (delivery) {
      const dv = document.createElement("div");
      dv.className = "tool-delivery";
      const drow = document.createElement("div");
      drow.className = "who";
      const dlabel = document.createElement("span");
      dlabel.className = "entry-label important";
      dlabel.textContent = deliveryLabel(delivery);
      drow.appendChild(dlabel);
      if (delivery.shadow) {
        const sb = document.createElement("span");
        sb.className = "entry-label";
        sb.title = "Recorded for observability, never sent to the human (shadow-mode rollout)";
        sb.textContent = "not sent";
        drow.appendChild(sb);
      }
      drow.appendChild(badge(deliverySurfaceLabel(delivery), "info"));
      const mirror = slackMirrorRef(delivery);
      if (mirror) {
        const ml = navLink("View in Slack mirror ↗", { view: "slack", container: mirror.container, ts: mirror.ts });
        ml.title = "Jump to this message in the mirrored Slack channel " + mirror.container;
        drow.appendChild(ml);
      }
      const dwhen = document.createElement("span");
      dwhen.className = "when";
      dwhen.textContent = `${delivery.shadow ? "shadow" : "delivered"} · ${fmtTime(delivery.createdAt)}`;
      drow.appendChild(dwhen);
      const pre = document.createElement("pre");
      const from = delivery.destination?.onBehalfOf ? `from ${delivery.destination.onBehalfOf}\n` : "";
      const to = delivery.destination?.target ? `to ${delivery.destination.target}\n` : "";
      const recipientLine = delivery.recipientThreadRef ? `recipient thread ${delivery.recipientThreadRef}\n` : "";
      pre.textContent = `${from}${to}${recipientLine}${delivery.text || ""}`.trim();
      dv.append(drow, pre);
      const files = deliveryFileBadges(delivery.attachments);
      if (files) dv.appendChild(files);
      body.appendChild(dv);
    }
    block.append(who);
    block.appendChild(body);
    return { block, sync: () => {} };
  }

  function renderHistory(root, d) {
    governanceUI.history.history(root, d, {
      historyKind,
      historyKindMatches,
      cron: urlToState().cron,
      cursor: historyCursor,
      scope,
      orgScope: "org:" + orgId,
      environments: environmentDir,
      title: VIEW_TITLE.history,
      kindLabels: KIND_LABEL,
      historyModeLabel,
      go,
      pageShell,
      cronName,
      scopeKind,
      shortName,
      plural,
      selectScope,
      fmtHistoryCreated,
      relTime,
      stateToUrl,
      titleCase,
      errorStripBox,
      adminErrorCount,
      adminErrors,
      scopeRows,
    });
  }

  let userDetailRequest = 0;
  async function showUserDetail(principalId) {
    const request = ++userDetailRequest;
    const root = $("view-data");
    root.textContent = "";
    return governanceUI.userDetail.detail(root, principalId, {
      api,
      pageShell,
      labelRole,
      fmtTime,
      scopeKind,
      plural,
      stateToUrl,
      go,
      confirm: (message) => window.confirm(message),
      orgId,
      webUiAsButton,
      current: (principal) => request === userDetailRequest && view === "user" && urlToState().principal === principal,
      reload: showUserDetail,
    });
  }

  async function showContextPage(sessionId, turnSeq) {
    return governanceUI.transcript.contextPage(sessionId, turnSeq, transcriptServices());
  }

  let slackContainers = null;
  let slackContainersTruncated = false;
  async function loadSlackContainers() {
    const r = await api("GET", "/api/slack-mirror");
    if (r.ok) {
      slackContainers = r.data.containers || [];
      slackContainersTruncated = !!r.data.hasMore;
    }
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

  function slackUnescape(s) {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  function slackMentionSpan(text) {
    const s = document.createElement("span");
    s.className = "sm-mention";
    s.textContent = text;
    return s;
  }

  function slackEntityNode(inner, mentions) {
    const u = slackUnescape(inner);
    if (u[0] === "@") {
      const [id, label] = u.slice(1).split("|");
      return slackMentionSpan("@" + (label || (mentions && mentions[id]) || id));
    }
    if (u[0] === "#") {
      const [id, label] = u.slice(1).split("|");
      return slackMentionSpan("#" + (label || id));
    }
    if (u[0] === "!") {
      const [cmd, label] = u.slice(1).split("|");
      return slackMentionSpan("@" + (label || cmd.split("^")[0]));
    }
    const bar = u.indexOf("|");
    const url = bar === -1 ? u : u.slice(0, bar);
    const label = bar === -1 ? url : u.slice(bar + 1);

    if (!/^(https?:|mailto:|tel:)/i.test(url)) return document.createTextNode(label);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;
    return a;
  }

  function slackAppendMrkdwn(raw, parent) {
    const text = slackUnescape(raw);
    const re = /\*([^*\n]+)\*|(?<!\w)_([^_\n]+)_(?!\w)|~([^~\n]+)~|(https?:\/\/[^\s<>]+)/g;
    let last = 0,
      m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      let el;
      if (m[1] != null) {
        el = document.createElement("strong");
        el.textContent = m[1];
      } else if (m[2] != null) {
        el = document.createElement("em");
        el.textContent = m[2];
      } else if (m[3] != null) {
        el = document.createElement("s");
        el.textContent = m[3];
      } else {
        let url = m[4].replace(/[.,;!?]+$/, "");
        while (url.endsWith(")") && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length)
          url = url.slice(0, -1);
        el = slackEntityNode(url);
        parent.appendChild(el);
        parent.appendChild(document.createTextNode(m[4].slice(url.length)));
        last = re.lastIndex;
        continue;
      }
      parent.appendChild(el);
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function slackParseInline(text, parent, mentions) {
    const re = /`([^`\n]+)`|<([^>\n]+)>|:([a-z0-9_+'-]+):/g;
    let last = 0,
      m;
    while ((m = re.exec(text))) {
      if (m.index > last) slackAppendMrkdwn(text.slice(last, m.index), parent);
      if (m[1] != null) {
        const c = document.createElement("code");
        c.className = "sm-code";
        c.textContent = slackUnescape(m[1]);
        parent.appendChild(c);
      } else if (m[2] != null) parent.appendChild(slackEntityNode(m[2], mentions));
      else {
        const emoji = governanceUI.charForName(m[3]);
        if (emoji) parent.appendChild(document.createTextNode(emoji));
        else slackAppendMrkdwn(m[0], parent);
      }
      last = re.lastIndex;
    }
    if (last < text.length) slackAppendMrkdwn(text.slice(last), parent);
  }

  function slackParseText(raw, mentions) {
    const frag = document.createDocumentFragment();
    if (!raw) return frag;
    raw.split("```").forEach((part, i) => {
      if (i % 2 === 1) {
        const pre = document.createElement("pre"),
          code = document.createElement("code");
        code.textContent = slackUnescape(part.replace(/^\n/, "").replace(/\n$/, ""));
        pre.appendChild(code);
        frag.appendChild(pre);
      } else {
        let quote = null;
        part.split("\n").forEach((line, lineIndex) => {
          const quoted = /^(?:>|&gt;) ?/.test(line);
          if (quoted) {
            if (!quote) {
              quote = document.createElement("blockquote");
              frag.appendChild(quote);
            } else quote.appendChild(document.createTextNode("\n"));
            slackParseInline(line.replace(/^(?:>|&gt;) ?/, ""), quote, mentions);
          } else {
            if (lineIndex && !quote) frag.appendChild(document.createTextNode("\n"));
            quote = null;
            slackParseInline(line, frag, mentions);
          }
        });
      }
    });
    return frag;
  }
  governanceUI.slackActivity.configure({
    api,
    go,
    urlToState,
    stateToUrl,
    pageShell,
    navLink,
    relTime,
    fmtTime,
    brandSelfLabel,
    slackParseText,
    slackContainerLabel,
    slackContainerScope,
    loadSlackContainers,
    containers: () => slackContainers,
    truncated: () => slackContainersTruncated,
    view: () => view,
    loaded: () => {
      viewLoadedAt.slack = Date.now();
    },
  });
  async function renderSlackMirror(st) {
    return governanceUI.slackActivity.renderSlackMirror(st);
  }
  function deliverySurfaceLabel(event) {
    const type = event?.destination?.type;
    if (type === "principal") return "Slack DM";
    if (type === "slack") return "Slack";
    if (type === "web") return "Web";
    return type || "Unknown surface";
  }

  function deliveryLabel(event) {
    if (event.shadow) return "Shadow delivery";
    return `${deliverySurfaceLabel(event)} delivery`;
  }

  function slackMirrorRef(event) {
    const d = event?.destination || {};
    if (d.type !== "slack" || !d.editRef || typeof d.target !== "string" || !d.target) return null;
    return { container: d.target.split(":")[0], ts: d.editRef };
  }

  async function renderAmbientJudgments(st) {
    return governanceUI.slackActivity.renderAmbientJudgments(st);
  }
  async function renderAckEmojiPicks(st) {
    return governanceUI.slackActivity.renderAckEmojiPicks(st);
  }
  function transcriptServices() {
    return {
      api,
      scope,
      historyKind,
      pageSize: TRANSCRIPT_PAGE_SIZE,
      visibility: transcriptVisibility,
      go,
      stateToUrl,
      pageShell,
      shortName,
      relTime,
      fmtTime,
      webUiAsButton,
      adminErrors,
      errorStripBox,
      plural,
      entryHidden: transcriptEntryHidden,
      renderToolEntry,
      stepDurEl,
      toolName,
      toolLabelText,
      toolPrimaryText,
      toolStatusMeta,
      toolCopyText,
      firstLine,
      copyButton,
      payloadText,
      payloadName,
      isXmlishText,
      renderXmlish,
      renderMarkdown,
      entryIsNoise,
      titleCase,
      brandSelfLabel,
      wakeOriginLabel,
      deliveryLabel,
      deliverySurfaceLabel,
      slackMirrorRef,
      shortId,
      metaChip,
      deliveryFileBadges,
      contextSections,
      requestBody,
      sumCacheUsage,
      cacheMetaItems,
      rawJsonLink,
      fmtContextSize,
      fmtTokens,
      isStablePrefixMiss,
      current: (id, turn) => {
        const st = urlToState();
        return view === "history" && st.session === id && (turn == null ? !st.turn : String(st.turn) === String(turn));
      },
      setObserver: (observer) => {
        transcriptObserver = observer;
      },
    };
  }
  async function showTranscript(sessionId, limit, expand) {
    return governanceUI.transcript.show(sessionId, limit, expand, transcriptServices());
  }

  function estimateTokens(text) {
    const n = (text || "").length;
    return n ? Math.max(1, Math.round(n / 4)) : 0;
  }
  function fmtTokens(n) {
    if (!n) return "0 tokens";
    if (n < 20) return "< 20 tokens";
    if (n < 1000) return n.toLocaleString() + " tokens";
    if (n < 1000000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k tokens";
    return (n / 1000000).toFixed(1) + "m tokens";
  }

  function blockText(o) {
    if (o == null) return "";
    if (typeof o === "string") return o;
    if (typeof o !== "object") return String(o);
    if (Array.isArray(o)) return o.map(blockText).join("\n");
    if (typeof o.text === "string" && (o.type === "text" || o.type == null)) return o.text;
    if (o.type === "image") {
      const mt = (o.source && o.source.media_type) || "image";
      const data = o.source && typeof o.source.data === "string" ? o.source.data : "";
      return "[image " + mt + (data ? " · " + data : "") + "]";
    }
    if (o.type === "tool_use")
      return "[tool_use " + (o.name || "tool") + (o.id ? " · " + o.id : "") + "]\n" + stringify(o.input ?? {});
    if (o.type === "tool_result")
      return (
        "[tool_result" +
        (o.tool_use_id ? " " + o.tool_use_id : "") +
        (o.is_error ? " · error" : "") +
        "]\n" +
        blockText(o.content)
      );
    if (o.type === "thinking")
      return (
        "[thinking]\n" +
        (typeof o.thinking === "string" ? o.thinking : "") +
        (typeof o.signature === "string" ? "\n[signature " + o.signature + "]" : "")
      );
    if (o.type === "redacted_thinking")
      return "[redacted_thinking" + (typeof o.data === "string" ? " " + o.data : "") + "]";
    if (o.type === "document") return "[document " + (o.title || o.name || "attachment") + "]";
    return stringify(o);
  }
  function messageEntryText(m) {
    const role = m && typeof m === "object" ? m.role || "message" : "message";
    const name = m && typeof m === "object" && m.name ? " (" + m.name + ")" : "";
    const content = m && typeof m === "object" ? blockText(m.content) : blockText(m);
    return "[" + String(role) + name + "]\n" + (content.length ? content : "(no content)");
  }
  function systemToText(system) {
    if (system == null) return { text: "", cacheSplit: false };
    if (typeof system === "string") return { text: system, cacheSplit: false };
    if (!Array.isArray(system)) return { text: stringify(system), cacheSplit: false };
    let out = "",
      cacheSplit = false;
    system.forEach((b, i) => {
      const t = b && typeof b === "object" && typeof b.text === "string" ? b.text : blockText(b);
      out += (i ? "\n" : "") + t;
      const cc = b && typeof b === "object" ? b.cache_control : null;
      if (cc) {
        const ttl = cc && typeof cc === "object" && cc.ttl ? " " + cc.ttl : "";
        out += "\n\n────── cache breakpoint (" + ((cc && cc.type) || "ephemeral") + ttl + ") ──────\n";
        cacheSplit = true;
      }
    });
    return { text: out, cacheSplit };
  }
  function transportText(transport) {
    if (!transport || typeof transport !== "object") return "";
    const lines = [];
    if (transport.modelId) lines.push("model: " + transport.modelId);
    const h = transport.headers;
    if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) lines.push(k + ": " + v);
    if (!lines.length) return "";
    return (
      lines.join("\n") +
      "\n\n(auth + anthropic-version headers are added by the provider SDK below the capture point, so they aren't shown)"
    );
  }
  function requestBody(q) {
    return q && q.promptEnvelope != null ? q.promptEnvelope : null;
  }
  function contextSections(request, transport) {
    const req = request && typeof request === "object" ? request : {};
    const messages = Array.isArray(req.messages) ? req.messages : [];
    const params = {};
    for (const [k, v] of Object.entries(req)) {
      if (k !== "system" && k !== "messages" && k !== "tools") params[k] = v;
    }
    const sys = systemToText(req.system);
    const sections = [
      { key: "transport", label: "Transport", note: "model + headers", text: transportText(transport) },
      {
        key: "system",
        label: "System prompt",
        note: sys.cacheSplit ? "verbatim · cache split shown" : "verbatim",
        text: sys.text,
      },
      {
        key: "messages",
        label: "Messages",
        note: messages.length
          ? messages.length + " message" + (messages.length === 1 ? "" : "s")
          : "not re-captured per step; the transcript is the record",
        text: messages.map(messageEntryText).join("\n\n"),
      },
      {
        key: "tools",
        label: "Tool schemas",
        note: Array.isArray(req.tools) ? req.tools.length + " tool" + (req.tools.length === 1 ? "" : "s") : "tools",
        text: req.tools == null ? "" : stringify(req.tools),
      },
      {
        key: "params",
        label: "Request params",
        note: Object.keys(params).length + " field" + (Object.keys(params).length === 1 ? "" : "s"),
        text: Object.keys(params).length ? stringify(params) : "",
      },
    ].filter((s) => s.text);
    return sections.map((s) => ({ ...s, tokens: estimateTokens(s.text), chars: s.text.length }));
  }
  function contextTotal(sections) {
    return sections.reduce((n, s) => n + s.tokens, 0);
  }
  function callCacheUsage(q) {
    const u = q && q.usage;
    if (!u || typeof u !== "object") return null;
    const read = Number(u.cacheRead) || 0,
      write = Number(u.cacheWrite) || 0,
      uncached = Number(u.input) || 0;
    return { cacheRead: read, cacheWrite: write, uncachedInput: uncached };
  }
  function sumCacheUsage(requests) {
    let saw = false,
      cacheRead = 0,
      cacheWrite = 0,
      uncachedInput = 0;
    for (const q of requests || []) {
      const u = callCacheUsage(q);
      if (!u) continue;
      saw = true;
      cacheRead += u.cacheRead;
      cacheWrite += u.cacheWrite;
      uncachedInput += u.uncachedInput;
    }
    return saw ? { cacheRead, cacheWrite, uncachedInput } : null;
  }

  function realInputTokens(q) {
    const u = callCacheUsage(q);
    if (!u) return null;
    const sum = u.cacheRead + u.cacheWrite + u.uncachedInput;
    return sum > 0 ? sum : null;
  }
  function fmtContextSize(q, sections) {
    const real = realInputTokens(q);
    return real != null ? fmtTokens(real) : "~" + fmtTokens(contextTotal(sections));
  }
  function cacheHitRatio(u) {
    if (!u) return null;
    const denom = u.cacheRead + u.cacheWrite + u.uncachedInput;
    return denom > 0 ? u.cacheRead / denom : null;
  }
  function isStablePrefixMiss(u) {
    const ratio = cacheHitRatio(u);
    if (ratio === null) return false;
    return u.cacheWrite >= 1024 && ratio < 0.1;
  }
  function metaChip(text, kind = "") {
    const s = document.createElement("span");
    s.className = "meta-chip" + (kind ? " " + kind : "");
    s.textContent = text;
    return s;
  }
  function cacheMetaItems(u) {
    if (!u) return [];
    const ratio = cacheHitRatio(u);
    const miss = isStablePrefixMiss(u);
    const out = [metaChip("cache " + (ratio === null ? "n/a" : fmtPct(ratio)), miss ? "danger" : "")];
    if (miss) out.push(metaChip("stable-prefix miss", "danger"));
    return out;
  }

  function durSeg(ms, label) {
    const span = document.createElement("span");
    let cls = "";
    if (ms >= 30000) cls = "dur-hot";
    else if (ms >= 5000) cls = "dur-warm";
    if (cls) span.className = cls;
    span.textContent = fmtMs(ms);
    if (!label) return span;
    const wrap = document.createDocumentFragment();
    const lbl = document.createElement("span");
    lbl.className = "seg-label";
    lbl.textContent = label + " ";
    wrap.append(lbl, span);
    return wrap;
  }

  function stepDurEl(segs) {
    const parts = (segs || []).filter(([ms]) => ms != null && ms >= 0);
    if (!parts.length) return null;
    const el = document.createElement("span");
    el.className = "step-dur";
    parts.forEach(([ms, label], i) => {
      if (i) el.appendChild(document.createTextNode(" · "));
      el.appendChild(durSeg(ms, label));
    });
    return el;
  }
  function rawJsonLink(requests, label = "Raw JSON") {
    const a = document.createElement("a");
    a.className = "context-raw";
    let payload;
    if (requests.length === 1) {
      payload = requestBody(requests[0]);
      if (requests[0]?.transport) payload = { request: requestBody(requests[0]), transport: requests[0].transport };
    } else {
      payload = requests.map((q) => ({
        step: q.step,
        model: q.model,
        createdAt: q.createdAt,
        truncated: !!q.truncated,
        ...(q.transport ? { transport: q.transport } : {}),
        request: requestBody(q),
      }));
    }
    a.href = "#";
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;

    let url = null;
    a.addEventListener("click", () => {
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      a.href = url;
    });
    return a;
  }

  function renderFiles(root, d) {
    governanceUI.artifacts.files(root, d, artifactContext());
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
    const a = document.createElement("a");
    a.href = href;
    a.download = f.name || fileName(f.path);
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function renderLive(root, d) {
    governanceUI.artifacts.live(root, d, artifactContext());
  }

  route();
  return {
    route,
    show: (v) => (v === "general" ? go({ view: "general", scope, session: null }) : setView(v)),
  };
}
