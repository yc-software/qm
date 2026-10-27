import { fmtTime } from "./format.ts";
import { mountTemplate } from "./shared.ts";
import { cardClass, closeIcon, saveButton, settingStatus, saveFooter } from "./setting-controls.ts";
import { SettingState, settingRegistry } from "./setting-state.ts";
import { mountCredentials } from "./settings-credentials.ts";
import { mountProviders } from "./settings-providers.ts";
import { mountFlags } from "./settings-flags.ts";
import { mountDecisions } from "./settings-decisions.ts";
import { brandingCard } from "./settings-branding.ts";
import { mountRuntimes } from "./settings-runtimes.ts";
export * from "./settings-credentials.ts";
export * from "./settings-providers.ts";
export * from "./settings-flags.ts";
export * from "./settings-decisions.ts";
export * from "./settings-runtimes.ts";
import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";

type Model = { id: string; name?: string };
type Data = Record<string, any>;
const runtimeKeys = ["runtime", "cron-runtime", "subagent-runtime", "fallback-runtime"];
export const modelSettingKeys = [...runtimeKeys, "webui-models", "memory-embedding-model"];
const runtimeReadKey = (key: string) => key.replace(/-runtime$/, "Runtime");
export class SettingsState extends SettingState {
  context: Data = {};
  selected = "";
  editing = false;
  history: Data[] = [];
  collect(_validate = true): Data {
    if (_validate && this.key === "instructions" && (this.draft.content || "").length > 100000)
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
  [...runtimeKeys, "webui-models", "memory-embedding-model", "instructions", "branding"].map((key) => [
    key,
    new SettingsState(key),
  ]),
);
const registry = settingRegistry(states);
export const { collect, statusKey } = registry;
const { capture } = registry;
export function load(data: Data, scope: string, only?: string) {
  const org = scope.startsWith("org:");
  for (const [key, s] of states) {
    if (only && only !== key) continue;
    s.context = data;
    s.saving = false;
    if (key === "branding") {
      const fields = ["accent", "mark", "selfLabel", "orgName", "markUrl"];
      s.draft = Object.fromEntries(fields.map((field) => [field, data.branding?.[field] || ""]));
      s.available = org && "branding" in data;
    } else if (key === "memory-embedding-model") {
      s.draft = { modelId: data.memoryEmbeddingModel || "" };
      s.available = org && "memoryEmbeddingModel" in data;
    } else if (key === "instructions") {
      s.draft = { content: data.instructions || "", expectedVersion: data.instructionsVersion || 0 };
      s.history = data.instructionsHistory || [];
      s.editing = false;
      s.available = true;
    } else {
      const runtime = runtimeKeys.includes(key);
      const saved = data[runtimeReadKey(key)];
      s.available =
        org &&
        !!data.baseModelOptions?.length &&
        (!runtime || (!!data.baseModelDefault && runtimeReadKey(key) in data));
      s.draft = runtime
        ? {
            ...(key !== "runtime" ? { inherit: !saved } : {}),
            modelId: saved?.modelId || data.baseModel || data.baseModelDefault || "",
            effortLevel: saved?.effortLevel || "auto",
            fastMode: saved?.fastMode === true,
          }
        : { ids: (data.webuiModels || []).filter(Boolean) };
      s.selected = "";
    }
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
  if (s.key === "instructions") return instructionsCard(s);
  if (s.key === "branding") return brandingCard(s);
  const ids: string[] = s.draft.ids || [];
  const available = s.catalog.filter((m) => !ids.includes(m.id));
  const canAdd = available.some((m) => m.id === s.selected);
  return html`<section class=${cardClass(s, "sv-models")} id="card-webui-models">
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
        <button type="button" id="webui-models-add-button" ?disabled=${!canAdd} @click=${() => s.add()}>
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
                ${closeIcon(12)}
              </button></span
            >`,
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
  for (const key of ["webui-models", "instructions", "branding"]) {
    const s = states.get(key)!;
    s.render = mountTemplate(`template[data-settings-card="card-${key}"]`, () => card(s));
  }
}

let instructionsActions: { restore: (revision: Data) => Promise<void> } = {
  restore: async () => {},
};
export const configureInstructions = (actions: typeof instructionsActions) => void (instructionsActions = actions);
export function refreshInstructions(data: Data) {
  const s = states.get("instructions")!;
  s.draft.expectedVersion = data.instructionsVersion || 0;
  s.baseline = JSON.stringify({ content: data.instructions || "", expectedVersion: s.draft.expectedVersion });
  s.history = data.instructionsHistory || [];
  s.changed();
}
function instructionsCard(s: SettingsState) {
  const saved = JSON.parse(s.baseline).content || "";
  const content = s.draft.content || "";
  return html`<section
    class=${classMap({ card: true, "sv-customize": true, "is-editing": s.editing, dirty: s.dirty })}
    id="card-instructions"
  >
    <div class="head">
      <h2>Instructions</h2>
      <p>
        Write the standing instructions composed into every system prompt for this scope. Saving creates a durable
        revision; restoring an older revision creates a new one.
      </p>
    </div>
    <div class="body instructions-preview-body">
      <div class="instructions-preview-label" id="instructions-preview-label">Standing instructions</div>
      <p class="instructions-preview" id="instructions-preview" aria-labelledby="instructions-preview-label">
        ${saved || "No saved instructions"}
      </p>
    </div>
    <div class="body instructions-workbench">
      <label for="instructions">Standing instructions</label
      ><textarea
        id="instructions"
        maxlength="100000"
        placeholder="No scope-specific instructions"
        .value=${content}
        @input=${(e: Event) => s.change("content", value(e))}
      ></textarea>
      <div class="instructions-meta">
        <span id="instructions-ver"
          >${s.draft.expectedVersion ? "Saved version " + s.draft.expectedVersion : "No saved revision"}</span
        ><span id="instructions-size"
          >${content.length.toLocaleString() + " characters · about " + Math.ceil(content.length / 4).toLocaleString() + " tokens"}</span
        ><span id="instructions-validation"
          >${content.length >= 100000 ? "Maximum length reached" : "Draft valid"}</span
        >
      </div>
      <div class="instructions-diff" id="instructions-diff">
        <section>
          <h3>Saved revision</h3>
          <pre id="instructions-saved">${saved || "No saved instructions"}</pre>
        </section>
        <section>
          <h3>Current draft</h3>
          <pre id="instructions-draft">
${content === saved ? "No draft changes" : content || "Instructions will be cleared"}</pre>
        </section>
      </div>
      <div class="instructions-history" id="instructions-history" aria-label="Instructions version history">
        <h3>Version history</h3>
        ${
          s.history.length
            ? repeat(
                s.history,
                (r) => r.version,
                (r) =>
                  html`<div class="instructions-revision">
                    <p>
                      Version ${r.version}<small
                        >${r.updatedBy || "Author unavailable"} ·
                        ${r.updatedAt ? fmtTime(r.updatedAt) : "Time unavailable"}</small
                      >
                    </p>
                    <button
                      type="button"
                      ?disabled=${r.version === s.draft.expectedVersion || s.saving}
                      @click=${() => instructionsActions.restore({ ...r })}
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
        id="instructions-history-link"
        @click=${() => {
          s.editing = true;
          s.render();
          document.getElementById("instructions-history")?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
      >
        View history ›</button
      ><button
        type="button"
        id="instructions-edit"
        @click=${() => {
          s.editing = !s.editing;
          if (!s.editing) s.draft.content = saved;
          s.changed();
          if (s.editing) document.getElementById("instructions")?.focus();
        }}
      >
        ${s.editing ? "Cancel" : "Edit"}</button
      >${saveButton(s, "Save")}${settingStatus(s)}
    </div>
  </section>`;
}
