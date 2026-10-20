import { mountTemplate } from "./shared.ts";
import { saveButton, settingStatus, saveFooter } from "./setting-controls.ts";
import { SettingState, settingRegistry } from "./setting-state.ts";
import { mountCredentials } from "./settings-credentials.ts";
export {
  configureCredentials,
  credentialState,
  credentialStatus,
  credentialLoading,
  loadCredentials,
  keychainSummary,
} from "./settings-credentials.ts";
import { mountProviders } from "./settings-providers.ts";
export { configureProviders, openProvider, loadProviders } from "./settings-providers.ts";
import { mountFlags } from "./settings-flags.ts";
import { mountDecisions } from "./settings-decisions.ts";
export { configureFlags, loadFlags } from "./settings-flags.ts";
export { configureDecisions, loadDecisions } from "./settings-decisions.ts";
import { brandingCard } from "./settings-branding.ts";
import { mountRuntimes } from "./settings-runtimes.ts";
export { configureRuntimes } from "./settings-runtimes.ts";
import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";

type Model = { id: string; name?: string };
type Data = Record<string, any>;
const runtimeKeys = ["runtime", "cron-runtime", "subagent-runtime", "fallback-runtime"];
const runtimeReadKey = (key: string) => key.replace(/-runtime$/, "Runtime");
export class SettingsState extends SettingState {
  context: Data = {};
  selected = "";
  open = false;
  active = 0;
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
    return [
      ...Object.values(this.context.modelsByHarness || {}).flat(),
      ...(this.context.baseModelOptions || []),
    ].filter((m: any, i, all) => m?.id && all.findIndex((x: any) => x?.id === m.id) === i) as Model[];
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
  add(id = this.selected) {
    if (id && !this.draft.ids.includes(id)) this.draft.ids.push(id);
    this.selected = "";
    this.active = 0;
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
export const { owns, collect, capture, commit, status, statusKey } = settingRegistry(states);
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
      s.saving = false;
      capture(key);
      continue;
    }
    if (key === "memory-embedding-model") {
      s.draft = { modelId: data.memoryEmbeddingModel || "" };
      s.available = scope.startsWith("org:") && "memoryEmbeddingModel" in data;
      s.saving = false;
      capture(key);
      continue;
    }
    if (key === "soul") {
      s.draft = { content: data.soul || "", expectedVersion: data.soulVersion || 0 };
      s.history = data.soulHistory || [];
      s.editing = false;
      s.available = true;
      s.saving = false;
      capture(key);
      continue;
    }
    s.available =
      scope.startsWith("org:") &&
      !!data.baseModelOptions?.length &&
      (!runtimeKeys.includes(key) || (!!data.baseModelDefault && runtimeReadKey(key) in data));
    const runtime = data[runtimeReadKey(key)];
    s.draft = runtimeKeys.includes(key)
      ? {
          ...(key !== "runtime" ? { inherit: !runtime } : {}),
          harnessId: runtime?.harnessId || data.harnessDefault || "pi",
          modelId: runtime?.modelId || data.baseModel || data.baseModelDefault || "",
          effortLevel: runtime?.effortLevel || "auto",
          fastMode: runtime?.fastMode === true,
        }
      : { ids: (data.webuiModels || []).filter(Boolean) };
    s.saving = false;
    s.selected = "";
    capture(key);
  }
}
export function updateCatalog(data: Data) {
  for (const s of states.values()) {
    s.context = { ...s.context, ...data };
    s.render();
  }
}
const value = (event: Event) => (event.target as HTMLInputElement).value;
const label = (s: SettingsState, id: string) => {
  const m = s.catalog.find((x) => x.id === id);
  return m?.name && m.name !== id ? `${m.name} (${id})` : id;
};
function card(s: SettingsState) {
  if (s.key === "soul") return soulCard(s);
  if (s.key === "branding") return brandingCard(s);
  const ids: string[] = s.draft.ids || [];
  const available = s.catalog.filter((m) => !ids.includes(m.id));
  const query = s.selected.trim().toLowerCase();
  const matches = available.filter((m) => label(s, m.id).toLowerCase().includes(query));
  const canAdd = available.some((m) => m.id === s.selected.trim());
  return html`<section
    class=${classMap({ card: true, "sv-models": true, hidden: !s.available, dirty: s.dirty })}
    id="card-webui-models"
  >
    <div class="head"><h2>Enabled models</h2></div>
    <div class="body">
      <div class="model-add-row">
        <div class="model-add-field">
          <label for="webui-models-add">Add a model</label>
          <div class=${classMap({ dd: true, open: s.open && !!matches.length })}>
            <input
              id="webui-models-add"
              role="combobox"
              autocomplete="off"
              aria-autocomplete="list"
              aria-controls="webui-models-options"
              aria-expanded=${s.open && !!matches.length ? "true" : "false"}
              aria-activedescendant=${matches[s.active] ? `webui-models-option-${s.active}` : ""}
              placeholder=${available.length ? "Search models…" : "All models enabled"}
              .value=${s.selected}
              ?disabled=${!available.length}
              @focus=${() => ((s.open = true), s.render())}
              @blur=${() => ((s.open = false), s.render())}
              @input=${(e: Event) => {
                s.selected = value(e);
                s.open = true;
                s.active = 0;
                s.render();
              }}
              @keydown=${(e: KeyboardEvent) => {
                const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
                if (step && matches.length) s.active = (s.active + step + matches.length) % matches.length;
                else if (e.key === "Enter" && (matches[s.active] || canAdd))
                  s.add(s.open && matches[s.active] ? matches[s.active]!.id : s.selected);
                else if (e.key === "Escape") s.open = false;
                else return;
                e.preventDefault();
                s.open = e.key !== "Escape";
                s.render();
              }}
            />
            <div class="dd-menu" id="webui-models-options" role="listbox">
              ${matches.map(
                (m, i) =>
                  html`<div
                    class=${classMap({ "dd-item": true, active: i === s.active })}
                    id=${`webui-models-option-${i}`}
                    role="option"
                    aria-selected=${i === s.active ? "true" : "false"}
                    @mousedown=${(e: Event) => (e.preventDefault(), s.add(m.id))}
                  >
                    ${label(s, m.id)}
                  </div>`,
              )}
            </div>
          </div>
        </div>
        <button
          type="button"
          id="webui-models-add-button"
          ?disabled=${!canAdd}
          @click=${() => s.add(s.selected.trim())}
        >
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
              ><button type="button" aria-label=${"Remove " + id} @click=${() => s.remove(id)}>
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
export function mountCards() {
  mountFlags();
  mountDecisions();
  mountProviders();
  mountCredentials();
  mountRuntimes();
  for (const [key, s] of states) {
    const id = (
      { soul: "card-soul", branding: "card-branding", "webui-models": "card-webui-models" } as Record<string, string>
    )[key];
    if (id) s.render = mountTemplate(`template[data-settings-card="${id}"]`, () => card(s));
  }
}

let soulActions: { formatTime: (time: any) => string; restore: (revision: Data) => Promise<void> } = {
  formatTime: String,
  restore: async () => {},
};
export function configureSoul(actions: typeof soulActions) {
  soulActions = actions;
}
export function refreshSoul(data: Data) {
  const s = states.get("soul")!;
  s.draft.expectedVersion = data.soulVersion || 0;
  s.baseline = JSON.stringify({ content: data.soul || "", expectedVersion: s.draft.expectedVersion });
  s.history = data.soulHistory || [];
  s.changed();
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
                        ${r.updatedAt ? soulActions.formatTime(r.updatedAt) : "Time unavailable"}</small
                      >
                    </p>
                    <button
                      type="button"
                      ?disabled=${r.version === s.draft.expectedVersion || s.saving}
                      @click=${() => soulActions.restore({ ...r })}
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
