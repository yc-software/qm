import { mountTemplate } from "./shared.ts";
import { html, render } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
let config: any = { label: (id: string) => id, formatTime: String, edit: () => {}, remove: () => {} };
type Data = Record<string, any>;
export class CredentialState {
  draft: Data = {};
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
  saving = false;
  message = "";
  tone = "";
  baseline = "";
  query = "";
  picker = false;
  resolutionError = "";
  render = () => {};
  constructor() {
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
  change(key: string, value: unknown) {
    this.draft[key] = value;
    this.changed();
  }
  changed() {
    if (!this.saving) {
      this.message = this.dirty ? "Unsaved changes" : "";
      this.tone = "";
    }
    this.render();
  }
  get dirty() {
    return JSON.stringify(this.collect()) !== this.baseline;
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
    return {
      slug: d.slug.trim(),
      name: d.name.trim(),
      delivery: env ? "env" : "broker",
      ...(env ? { envKey: d.envkey.trim() } : {}),
      host: env ? "" : d.host.trim(),
      ...(d.secret ? { secret: d.secret } : {}),
      injection: {
        ...(typeof actor === "boolean" ? { actor } : {}),
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
        : (b.grantees.map(config.label).join(", ") || "No principal selected") +
          (d.deployments ? " · published apps, acting as their publisher" : " · switched off for published apps"),
      secret: d.secret ? "Will replace the stored secret" : storedSecret,
    };
  }
}
export const credentialState = new CredentialState();
export function configureCredentials(options: any) {
  config = options;
}
export function credentialStatus(message: string, tone: string) {
  credentialState.message = message;
  credentialState.tone = tone;
  credentialState.saving = tone === "saving";
  credentialState.render();
}
export function credentialLoading(message = "Loading credentials…", retry = false) {
  credentialState.rows = [];
  credentialState.listMessage = message;
  credentialState.listRetry = retry;
  credentialState.render();
}
export function loadCredentials(rows: Data[], directory: Data[], channels: Data[], scopes: Data[], scope: string) {
  Object.assign(credentialState, { rows, directory, channels, scopes, scope, listMessage: "", listRetry: false });
  if (!credentialState.open) credentialState.baseline = JSON.stringify(credentialState.collect());
  credentialState.render();
}
const plural = (n: number, label: string) => n + " " + label + (n === 1 ? "" : "s");
const badge = (text: string, tone: string) => html`<span class=${"badge " + tone}>${text}</span>`;
function credentialUsage(c: Data) {
  if (c.usageUnavailable) return "Usage unavailable";
  if (c.usageCount == null) return "Loading usage…";
  return (
    (c.usageTruncated ? "at least " : "") +
    plural(c.usageCount, "successful use") +
    (c.usageCount ? " since " + config.formatTime(c.usageSince) : " in retained broker history")
  );
}
function credentialRows() {
  if (credentialState.listMessage)
    return html`${credentialState.listMessage}${credentialState.listRetry ? html`<button type="button" style="margin-inline-start: 8px" @click=${() => config.reload()}>Retry</button>` : null}`;
  return credentialState.rows.length
    ? repeat(
        credentialState.rows,
        (c) => c.slug,
        (c) => {
          const org = (c.grantees || []).some((g: string) => g.startsWith("org:"));
          const target =
            c.delivery === "env"
              ? "sandbox env $" + (c.envKey || "?")
              : c.host + " · " + (c.allowedMethods?.length ? c.allowedMethods.join("/") : "GET");
          return html`<div
            class=${classMap({ "credential-row": true, "is-editing": c.slug === credentialState.editing })}
          >
            <div class="credential-main">
              <div class="credential-title">
                <strong>${c.name || c.slug}</strong><span class="credential-slug">${c.slug}</span>
              </div>
              <div class="hint">${target + " · " + credentialUsage(c)}</div>
              <div class="credential-badges">
                ${badge(c.delivery === "env" ? "Env" : "Broker", "info")}${badge(c.enabled === false ? "Disabled" : "Enabled", c.enabled === false ? "warn" : "ok")}${badge(c.hasSecret ? "Secret set" : "Secret missing", c.hasSecret ? "ok" : "err")}${badge(org ? "Organization-wide" : plural((c.grantees || []).length, "principal"), org ? "info" : "muted")}${c.delivery !== "env" && c.deployments === false ? badge("No apps", "muted") : null}
              </div>
            </div>
            <div class="credential-actions">
              <button type="button" @click=${() => config.edit(c)}>Edit</button
              ><button
                type="button"
                class="rowbtn danger"
                title="Delete credential"
                aria-label=${"Delete " + (c.name || c.slug)}
                @click=${() => config.remove(c)}
              >
                Delete
              </button>
            </div>
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
          ${selected.map((id) => item(id, config.label(id), true))}`
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

function template() {
  const env = credentialState.draft.delivery === "env";
  const cap = credentialState.capability();
  return html` <section
    class=${classMap({ card: true, "sv-credentials": true, dirty: credentialState.dirty })}
    id="card-service-credentials"
  >
    <div class="head">
      <h2>Shared service credentials</h2>
      <p>
        The agent calls these services by proxy such that secrets never reach a sandbox. Review the complete effective
        capability (destination, authentication, methods, paths, and principals) before saving.
      </p>
    </div>
    <div class="body">
      <div id="sc-list" role="status" aria-live="polite" class=${credentialState.rows.length ? "" : "hint"}>
        ${credentialRows()}
      </div>
    </div>
    <div
      class=${classMap({ body: true, hidden: !credentialState.open })}
      id="sc-editor"
      style="border-top: 1px solid var(--border, #2a2a2a); padding-top: 12px"
    >
      <div class="sc-form-head">
        <p class="hint" id="sc-form-title">
          ${credentialState.editing ? "Editing " + credentialState.editing : "Add a credential"}
        </p>
        <span class=${"badge " + (credentialState.editing ? "info" : "muted")} id="sc-form-mode"
          >${credentialState.editing ? "Editing" : "New"}</span
        >
      </div>
      <div class="sc-semantics" aria-label="Blank value semantics">
        <div><strong>Blank secret</strong><span id="sc-secret-semantics">${secretSemantics()}</span></div>
        <div><strong>Blank method</strong><span>Uses the broker default: GET only.</span></div>
        <div><strong>Blank paths</strong><span>Allows every path on the selected host.</span></div>
      </div>
      <div class="editor-grid">
        <div>
          <label style="display: block; margin-bottom: 8px"
            >Slug <span class="hint">lowercase identifier</span
            ><input
              type="text"
              id="sc-slug"
              .value=${credentialState.draft.slug || ""}
              @input=${(e: Event) => credentialState.change("slug", (e.target as HTMLInputElement).value)}
              ?disabled=${!!credentialState.editing}
              placeholder="credential-name"
              autocomplete="off"
              style="width: 100%"
          /></label>
          <label style="display: block; margin-bottom: 8px"
            >Display name
            <input
              type="text"
              id="sc-name"
              .value=${credentialState.draft.name || ""}
              @input=${(e: Event) => credentialState.change("name", (e.target as HTMLInputElement).value)}
              placeholder="Credential display name"
              style="width: 100%"
          /></label>
          <label style="display: block; margin-bottom: 8px"
            >Delivery <span class="hint">how the secret is used</span>
            <select
              id="sc-delivery"
              .value=${credentialState.draft.delivery || ""}
              @input=${(e: Event) => credentialState.change("delivery", (e.target as HTMLInputElement).value)}
              style="width: 100%"
            >
              <option value="broker">
                Broker: core stamps it onto proxied HTTP calls; the secret never leaves core
              </option>
              <option value="env">
                Sandbox env: injected into all-internal conversations under an env var (e.g. a browser-provider key for
                the browse skill)
              </option>
            </select>
          </label>
          <label style="display: block; margin-bottom: 8px" class=${classMap({ "sc-env-only": true, hidden: !env })}
            >Env var <span class="hint">UPPER_SNAKE_CASE; the skill reads this</span
            ><input
              type="text"
              id="sc-envkey"
              .value=${credentialState.draft.envkey || ""}
              @input=${(e: Event) => credentialState.change("envkey", (e.target as HTMLInputElement).value)}
              placeholder="STEEL_API_KEY"
              autocomplete="off"
              style="width: 100%"
          /></label>
          <label style="display: block; margin-bottom: 8px" class=${classMap({ "sc-broker-only": true, hidden: env })}
            >Destination host <span class="hint">bare hostname only</span
            ><input
              type="text"
              id="sc-host"
              .value=${credentialState.draft.host || ""}
              @input=${(e: Event) => credentialState.change("host", (e.target as HTMLInputElement).value)}
              placeholder="service.example"
              autocomplete="off"
              style="width: 100%"
          /></label>
          <label style="display: block; margin-bottom: 8px"
            >Secret
            <input
              type="password"
              id="sc-secret"
              .value=${credentialState.draft.secret || ""}
              @input=${(e: Event) => credentialState.change("secret", (e.target as HTMLInputElement).value)}
              autocomplete="new-password"
              placeholder=${credentialState.original?.hasSecret ? "Stored secret retained when blank" : "Write-only secret"}
              style="width: 100%"
          /></label>
          <p class="field-hint" id="sc-secret-hint">${secretHint()}</p>
          <div class=${classMap({ "sc-broker-only": true, hidden: env })} style="display: flex; gap: 10px">
            <label style="display: block; margin-bottom: 8px; flex: 1"
              >Authentication header <span class="hint">blank = Authorization</span
              ><input
                type="text"
                id="sc-header"
                .value=${credentialState.draft.header || ""}
                @input=${(e: Event) => credentialState.change("header", (e.target as HTMLInputElement).value)}
                placeholder="Default: Authorization"
                style="width: 100%"
            /></label>
            <label style="display: block; margin-bottom: 8px; flex: 1"
              >Value prefix <span class="hint">blank = Bearer</span
              ><input
                type="text"
                id="sc-scheme"
                .value=${credentialState.draft.scheme || ""}
                @input=${(e: Event) => credentialState.change("scheme", (e.target as HTMLInputElement).value)}
                placeholder="Default: Bearer"
                style="width: 100%"
            /></label>
          </div>
          <label style="display: block; margin-bottom: 8px" class=${classMap({ "sc-broker-only": true, hidden: env })}
            >Allowed HTTP methods <span class="hint">comma-separated; blank = GET</span
            ><input
              type="text"
              id="sc-methods"
              .value=${credentialState.draft.methods || ""}
              @input=${(e: Event) => credentialState.change("methods", (e.target as HTMLInputElement).value)}
              placeholder="GET"
              style="width: 100%"
          /></label>
          <label style="display: block; margin-bottom: 8px" class=${classMap({ "sc-broker-only": true, hidden: env })}
            >Allowed path prefixes <span class="hint">one per line; blank = any path</span
            ><textarea
              id="sc-paths"
              .value=${credentialState.draft.paths || ""}
              @input=${(e: Event) => credentialState.change("paths", (e.target as HTMLInputElement).value)}
              placeholder="/allowed/path/"
            ></textarea>
          </label>
          <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; margin-bottom: 10px"
            ><input
              type="checkbox"
              id="sc-enabled"
              .checked=${credentialState.draft.enabled !== false}
              @change=${(e: Event) => credentialState.change("enabled", (e.target as HTMLInputElement).checked)}
              style="width: auto"
            />
            Credential is enabled</label
          >
          <label
            class=${classMap({ "sc-broker-only": true, hidden: env })}
            style="display: flex; align-items: center; gap: 10px; cursor: pointer; margin-bottom: 10px"
            ><input
              type="checkbox"
              id="sc-deployments"
              .checked=${credentialState.draft.deployments !== false}
              @change=${(e: Event) => credentialState.change("deployments", (e.target as HTMLInputElement).checked)}
              style="width: auto"
            />
            Published apps may use it, acting as their publisher</label
          >
          <p class=${classMap({ hint: true, "sc-broker-only": true, hidden: env })} style="margin-bottom: 6px">
            Principals with access
          </p>
          <p class=${classMap({ hint: true, "sc-env-only": true, hidden: !env })} style="margin-bottom: 6px">
            Access: every all-internal conversation. Env delivery is not gated by grants. Rooms with externals get
            nothing, everyone else gets the env var.
          </p>
          <label
            class=${classMap({ "sc-broker-only": true, hidden: env })}
            style="display: flex; align-items: center; gap: 8px; cursor: pointer; margin-bottom: 6px"
            ><input
              type="radio"
              name="sc-share"
              id="sc-share-org"
              .checked=${!!credentialState.draft.org}
              @change=${() => credentialState.change("org", true)}
              value="org"
              style="width: auto"
            />
            Everyone in this organization</label
          >
          <label
            class=${classMap({ "sc-broker-only": true, hidden: env })}
            style="display: flex; align-items: center; gap: 8px; cursor: pointer; margin-bottom: 6px"
            ><input
              type="radio"
              name="sc-share"
              value="people"
              .checked=${!credentialState.draft.org}
              @change=${() => credentialState.change("org", false)}
              style="width: auto"
            />
            Only selected people or teams</label
          >
          <input
            type="text"
            id="sc-people"
            .value=${credentialState.draft.people || ""}
            @input=${(e: Event) => credentialState.change("people", (e.target as HTMLInputElement).value)}
            class=${classMap({ "sc-broker-only": true, hidden: env })}
            list="sc-people-options"
            placeholder="Principal IDs, comma-separated"
            style="width: 100%; display: none"
          />
          <datalist id="sc-people-options"></datalist>
          <div
            class=${classMap({ "sc-picker": true, "sc-broker-only": true, hidden: env })}
            style=${credentialState.draft.org ? "display: none" : ""}
            id="sc-picker"
          >
            <input
              type="text"
              id="sc-picker-search"
              .value=${credentialState.query}
              @input=${(e: Event) => {
                credentialState.query = (e.target as HTMLInputElement).value;
                credentialState.picker = true;
                credentialState.render();
              }}
              @focus=${() => {
                credentialState.picker = true;
                credentialState.render();
              }}
              @blur=${() =>
                setTimeout(() => {
                  credentialState.picker = false;
                  credentialState.render();
                }, 150)}
              placeholder="Search people to grant access…"
              autocomplete="off"
              spellcheck="false"
            />
            <div class="sc-picker-list" id="sc-picker-list" ?hidden=${!credentialState.picker}>${pickerRows()}</div>
          </div>
          <div class=${classMap({ "identity-chips": true, "sc-broker-only": true, hidden: env })} id="sc-people-chips">
            ${credentialState.draft.org ? null : credentialState.grantees().map((id) => html`<span class="identity-chip">${config.label(id)}${grantTag(id)}</span>`)}
          </div>
        </div>
        <aside class="editor-panel" aria-live="polite">
          <h3>Effective capability</h3>
          <dl class="capability-summary">
            <div>
              <dt>State</dt>
              <dd id="sc-cap-state">${cap.state}</dd>
            </div>
            <div>
              <dt>Host</dt>
              <dd id="sc-cap-host">${cap.host}</dd>
            </div>
            <div>
              <dt>Auth</dt>
              <dd id="sc-cap-auth">${cap.auth}</dd>
            </div>
            <div>
              <dt>Methods</dt>
              <dd id="sc-cap-methods">${cap.methods}</dd>
            </div>
            <div>
              <dt>Paths</dt>
              <dd id="sc-cap-paths">${cap.paths}</dd>
            </div>
            <div>
              <dt>Access</dt>
              <dd id="sc-cap-principals">${cap.principals}</dd>
            </div>
            <div>
              <dt>Secret</dt>
              <dd id="sc-cap-secret">${cap.secret}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
    <div class="foot">
      <button type="button" class="viewlink" data-viewlink="audit">View usage ›</button
      ><button
        type="button"
        id="sc-add"
        ?disabled=${!!credentialState.listMessage}
        class=${credentialState.open ? "hidden" : ""}
      >
        + Add credential</button
      ><button
        class=${classMap({ primary: true, hidden: !credentialState.open, dirty: credentialState.dirty })}
        id="sc-save"
        ?disabled=${!credentialState.dirty || credentialState.saving}
      >
        ${credentialState.editing ? "Save changes" : "Save credential"}</button
      ><button class=${credentialState.open ? "" : "hidden"} id="sc-reset">Cancel</button
      ><span
        class=${classMap({ status: true, [credentialState.tone]: !!credentialState.tone })}
        id="st-service-credentials"
        >${credentialState.message}</span
      >
    </div>
  </section>`;
}
export function mountCredentials() {
  credentialState.render = mountTemplate('template[data-settings-card="card-service-credentials"]', template);
}

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
  return config.label(id) === id ? html`<small>unresolved</small>` : null;
}

const summaryRoots = new WeakSet<HTMLElement>();
export function keychainSummary(data: Data | null) {
  const root = document.querySelector<HTMLElement>("#card-personal-keychains .keychain-summary");
  if (!root) return;
  if (!summaryRoots.has(root)) {
    root.replaceChildren();
    summaryRoots.add(root);
  }
  const ready = data && data.enabled !== false;
  render(
    html`<strong id="keychain-user-count">${ready ? String(data.users) : "—"}</strong> users with keychain entries ·
      <strong id="keychain-standing-count">${ready ? String(data.standing) : "—"}</strong> standing grants`,
    root,
  );
}
