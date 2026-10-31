import { badge } from "./shared.ts";
import { reviewChange } from "./setting-controls.ts";
import type { AdminPage } from "./sections.ts";
import { page, draw } from "./settings.ts";
import { SettingState } from "./setting-state.ts";
import { textField, toggleField } from "./setting-controls.ts";
import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
type Data = Record<string, any>;
export class CredentialState extends SettingState {
  rows: Data[] = [];
  listMessage = "Loading credentials…";
  listRetry = false;
  directory: Data[] = [];
  channels: Data[] = [];
  scopes: Data[] = [];
  scope = "";
  editing: string | null = null;
  version: number | null = null;
  original: Data | null = null;
  open = false;
  query = "";
  picker = false;
  resolutionError = "";
  constructor() {
    super("service-credentials");
    this.reset();
  }
  reset() {
    this.editing = null;
    this.version = null;
    this.original = null;
    this.open = false;
    this.query = "";
    this.picker = false;
    this.saving = false;
    this.message = "";
    this.tone = "";
    this.draft = {
      slug: "",
      name: "",
      delivery: "broker",
      envkey: "",
      host: "",
      secret: "",
      header: "",
      scheme: "",
      methods: "",
      paths: "",
      enabled: true,
      deployments: true,
      org: true,
      people: "",
    };
    this.baseline = JSON.stringify(this.collect());
    this.render();
  }
  begin(c: Data | null) {
    this.reset();
    this.open = true;
    if (c) {
      this.editing = c.slug;
      this.version = c.updatedAt;
      this.original = c;
      const org = (c.grantees || []).some((g: string) => g.startsWith("org:"));
      this.draft = {
        slug: c.slug,
        name: c.name,
        delivery: c.delivery || "broker",
        envkey: c.envKey || "",
        host: c.host || "",
        secret: "",
        header: c.injection?.header || "",
        scheme: c.injection?.scheme || "",
        methods: (c.allowedMethods || []).join(", "),
        paths: (c.allowedPathPrefixes || []).join("\n"),
        enabled: c.enabled !== false,
        deployments: c.deployments !== false,
        org,
        people: org
          ? ""
          : (c.grantees || []).map((g: string) => (g.startsWith("personal:") ? g.slice(9) : g)).join(", "),
      };
    }
    this.baseline = JSON.stringify(this.collect());
    this.render();
  }
  commit(body: Data) {
    const fresh = this.rows.find((row) => row.slug === body.slug);
    if (fresh) {
      if (this.draft.slug.trim() === body.slug) this.editing = body.slug;
      this.version = fresh.updatedAt;
      this.original = fresh;
    }
    const saved = { ...body };
    if (this.editing && this.version != null) saved.expectedUpdatedAt = this.version;
    if (this.draft.secret === body.secret) this.draft.secret = "";
    delete saved.secret;
    this.baseline = JSON.stringify(saved);
    this.saving = false;
    this.changed();
  }
  changed() {
    if (!this.saving) {
      this.message = this.dirty ? "Unsaved changes" : "";
      this.tone = "";
    }
    this.render();
  }
  get selected(): string[] {
    return this.draft.people
      .split(",")
      .map((x: string) => x.trim())
      .filter(Boolean);
  }
  grantees(): string[] {
    this.resolutionError = "";
    if (this.draft.org) return [this.scope];
    return this.selected.map((id) => {
      if (/^(personal|team|org|channel|group):/.test(id)) return id;
      const q = id.toLowerCase();
      const exact = this.directory.filter((m) => m.principalId.toLowerCase() === q || m.slackId?.toLowerCase() === q);
      if (exact.length === 1) return "personal:" + exact[0].principalId;
      const names = this.directory.filter((m) => m.displayName.toLowerCase() === q);
      if (names.length === 1) return "personal:" + names[0].principalId;
      if (names.length > 1 || exact.length > 1)
        this.resolutionError = "“" + id + "” matches multiple people. Use an exact principal ID.";
      return "personal:" + id;
    });
  }
  collect() {
    const d = this.draft;
    const env = d.delivery === "env";
    const actor = this.original?.injection?.actor;
    const fixedHeaders = this.original?.injection?.headers;
    return {
      slug: d.slug.trim(),
      name: d.name.trim(),
      delivery: env ? "env" : "broker",
      ...(env ? { envKey: d.envkey.trim() } : {}),
      host: env ? "" : d.host.trim(),
      ...(d.secret ? { secret: d.secret } : {}),
      injection: {
        ...(typeof actor === "boolean" ? { actor } : {}),
        ...(fixedHeaders ? { headers: fixedHeaders } : {}),
        ...(d.header.trim() ? { header: d.header.trim() } : {}),
        ...(d.scheme ? { scheme: d.scheme } : {}),
      },
      allowedMethods: d.methods
        .split(",")
        .map((x: string) => x.trim())
        .filter(Boolean),
      allowedPathPrefixes: d.paths
        .split("\n")
        .map((x: string) => x.trim())
        .filter(Boolean),
      enabled: d.enabled,
      deployments: env ? true : d.deployments,
      grantees: env ? [this.scope] : this.grantees(),
      ...(this.editing && this.version != null ? { expectedUpdatedAt: this.version } : {}),
    };
  }
  validate(body: Data) {
    if (!body.slug) return "Slug is required.";
    if (!body.name) return "Name is required.";
    if (body.delivery === "env") {
      if (!body.envKey) return "Env delivery needs an env var name.";
      if (!/^[A-Z][A-Z0-9_]*$/.test(body.envKey)) return "Env var must be UPPER_SNAKE_CASE.";
      if (body.envKey.startsWith("AGENT_")) return "AGENT_* env vars are reserved for the platform.";
    } else if (!body.host) return "Host is required.";
    if (body.delivery !== "env" && !this.draft.org && !body.grantees.length)
      return "Add at least one person or choose org-wide access.";
    if (body.delivery !== "env" && this.resolutionError) return this.resolutionError;
    const unsupported = body.grantees.find((g: string) => g.startsWith("group:") || /^personal:[^,]*:/.test(g));
    if (unsupported)
      return (
        "Remove unsupported legacy grant “" +
        unsupported +
        "” before saving. Shared credentials support people, teams, channels, or the organization."
      );
    return "";
  }
  capability() {
    const d = this.draft;
    const env = d.delivery === "env";
    const b = this.collect();
    const disabled = env ? "Disabled: never injected" : "Disabled: broker requests refused";
    const envHost = d.envkey.trim() ? "Sandbox env $" + d.envkey.trim() : "Env var not set";
    const brokerHost = d.host.trim() ? d.host.trim() + " and its subdomains" : "Not set";
    const brokerPaths = b.allowedPathPrefixes.length ? b.allowedPathPrefixes.join(", ") : "Any path on this host";
    const storedSecret = this.original?.hasSecret ? "Stored secret retained" : "Required before first save";
    return {
      state: d.enabled ? "Enabled" : disabled,
      host: env ? envHost : brokerHost,
      auth: env
        ? "Injected into all-internal conversations; rooms with externals get nothing"
        : (d.header.trim() || "Authorization") + " header · prefix “" + (d.scheme || "Bearer") + "”",
      methods: env
        ? "None"
        : (b.allowedMethods.length ? b.allowedMethods.map((m: string) => m.toUpperCase()) : ["GET"]).join(", "),
      paths: env ? "Never served by the credential broker" : brokerPaths,
      principals: env
        ? "Every all-internal conversation; grants don't gate env delivery"
        : (b.grantees.map(label).join(", ") || "No principal selected") +
          (d.deployments ? " · published apps, acting as their publisher" : " · switched off for published apps"),
      secret: d.secret ? "Will replace the stored secret" : storedSecret,
    };
  }
}
export const credentialState = new CredentialState();
let keychain: Data | null = null;
let usageRows: Data[] = [];
function label(grantee: string) {
  if (grantee.startsWith("org:")) return "Everyone in this organization";
  if (grantee.startsWith("channel:")) {
    const name = credentialState.channels.find((c) => "channel:" + c.channelId === grantee)?.name;
    return name ? "#" + name.replace(/^#/, "") + " (" + grantee + ")" : grantee;
  }
  const id = grantee.startsWith("personal:") ? grantee.slice("personal:".length) : grantee;
  const member = credentialState.directory.find((m) => m.principalId === id || m.slackId === id);
  return member ? member.displayName + " (" + id + ")" : grantee;
}
const scopeUrl = (view: AdminPage, path = "") => "/api/scopes/" + encodeURIComponent(view.orgScope) + path;
const status = (message: string, tone = "") =>
  Object.assign(credentialState, { message, tone, saving: tone === "saving" }).render();
function show(view: AdminPage, data: Data) {
  const s = credentialState;
  Object.assign(s, {
    directory: data.directoryMembers || [],
    channels: data.directoryChannels || [],
    scope: view.orgScope,
    listMessage: "",
    listRetry: false,
  });
  s.rows = usageRows = data.serviceCredentials || [];
  if (!s.open) s.baseline = JSON.stringify(s.collect());
  draw();
  void loadUsage(view);
}
async function loadUsage(view: AdminPage) {
  if (!usageRows.length) return;
  const rows = usageRows;
  const result = await view.api("GET", scopeUrl(view, "/credential-usage"));
  if (!view.current() || rows !== usageRows) return;
  const summaries = new Map<string, Data>(
    (result.data?.summaries || []).map((summary: Data) => [summary.slug, summary]),
  );
  credentialState.rows = rows.map((c) => ({
    ...c,
    ...(result.ok ? summaries.get(c.slug) : {}),
    usageUnavailable: !result.ok || !summaries.has(c.slug),
  }));
  draw();
}
export async function loadCredentials(view: AdminPage) {
  Object.assign(credentialState, { rows: [], listMessage: "Loading credentials…", listRetry: false });
  keychain = null;
  draw();
  void view.api("GET", "/api/keychain?summary=1").then((res) => {
    if (!view.current()) return;
    keychain = res.ok ? res.data : null;
    draw();
  });
  const r = await view.api("GET", scopeUrl(view, "?view=credentials"));
  if (!view.current()) return;
  if (!r.ok) {
    const listMessage = r.status === 403 ? "You don't administer this scope." : "Could not load credentials.";
    return Object.assign(credentialState, { listMessage, listRetry: true }).render();
  }
  show(view, r.data);
}
async function refreshConflict(view: AdminPage) {
  const s = credentialState;
  const fresh = await view.api("GET", scopeUrl(view, "?view=credentials"));
  if (!view.current() || !fresh.ok) return false;
  const editing = (fresh.data.serviceCredentials || []).find((c: Data) => c.slug === s.editing);
  if (editing) s.version = editing.updatedAt;
  show(view, fresh.data);
  s.changed();
  return editing ? "present" : "missing";
}
const dialog = () => document.getElementById("sc-dialog") as HTMLDialogElement | null;
function openEditor(c: Data | null) {
  credentialState.begin(c);
  status("");
  const d = dialog();
  if (d && !d.open) d.showModal();
  document.getElementById("sc-name")?.focus();
}
function closeEditor() {
  const d = dialog();
  const wasOpen = !!d?.open;
  if (wasOpen) d!.close();
  credentialState.reset();
  if (wasOpen) document.getElementById("sc-add")?.focus();
}
const dismiss = () => credentialState.tone !== "saving" && closeEditor();
async function save() {
  const s = credentialState;
  const view = page;
  const body = s.collect();
  const invalid = s.validate(body);
  if (invalid) return status(invalid, "err");
  status("Saving...", "saving");
  const r = await view.api("PUT", scopeUrl(view, "/service-credentials"), body);
  if (!view.current()) return;
  if (r.ok) {
    await loadCredentials(view);
    if (!view.current()) return;
    s.commit(body);
    if (!s.dirty) closeEditor();
    return status("Saved", "ok");
  }
  if (r.status === 0) {
    s.saving = false;
    s.changed();
    return status(
      "Save failed because the admin service could not be reached. Your draft is preserved; try again.",
      "err",
    );
  }
  const conflict = r.status === 409 ? await refreshConflict(view) : false;
  s.saving = false;
  s.changed();
  let message = r.data?.message || "Save failed.";
  if (r.status === 403) message = "Not authorized for this scope.";
  else if (conflict === "missing")
    message =
      "This credential was deleted elsewhere. Your draft is preserved, but it remains an edit and cannot recreate the credential. Cancel the edit before creating a new credential.";
  else if (conflict === "present") message = "Credential changed; latest revision loaded and your draft was preserved.";
  else if (r.status === 409)
    message =
      "Credential changed, but the latest revision could not be loaded. Your draft is preserved; refresh the page before retrying.";
  status(message, "err");
}
async function remove(c: Data) {
  const view = page;
  const grantees: string[] = c.grantees || [];
  const recentUsers: string[] = c.recentUsagePrincipals || [];
  const principals = grantees.some((g) => g.startsWith("org:"))
    ? "everyone in the organization"
    : grantees.map(label).join(", ");
  let recent = " No successful use appears in the retained window.";
  if (c.usageCount == null || c.usageUnavailable) recent = " Recent usage is unavailable.";
  else if (recentUsers.length)
    recent =
      " Recent users in the retained window: " + recentUsers.map((id) => label("personal:" + id)).join(", ") + ".";
  const confirmed = await reviewChange({
    title: "Delete “" + (c.name || c.slug) + "”?",
    subtitle: "This credential currently grants broker access to " + principals + "." + recent,
    facts: [
      ["Scope", "Organization · " + view.org],
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
  if (!confirmed || !view.current()) return;
  const r = await view.api("PUT", scopeUrl(view, "/service-credentials"), {
    slug: c.slug,
    delete: true,
    expectedUpdatedAt: c.updatedAt,
  });
  if (!view.current()) return;
  if (r.ok) {
    closeEditor();
    await loadCredentials(view);
    return status("Deleted", "ok");
  }
  const conflict = r.status === 409 ? await refreshConflict(view) : false;
  let message = r.data?.message || "Delete failed.";
  if (r.status === 409)
    message = conflict
      ? "Credential changed; the latest state is shown. Review it before deleting."
      : "Credential changed, but the latest state could not be loaded. Refresh the page before deleting.";
  status(message, "err");
}
export const addCredential = () =>
  html`<button
    class="btn"
    type="button"
    id="sc-add"
    ?disabled=${!!credentialState.listMessage}
    @click=${() => openEditor(null)}
  >
    + Add credential
  </button>`;
export const keychainCard = () => {
  const ready = keychain && keychain.enabled !== false;
  return html`<section class="card sv-credentials" id="card-personal-keychains">
    <div class="head">
      <h2>Personal keychains</h2>
      <a class="viewlink" href=${page.href("users")}>View users ›</a>
    </div>
    <div class="body">
      <div class="keychain-summary">
        <strong id="keychain-user-count">${ready ? String(keychain!.users) : "—"}</strong> users with keychain entries ·
        <strong id="keychain-standing-count">${ready ? String(keychain!.standing) : "—"}</strong> standing grants
      </div>
    </div>
  </section>`;
};
const plural = (n: number, label: string) => n + " " + label + (n === 1 ? "" : "s");
function credentialUsage(c: Data) {
  if (c.usageUnavailable) return "Usage unavailable";
  if (c.usageCount == null) return "Loading usage…";
  return (
    (c.usageTruncated ? "at least " : "") +
    plural(c.usageCount, "successful use") +
    (c.usageCount ? " since " + new Date(c.usageSince).toLocaleString() : " in retained broker history")
  );
}
function credentialRows() {
  if (credentialState.listMessage)
    return html`${credentialState.listMessage}${credentialState.listRetry ? html`<button class="btn" type="button" style="margin-inline-start: 8px" @click=${() => loadCredentials(page)}>Retry</button>` : null}`;
  return credentialState.rows.length
    ? repeat(
        credentialState.rows,
        (c) => c.slug,
        (c) => {
          const deployment = c.source === "deployment";
          const org = deployment || (c.grantees || []).some((g: string) => g.startsWith("org:"));
          const target =
            c.delivery === "env"
              ? "sandbox env $" + (c.envKey || "?")
              : c.host +
                " · " +
                (c.allowedMethods?.length ? c.allowedMethods.join("/") : "GET") +
                (c.maxRequestsPerDay ? " · " + plural(c.maxRequestsPerDay, "request") + " per UTC day" : "");
          return html`<div
            class=${classMap({ "credential-row": true, "is-editing": c.slug === credentialState.editing })}
          >
            <div class="credential-main">
              <div class="credential-title">
                <strong>${c.name || c.slug}</strong><span class="credential-slug">${c.slug}</span>
              </div>
              <div class="hint">${target + " · " + credentialUsage(c)}</div>
              <div class="credential-badges">
                ${badge(c.delivery === "env" ? "Env" : "Broker", "info")}${badge(c.enabled === false ? "Disabled" : "Enabled", c.enabled === false ? "warn" : "ok")}${badge(c.hasSecret ? "Secret set" : "Secret missing", c.hasSecret ? "ok" : "err")}${badge(org ? "Organization-wide" : plural((c.grantees || []).length, "principal"), org ? "info" : "muted")}${c.delivery !== "env" && c.deployments === false ? badge("No apps", "muted") : null}${deployment ? badge("Supplied by deployment", "info") : null}
              </div>
            </div>
            ${
              deployment
                ? html`<div class="credential-actions hint">Read-only</div>`
                : html`<div class="credential-actions">
                    <button class="btn" type="button" @click=${() => openEditor(c)}>Edit</button
                    ><button
                      type="button"
                      class="btn compact rowbtn danger"
                      title="Delete credential"
                      aria-label=${"Delete " + (c.name || c.slug)}
                      @click=${() => remove(c)}
                    >
                      Delete
                    </button>
                  </div>`
            }
          </div>`;
        },
      )
    : "No credentials configured.";
}
function pickerRows() {
  const s = credentialState;
  const selected = s.selected;
  const q = s.query.trim().toLowerCase();
  const people = s.directory.filter(
    (m) =>
      !selected.includes(m.principalId) &&
      (!q || [m.principalId, m.displayName || "", m.slackId || ""].some((v) => v.toLowerCase().includes(q))),
  );
  const channelMap = new Map(s.scopes.map((row) => [row.scopeId, row]));
  s.channels.forEach((c) =>
    channelMap.set("channel:" + c.channelId, { scopeId: "channel:" + c.channelId, label: c.name }),
  );
  const channels = [...channelMap.values()].filter(
    (c) =>
      c.scopeId.startsWith("channel:") &&
      !selected.includes(c.scopeId) &&
      (!q || [c.scopeId, c.label || ""].some((v) => v.toLowerCase().includes(q))),
  );
  const item = (id: string, label: string, checked: boolean) =>
    html`<div
      class="sc-picker-item"
      @mousedown=${(e: MouseEvent) => {
        e.preventDefault();
        s.change("people", (checked ? selected.filter((x) => x !== id) : [...selected, id]).join(", "));
      }}
    >
      <input type="checkbox" .checked=${checked} /><span>${label}</span>
    </div>`;
  return html`${
    selected.length
      ? html`<div class="sc-picker-group">Has access</div>
          ${selected.map((id) => item(id, label(id), true))}`
      : null
  }${
    people.length
      ? html`<div class="sc-picker-group">People</div>
          ${people.slice(0, 30).map((m) => item(m.principalId, m.displayName + " (" + m.principalId + ")", false))}`
      : null
  }${people.length > 30 ? html`<div class="sc-picker-more">${"…" + (people.length - 30) + " more — keep typing"}</div>` : null}${
    channels.length
      ? html`<div class="sc-picker-group">Channels</div>
          ${channels.slice(0, 15).map((c) => item(c.scopeId, c.label ? "#" + c.label.replace(/^#/, "") + " (" + c.scopeId + ")" : c.scopeId, false))}`
      : null
  }${channels.length > 15 ? html`<div class="sc-picker-more">${"…" + (channels.length - 15) + " more channels — keep typing"}</div>` : null}`;
}

const capabilityRows = [
  ["State", "state"],
  ["Host", "host"],
  ["Auth", "auth"],
  ["Methods", "methods"],
  ["Paths", "paths"],
  ["Access", "principals"],
  ["Secret", "secret"],
] as const;
const only = (kind: string) =>
  classMap({ ["sc-" + kind + "-only"]: true, hidden: (kind === "env") !== (credentialState.draft.delivery === "env") });
const field = (key: string, label: string, hint: string | number, o: Parameters<typeof textField>[5] = {}) =>
  textField(label, hint, "sc-" + key, credentialState.draft[key] || "", (v) => credentialState.change(key, v), o);
export function credentialsCard() {
  const s = credentialState;
  const env = s.draft.delivery === "env";
  const cap = s.capability();
  return html`<section
    class=${classMap({ card: true, "sv-credentials": true, dirty: s.dirty })}
    id="card-service-credentials"
  >
    <div class="head">
      <h2>Shared service credentials</h2>
      <p>
        The agent calls these services by proxy such that secrets never reach a sandbox. Review the complete effective
        capability (destination, authentication, methods, paths, and principals) before saving.
      </p>
      <a class="viewlink" href=${page.href("audit")}>View usage ›</a>
    </div>
    <div class="body">
      <div id="sc-list" role="status" aria-live="polite" class=${credentialState.rows.length ? "" : "hint"}>
        ${credentialRows()}
      </div>
    </div>
    <div class="foot">${s.open ? null : statusLine()}</div>
    <dialog
      id="sc-dialog"
      class="custom-provider-dialog credential-dialog"
      aria-labelledby="sc-dialog-title"
      aria-describedby="sc-dialog-description"
      @cancel=${(e: Event) => (e.preventDefault(), dismiss())}
      @click=${(e: MouseEvent) => e.target === e.currentTarget && dismiss()}
    >
      <div class="project-dialog-head">
        <div>
          <h2 id="sc-dialog-title">${s.editing ? "Edit credential" : "Add credential"}</h2>
          <p id="sc-dialog-description">Connect a service securely, then choose what the agent can access.</p>
        </div>
        <button
          class="project-icon-button"
          type="button"
          id="sc-dialog-close"
          aria-label="Close credential dialog"
          @click=${dismiss}
        >
          ×
        </button>
      </div>
      <div class="body" id="sc-editor" style="border-top: 1px solid var(--border, #2a2a2a); padding-top: 12px">
        <div class="sc-semantics" aria-label="Blank value semantics">
          <div><strong>Blank secret</strong><span id="sc-secret-semantics">${secretSemantics()}</span></div>
          <div><strong>Blank method</strong><span>Uses the broker default: GET only.</span></div>
          <div><strong>Blank paths</strong><span>Allows every path on the selected host.</span></div>
        </div>
        <div class="editor-grid">
          <div>
            ${field("slug", "Slug", "lowercase identifier", { placeholder: "credential-name", auto: "off", disabled: !!s.editing })}
            ${field("name", "Display name", 12, { placeholder: "Credential display name" })}
            <label style="display: block; margin-bottom: 8px"
              >Delivery <span class="hint">how the secret is used</span>
              <select
                id="sc-delivery"
                .value=${s.draft.delivery || ""}
                @input=${(e: Event) => s.change("delivery", (e.target as HTMLInputElement).value)}
                style="width: 100%"
              >
                <option value="broker">
                  Broker: core stamps it onto proxied HTTP calls; the secret never leaves core
                </option>
                <option value="env">
                  Sandbox env: injected into all-internal conversations under an env var (e.g. a browser-provider key
                  for the browse skill)
                </option>
              </select>
            </label>
            ${field("envkey", "Env var", "UPPER_SNAKE_CASE; the skill reads this", { placeholder: "STEEL_API_KEY", auto: "off", cls: only("env") })}
            ${field("host", "Destination host", "bare hostname only", { placeholder: "service.example", auto: "off", cls: only("broker") })}
            ${field("secret", "Secret", 12, { placeholder: s.original?.hasSecret ? "Stored secret retained when blank" : "Write-only secret", type: "password", auto: "new-password" })}
            <p class="field-hint" id="sc-secret-hint">${secretHint()}</p>
            <div class=${classMap({ "sc-broker-only": true, hidden: env })} style="display: flex; gap: 10px">
              ${field("header", "Authentication header", "blank = Authorization", { placeholder: "Default: Authorization", flex: true })}
              ${field("scheme", "Value prefix", "blank = Bearer", { placeholder: "Default: Bearer", flex: true })}
            </div>
            ${field("methods", "Allowed HTTP methods", "comma-separated; blank = GET", { placeholder: "GET", cls: only("broker") })}
            <label style="display: block; margin-bottom: 8px" class=${classMap({ "sc-broker-only": true, hidden: env })}
              >Allowed path prefixes <span class="hint">one per line; blank = any path</span
              ><textarea
                id="sc-paths"
                .value=${s.draft.paths || ""}
                @input=${(e: Event) => s.change("paths", (e.target as HTMLInputElement).value)}
                placeholder="/allowed/path/"
              ></textarea>
            </label>
            ${toggleField("Credential is enabled", 12, s.draft.enabled !== false, (on) => s.change("enabled", on), { id: "sc-enabled" })}
            ${toggleField("Published apps may use it, acting as their publisher", 12, s.draft.deployments !== false, (on) => s.change("deployments", on), { id: "sc-deployments", cls: only("broker") })}
            <p class=${classMap({ hint: true, "sc-broker-only": true, hidden: env })} style="margin-bottom: 6px">
              Principals with access
            </p>
            <p class=${classMap({ hint: true, "sc-env-only": true, hidden: !env })} style="margin-bottom: 6px">
              Access: every all-internal conversation. Env delivery is not gated by grants. Rooms with externals get
              nothing, everyone else gets the env var.
            </p>
            ${toggleField("Everyone in this organization", 12, !!s.draft.org, () => s.change("org", true), { id: "sc-share-org", name: "sc-share", value: "org", cls: only("broker") })}
            ${toggleField("Only selected people or teams", 12, !s.draft.org, () => s.change("org", false), { name: "sc-share", value: "people", cls: only("broker") })}
            <div
              class=${classMap({ "sc-picker": true, "sc-broker-only": true, hidden: env })}
              style=${s.draft.org ? "display: none" : ""}
              id="sc-picker"
            >
              <input
                type="text"
                id="sc-picker-search"
                .value=${s.query}
                @input=${(e: Event) => {
                  s.query = (e.target as HTMLInputElement).value;
                  s.picker = true;
                  s.render();
                }}
                @focus=${() => {
                  s.picker = true;
                  s.render();
                }}
                @blur=${() =>
                  setTimeout(() => {
                    s.picker = false;
                    s.render();
                  }, 150)}
                placeholder="Search people to grant access…"
                autocomplete="off"
                spellcheck="false"
              />
              <div class="sc-picker-list" id="sc-picker-list" ?hidden=${!s.picker}>${pickerRows()}</div>
            </div>
            <div
              class=${classMap({ "identity-chips": true, "sc-broker-only": true, hidden: env })}
              id="sc-people-chips"
            >
              ${s.draft.org ? null : s.grantees().map((id) => html`<span class="identity-chip">${label(id)}${grantTag(id)}</span>`)}
            </div>
          </div>
          <aside class="editor-panel" aria-live="polite">
            <h3>Effective capability</h3>
            <dl class="capability-summary">
              ${capabilityRows.map(
                ([label, key]) =>
                  html`<div>
                    <dt>${label}</dt>
                    <dd id=${"sc-cap-" + key}>${cap[key]}</dd>
                  </div> `,
              )}
            </dl>
          </aside>
        </div>
      </div>
      <div class="project-dialog-actions" id="sc-dialog-actions">
        ${s.open ? statusLine() : null}<button class="btn" id="sc-reset" @click=${dismiss}>Cancel</button
        ><button
          class=${classMap({ btn: true, primary: true, dirty: s.dirty })}
          id="sc-save"
          ?disabled=${!s.dirty || s.saving}
          @click=${save}
        >
          ${s.editing ? "Save changes" : "Save credential"}
        </button>
      </div>
    </dialog>
  </section>`;
}
const statusLine = () =>
  html`<span
    class=${classMap({ status: true, [credentialState.tone]: !!credentialState.tone })}
    id="st-service-credentials"
    >${credentialState.message}</span
  >`;

function secretSemantics() {
  if (credentialState.original?.hasSecret) return "Keeps the stored secret unchanged.";
  return credentialState.editing ? "A secret is required before saving." : "New credentials require a secret.";
}
function secretHint() {
  if (!credentialState.editing) return "The secret is write-only. It cannot be viewed after saving.";
  return credentialState.original?.hasSecret
    ? "Stored secret is set. Leave blank to keep it; enter a new value to replace it."
    : "No stored secret yet. Enter one to make this credential usable.";
}
function grantTag(id: string) {
  if (id.startsWith("group:")) return html`<small>unsupported · remove before saving</small>`;
  if (id.startsWith("channel:")) return html`<small>channel</small>`;
  return label(id) === id ? html`<small>unresolved</small>` : null;
}
