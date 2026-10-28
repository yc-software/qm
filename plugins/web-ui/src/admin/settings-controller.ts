import { swallowAs } from "../../../chassis/src/errors";
import { type Api, scopeUrl, viewUrl } from "./api.ts";
import * as governanceUI from "./admin.ts";
import * as settings from "./settings.ts";
import { initCustomDropdowns } from "./dropdown.ts";
import { el } from "./dom.ts";
import { pick } from "./format.ts";

export interface SettingsContext {
  api: Api;
  scope: () => string;
  view: () => string;
  scopeDir: () => any[] | null;
  dirLabel: (id: string) => string;
  shortName: (scopeId: string) => string;
  scopeName: (scopeId?: string) => string;
  go: (state: Record<string, unknown>) => void;
  hasDraft: () => boolean;
}

interface Review {
  title: string;
  subtitle: string;
  facts: [string, string][];
  warning: string;
  confirmLabel: string | null;
  danger?: boolean;
}

const EFFECT_LABELS: Record<string, string> = { allow: "Allow", deny: "Deny", require_approval: "Require approval" };
const $ = (id: string): any => document.getElementById(id);

let api: Api, scope: () => string, view: () => string, scopeDir: () => any[] | null, dirLabel: (id: string) => string;
let shortName: (scopeId: string) => string, governanceScopeName: (scopeId?: string) => string;
let go: SettingsContext["go"], hasGovernanceDraft: () => boolean, scAddButton: any, scStatusHome: any, dialog: any;
let govFlatContent: HTMLElement;
export function startSettings(context: SettingsContext) {
  ({
    api,
    scope,
    view,
    scopeDir,
    dirLabel,
    shortName,
    scopeName: governanceScopeName,
    go,
    hasDraft: hasGovernanceDraft,
  } = context);
  scAddButton = $("sc-add");
  scStatusHome = $("st-service-credentials").parentElement;
  $("card-service-credentials").insertAdjacentHTML(
    "beforeend",
    '<dialog id="sc-dialog" class="custom-provider-dialog credential-dialog" aria-labelledby="sc-dialog-title" aria-describedby="sc-dialog-description"><div class="project-dialog-head"><div><h2 id="sc-dialog-title">Add credential</h2><p id="sc-dialog-description">Connect a service securely, then choose what the agent can access.</p></div><button class="project-icon-button" type="button" id="sc-dialog-close" aria-label="Close credential dialog">×</button></div><div class="project-dialog-actions" id="sc-dialog-actions"></div></dialog>',
  );
  dialog = $("sc-dialog");
  dialog.insertBefore($("sc-editor"), $("sc-dialog-actions"));
  $("sc-dialog-actions").append($("sc-reset"), $("sc-save"));
  const dismiss = () => {
    if (!$("st-service-credentials").classList.contains("saving")) resetScForm();
  };
  $("sc-dialog-close").onclick = dismiss;
  dialog.addEventListener("cancel", (event: any) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener("click", (event: any) => {
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (event.target === dialog && (x < left || x > right || y < top || y > bottom)) dismiss();
  });
  $("governance-review-cancel").onclick = () => finishGovernanceReview(false);
  $("governance-review-confirm").onclick = () => finishGovernanceReview(true);
  $("governance-review").addEventListener("cancel", (event: any) => {
    event.preventDefault();
    finishGovernanceReview(false);
  });
  settings.configureInstructions({ restore: restoreInstructions });
  settings.configureDecisions({
    save: (targetScope: any, body: any) => api("PUT", scopeUrl(targetScope, "/decisions"), body),
  });
  settings.configureCredentials({
    label: serviceCredentialPrincipalLabel,
    edit: loadScForm,
    remove: deleteSc,
    reload: loadScope,
  });
  scAddButton.onclick = () => {
    resetScForm();
    loadScForm(null);
  };
  $("sc-reset").onclick = () => {
    if (!$("st-service-credentials").classList.contains("saving")) resetScForm();
  };
  $("sc-save").onclick = saveServiceCredential;
  settings.configureProviders({
    api,
    refresh: async () => {
      await settings.loadProviders();
      if (view() !== "models") return;
      const requestedScope = scope();
      const requestedGeneration = governanceReq;
      const fresh = await api("GET", viewUrl(requestedScope, "models"));
      if (fresh.ok && scope() === requestedScope && view() === "models" && governanceReq === requestedGeneration)
        settings.updateCatalog(fresh.data);
    },
  });
  $("policy-test-open").onclick = () => {
    $("policy-test-dialog").showModal();
    $("policy-sample").focus();
  };
  $("policy-test-close").onclick = () => $("policy-test-dialog").close();
  $("policy-simulate").onclick = simulatePolicy;
  $("policy-sample").addEventListener("keydown", (e: any) => {
    if (e.key === "Enter") {
      e.preventDefault();
      simulatePolicy();
    }
  });
  $("auto-flagger-reset").onclick = resetAutoFlagger;
  document.querySelectorAll<HTMLButtonElement>("[data-save]").forEach((btn) => {
    btn.onclick = () => saveSetting(btn.dataset.save!, btn);
  });
  settings.configureRuntimes({ save: (key) => saveSetting(key) });
  const credentialEdited = (e: any) => {
    if (e.target.matches("input, textarea, select") && e.target.closest("#card-service-credentials"))
      credentialState.changed();
  };
  $("view-governance").addEventListener("input", credentialEdited);
  $("view-governance").addEventListener("change", credentialEdited);
  govFlatContent = document.querySelector("#view-governance .governance-content") as HTMLElement;
  new MutationObserver(scheduleGovFlatten).observe($("app-view"), {
    attributes: true,
    attributeFilter: ["data-subview"],
  });
  new MutationObserver(scheduleGovFlatten).observe(govFlatContent, {
    attributes: true,
    attributeFilter: ["class"],
    subtree: true,
  });
  flattenGovernanceCards();
  resetScForm();
  return {
    review: reviewGovernanceChange,
    loadScope,
    save: (key: string) => void saveSetting(key),
    setPending: setGovernancePending,
    readyScope: () => governanceReadyScope,
    forgetReady: () => {
      governanceReadyScope = null;
    },
  };
}
function openScDialog() {
  $("sc-dialog-title").textContent = scEditing ? "Edit credential" : "Add credential";
  setStatus("st-service-credentials", "", "");
  $("sc-dialog-actions").prepend($("st-service-credentials"));
  if (!dialog.open) dialog.showModal();
}
const statusTimers = new Map();
function setStatus(id: string, msg: string, kind?: string, sticky = false) {
  if (id === "st-service-credentials") {
    settings.credentialStatus(msg, kind || "");
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
let governanceReviewResolve: ((confirmed: boolean) => void) | null = null;
function finishGovernanceReview(confirmed: boolean) {
  const dialog = $("governance-review");
  if (dialog.open) dialog.close();
  const resolve = governanceReviewResolve;
  governanceReviewResolve = null;
  if (resolve) resolve(confirmed);
}
function reviewGovernanceChange({ title, subtitle, facts, warning, confirmLabel, danger = false }: Review) {
  if (governanceReviewResolve) finishGovernanceReview(false);
  const dialog = $("governance-review");
  $("governance-review-title").textContent = title;
  $("governance-review-subtitle").textContent = subtitle;
  $("governance-review-facts").replaceChildren(...facts.flatMap(([key, value]) => [el("dt", key), el("dd", value)]));
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
const credentialState = settings.credentialState;
let loadedGovernanceScope: string | null = null;
let governanceReadyScope: string | null = null;
let loadedCommandPolicyPresent = false;
let serviceCredDirectory: any = [];
let serviceCredChannels: any = [];
async function restoreInstructions(revision: Record<string, any>) {
  const immutable = { ...revision };
  const targetScope = scope();
  const targetGeneration = governanceReq;
  const draftBefore = JSON.stringify(settings.collect("instructions"));
  const expectedVersion = settings.collect("instructions").expectedVersion;
  const confirmed = await reviewGovernanceChange({
    title: "Restore instructions version " + immutable.version + "?",
    subtitle: "The saved instructions from this revision will replace the current instructions.",
    facts: [
      ["Scope", governanceScopeName(targetScope)],
      ["Current", "Version " + expectedVersion],
      ["Restore", "Version " + immutable.version],
    ],
    warning: "This does not erase history. A new revision will be created, and future turns will use it immediately.",
    confirmLabel: "Restore version " + immutable.version,
    danger: true,
  });
  if (!confirmed || scope() !== targetScope || governanceReq !== targetGeneration) return;
  setStatus("st-instructions", "Restoring…", "saving", true);
  const r = await api("PUT", scopeUrl(targetScope, "/instructions"), {
    content: immutable.content,
    expectedVersion,
  });
  if (scope() !== targetScope || governanceReq !== targetGeneration) return;
  if (!r.ok) {
    if (r.status === 409) await refreshInstructionsConflict();
    return setStatus(
      "st-instructions",
      r.status === 409
        ? "Instructions changed; latest revision loaded and your draft was preserved."
        : r.data?.message || "Restore failed.",
      "err",
      true,
    );
  }
  const fresh = await api("GET", viewUrl(targetScope, "customize"));
  if (scope() !== targetScope || governanceReq !== targetGeneration) return;
  if (!fresh.ok)
    return setStatus("st-instructions", "Restored, but the latest version could not be refreshed.", "warn", true);
  if (JSON.stringify(settings.collect("instructions")) === draftBefore)
    settings.load(fresh.data, targetScope, "instructions");
  else settings.refreshInstructions(fresh.data);
  sectionSnapshots.set("instructions", settings.states.get("instructions")!.baseline);
  if (!settings.states.get("instructions")!.dirty)
    setStatus("st-instructions", "Version " + immutable.version + " restored as a new revision", "ok", true);
}
function renderEnvironmentNotice(data: any) {
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
function setGovernancePending(pending: boolean) {
  const root = $("view-governance");
  if (pending) $("governance-loading").textContent = "Loading settings…";
  root.classList.toggle("governance-pending", pending);
  root.setAttribute("aria-busy", String(pending));
  $("governance-loading").classList.toggle("hidden", !pending);
}
let governanceReq = 0;
async function loadScope() {
  const requestedScope = scope();
  const requestedView = view();
  const requestId = ++governanceReq;
  const scopeChanged = scope() !== loadedGovernanceScope;
  if (requestedView === "credentials") {
    serviceCredList = [];
    settings.credentialLoading();
    void loadPersonalKeychainSummary(requestId, requestedScope);
  }
  const r = await api("GET", viewUrl(scope(), requestedView));
  if (requestId !== governanceReq || requestedScope !== scope() || requestedView !== view()) return;
  if (!r.ok) {
    const denied = r.status === 403 ? "You don't administer this scope." : null;
    if (requestedView === "credentials") settings.credentialLoading(denied || "Could not load credentials.", true);
    if (requestedView === "governance" && governanceReadyScope !== requestedScope)
      $("governance-loading").textContent = denied || "Could not load settings. Select Governance to retry.";
    return governanceUI.status("command-policy", denied || r.data?.message || "Failed to load.", "err");
  }
  if (requestedView === "governance") {
    renderEnvironmentNotice(r.data);
    loadedCommandPolicyPresent = r.data.commandPolicy != null;
    governanceUI.load(r.data, scope());
  }
  if (requestedView === "customize") {
    savedBranding = r.data.branding || {};
    settings.load(r.data, scope(), "instructions");
    settings.load(r.data, scope(), "branding");
    void settings.loadFlags(r.data, scope());
    settings.loadDecisions(r.data, scope());
  }
  if (requestedView === "slack-settings") governanceUI.integrations.loadScope(r.data, scope());
  const opts = r.data.baseModelOptions || [];
  if (requestedView === "models") {
    for (const key of settings.modelSettingKeys) settings.load(r.data, scope(), key);
    void settings.loadProviders();
  }
  if (requestedView === "credentials") {
    loadServiceCredDirectory(r.data);
    renderServiceCreds(r.data.serviceCredentials || []);
    void loadServiceCredentialUsage(requestedScope, requestId);
  }
  if (scopeChanged) resetScForm();
  if (requestedView === "governance") {
    governanceReadyScope = requestedScope;
    setGovernancePending(false);
    flattenGovernanceCards();
  }
  loadedGovernanceScope = scope();
  initCustomDropdowns($("view-governance"));
  captureGovernanceSnapshots();
  if (r.data.modelCatalogRefreshing) {
    void api("GET", viewUrl(requestedScope, requestedView) + "&catalog=refresh")
      .then((fresh) => {
        if (!fresh.ok || requestId !== governanceReq || requestedScope !== scope() || requestedView !== view()) return;
        for (const model of fresh.data.baseModelOptions || []) {
          const existing = opts.findIndex((candidate: any) => candidate.id === model.id);
          if (existing < 0) opts.push(model);
          else opts[existing] = model;
        }
        if (requestedView === "governance") governanceUI.updateCatalog(fresh.data);
        settings.updateCatalog(r.data);
        initCustomDropdowns($("view-governance"));
      })
      .catch(swallowAs("admin: model catalog refresh", undefined));
  }
}
async function refreshInstructionsConflict() {
  const fresh = await api("GET", viewUrl(scope(), view()));
  if (!fresh.ok) return false;
  settings.refreshInstructions(fresh.data);
  sectionSnapshots.set("instructions", settings.states.get("instructions")!.baseline);
  return true;
}
async function refreshServiceCredentialConflict() {
  const requestedScope = scope();
  const requestedView = view();
  const requestId = ++governanceReq;
  const fresh = await api("GET", viewUrl(scope(), view()));
  if (requestId !== governanceReq || requestedScope !== scope() || requestedView !== view() || !fresh.ok) return false;
  loadServiceCredDirectory(fresh.data);
  const credentials = fresh.data.serviceCredentials || [];
  const refreshedEditing = credentials.find((credential: any) => credential.slug === scEditing);
  if (refreshedEditing) credentialState.version = refreshedEditing.updatedAt;
  renderServiceCreds(credentials);
  void loadServiceCredentialUsage(requestedScope, requestId);
  credentialState.render();
  credentialState.changed();
  return refreshedEditing ? "present" : "missing";
}
function loadServiceCredDirectory(data: any) {
  serviceCredDirectory = data.directoryMembers || [];
  serviceCredChannels = data.directoryChannels || [];
}
let savedBranding = {};
let scEditing: string | null = null;
let serviceCredList: any = [];
async function loadServiceCredentialUsage(requestedScope: any, requestId: any) {
  if (!serviceCredList.length) return;
  const result = await api("GET", scopeUrl(requestedScope, "/credential-usage"));
  if (requestId !== governanceReq || requestedScope !== scope() || view() !== "credentials") return;
  const summaries = new Map<string, Record<string, unknown>>(
    (result.data?.summaries || []).map((summary: any) => [summary.slug, summary]),
  );
  renderServiceCreds(
    serviceCredList.map((credential: any) => ({
      ...credential,
      ...(result.ok ? summaries.get(credential.slug) : {}),
      usageUnavailable: !result.ok || !summaries.has(credential.slug),
    })),
  );
}
function renderServiceCreds(list: any) {
  serviceCredList = list;
  settings.loadCredentials(list, serviceCredDirectory, serviceCredChannels, scopeDir() || [], scope());
}
function loadScForm(c: any) {
  if (c) scEditing = c.slug;
  credentialState.begin(c);
  openScDialog();
  $("sc-name").focus();
}
function resetScForm() {
  const dialog = $("sc-dialog");
  const wasOpen = dialog.open;
  if (wasOpen) dialog.close();
  scStatusHome.appendChild($("st-service-credentials"));
  scEditing = null;
  credentialState.reset();
  if (wasOpen) scAddButton.focus();
}
function serviceCredentialPrincipalLabel(grantee: any) {
  if (grantee.startsWith("org:")) return "Everyone in this organization";
  if (grantee.startsWith("channel:")) {
    const label = dirLabel(grantee);
    return label ? "#" + label + " (" + grantee + ")" : grantee;
  }
  const id = grantee.startsWith("personal:") ? grantee.slice("personal:".length) : grantee;
  const member = serviceCredDirectory.find(
    (candidate: any) => candidate.principalId === id || candidate.slackId === id,
  );
  return member ? member.displayName + " (" + id + ")" : grantee;
}
async function deleteSc(credential: any) {
  const c = {
    ...credential,
    grantees: [...(credential.grantees || [])],
    recentUsagePrincipals: [...(credential.recentUsagePrincipals || [])],
  };
  const targetScope = scope();
  const principals = c.grantees.some((g: any) => g.startsWith("org:"))
    ? "everyone in the organization"
    : c.grantees.map(serviceCredentialPrincipalLabel).join(", ");
  let recent = " No successful use appears in the retained window.";
  if (c.usageCount == null || c.usageUnavailable) recent = " Recent usage is unavailable.";
  else if (c.recentUsagePrincipals.length)
    recent =
      " Recent users in the retained window: " +
      c.recentUsagePrincipals.map((id: any) => serviceCredentialPrincipalLabel("personal:" + id)).join(", ") +
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
  if (!confirmed || targetScope !== scope()) return;
  const r = await api("PUT", scopeUrl(targetScope, "/service-credentials"), {
    slug: c.slug,
    delete: true,
    expectedUpdatedAt: c.updatedAt,
  });
  if (targetScope !== scope()) return;
  if (r.ok) {
    resetScForm();
    await loadScope();
    return setStatus("st-service-credentials", "Deleted", "ok");
  }
  const conflictState = r.status === 409 ? await refreshServiceCredentialConflict() : false;
  let message = r.data?.message || "Delete failed.";
  if (r.status === 409 && conflictState)
    message = "Credential changed; the latest state is shown. Review it before deleting.";
  else if (r.status === 409)
    message = "Credential changed, but the latest state could not be loaded. Refresh the page before deleting.";
  setStatus("st-service-credentials", message, "err");
}
async function saveServiceCredential() {
  const status = (message: string, kind: string, sticky?: boolean) =>
    setStatus("st-service-credentials", message, kind, sticky);
  const unreachable = () => {
    credentialState.changed();
    status(
      "Save failed because the admin service could not be reached. Your draft is preserved; try again.",
      "err",
      true,
    );
  };
  const body = credentialState.collect();
  const targetScope = scope();
  const invalid = credentialState.validate(body);
  if (invalid) return status(invalid, "err");
  $("sc-save").disabled = true;
  status("Saving...", "saving", true);
  let r;
  try {
    r = await api("PUT", scopeUrl(targetScope, "/service-credentials"), body);
  } catch {
    if (targetScope === scope()) unreachable();
    return;
  }
  if (scope() !== targetScope) return;
  if (r.ok) {
    await loadScope();
    if (scope() !== targetScope) return;
    credentialState.commit(body);
    if (!credentialState.dirty) resetScForm();
    return status("Saved", "ok");
  }
  let conflictState;
  try {
    conflictState = r.status === 409 ? await refreshServiceCredentialConflict() : false;
  } catch {
    return unreachable();
  }
  credentialState.changed();
  let message = r.data?.message || "Save failed.";
  if (r.status === 403) message = "Not authorized for this scope.";
  else if (r.status === 409 && conflictState === "missing")
    message =
      "This credential was deleted elsewhere. Your draft is preserved, but it remains an edit and cannot recreate the credential. Cancel the edit before creating a new credential.";
  else if (r.status === 409 && conflictState === "present")
    message = "Credential changed; latest revision loaded and your draft was preserved.";
  else if (r.status === 409)
    message =
      "Credential changed, but the latest revision could not be loaded. Your draft is preserved; refresh the page before retrying.";
  status(message, "err");
}
async function loadPersonalKeychainSummary(requestId: any, requestedScope: any) {
  settings.keychainSummary(null);
  const res = await api("GET", "/api/keychain?summary=1");
  if (requestId !== governanceReq || requestedScope !== scope() || view() !== "credentials") return;
  settings.keychainSummary(res.ok ? res.data : null);
}
async function simulatePolicy() {
  const command = $("policy-sample").value;
  const result = $("policy-result");
  const show = (tone: any, text: any) => {
    result.dataset.tone = tone;
    result.textContent = text;
  };
  if (!command.trim()) return show("", "Enter a sample command first.");
  let policy;
  try {
    policy = governanceUI.collect("command-policy");
  } catch (err) {
    return show("danger", err instanceof Error ? err.message : "Policy is invalid.");
  }
  $("policy-simulate").disabled = true;
  show("", "Evaluating with the server’s command scanner…");
  const simulateBody: Record<string, unknown> = { command };
  if (loadedCommandPolicyPresent || $("card-command-policy").classList.contains("dirty")) simulateBody.policy = policy;
  const response = await api("PUT", scopeUrl(scope(), "/command-policy-simulate"), simulateBody);
  $("policy-simulate").disabled = false;
  if (!response.ok) return show("danger", response.data?.message || "Simulation failed.");
  const { decision, ruleSource, ruleIndex, matched, reason } = response.data;
  let rule = "No scope-policy rule matches";
  if (ruleSource === "organization") rule = "Organization rule " + (ruleIndex + 1) + " matches";
  else if (ruleSource === "scope") rule = "This scope’s rule " + (ruleIndex + 1) + " matches";
  if (matched && (ruleSource === "organization" || ruleSource === "scope")) rule += " “" + matched + "”";
  const outcome = " → " + (EFFECT_LABELS[decision] || decision) + (reason ? " · " + reason : "");
  show(pick({ allow: "ok", deny: "danger" }, decision, "warn"), rule + outcome);
}
const sectionSnapshots = new Map();
function captureGovernanceSnapshots() {
  governanceUI.states.forEach((state, key) => {
    sectionSnapshots.set(key, JSON.stringify(state.collect(false)));
    governanceUI.capture(key);
  });
}
function governanceSaveReview(key: any, body: any) {
  const before = () => JSON.parse(sectionSnapshots.get(key) || "{}");
  const review = (current: any, proposed: any, options: any) =>
    reviewGovernanceChange({
      facts: [
        ["Scope", governanceScopeName()],
        ["Current", current],
        ["Proposed", proposed],
      ],
      ...options,
    });
  if (key === "external-slack-participants") {
    const label = (on: any) => (on ? "External audiences enabled" : "Internal only");
    return review(label(!!before().on), label(body.on), {
      title: body.on ? "Allow external Slack audiences?" : "Return Slack to internal-only?",
      subtitle: "This organization-wide audience boundary applies to future Slack turns.",
      warning: body.on
        ? "Agent replies and anything read in a mixed Slack room can be visible to guests or Slack Connect participants. External users still cannot drive the agent."
        : "Mixed-audience Slack rooms will stop receiving agent replies after this change.",
      confirmLabel: body.on ? "Allow external audiences" : "Require internal audiences",
      danger: !!body.on,
    });
  }
  return Promise.resolve(true);
}
async function refreshPolicySetting(
  key: any,
  requestedScope: any,
  requestedGeneration: any,
  draftBefore: any,
  message: any,
) {
  const fresh = await api("GET", viewUrl(requestedScope, "governance"));
  if (requestedScope !== scope() || requestedGeneration !== governanceReq) return;
  if (!fresh.ok) return governanceUI.status(key, "Saved, but the current setting could not be refreshed.", "warn");
  const state = governanceUI.states.get(key)!;
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
async function resetAutoFlagger() {
  const requestedScope = scope();
  const requestedGeneration = governanceReq;
  const draftBefore = JSON.stringify(governanceUI.collect("auto-flagger"));
  const r = await api("PUT", scopeUrl(requestedScope, "/auto-flagger"), {
    reset: true,
  });
  if (requestedScope !== scope() || requestedGeneration !== governanceReq) return;
  if (!r.ok) return setStatus("st-auto-flagger", r.data?.message || "Reset failed.", "err");
  await refreshPolicySetting("auto-flagger", requestedScope, requestedGeneration, draftBefore, "Default restored");
}
async function saveSetting(key: string, btn?: HTMLButtonElement) {
  const requestedScope = scope();
  const requestedGeneration = governanceReq;
  const stale = () => requestedScope !== scope() || requestedGeneration !== governanceReq;
  let body;
  try {
    body = governanceUI.collect(key);
  } catch (err) {
    return governanceUI.status(key, err instanceof Error ? err.message : "Could not save.", "err");
  }
  if (!(await governanceSaveReview(key, body)) || stale()) return;
  const saveRequest = String(++governanceSaveSeq);
  if (btn) {
    btn.dataset.saveRequest = saveRequest;
    btn.disabled = true;
  }
  governanceUI.status(key, "Saving...", "saving");
  const isBranding = key === "branding";
  const brandingBody = isBranding ? { ...savedBranding, ...body } : body;
  const r = await api("PUT", scopeUrl(requestedScope, "/" + (isBranding ? "branding" : key)), brandingBody);
  if (requestedGeneration !== governanceReq) return;
  if (requestedScope !== scope()) {
    if (btn && btn.dataset.saveRequest !== saveRequest) return;
    if (btn) {
      delete btn.dataset.saveRequest;
      btn.disabled = !btn.classList.contains("dirty");
    }
    return governanceUI.status(key, "", "");
  }
  if (btn?.dataset.saveRequest === saveRequest) delete btn.dataset.saveRequest;
  if (!r.ok) {
    const instructionsConflict = key === "instructions" && r.status === 409;
    if (instructionsConflict) await refreshInstructionsConflict();
    let message = r.data?.message || "Save failed.";
    if (instructionsConflict) message = "Instructions changed; latest revision loaded and your draft was preserved.";
    else if (r.status === 403) message = "Not authorized for this scope.";
    return governanceUI.status(key, message, "err");
  }
  governanceUI.commit(key, body);
  sectionSnapshots.set(key, JSON.stringify(body));
  if (isBranding) {
    savedBranding = brandingBody;
    if (!hasGovernanceDraft()) location.reload();
    return;
  }
  if (key === "instructions") {
    const fresh = await api("GET", viewUrl(requestedScope, "customize"));
    if (stale()) return;
    if (!fresh.ok) return governanceUI.status(key, "Saved, but the latest version could not be refreshed.", "warn");
    settings.refreshInstructions(fresh.data);
    sectionSnapshots.set(key, governanceUI.states.get(key)!.baseline);
    if (!governanceUI.states.get(key)!.dirty) governanceUI.status(key, "Saved", "ok");
    return;
  }
  if (key === "command-policy") loadedCommandPolicyPresent = true;
  if (!["ambient-policy", "auto-flagger"].includes(key)) return;
  const fresh = await api("GET", viewUrl(requestedScope, "governance"));
  if (stale() || !fresh.ok || governanceUI.states.get(key)!.dirty) return;
  governanceUI.load(fresh.data, requestedScope, key);
  sectionSnapshots.set(key, JSON.stringify(governanceUI.collect(key)));
  governanceUI.status(key, "Saved", "ok");
}
function flattenGovernanceCards() {
  const cards = [...govFlatContent.children];
  const last = cards.findLast((el) => el.matches("section.card") && getComputedStyle(el).display !== "none");
  cards.forEach((el) => el.classList.toggle("flat-last", el === last));
}
let govFlatRaf = 0;
function scheduleGovFlatten() {
  cancelAnimationFrame(govFlatRaf);
  govFlatRaf = requestAnimationFrame(flattenGovernanceCards);
}
