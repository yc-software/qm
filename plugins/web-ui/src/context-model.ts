import { html, nothing, type TemplateResult } from "lit";
import type { RuntimeConfig } from "./core-bridge";
import { getRuntimeConfig, loadRuntimeConfig, saveRuntimeConfig, subscribeRuntimeConfig } from "./runtime-config-store";
import {
  defaultEffortForModel,
  harnessSupportsFastMode,
  harnessSupportsEffort,
  runtimeModelOptions,
  type EffortLevel,
  type ModelOption,
} from "./model-options";
import { createModelPicker } from "./model-picker";
import {
  loadLoadout,
  saveLoadout,
  reconcileLoadout,
  upsertLoadout,
  effortLevelsForHarness,
  compatibleHarnessOptions,
  type LoadoutEntry,
} from "./composer-loadout";
import { modelSupportsFastMode } from "./pi-models";
import { errMessage } from "../../chassis/src/errors";

const INHERIT = "";

export const contextModelState = {
  scope: null as string | null,
  loading: false,
  saving: false,
  pending: null as string | null,
  pendingEffort: null as string | null,
  pendingFast: null as boolean | null,
  get config(): RuntimeConfig | null {
    return getRuntimeConfig(contextModelState.scope);
  },
  notice: "",
  noticeKind: "" as "" | "error",
};

let picker: ReturnType<typeof createModelPicker<void>> | undefined;
let pickerState = { openMenu: null as string | null, menuQuery: "", effortLevel: "auto" as EffortLevel };
let loadSeq = 0;
let unsubscribeRuntime: (() => void) | undefined;
let redraw: () => void = () => {};

export function resetContextModel(): void {
  picker?.dispose();
  picker = undefined;
  pickerState = { openMenu: null, menuQuery: "", effortLevel: "auto" };
  loadSeq += 1;
  unsubscribeRuntime?.();
  unsubscribeRuntime = undefined;
  contextModelState.scope = null;
  contextModelState.loading = false;
  contextModelState.saving = false;
  contextModelState.pending = null;
  contextModelState.pendingEffort = null;
  contextModelState.pendingFast = null;
  contextModelState.notice = "";
  contextModelState.noticeKind = "";
}

export async function loadContextModel(scopeId: string, onChange: () => void): Promise<void> {
  redraw = onChange;
  if (contextModelState.scope === scopeId) return;
  resetContextModel();
  const seq = ++loadSeq;
  contextModelState.scope = scopeId;
  contextModelState.loading = true;
  unsubscribeRuntime = subscribeRuntimeConfig(scopeId, () => {
    contextModelState.loading = false;
    redraw();
  });
  const config = await loadRuntimeConfig(scopeId);
  if (seq !== loadSeq) return;
  contextModelState.loading = false;
  if (!config) {
    contextModelState.notice = "Couldn't load this project's model.";
    contextModelState.noticeKind = "error";
  }
  redraw();
}

function optionsFor(config: RuntimeConfig): ModelOption[] {
  return runtimeModelOptions(config.approvedHarnesses, config.modelsByHarness, config.modelCatalog);
}

function optionLabel(option: ModelOption, multiHarness: boolean): string {
  return multiHarness ? `${option.harnessLabel} · ${option.label}` : option.label;
}

function labelForRuntime(config: RuntimeConfig, runtime: { harnessId: string; modelId: string }): string {
  const options = optionsFor(config);
  const multiHarness = new Set(options.map((o) => o.harnessId)).size > 1;
  const match = options.find((o) => o.value === `${runtime.harnessId}:${runtime.modelId}`);
  return match ? optionLabel(match, multiHarness) : runtime.modelId;
}

function selectedValue(config: RuntimeConfig): string {
  return config.scopeOverride ? `${config.scopeOverride.harnessId}:${config.scopeOverride.modelId}` : INHERIT;
}

function effortLevelsFor(harnessId: string): Array<{ value: EffortLevel; label: string }> {
  if (!harnessSupportsEffort(harnessId)) return [];
  return effortLevelsForHarness(harnessId);
}

function selectedEffort(config: RuntimeConfig): string {
  return (
    config.effective.effortLevel ??
    defaultEffortForModel(
      optionsFor(config).find((option) => option.value === `${config.effective.harnessId}:${config.effective.modelId}`)
        ?.model,
    )
  );
}

