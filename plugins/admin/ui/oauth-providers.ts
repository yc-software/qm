import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { settingStatus } from "./setting-controls.ts";
import { connectors, context, connectorLabel } from "./integrations-state.ts";

export type CustomProvider = {
  provider: string;
  label: string;
  description?: string;
  authUrl: string;
  tokenUrl: string;
  hosts: string[];
  scopes: string[];
  clientAuth: "basic" | "body";
  scopeParam?: string;
  authParams?: Record<string, string>;
  pkce?: boolean;
  docsUrl?: string;
  setupSteps?: string[];
  updatedBy?: string;
  updatedAt?: number;
};
const lines = (text: string, separator = /[\n,]/) =>
  text
    .split(separator)
    .map((x) => x.trim())
    .filter(Boolean);
const blankProvider = () => ({
  provider: "",
  label: "",
  description: "",
  authUrl: "",
  tokenUrl: "",
  hosts: "",
  scopes: "",
  clientAuth: "body",
  scopeParam: "",
  authParams: "",
  docsUrl: "",
  setupSteps: "",
  pkce: false,
});
function callbackUrl(provider: string) {
  return location.origin + "/v1/connectors/oauth/" + (provider.trim() || "<name>") + "/callback";
}
class ProvidersState {
  get list() {
    return connectors.providers;
  }
  editor = false;
  editing = "";
  draft = blankProvider();
  revision = 0;
  busy = false;
  message = "";
  tone = "";
  render = () => {};
  setStatus(message: string, tone: string) {
    this.message = message;
    this.tone = tone;
    this.render();
  }
  change(field: string, value: string | boolean) {
    this.draft = { ...this.draft, [field]: value };
    this.revision++;
    this.render();
  }
  reset() {
    this.editor = false;
    this.editing = "";
    this.draft = blankProvider();
    this.revision++;
    this.render();
  }
  edit(p?: CustomProvider) {
    this.editing = p?.provider || "";
    this.draft = p
      ? {
          provider: p.provider,
          label: p.label,
          description: p.description || "",
          authUrl: p.authUrl,
          tokenUrl: p.tokenUrl,
          hosts: p.hosts.join("\n"),
          scopes: p.scopes.join("\n"),
          clientAuth: p.clientAuth,
          scopeParam: p.scopeParam || "",
          authParams: Object.entries(p.authParams || {})
            .map(([key, value]) => key + "=" + value)
            .join("\n"),
          docsUrl: p.docsUrl || "",
          setupSteps: (p.setupSteps || []).join("\n"),
          pkce: !!p.pkce,
        }
      : blankProvider();
    this.editor = true;
    this.revision++;
    this.setStatus("", "");
  }
  payload() {
    const d = this.draft,
      description = d.description.trim(),
      scopeParam = d.scopeParam.trim(),
      docsUrl = d.docsUrl.trim(),
      setupSteps = lines(d.setupSteps, /\n/),
      authParams = Object.fromEntries(
        lines(d.authParams, /\n/).map((line) => {
          const at = line.indexOf("=");
          if (at < 1) throw new Error("Use key=value for authorization parameters, one per line.");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
      );
    return {
      provider: d.provider.trim(),
      label: d.label.trim(),
      ...(description ? { description } : {}),
      authUrl: d.authUrl.trim(),
      tokenUrl: d.tokenUrl.trim(),
      hosts: lines(d.hosts),
      scopes: lines(d.scopes),
      clientAuth: d.clientAuth,
      ...(scopeParam ? { scopeParam } : {}),
      ...(Object.keys(authParams).length ? { authParams } : {}),
      ...(d.pkce ? { pkce: true } : {}),
      ...(docsUrl ? { docsUrl } : {}),
      ...(setupSteps.length ? { setupSteps } : {}),
    };
  }
  async put(body: Record<string, unknown>, failed: string) {
    const scope = context.orgScope();
    const result = await context.api("PUT", "/api/scopes/" + encodeURIComponent(scope) + "/connector-providers", body);
    if (scope !== context.orgScope()) return false;
    if (!result.ok)
      throw new Error(
        result.status === 403
          ? "Only an org admin can manage connectors."
          : result.data?.message || failed + " (HTTP " + result.status + ")",
      );
    await connectors.load();
    return true;
  }
  async run(action: () => Promise<string>) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const message = await action();
      this.setStatus(message, "ok");
    } catch (error) {
      this.setStatus((error as Error).message, "err");
    } finally {
      this.busy = false;
      this.render();
    }
  }
  save() {
    const revision = this.revision,
      created = !this.editing;
    return this.run(async () => {
      const body = this.payload();
      if (created && this.list.some((p) => p.provider === body.provider))
        throw new Error("A provider named " + body.provider + " already exists.");
      this.setStatus("Saving...", "saving");
      if (!(await this.put(body, "Save failed."))) return "";
      if (revision !== this.revision) {
        this.editing = body.provider;
        this.draft = { ...this.draft, provider: body.provider };
        return "Saved. Your newer edits are not saved.";
      }
      this.reset();
      return created ? "Saved. Add its OAuth app above to make it linkable." : "Saved";
    });
  }
  remove(p: CustomProvider) {
    if (connectors.list.some((c) => c.provider === p.provider))
      return Promise.resolve(this.setStatus("Delete the " + p.label + " OAuth app above first.", "err"));
    if (!confirm("Delete " + p.label + "? Everyone's linked " + p.label + " accounts are disconnected."))
      return Promise.resolve();
    return this.run(async () => {
      if (!(await this.put({ provider: p.provider, delete: true }, "Delete failed."))) return "";
      if (this.editing === p.provider) this.reset();
      return "Deleted";
    });
  }
}
export const providers = new ProvidersState();
function badge(text: string, tone: string) {
  return html`<span class=${"badge " + tone}>${text}</span>`;
}
export function providerCard() {
  const s = providers,
    d = s.draft;
  return html`<section class="card" id="card-oauth-providers">
    <div class="head">
      <h2>Custom OAuth providers</h2>
      <p>
        Add an OAuth provider that isn't built in. Once saved, it appears in the OAuth app picker above; add its client
        ID and secret there to make it linkable. Applies org-wide.
      </p>
    </div>
    <div class="body">
      <div id="op-list" class=${s.list.length ? "" : "hint"}>${customProviderRows()}</div>
    </div>
    <div
      class=${classMap({ body: true, hidden: !s.editor })}
      id="op-editor"
      style="border-top: 1px solid var(--border, #2a2a2a); padding-top: 12px"
    >
      <div class="sc-form-head">
        <p class="hint" id="op-form-title">
          ${s.editing ? "Editing " + connectorLabel(s.editing) : "Add an OAuth provider"}
        </p>
        <span class=${"badge " + (s.editing ? "info" : "muted")}>${s.editing ? "Editing" : "New"}</span>
      </div>
      ${field("Name", "op-name", "provider", "asana", Boolean(s.editing))}
      <p class="field-hint">Lowercase letters, digits and -. Can't be changed later.</p>
      ${field("Label", "op-label", "label", "Asana")}
      ${field("Description", "op-description", "description", "Optional")}
      ${field("Authorization URL", "op-auth-url", "authUrl", "https://example.com/oauth/authorize", Boolean(s.editing))}
      ${field("Token URL", "op-token-url", "tokenUrl", "https://example.com/oauth/token", Boolean(s.editing))}
      ${area("API hosts", "op-hosts", "hosts", "api.example.com", Boolean(s.editing))}
      <p class="field-hint">
        ${
          s.editing
            ? "URLs and hosts can't change. Delete and re-add the provider to change them."
            : "One hostname per line. Requests to these hosts carry the user's token."
        }
      </p>
      ${area("Scopes", "op-scopes", "scopes", "Optional")}
      <p class="field-hint">One per line. Leave empty if the provider sets scopes on the app.</p>
      <label style="display: block; margin-bottom: 8px"
        >Client authentication
        <select
          id="op-client-auth"
          style="width: 100%"
          @change=${(e: Event) => s.change("clientAuth", (e.target as HTMLSelectElement).value)}
        >
          <option value="basic" .selected=${d.clientAuth === "basic"}>HTTP Basic header</option>
          <option value="body" .selected=${d.clientAuth === "body"}>Request body</option>
        </select></label
      >
      ${field("Scope parameter", "op-scope-param", "scopeParam", "scope")}
      ${area("Authorization parameters", "op-auth-params", "authParams", "access_type=offline")}
      <p class="field-hint">Optional. One key=value per line, added to the authorization URL.</p>
      ${field("Docs URL", "op-docs-url", "docsUrl", "Optional")}
      ${area("Setup steps", "op-setup-steps", "setupSteps", "Optional, one per line")}
      ${check("Use PKCE", "op-pkce", "pkce")}
      <div class="hint" id="op-redirect">
        ${"Callback URL: " + callbackUrl(d.provider)}
        <div>Register this in the provider's OAuth app.</div>
      </div>
    </div>
    <div class="foot">
      <button type="button" id="add-oauth-provider" class=${s.editor ? "hidden" : ""} @click=${() => s.edit()}>
        + Add OAuth provider</button
      ><button
        class=${classMap({ primary: true, hidden: !s.editor })}
        id="op-save"
        ?disabled=${s.busy}
        @click=${() => s.save()}
      >
        ${s.editing ? "Save changes" : "Save provider"}</button
      ><button class=${s.editor ? "" : "hidden"} id="op-reset" ?disabled=${s.busy} @click=${() => s.reset()}>
        Cancel</button
      >${settingStatus(s, "st-oauth-providers")}
    </div>
  </section>`;
}
function field(label: string, id: string, key: string, placeholder: string, disabled = false) {
  return html`<label style="display: block; margin-bottom: 8px"
    >${label}
    <input
      type="text"
      id=${id}
      .value=${(providers.draft as Record<string, any>)[key]}
      ?disabled=${disabled}
      @input=${(e: Event) => providers.change(key, (e.target as HTMLInputElement).value)}
      autocomplete="off"
      spellcheck="false"
      placeholder=${placeholder}
      style="width: 100%"
  /></label>`;
}
function area(label: string, id: string, key: string, placeholder: string, disabled = false) {
  return html`<label style="display: block; margin-bottom: 8px"
    >${label}
    <textarea
      id=${id}
      rows="2"
      .value=${(providers.draft as Record<string, any>)[key]}
      ?disabled=${disabled}
      @input=${(e: Event) => providers.change(key, (e.target as HTMLTextAreaElement).value)}
      spellcheck="false"
      placeholder=${placeholder}
      style="width: 100%; font-family: var(--mono, monospace)"
    ></textarea>
  </label>`;
}
function check(label: string, id: string, key: string) {
  return html`<label style="display: flex; align-items: center; gap: 10px; cursor: pointer; margin-bottom: 10px"
    ><input
      type="checkbox"
      id=${id}
      style="width: auto"
      .checked=${!!(providers.draft as Record<string, any>)[key]}
      @change=${(e: Event) => providers.change(key, (e.target as HTMLInputElement).checked)}
    />
    ${label}</label
  >`;
}
function appBadge(app?: { enabled?: boolean }) {
  if (!app) return badge("No OAuth app", "muted");
  return app.enabled === false ? badge("OAuth app disabled", "warn") : badge("OAuth app set", "ok");
}
function customProviderRows() {
  if (!providers.list.length) return "No custom providers.";
  return repeat(
    providers.list,
    (p) => p.provider,
    (p: CustomProvider) =>
      html`<div class=${classMap({ "credential-row": true, "is-editing": p.provider === providers.editing })}>
        <div class="credential-main">
          <div class="credential-title">
            <strong>${p.label}</strong><span class="credential-slug">${p.provider}</span>
          </div>
          <div class="hint">
            ${p.hosts.join(", ") + (p.updatedBy ? " · by " + p.updatedBy : "") + (p.updatedAt ? " · " + context.fmtTime(new Date(p.updatedAt).toISOString()) : "")}
          </div>
          <div class="credential-badges">${appBadge(connectors.list.find((c) => c.provider === p.provider))}</div>
        </div>
        <div class="credential-actions">
          <button
            type="button"
            aria-label=${"Edit " + p.label}
            ?disabled=${providers.busy}
            @click=${() => providers.edit(p)}
          >
            Edit</button
          ><button
            type="button"
            class="rowbtn danger"
            title="Delete provider"
            aria-label=${"Delete " + p.label}
            ?disabled=${providers.busy}
            @click=${() => providers.remove(p)}
          >
            Delete
          </button>
        </div>
      </div>`,
  );
}
