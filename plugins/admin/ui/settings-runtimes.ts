import { html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { ChevronDown } from "lucide";
import { createModelPicker, type ModelCatalog } from "../../web-ui/src/model-picker.ts";
import { runtimeModelOptions, type EffortLevel, type ModelOption } from "../../web-ui/src/model-options.ts";
import { icon } from "../../web-ui/src/icons.ts";
import { loadoutActions, type LoadoutEntry } from "../../web-ui/src/composer-loadout.ts";
import { mountTemplate } from "./shared.ts";
import { states, type SettingsState } from "./settings.ts";

const rows: [key: string, label: string, inherit?: string][] = [
  ["runtime", "Conversation runtime"],
  ["cron-runtime", "Cron runtime", "Job's scope default"],
  ["subagent-runtime", "Subagent runtime", "Child's scope default"],
  ["fallback-runtime", "Fallback runtime", "Built-in fallback"],
];
const RECALL = "memory-embedding-model";
const keys = [...rows.map(([key]) => key), RECALL];
type Embedding = { id: string; name: string; provider: string };
const pickers = new Map<string, ReturnType<typeof picker>>();
const modelOptions = new WeakMap<object, ModelOption[]>();
let saveSetting: (key: string) => Promise<void> = async () => {};

export function configureRuntimes(actions: { save: (key: string) => Promise<void> }) {
  saveSetting = actions.save;
}

function optionsFor(context: Record<string, any>): ModelOption[] {
  let options = modelOptions.get(context);
  if (!options) {
    const ids = ((context.baseModelOptions ?? []) as { id: string }[]).map((model) => model.id);
    options = runtimeModelOptions(ids, context.modelCatalog ?? {});
    modelOptions.set(context, options);
  }
  return options;
}

const value = (s: SettingsState) => s.draft.modelId;
const current = (s: SettingsState): LoadoutEntry => ({
  value: value(s),
  effort: s.draft.effortLevel as EffortLevel,
  fast: s.draft.fastMode === true,
});

function picker(s: SettingsState, inheritLabel?: string) {
  const state = { openMenu: null as string | null, menuQuery: "", effortLevel: "auto" as EffortLevel };
  const catalog: ModelCatalog = {
    options: () => optionsFor(s.context),
    supportsFast: (modelId) => (s.context.fastModeModelIds ?? []).includes(modelId),
    overridden: () => !s.draft.inherit,
  };
  const actions = loadoutActions(
    catalog.options,
    () => current(s),
    (option, entry) => {
      Object.assign(s.draft, {
        ...(s.key === "runtime" ? {} : { inherit: false }),
        modelId: option.model.id,
        effortLevel: entry.effort,
        fastMode: entry.fast,
      });
      s.changed();
    },
    catalog.supportsFast,
  );
  const control = createModelPicker<void>({
    host: () => document.querySelector<HTMLElement>(`[data-runtime-row="${s.key}"]`),
    redraw: () => s.render(),
    scopeKey: () => null,
    state,
    catalog,
    activeEntry: () => current(s),
    ...actions,
    effectiveFastMode: () => s.draft.fastMode === true,
    changeDefault: async () => {
      state.openMenu = null;
      s.change("inherit", true);
    },
    showDefaultAction: false,
    showInheritAction: !!inheritLabel,
    inheritLabel,
    get emptyLabel() {
      return s.draft.inherit ? inheritLabel : `${s.draft.modelId} (unavailable)`;
    },
  });
  return { control, state };
}

function runtimeRow(key: string, label: string, inheritLabel?: string) {
  const s = states.get(key)!;
  if (!s.available) return nothing;
  const { control, state } = pickers.get(key) ?? pickers.set(key, picker(s, inheritLabel)).get(key)!;
  state.effortLevel = s.draft.effortLevel;
  const choice = s.draft.inherit ? undefined : optionsFor(s.context).find((option) => option.value === value(s));
  return html`<div class="runtime-row" data-runtime-row=${key}>
    <span class="runtime-label">${label}</span>${control.render(undefined, choice, s.saving)}
  </div>`;
}

const source = (model: Embedding) => (model.provider === "qm:gateway" ? "Model gateway" : "OpenAI");

function recallRow() {
  const s = states.get(RECALL)!;
  if (!s.available) return nothing;
  const models: Embedding[] = s.context.memoryEmbeddingOptions || [];
  const selected: string = s.draft.modelId || "";
  const missing = selected && !models.some((model) => model.id === selected);
  return html`<div class="runtime-row" data-runtime-row=${RECALL}>
      <span class="runtime-label" id="recall-runtime-label">Recall runtime</span>
      <div class="menu-control loadout-control">
        <select
          aria-labelledby="recall-runtime-label"
          class="menu-button loadout-button"
          .value=${selected}
          ?disabled=${s.saving}
          @change=${(e: Event) => s.change("modelId", (e.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${!selected}>Off — newest facts (recency)</option>
          ${models.map((model) => html`<option value=${model.id} ?selected=${model.id === selected}>${model.name} · ${source(model)}</option>`)}
          ${missing ? html`<option value=${selected} selected>${selected} (unavailable)</option>` : nothing}
        </select>
        ${icon(ChevronDown, 13)}
      </div>
    </div>
    <p class="hint runtime-hint">
      Recall uses the newest facts when no model is selected, the saved model is unavailable, or an embedding call
      fails.
    </p>`;
}

function card() {
  const shown = keys.map((key) => states.get(key)!).filter((s) => s.available);
  const dirty = shown.filter((s) => s.dirty);
  const labels = Object.fromEntries([...rows, [RECALL, "Recall runtime"]]);
  const failed = shown.filter((s) => s.tone === "err");
  const status = failed.length
    ? { tone: "err", message: failed.map((s) => `${labels[s.key]}: ${s.message}`).join(" · ") }
    : (shown.find((s) => s.saving) ?? shown.find((s) => s.message));
  return html`<section
    class=${classMap({ card: true, "sv-models": true, hidden: !shown.length, dirty: !!dirty.length })}
    id="card-runtimes"
  >
    <div class="body runtime-rows">
      ${rows.map(([key, label, inherit]) => runtimeRow(key, label, inherit))}${recallRow()}
    </div>
    <div class="foot">
      <button
        type="button"
        id="runtimes-save"
        class=${classMap({ primary: true, dirty: !!dirty.length })}
        ?disabled=${!dirty.length || shown.some((s) => s.saving)}
        @click=${() => Promise.all(dirty.map((s) => saveSetting(s.key)))}
      >
        Save</button
      ><span class=${classMap({ status: true, [status?.tone || "idle"]: true })}>${status?.message ?? ""}</span>
    </div>
  </section>`;
}

export function mountRuntimes() {
  const draw = mountTemplate('template[data-settings-card="card-runtimes"]', card);
  for (const key of keys) states.get(key)!.render = draw;
}
