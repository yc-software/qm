import { html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { createModelPicker, type ModelCatalog } from "../model-picker.ts";
import { runtimeModelOptions, type EffortLevel, type ModelOption } from "../model-options.ts";
import { fieldSelect } from "../ui.ts";
import { settingsRow, settingsSection } from "../settings-layout.ts";
import { loadoutActions, type LoadoutEntry } from "../composer-loadout.ts";
import { BUDGET, COMPACTION, RECALL, runtimeCardKeys, states, type SettingsState } from "./settings.ts";

const rows: [key: string, label: string, note: string, inherit?: string][] = [
  ["runtime", "Conversations", "The default model and effort for new conversations."],
  ["cron-runtime", "Frequent crons", "Crons that run more than once a day.", "Job's scope default"],
  ["subagent-runtime", "Subagents", "Work the agent hands off to a subagent.", "Child's scope default"],
  ["fallback-runtime", "Fallback", "Takes over when the main model refuses or is unavailable.", "No fallback"],
];
const COMPACTION_LABEL = "Compaction keeps";
const BUDGET_LABEL = "History budget";
type Embedding = { id: string; name: string; provider: string };
const pickers = new Map<string, ReturnType<typeof picker>>();
const modelOptions = new WeakMap<object, ModelOption[]>();

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

function runtimeRow(key: string, label: string, note: string, inheritLabel?: string) {
  const s = states.get(key)!;
  if (!s.available) return nothing;
  const { control, state } = pickers.get(key) ?? pickers.set(key, picker(s, inheritLabel)).get(key)!;
  state.effortLevel = s.draft.effortLevel;
  const choice = s.draft.inherit ? undefined : optionsFor(s.context).find((option) => option.value === value(s));
  return settingsRow(
    label,
    note,
    html`<span class="field-menu settings-control" data-runtime-row=${key}
      >${control.render(undefined, choice, s.saving)}</span
    >`,
  );
}
const source = (model: Embedding) => (model.provider === "qm:gateway" ? "Model gateway" : "OpenAI");

function recallRow() {
  const s = states.get(RECALL)!;
  if (!s.available) return nothing;
  const models: Embedding[] = s.context.memoryEmbeddingOptions || [];
  const selected: string = s.draft.modelId || "";
  const missing = selected && !models.some((model) => model.id === selected);
  return settingsRow(
    "Recall",
    "Ranks remembered facts by relevance. Off, or if the model fails, the newest facts are used.",
    html`<span class="settings-control" data-runtime-row=${RECALL}
      >${fieldSelect({
        ariaLabel: "Recall model",
        value: selected,
        disabled: s.saving,
        onChange: (value) => s.change("modelId", value),
        options: html`<option value="" ?selected=${!selected}>Off</option>
          ${models.map((model) => html`<option value=${model.id} ?selected=${model.id === selected}>${model.name} · ${source(model)}</option>`)}
          ${missing ? html`<option value=${selected} selected>${selected} (unavailable)</option>` : nothing}`,
      })}</span
    >`,
  );
}
function numberRow(
  key: string,
  label: string,
  field: string,
  unit: string,
  step: number,
  note: (fallback: string) => string,
) {
  const s = states.get(key)!;
  if (!s.available) return nothing;
  const fallback = String(s.context[`${field}Default`] ?? "");
  return settingsRow(
    label,
    note(Number(fallback).toLocaleString()),
    html`<span class="settings-control settings-number" data-runtime-row=${key}
      ><input
        type="number"
        step=${step}
        placeholder=${fallback}
        aria-label=${`${label} (${unit})`}
        .value=${s.draft.value}
        ?disabled=${s.saving}
        @input=${(e: Event) => s.change("value", (e.target as HTMLInputElement).value.trim())}
      /><span>${unit === "percent" ? "%" : unit}</span></span
    >`,
  );
}
const compactionRow = () =>
  numberRow(
    COMPACTION,
    COMPACTION_LABEL,
    "compactionKeepPercent",
    "percent",
    1,
    (fallback) =>
      `Share of the history budget kept word for word when a conversation compacts. Lower compacts less often and costs less. Default ${fallback}%.`,
  );
const budgetRow = () =>
  numberRow(
    BUDGET,
    BUDGET_LABEL,
    "historyBudgetTokens",
    "tokens",
    1000,
    (fallback) =>
      `Most history any model sees, never more than half its context window. Lower is cheaper but remembers less word for word. Default ${fallback}.`,
  );

export function runtimesCard() {
  const shown = runtimeCardKeys.map((key) => states.get(key)!).filter((s) => s.available);
  const dirty = shown.filter((s) => s.dirty);
  const labels = Object.fromEntries([
    ...rows.map(([key, label]) => [key, label]),
    [RECALL, "Recall"],
    [COMPACTION, COMPACTION_LABEL],
    [BUDGET, BUDGET_LABEL],
  ]);
  const failed = shown.filter((s) => s.tone === "err");
  const status = failed.length
    ? { tone: "err", message: failed.map((s) => `${labels[s.key]}: ${s.message}`).join(" · ") }
    : (shown.find((s) => s.saving) ?? shown.find((s) => s.message));
  const context = [states.get(COMPACTION)!, states.get(BUDGET)!].some((s) => s.available);
  return html`<div class="settings-stack" id="card-runtimes" ?hidden=${!shown.length}>
    ${settingsSection("Runtimes", html`${rows.map(([key, label, note, inherit]) => runtimeRow(key, label, note, inherit))}${recallRow()}`)}
    ${settingsSection("Context", html`${compactionRow()}${budgetRow()}`, { hidden: !context })}
    <div class="settings-save">
      <span class=${classMap({ status: true, [status?.tone || "idle"]: true })}>${status?.message ?? ""}</span
      ><button
        type="button"
        id="runtimes-save"
        class=${classMap({ btn: true, primary: true, dirty: !!dirty.length })}
        ?disabled=${!dirty.length || shown.some((s) => s.saving)}
        @click=${() => Promise.all(dirty.map((s) => s.save()))}
      >
        Save
      </button>
    </div>
  </div>`;
}
