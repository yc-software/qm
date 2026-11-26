import { settingsSection } from "../settings-layout.ts";
import { brandName } from "../ui.ts";
import { badge } from "./shared.ts";
import { formField, reviewChange, switchField } from "./setting-controls.ts";
import type { AdminPage } from "./sections.ts";
import { page, draw } from "./settings.ts";
import { SettingState } from "./setting-state.ts";
import { html } from "lit";
import { loadScopeLabels, scopePerson } from "../scope-labels.ts";
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
          : (c.grantees || []).map((g: string) => (g.startsWith("personal:") ? scopePerson(g) : g)).join(", "),
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
  const id = grantee.startsWith("personal:") ? scopePerson(grantee) : grantee;
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
  void loadScopeLabels(s.rows.flatMap((c: Data) => c.grantees || [])).then(draw);
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
  if (view.fullAdmin)
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
export const credentialActions = () =>
  html`<a class="viewlink" href=${page.href("audit")}>View usage ›</a
    ><button
      class="btn primary"
      type="button"
      id="sc-add"
      ?disabled=${!!credentialState.listMessage}
      @click=${() => openEditor(null)}
    >
      + Add credential
    </button>`;
export const keychainCard = () => {
  if (!page.fullAdmin) return "";
  const ready = keychain && keychain.enabled !== false;
  return settingsSection(
    "Personal keychains",
    html`<div class="keychain-summary">
      <strong id="keychain-user-count">${ready ? String(keychain!.users) : "—"}</strong> users with keychain entries ·
      <strong id="keychain-standing-count">${ready ? String(keychain!.standing) : "—"}</strong> standing grants
    </div>`,
    { id: "card-personal-keychains", action: html`<a class="viewlink" href=${page.href("users")}>View users ›</a>` },
  );
};
const plural = (n: number, label: string) => n + " " + label + (n === 1 ? "" : "s");
const granteeCount = (grantees: string[]) => {
  const channels = grantees.filter((g) => g.startsWith("channel:")).length;
  const people = grantees.length - channels;
  return [people ? people + (people === 1 ? " person" : " people") : "", channels ? plural(channels, "channel") : ""]
    .filter(Boolean)
    .join(", ");
};
const fmt = (n: number) => n.toLocaleString();
function credentialUsage(c: Data): { short: string; full: string } {
  if (c.usageUnavailable) return { short: "Usage unavailable", full: "Usage unavailable" };
  if (c.usageCount == null) return { short: "", full: "Loading usage…" };
  const n: number = c.usageCount;
  return {
    short:
      fmt(n) +
      (c.usageTruncated ? "+" : "") +
      (n === 1 ? " use" : " uses") +
      (n && c.usageSince
        ? " since " + new Date(c.usageSince).toLocaleDateString(undefined, { month: "short", day: "numeric" })
        : ""),
    full:
      (c.usageTruncated ? "at least " : "") +
      plural(n, "successful use") +
      (n ? " since " + new Date(c.usageSince).toLocaleString() : " in retained broker history"),
  };
}
function credentialFlags(c: Data) {
  const org = c.source === "deployment" || (c.grantees || []).some((g: string) => g.startsWith("org:"));
  return html`${c.enabled === false ? badge("Disabled", "warn") : null}${c.hasSecret ? null : badge("Secret missing", "err")}${
    c.delivery !== "env" && !org ? badge(granteeCount(c.grantees || []), "muted") : null
  }${c.delivery !== "env" && c.deployments === false ? badge("Not for apps", "muted") : null}`;
}
function credentialRow(c: Data) {
  const deployment = c.source === "deployment";
  const usage = credentialUsage(c);
  const meta =
    c.delivery === "env"
      ? "$" + (c.envKey || "?")
      : [
          c.host,
          c.allowedMethods?.length ? c.allowedMethods.join(", ") : "GET",
          c.maxRequestsPerDay ? fmt(c.maxRequestsPerDay) + " requests per UTC day" : "",
        ]
          .filter(Boolean)
          .join(" · ");
  const body = html`<span class="cred-text">
      <span class="cred-name">${c.name || c.slug}<span class="credential-slug">${c.slug}</span></span>
      <span class="cred-meta">${meta}</span>
    </span>
    <span class="cred-flags">${credentialFlags(c)}</span>
    <span class="cred-usage" title=${usage.full}>${usage.short}</span>`;
  return deployment
    ? html`<div class="cred-row is-locked" title="Set in the deployment's configuration; edit it there.">
        ${body}<span class="cred-end">Managed</span>
      </div>`
    : html`<button
        type="button"
        class=${classMap({ "cred-row": true, "is-editing": c.slug === credentialState.editing })}
        aria-label=${"Edit " + (c.name || c.slug)}
        @click=${() => openEditor(c)}
      >
        ${body}<span class="cred-end" aria-hidden="true">›</span>
      </button>`;
}
const credentialGroups: [string, string, (c: Data) => boolean][] = [
  [
    "Proxied services",
    "Called through the broker. The secret stays in core.",
    (c) => c.source !== "deployment" && c.delivery !== "env",
  ],
  [
    "Sandbox environment",
    "Injected as an env var in all-internal conversations.",
    (c) => c.source !== "deployment" && c.delivery === "env",
  ],
  ["From the deployment", "Configured outside this page. Read-only here.", (c) => c.source === "deployment"],
];
function credentialRows() {
  if (credentialState.listMessage)
    return html`${credentialState.listMessage}${credentialState.listRetry ? html`<button class="btn" type="button" style="margin-inline-start: 8px" @click=${() => loadCredentials(page)}>Retry</button>` : null}`;
  if (!credentialState.rows.length) return "No credentials configured.";
  return credentialGroups.map(([title, hint, test]) => {
    const rows = credentialState.rows.filter(test);
    return rows.length
      ? settingsSection(
          title,
          repeat(rows, (c) => c.slug, credentialRow),
          { note: hint },
        )
      : null;
  });
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
const cdField = (
  key: string,
  name: string,
  help: string,
  o: Parameters<typeof formField>[5] & { only?: "env" | "broker" } = {},
) =>
  formField(name, help, "sc-" + key, credentialState.draft[key] || "", (v) => credentialState.change(key, v), {
    ...o,
    hidden: !!o.only && (o.only === "env") !== (credentialState.draft.delivery === "env"),
  });

export function credentialsCard() {
  const s = credentialState;
  const env = s.draft.delivery === "env";
  const cap = s.capability();
  return html`<div class=${classMap({ "settings-stack": true, dirty: s.dirty })} id="card-service-credentials">
    <div id="sc-list" role="status" aria-live="polite" class=${credentialState.rows.length ? "" : "hint"}>
      ${credentialRows()}
    </div>
    ${s.open || !s.message ? null : statusLine()}
    <dialog
      id="sc-dialog"
      class="custom-provider-dialog credential-dialog cd"
      aria-labelledby="sc-dialog-title"
      aria-describedby="sc-dialog-description"
      @cancel=${(e: Event) => (e.preventDefault(), dismiss())}
      @click=${(e: MouseEvent) => e.target === e.currentTarget && dismiss()}
    >
      <header class="cd-head">
        <h2 id="sc-dialog-title">${s.editing ? "Edit credential" : "Add credential"}</h2>
        <p id="sc-dialog-description">Connect a service securely, then choose what the agent can access.</p>
      </header>
      <div class="cd-body" id="sc-editor">
        <section class="cd-section">
          <h3>Service</h3>
          ${cdField("name", "Name", "", { placeholder: "Example API" })}
          ${cdField("slug", "Identifier", s.editing ? "Can't be changed after the credential is created." : "Lowercase letters, numbers and dashes. Can't be changed later.", { placeholder: "example-api", auto: "off", disabled: !!s.editing })}
          <label class="form-field">
            <span class="form-label">Delivery</span>
            <select
              id="sc-delivery"
              .value=${s.draft.delivery || ""}
              @input=${(e: Event) => s.change("delivery", (e.target as HTMLInputElement).value)}
            >
              <option value="broker">Proxied by ${brandName()}</option>
              <option value="env">Sandbox environment variable</option>
            </select>
            <span class="form-help"
              >${
                env
                  ? "Injected into every all-internal conversation. Rooms with external guests get nothing."
                  : `${brandName()} adds the secret to outgoing requests. It never enters a sandbox.`
              }</span
            >
          </label>
        </section>
        <section class="cd-section">
          <h3>Connection</h3>
          ${cdField("host", "Host", "Hostname only, without https://.", { placeholder: "api.example.com", auto: "off", only: "broker" })}
          ${cdField("envkey", "Variable name", "UPPER_SNAKE_CASE. The skill reads this.", { placeholder: "EXAMPLE_API_KEY", auto: "off", only: "env" })}
          ${cdField("secret", "Secret", secretHint(), { placeholder: s.original?.hasSecret ? "••••••••  (unchanged)" : "Paste the key", type: "password", auto: "new-password", helpId: "sc-secret-hint" })}
          <div class=${classMap({ "cd-row": true, hidden: env })}>
            ${cdField("header", "Header", "Blank uses Authorization.", { placeholder: "Authorization" })}
            ${cdField("scheme", "Prefix", "Blank uses Bearer.", { placeholder: "Bearer" })}
          </div>
        </section>
        <section class=${classMap({ "cd-section": true, hidden: env })}>
          <h3>Allowed requests</h3>
          ${cdField("methods", "Methods", "Comma-separated. Blank allows GET only.", { placeholder: "GET, POST" })}
          <label class="form-field">
            <span class="form-label">Paths</span>
            <textarea
              id="sc-paths"
              rows="3"
              .value=${s.draft.paths || ""}
              @input=${(e: Event) => s.change("paths", (e.target as HTMLInputElement).value)}
              placeholder="/v1/search"
            ></textarea>
            <span class="form-help">One prefix per line. Blank allows every path on the host.</span>
          </label>
        </section>
        <section class="cd-section">
          <h3>Access</h3>
          <div class="settings-card">
            ${switchField("sc-enabled", "Enabled", "", s.draft.enabled !== false, (on) => s.change("enabled", on))}
            ${
              env
                ? null
                : switchField(
                    "sc-deployments",
                    "Published apps",
                    "Apps can use it, acting as their publisher.",
                    s.draft.deployments !== false,
                    (on) => s.change("deployments", on),
                  )
            }
          </div>
          ${
            env
              ? html`<p class="form-help">
                  Every all-internal conversation gets the variable. It isn't limited by grants.
                </p>`
              : html`<div class="form-field">
                    <span class="form-label">Who can use it</span>
                    <div class="cd-segmented" role="radiogroup" aria-label="Who can use it">
                      <label
                        ><input
                          type="radio"
                          name="sc-share"
                          value="org"
                          id="sc-share-org"
                          .checked=${!!s.draft.org}
                          @change=${() => s.change("org", true)}
                        /><span>Everyone</span></label
                      ><label
                        ><input
                          type="radio"
                          name="sc-share"
                          value="people"
                          .checked=${!s.draft.org}
                          @change=${() => s.change("org", false)}
                        /><span>Specific people or channels</span></label
                      >
                    </div>
                  </div>
                  ${
                    s.draft.org
                      ? null
                      : html`<div class="sc-picker" id="sc-picker">
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
                            placeholder="Search people or channels"
                            autocomplete="off"
                            spellcheck="false"
                          />
                          <div class="sc-picker-list" id="sc-picker-list" ?hidden=${!s.picker}>${pickerRows()}</div>
                        </div>`
                  }
                  ${
                    !s.draft.org && s.grantees().length
                      ? html`<div class="identity-chips" id="sc-people-chips">
                          ${s.grantees().map((id) => html`<span class="identity-chip">${label(id)}${grantTag(id)}</span>`)}
                        </div>`
                      : null
                  }`
          }
        </section>
        <section class="cd-section" aria-live="polite">
          <h3>Summary</h3>
          <dl class="settings-card cd-summary">
            ${capabilityRows.map(
              ([label, key]) =>
                html`<div>
                  <dt>${label}</dt>
                  <dd id=${"sc-cap-" + key}>${cap[key]}</dd>
                </div>`,
            )}
          </dl>
        </section>
      </div>
      <footer class="cd-foot" id="sc-dialog-actions">
        ${
          s.editing && s.original
            ? html`<button class="btn danger" type="button" id="sc-delete" @click=${() => remove(s.original!)}>
                Delete
              </button>`
            : null
        }
        <span class="cd-spacer"></span>${s.open ? statusLine() : null}<button
          class="btn"
          type="button"
          id="sc-reset"
          @click=${dismiss}
        >
          Cancel</button
        ><button
          class=${classMap({ btn: true, primary: true, dirty: s.dirty })}
          type="button"
          id="sc-save"
          ?disabled=${!s.dirty || s.saving}
          @click=${save}
        >
          ${s.editing ? "Save" : "Add credential"}
        </button>
      </footer>
    </dialog>
  </div>`;
}
const statusLine = () =>
  html`<span
    class=${classMap({ status: true, [credentialState.tone]: !!credentialState.tone })}
    id="st-service-credentials"
    >${credentialState.message}</span
  >`;

function secretHint() {
  if (!credentialState.editing) return "Required. The secret is write-only and can't be viewed after saving.";
  return credentialState.original?.hasSecret
    ? "Stored secret is set. Leave blank to keep it; enter a new value to replace it."
    : "No stored secret yet. Enter one to make this credential usable.";
}
function grantTag(id: string) {
  if (id.startsWith("group:")) return html`<small>unsupported · remove before saving</small>`;
  if (id.startsWith("channel:")) return html`<small>channel</small>`;
  return label(id) === id ? html`<small>unresolved</small>` : null;
}