async function choose(scope: string, value: string, effort?: string, fast = false): Promise<void> {
  if (contextModelState.saving) return;
  const seq = loadSeq;
  const restoreFocus = document.activeElement?.closest(".context-model .loadout-control") !== null;
  contextModelState.saving = true;
  contextModelState.pending = value;
  contextModelState.pendingEffort = effort ?? null;
  contextModelState.pendingFast = fast;
  picker?.resetSection();
  contextModelState.notice = "";
  contextModelState.noticeKind = "";
  redraw();
  try {
    const sep = value.indexOf(":");
    const harnessId = value.slice(0, sep);
    await saveRuntimeConfig(
      scope,
      value === INHERIT
        ? { inherit: true }
        : {
            harnessId,
            modelId: value.slice(sep + 1),
            fastMode: fast && harnessSupportsFastMode(harnessId) && modelSupportsFastMode(scope, value.slice(sep + 1)),
            ...(effort && effortLevelsFor(harnessId).some((o) => o.value === effort) ? { effortLevel: effort } : {}),
          },
    );
    if (seq !== loadSeq) return;
  } catch (e) {
    if (seq !== loadSeq) return;
    contextModelState.notice = errMessage(e, "Couldn't change the model. Try again.");
    contextModelState.noticeKind = "error";
  } finally {
    if (seq === loadSeq) {
      contextModelState.saving = false;
      contextModelState.pending = null;
      contextModelState.pendingEffort = null;
      contextModelState.pendingFast = null;
      redraw();
      if (restoreFocus)
        requestAnimationFrame(() => {
          if (seq === loadSeq && document.activeElement === document.body)
            document.querySelector<HTMLButtonElement>(".context-model .loadout-button")?.focus();
        });
    }
  }
}

function activeEntry(config: RuntimeConfig): LoadoutEntry {
  return {
    value: contextModelState.pending || `${config.effective.harnessId}:${config.effective.modelId}`,
    effort: (contextModelState.pendingEffort ?? selectedEffort(config)) as EffortLevel,
    fast: contextModelState.pendingFast ?? config.effective.fastMode === true,
  };
}

function contextPicker(scopeId: string) {
  const current = () => activeEntry(contextModelState.config!);
  const options = () => optionsFor(contextModelState.config!);
  const apply = (entry: LoadoutEntry) => {
    if (contextModelState.saving) return;
    const option = options().find((option) => option.value === entry.value);
    if (!option) return;
    const normalized = {
      ...entry,
      effort: effortLevelsForHarness(option.harnessId).some((level) => level.value === entry.effort)
        ? entry.effort
        : ("auto" as EffortLevel),
      fast: entry.fast && harnessSupportsFastMode(option.harnessId) && modelSupportsFastMode(scopeId, option.model.id),
    };
    void choose(scopeId, normalized.value, normalized.effort, normalized.fast);
  };
  return createModelPicker<void>({
    host: () => document.querySelector<HTMLElement>(".context-model"),
    redraw,
    scopeKey: () => scopeId,
    state: pickerState,
    entries: () => reconcileLoadout(loadLoadout(), options(), current()),
    activeEntry: current,
    saveEntries: saveLoadout,
    apply,
    add: (option) => {
      const entry = { value: option.value, effort: defaultEffortForModel(option.model), fast: false };
      saveLoadout(upsertLoadout(reconcileLoadout(loadLoadout(), options(), current()), entry));
      pickerState.menuQuery = "";
      apply(entry);
    },
    selectEffort: (effort) => apply({ ...current(), effort }),
    selectHarness: (harnessId) => {
      const selected = options().find((option) => option.value === current().value);
      const target =
        selected &&
        compatibleHarnessOptions(options(), selected.model.id).find((option) => option.harnessId === harnessId);
      if (target) apply({ ...current(), value: target.value });
    },
    toggleFastMode: () => apply({ ...current(), fast: !current().fast }),
    effectiveFastMode: () => current().fast,
    changeDefault: () => choose(scopeId, INHERIT),
    showDefaultAction: false,
  });
}

export function contextModelSection(scopeId: string): TemplateResult | typeof nothing {
  if (contextModelState.scope !== scopeId) return nothing;
  if (contextModelState.loading)
    return html`<section class="context-panel context-model" aria-labelledby="context-model-title">
      <h2 class="context-panel-title" id="context-model-title">Model</h2>
      <div class="context-panel-loading">Loading…</div>
    </section>`;
  const config = contextModelState.config;
  if (!config)
    return html`<section class="context-panel context-model" aria-labelledby="context-model-title">
      <h2 class="context-panel-title" id="context-model-title">Model</h2>
      <span class="context-model-status error" aria-live="polite">${contextModelState.notice}</span>
    </section>`;
  const options = optionsFor(config);
  const active = activeEntry(config);
  const option = options.find((option) => option.value === active.value);
  const stalePin = config.scopeOverride && !options.some((option) => option.value === selectedValue(config));
  pickerState.effortLevel = active.effort;
  picker ??= contextPicker(scopeId);
  picker.place();
  return html`
    <section class="context-panel context-model" aria-labelledby="context-model-title">
      <h2 class="context-panel-title" id="context-model-title">Model</h2>
      ${stalePin ? html`<span class="context-model-status">${labelForRuntime(config, config.scopeOverride!)} (no longer offered)</span>` : nothing}
      ${!option && !stalePin ? html`<span class="context-model-status">${labelForRuntime(config, config.effective)} (no longer offered)</span>` : nothing}
      ${picker.render(undefined, option, contextModelState.saving)}
      ${
        contextModelState.notice
          ? html`<span
              class=${`context-model-status ${contextModelState.noticeKind === "error" ? "error" : ""}`}
              aria-live="polite"
              >${contextModelState.notice}</span
            >`
          : nothing
      }
    </section>
  `;
}
