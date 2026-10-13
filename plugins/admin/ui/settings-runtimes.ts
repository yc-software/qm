import { html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { Check, ChevronDown } from "lucide";
import { createModelPicker } from "../../web-ui/src/model-picker.ts";
import { cacheRuntimeConfig } from "../../web-ui/src/runtime-config-cache.ts";
import { getModelOptions, harnessSupportsFastMode, type EffortLevel } from "../../web-ui/src/model-options.ts";
import { modelSupportsFastMode } from "../../web-ui/src/pi-models.ts";
import { icon } from "../../web-ui/src/icons.ts";
import {
  compatibleHarnessOptions,
  effortLevelsForHarness,
  ultrafastChoice,
  ULTRAFAST_MODEL_ID,
  type LoadoutEntry,
} from "../../web-ui/src/composer-loadout.ts";
import { mountTemplate } from "./shared.ts";
import { saveButton } from "./setting-controls.ts";
import { states, type SettingsState } from "./settings.ts";

const rows: [key: string, label: string, inherit?: string][] = [
  ["runtime", "Conversation runtime"],
  ["cron-runtime", "Cron runtime", "Job's scope default"],
  ["subagent-runtime", "Subagent runtime", "Child's scope default"],
  ["fallback-runtime", "Fallback runtime", "Built-in fallback"],
];
const RECALL = "memory-embedding-model";
type Embedding = { id: string; name: string; provider: string };
const pickers = new Map<string, ReturnType<typeof picker>>();
let recallOpen = false;

const scopeKey = (key: string) => `admin:${key}`;
const value = (s: SettingsState) => `${s.draft.harnessId}:${s.draft.modelId}`;
const current = (s: SettingsState): LoadoutEntry => ({
  value: value(s),
  effort: s.draft.effortLevel as EffortLevel,
  fast: s.draft.fastMode === true,
});

function prime(s: SettingsState) {
  const data = s.context;
  cacheRuntimeConfig(scopeKey(s.key), {
    scopeId: scopeKey(s.key),
    approvedHarnesses: data.harnessOptions ?? [],
    modelsByHarness: Object.fromEntries(
      Object.entries(data.modelsByHarness ?? {}).map(([harness, models]) => [
        harness,
        (models as { id: string }[]).map((model) => model.id),
      ]),
    ),
    modelCatalog: data.modelCatalog ?? {},
    orgDefault: { harnessId: "", modelId: "", revision: 0 },
    scopeOverride: s.draft.inherit ? null : { harnessId: s.draft.harnessId, modelId: s.draft.modelId, orgRevision: 0 },
    effective: { harnessId: "", modelId: "" },
    upgradeAvailable: false,
    fastModeModelIds: data.fastModeModelIds ?? [],
  });
}

function apply(s: SettingsState, entry: LoadoutEntry) {
  const option = getModelOptions(scopeKey(s.key)).find((candidate) => candidate.value === entry.value);
  if (!option) return;
  const levels = effortLevelsForHarness(option.harnessId, option.model);
  Object.assign(s.draft, {
    ...(s.key === "runtime" ? {} : { inherit: false }),
    harnessId: option.harnessId,
    modelId: option.model.id,
    effortLevel: levels.some((level) => level.value === entry.effort) ? entry.effort : levels[0]!.value,
    fastMode:
      entry.fast &&
      harnessSupportsFastMode(option.harnessId) &&
      modelSupportsFastMode(scopeKey(s.key), option.model.id),
  });
  s.changed();
}

function picker(s: SettingsState, inheritLabel?: string) {
  const options = () => getModelOptions(scopeKey(s.key));
  const state = { openMenu: null as string | null, menuQuery: "", effortLevel: "auto" as EffortLevel };
  const control = createModelPicker<void>({
    host: () => document.querySelector<HTMLElement>(`[data-runtime-row="${s.key}"]`),
    redraw: () => s.render(),
    scopeKey: () => scopeKey(s.key),
    state,
    activeEntry: () => current(s),
    apply: (entry) => apply(s, entry),
    selectEffort: (effort) => apply(s, { ...current(s), effort }),
    selectHarness: (harnessId) => {
      const selected = options().find((option) => option.value === value(s));
      const target =
        selected && compatibleHarnessOptions(options(), selected.model.id).find((o) => o.harnessId === harnessId);
      if (target) apply(s, { ...current(s), value: target.value });
    },
    toggleFastMode: () => {
      const selected = options().find((option) => option.value === value(s));
      const target = selected?.model.id === ULTRAFAST_MODEL_ID ? ultrafastChoice(options(), selected) : undefined;
      apply(s, { ...current(s), ...(target ? { value: target.value } : {}), fast: !s.draft.fastMode });
    },
    effectiveFastMode: () => s.draft.fastMode === true,
    changeDefault: async () => {
      state.openMenu = null;
      s.draft.inherit = true;
      s.changed();
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
  prime(s);
  const { control, state } = pickers.get(key) ?? pickers.set(key, picker(s, inheritLabel)).get(key)!;
  state.effortLevel = s.draft.effortLevel;
  const choice = s.draft.inherit
    ? undefined
    : getModelOptions(scopeKey(key)).find((option) => option.value === value(s));
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
  const active = models.find((model) => model.id === selected);
  const choice = (id: string, name: string, detail: string) =>
    html`<div class=${classMap({ "loadout-row": true, active: id === selected })}>
      <button
        class="loadout-pick"
        type="button"
        role="menuitemradio"
        aria-checked=${id === selected ? "true" : "false"}
        @click=${() => {
          recallOpen = false;
          s.change("modelId", id);
        }}
      >
        <span class="loadout-model-copy"
          ><span class="loadout-name">${name}</span><span class="loadout-details">${detail}</span></span
        >${id === selected ? icon(Check, 15) : nothing}
      </button>
    </div>`;
  return html`<div class="runtime-row" data-runtime-row=${RECALL}>
      <span class="runtime-label">Recall runtime</span>
      <div class="menu-control loadout-control">
        <button
          class="menu-button loadout-button"
          type="button"
          aria-haspopup="menu"
          aria-expanded=${recallOpen ? "true" : "false"}
          ?disabled=${s.saving}
          @click=${(e: Event) => {
            e.stopPropagation();
            recallOpen = !recallOpen;
            s.render();
          }}
        >
          <span class="menu-label">${active?.name ?? (selected ? `${selected} (unavailable)` : "Off")}</span
          >${active ? html`<span class="menu-suffix">${source(active)}</span>` : nothing}${icon(ChevronDown, 13)}
        </button>
        ${
          recallOpen
            ? html`<div
                class="menu-popover loadout-popover recall-popover"
                role="menu"
                aria-label="Recall runtime"
                @click=${(e: Event) => e.stopPropagation()}
              >
                <div class="loadout-list">
                  ${choice("", "Off", "Newest facts (recency)")}
                  ${models.map((model) => choice(model.id, model.name, source(model)))}
                </div>
              </div>`
            : nothing
        }
      </div>
    </div>
    <p class="hint runtime-hint">
      Recall uses the newest facts when no model is selected, the saved model is unavailable, or an embedding call
      fails.
    </p>`;
}

function card() {
  const keys = [...rows.map(([key]) => key), RECALL];
  const shown = keys.map((key) => states.get(key)!).filter((s) => s.available);
  const dirty = shown.filter((s) => s.dirty);
  const status = shown.find((s) => s.tone === "err") ?? shown.find((s) => s.saving) ?? shown.find((s) => s.message);
  return html`<section
    class=${classMap({ card: true, "sv-models": true, hidden: !shown.length, dirty: !!dirty.length })}
    id="card-base-model"
  >
    <div class="body runtime-rows">
      ${rows.map(([key, label, inherit]) => runtimeRow(key, label, inherit))}${recallRow()}
    </div>
    <div class="foot">
      <span hidden>${keys.map((key) => saveButton(states.get(key)!))}</span
      ><button
        type="button"
        id="runtimes-save"
        class=${classMap({ primary: true, dirty: !!dirty.length })}
        ?disabled=${!dirty.length || shown.some((s) => s.saving)}
        @click=${(e: Event) => {
          const foot = (e.currentTarget as HTMLElement).parentElement!;
          for (const s of dirty) foot.querySelector<HTMLButtonElement>(`[data-save="${s.key}"]`)!.click();
        }}
      >
        Save</button
      ><span class=${classMap({ status: true, [status?.tone || "idle"]: true })}>${status?.message ?? ""}</span>
    </div>
  </section>`;
}

export function mountRuntimes() {
  const draw = mountTemplate('template[data-settings-card="card-base-model"]', card);
  for (const key of [...rows.map(([key]) => key), RECALL]) states.get(key)!.render = draw;
  document.addEventListener("click", () => {
    if (!recallOpen) return;
    recallOpen = false;
    draw();
  });
}
