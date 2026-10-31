import { html, render, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import type { AdminPage } from "./sections.ts";
import { pageHeader } from "./shared.ts";
import { saveButton, settingStatus, saveFooter, reviewChange } from "./setting-controls.ts";
import { SettingState, putSetting } from "./setting-state.ts";
import {
  credentialsCard,
  keychainCard,
  loadCredentials,
  addCredential,
  credentialState,
} from "./settings-credentials.ts";
import { providersCard, useProviders, loadProviders } from "./settings-providers.ts";
import { flagsCard, loadFlags } from "./settings-flags.ts";
import { decisionsCard, loadDecisions } from "./settings-decisions.ts";
import { brandingCard } from "./settings-branding.ts";
import { runtimesCard } from "./settings-runtimes.ts";

type Model = { id: string; name?: string };
type Data = Record<string, any>;
const runtimeKeys = ["runtime", "cron-runtime", "subagent-runtime", "fallback-runtime"];
const runtimeReadKey = (key: string) => key.replace(/-runtime$/, "Runtime");
export class SettingsState extends SettingState {
  context: Data = {};
  selected = "";
  editing = false;
  history: Data[] = [];
  collect(_validate = true): Data {
    if (_validate && this.key === "soul" && (this.draft.content || "").length > 100000)
      throw new Error("Maximum length reached");
    if (this.key !== "runtime" && runtimeKeys.includes(this.key)) {
      if (this.draft.inherit) return { inherit: true };
      const { inherit: _inherit, ...selection } = this.draft;
      return structuredClone(selection);
    }
    if (this.key === "memory-embedding-model") return { modelId: this.draft.modelId || null };
    if (this.key === "branding")
      return Object.fromEntries(Object.entries(this.draft).map(([key, value]) => [key, String(value).trim()]));
    return structuredClone(this.draft);
  }
  get catalog(): Model[] {
    return [...(this.context.baseModelOptions || [])].filter(
      (m: any, i, all) => m?.id && all.findIndex((x: any) => x?.id === m.id) === i,
    ) as Model[];
  }
  change(field: string, value: unknown) {
    this.draft[field] = value;
    this.changed();
  }
  changed() {
    this.message = this.dirty ? "Unsaved changes" : "";
    this.tone = "";
    this.render();
  }
  commit(body: Data) {
    this.baseline = JSON.stringify(body);
    this.saving = false;
    this.changed();
  }
  save = () => saveSetting(this);
  add() {
    if (this.selected && !this.draft.ids.includes(this.selected)) this.draft.ids.push(this.selected);
    this.selected = "";
    this.changed();
  }
  remove(id: string) {
    this.draft.ids = this.draft.ids.filter((x: string) => x !== id);
    this.changed();
  }
}
export const states = new Map(
  [...runtimeKeys, "webui-models", "memory-embedding-model", "soul", "branding"].map((key) => [
    key,
    new SettingsState(key),
  ]),
);
export let page: AdminPage;
let savedBranding: Data = {};
const scopeUrl = (query = "") => "/api/scopes/" + encodeURIComponent(page.orgScope) + query;
export function draw() {
  if (page?.host.isConnected) render(template(), page.host);
}
for (const s of states.values()) s.render = draw;
credentialState.render = draw;

export function load(data: Data, scope: string, only?: string) {
  for (const [key, s] of states) {
    if (only && only !== key) continue;
    s.context = data;
    if (key === "branding") {
      s.draft = {
        accent: data.branding?.accent || "",
        mark: data.branding?.mark || "",
        selfLabel: data.branding?.selfLabel || "",
        orgName: data.branding?.orgName || "",
        markUrl: data.branding?.markUrl || "",
      };
      s.available = scope.startsWith("org:") && "branding" in data;
    } else if (key === "memory-embedding-model") {
      s.draft = { modelId: data.memoryEmbeddingModel || "" };
      s.available = scope.startsWith("org:") && "memoryEmbeddingModel" in data;
    } else if (key === "soul") {
      s.draft = { content: data.soul || "", expectedVersion: data.soulVersion || 0 };
      s.history = data.soulHistory || [];
      s.editing = false;
      s.available = true;
    } else {
      s.available =
        scope.startsWith("org:") &&
        !!data.baseModelOptions?.length &&
        (!runtimeKeys.includes(key) || (!!data.baseModelDefault && runtimeReadKey(key) in data));
      const runtime = data[runtimeReadKey(key)];
      s.draft = runtimeKeys.includes(key)
        ? {
            ...(key !== "runtime" ? { inherit: !runtime } : {}),
            modelId: runtime?.modelId || data.baseModel || data.baseModelDefault || "",
            effortLevel: runtime?.effortLevel || "auto",
            fastMode: runtime?.fastMode === true,
          }
        : { ids: (data.webuiModels || []).filter(Boolean) };
      s.selected = "";
    }
    s.saving = false;
    s.baseline = JSON.stringify(s.collect(false));
    s.changed();
  }
}
function updateCatalog(data: Data) {
  for (const s of states.values()) s.context = { ...s.context, ...data };
  draw();
}
function refreshSoul(data: Data) {
  const s = states.get("soul")!;
  s.draft.expectedVersion = data.soulVersion || 0;
  s.baseline = JSON.stringify({ content: data.soul || "", expectedVersion: s.draft.expectedVersion });
  s.history = data.soulHistory || [];
  s.changed();
}

async function freshSoul(current: () => boolean) {
  const fresh = await page.api("GET", scopeUrl("?view=customize"));
  return current() ? fresh : null;
}

async function saveSetting(s: SettingsState) {
  let body: Data;
  try {
    body = s.collect();
  } catch (err) {
    return Object.assign(s, { message: err instanceof Error ? err.message : "Could not save.", tone: "err" }).render();
  }
  const view = page;
  const branding = s.key === "branding" ? { ...savedBranding, ...body } : body;
  const r = await putSetting(view, view.orgScope, s, s.key, branding);
  if (!r) return;
  if (!r.ok) {
    if (s.key !== "soul" || r.status !== 409) return;
    const fresh = await freshSoul(view.current);
    if (fresh?.ok) refreshSoul(fresh.data);
    return Object.assign(s, {
      message: "SOUL changed; latest revision loaded and your draft was preserved.",
      tone: "err",
    }).render();
  }
  s.commit(body);
  if (s.key === "branding") {
    savedBranding = branding;
    if (![...states.values()].some((x) => x.available && x.dirty)) location.reload();
  }
  if (s.key !== "soul") return;
  const fresh = await freshSoul(view.current);
  if (!fresh) return;
  if (!fresh.ok)
    return Object.assign(s, {
      message: "Saved, but the latest version could not be refreshed.",
      tone: "warn",
    }).render();
  refreshSoul(fresh.data);
  if (!s.dirty) Object.assign(s, { message: "Saved", tone: "ok" }).render();
}

async function restoreSoul(revision: Data) {
  const s = states.get("soul")!;
  const view = page;
  const draftBefore = JSON.stringify(s.collect(false));
  const expectedVersion = s.draft.expectedVersion;
  const confirmed = await reviewChange({
    title: "Restore SOUL version " + revision.version + "?",
    subtitle: "The saved instructions from this revision will replace the current SOUL.",
    facts: [
      ["Scope", "Organization · " + view.org],
      ["Current", "Version " + expectedVersion],
      ["Restore", "Version " + revision.version],
    ],
    warning: "This does not erase history. A new revision will be created, and future turns will use it immediately.",
    confirmLabel: "Restore version " + revision.version,
    danger: true,
  });
  if (!confirmed || !view.current()) return;
  Object.assign(s, { saving: true, message: "Restoring…", tone: "saving" }).render();
  const r = await view.api("PUT", scopeUrl("/soul"), { content: revision.content, expectedVersion });
  s.saving = false;
  if (!view.current()) return;
  if (!r.ok) {
    if (r.status === 409) {
      const fresh = await freshSoul(view.current);
      if (fresh?.ok) refreshSoul(fresh.data);
    }
    const message =
      r.status === 409
        ? "SOUL changed; latest revision loaded and your draft was preserved."
        : r.data?.message || "Restore failed.";
    return Object.assign(s, { message, tone: "err" }).render();
  }
  const fresh = await freshSoul(view.current);
  if (!fresh) return;
  if (!fresh.ok)
    return Object.assign(s, {
      message: "Restored, but the latest version could not be refreshed.",
      tone: "warn",
    }).render();
  if (JSON.stringify(s.collect(false)) === draftBefore) load(fresh.data, view.orgScope, "soul");
  else refreshSoul(fresh.data);
  if (!s.dirty)
    Object.assign(s, { message: "Version " + revision.version + " restored as a new revision", tone: "ok" }).render();
}

async function refreshCatalog(view: AdminPage, data: Data) {
  const fresh = await view.api("GET", scopeUrl("?view=" + encodeURIComponent(view.view) + "&catalog=refresh"));
  if (!fresh.ok || !view.current()) return;
  const merge = (target: Model[], incoming: Model[] = []) => {
    for (const model of incoming) {
      const at = target.findIndex((candidate) => candidate.id === model.id);
      if (at < 0) target.push(model);
      else target[at] = model;
    }
  };
  merge((data.baseModelOptions ||= []), fresh.data.baseModelOptions);
  updateCatalog(data);
}

let status = "";
export async function mount(next: AdminPage) {
  page = next;
  status = "";
  useProviders({ page: next, redraw: draw, refresh: refreshProviders });
  if (next.view === "credentials") return void loadCredentials(next);
  draw();
  if (next.view === "models") void loadProviders();
  const r = await next.api("GET", scopeUrl("?view=" + encodeURIComponent(next.view)));
  if (!next.current()) return;
  if (!r.ok) status = r.status === 403 ? "You don't administer this scope." : r.data?.message || "Failed to load.";
  if (r.ok && next.view === "models")
    for (const key of [...runtimeKeys, "webui-models", "memory-embedding-model"]) load(r.data, next.orgScope, key);
  if (r.ok && next.view === "customize") {
    savedBranding = r.data.branding || {};
    load(r.data, next.orgScope, "soul");
    load(r.data, next.orgScope, "branding");
    loadDecisions(r.data, next.orgScope);
    void loadFlags(r.data, next.orgScope);
  }
  draw();
  if (r.ok && r.data.modelCatalogRefreshing) void refreshCatalog(next, r.data);
}

async function refreshProviders() {
  const view = page;
  await loadProviders();
  if (view.view !== "models") return;
  const fresh = await view.api("GET", scopeUrl("?view=models"));
  if (fresh.ok && view.current()) updateCatalog(fresh.data);
}

function template() {
  const view = page.view;
  const s = (key: string) => states.get(key)!;
  const cards: Data = {
    models: () => [runtimesCard(), providersCard(), modelsCard(s("webui-models"))],
    credentials: () => [credentialsCard(), keychainCard()],
    customize: () => [soulCard(s("soul")), brandingCard(s("branding")), flagsCard(), decisionsCard()],
  };
  return html`${pageHeader({ actions: view === "credentials" ? addCredential() : nothing })}
    <div id="view-governance">
      <div class="governance-content">
        ${status ? html`<p class="hint" role="status">${status}</p>` : nothing}${cards[view]()}
      </div>
    </div>`;
}

const value = (event: Event) => (event.target as HTMLInputElement).value;
const label = (s: SettingsState, id: string) => {
  const m = s.catalog.find((x) => x.id === id);
  return m?.name && m.name !== id ? `${m.name} (${id})` : id;
};
function modelsCard(s: SettingsState) {
  const ids: string[] = s.draft.ids || [];
  const available = s.catalog.filter((m) => !ids.includes(m.id));
  const canAdd = available.some((m) => m.id === s.selected);
  return html`<section
    class=${classMap({ card: true, "sv-models": true, hidden: !s.available, dirty: s.dirty })}
    id="card-webui-models"
  >
    <div class="head"><h2>Enabled models</h2></div>
    <div class="body">
      <div class="model-add-row">
        <div class="model-add-field">
          <label for="webui-models-add">Add a model</label
          ><input
            id="webui-models-add"
            list="webui-models-options"
            autocomplete="off"
            placeholder="Search models…"
            .value=${s.selected}
            ?disabled=${!available.length}
            @input=${(e: Event) => {
              s.selected = value(e);
              s.render();
            }}
            @keydown=${(e: KeyboardEvent) => e.key === "Enter" && canAdd && s.add()}
          /><datalist id="webui-models-options">
            ${available.map((m) => html`<option value=${m.id}>${label(s, m.id)}</option>`)}
          </datalist>
        </div>
        <button class="btn" type="button" id="webui-models-add-button" ?disabled=${!canAdd} @click=${() => s.add()}>
          + Add model
        </button>
      </div>
      <div id="webui-models-list" class="model-list">
        <p id="webui-models-empty" class=${classMap({ hint: true, hidden: !!ids.length })}>
          No additional models enabled.
        </p>
        ${repeat(
          ids,
          (id) => id,
          (id) =>
            html`<span data-chip=${id} class="model-chip"
              ><span>${label(s, id)}</span
              ><button class="btn" type="button" aria-label=${"Remove " + id} @click=${() => s.remove(id)}>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg></button
            ></span>`,
        )}
      </div>
    </div>
    ${saveFooter(s)}
  </section>`;
}
function soulCard(s: SettingsState) {
  const saved = JSON.parse(s.baseline).content || "";
  const content = s.draft.content || "";
  return html`<section
    class=${classMap({ card: true, "sv-customize": true, "is-editing": s.editing, dirty: s.dirty })}
    id="card-soul"
  >
    <div class="head">
      <h2>Organization SOUL</h2>
      <p>
        Write the standing instructions composed into every system prompt for this scope. Saving creates a durable
        revision; restoring an older revision creates a new one.
      </p>
    </div>
    <div class="body soul-preview-body">
      <div class="soul-preview-label" id="soul-preview-label">Standing instructions</div>
      <p class="soul-preview" id="soul-preview" aria-labelledby="soul-preview-label">
        ${saved || "No saved instructions"}
      </p>
    </div>
    <div class="body soul-workbench">
      <label for="soul">Standing instructions</label
      ><textarea
        id="soul"
        maxlength="100000"
        placeholder="No scope-specific instructions"
        .value=${content}
        @input=${(e: Event) => s.change("content", value(e))}
      ></textarea>
      <div class="soul-meta">
        <span id="soul-ver"
          >${s.draft.expectedVersion ? "Saved version " + s.draft.expectedVersion : "No saved revision"}</span
        ><span id="soul-size"
          >${content.length.toLocaleString() + " characters · about " + Math.ceil(content.length / 4).toLocaleString() + " tokens"}</span
        ><span id="soul-validation">${content.length >= 100000 ? "Maximum length reached" : "Draft valid"}</span>
      </div>
      <div class="soul-diff" id="soul-diff">
        <section>
          <h3>Saved revision</h3>
          <pre id="soul-saved">${saved || "No saved instructions"}</pre>
        </section>
        <section>
          <h3>Current draft</h3>
          <pre id="soul-draft">
${content === saved ? "No draft changes" : content || "Instructions will be cleared"}</pre>
        </section>
      </div>
      <div class="soul-history" id="soul-history" aria-label="SOUL version history">
        <h3>Version history</h3>
        ${
          s.history.length
            ? repeat(
                s.history,
                (r) => r.version,
                (r) =>
                  html`<div class="soul-revision">
                    <p>
                      Version ${r.version}<small
                        >${r.updatedBy || "Author unavailable"} ·
                        ${r.updatedAt ? new Date(r.updatedAt).toLocaleString() : "Time unavailable"}</small
                      >
                    </p>
                    <button
                      class="btn"
                      type="button"
                      ?disabled=${r.version === s.draft.expectedVersion || s.saving}
                      @click=${() => restoreSoul({ ...r })}
                    >
                      ${r.version === s.draft.expectedVersion ? "Current" : "Restore"}
                    </button>
                  </div>`,
              )
            : html`<p class="hint">History begins with the next saved revision.</p>`
        }
      </div>
    </div>
    <div class="foot">
      <button
        type="button"
        class="viewlink"
        id="soul-history-link"
        @click=${() => {
          s.editing = true;
          s.render();
          document.getElementById("soul-history")?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
      >
        View history ›</button
      ><button
        class="btn"
        type="button"
        id="soul-edit"
        @click=${() => {
          s.editing = !s.editing;
          if (!s.editing) s.draft.content = saved;
          s.changed();
          if (s.editing) document.getElementById("soul")?.focus();
        }}
      >
        ${s.editing ? "Cancel" : "Edit"}</button
      >${saveButton(s, "Save")}${settingStatus(s)}
    </div>
  </section>`;
}
