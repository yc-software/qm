import { runtimeConfigKey, loadRuntimeConfig, saveRuntimeConfig, subscribeRuntimeConfig } from "./runtime-config-store";
import { getRuntimeConfig, type RuntimeChange } from "./runtime-config-cache.ts";
import type { Agent } from "@earendil-works/pi-agent-core";
import { errMessage } from "../../chassis/src/errors";
import {
  defaultEffortForModel,
  getModelOptions,
  type EffortLevel,
  type ModelOption,
  type ModelOptionValue,
} from "./model-options";
import { modelSupportsFastMode } from "./pi-models";
import {
  LOADOUT_CAP,
  isUltrafastModel,
  presetModelId,
  ultrafastChoice,
  loadLoadout,
  saveLoadout,
  reconcileLoadout,
  upsertLoadout,
  effortLevelsForModel,
  modelLoadoutOptions,
  supportedEffort,
  type LoadoutEntry,
} from "./composer-loadout";
import { forgetThreadPick, hasThreadModelPick, rememberThreadPick } from "./thread-model-picks";
import { createModelPicker } from "./model-picker";
import { runtimeScopeKey, type ComposerState, type Composer } from "./composer";

export function modelOptionFor(value: ModelOptionValue, scopeKey?: string | null): ModelOption | undefined {
  return getModelOptions(scopeKey).find((option) => option.value === value);
}

export function composerStateFor(c: Composer): ComposerState {
  return {
    draft: "",
    attachments: [],
    error: "",
    processingFiles: false,
    dragging: false,
    openMenu: null,
    menuQuery: "",
    slashDismissed: false,
    get effortLevel(): EffortLevel {
      const selected = c.currentModelOption();
      const effort =
        c.effortOverride ??
        (c.restoredLoadout?.value === selected?.value ? c.restoredLoadout?.effort : undefined) ??
        (getRuntimeConfig(c.scopeKey())?.effective.effortLevel as EffortLevel | undefined) ??
        defaultEffortForModel(selected?.model);
      return supportedEffort(selected?.model, effort);
    },
    set effortLevel(value: EffortLevel) {
      ++c.revision.effort;
      c.effortOverride = value;
    },
    get fastMode(): boolean | undefined {
      const selected = c.currentModelOption();
      const fast =
        c.fastModeOverride ??
        (c.restoredLoadout?.value === selected?.value ? c.restoredLoadout?.fast : undefined) ??
        getRuntimeConfig(c.scopeKey())?.effective.fastMode === true;
      return fast && modelSupportsFastMode(c.scopeKey(), selected?.model.id);
    },
    set fastMode(value: boolean | undefined) {
      ++c.revision.fast;
      c.fastModeOverride = value;
    },
    pasteView: null,
  };
}

export async function refreshRuntimeSelection(
  c: Composer,
  scopeId: string | null,
  agent?: Agent,
  refresh = false,
): Promise<void> {
  const request = ++c.runtimeRequest;
  const actualScope = runtimeScopeKey(scopeId);
  const key = runtimeConfigKey(actualScope, c.options.runtimeAccount);
  const identity = `${key}:${c.ctx.chat.state.threadRef}`;
  const changedIdentity = identity !== c.runtimeIdentity;
  if (changedIdentity) {
    c.effortOverride = undefined;
    c.fastModeOverride = undefined;
    c.restoredLoadout = undefined;
    c.loadoutRestored = false;
    c.runtimeIdentity = identity;
  }
  c.unsubscribeRuntime?.();
  let defaults = getRuntimeConfig(key)?.effective;
  c.unsubscribeRuntime =
    key === null
      ? undefined
      : subscribeRuntimeConfig(key, () => {
          if (key !== c.scopeKey()) return;
          const next = getRuntimeConfig(key)?.effective;
          if ((["modelId", "effortLevel", "fastMode"] as const).some((field) => defaults?.[field] !== next?.[field])) {
            c.restoredLoadout = undefined;
            followDefault(c, defaults);
          }
          defaults = next;
          syncRuntimeSelection(c, c.ctx.chat.state.agent ?? undefined);
        });
  c.state.error = "";
  syncRuntimeSelection(c, agent);
  const config = actualScope === null ? null : await loadRuntimeConfig(actualScope, refresh, c.options.runtimeAccount);
  if (request !== c.runtimeRequest) return;
  if (!config) c.state.error = "Could not load runtime settings.";
  if (config && !c.loadoutRestored) {
    restoreLoadoutSelection(c);
    c.loadoutRestored = true;
  }
  syncRuntimeSelection(c, agent);
}

function followDefault(c: Composer, previous: { modelId: string } | undefined): void {
  const threadRef = c.ctx.chat.state.threadRef;
  const pick = c.threadPick();
  const picked = pick ? modelOptionFor(pick, c.scopeKey()) : undefined;
  if (!threadRef || !previous || !picked) return;
  if (picked.model.id !== previous.modelId) return;
  forgetThreadPick(threadRef);
  c.effortOverride = undefined;
  c.fastModeOverride = undefined;
  c.loadoutRestored = false;
}

function restoreLoadoutSelection(c: Composer): void {
  c.loadout = loadLoadout(c.loadoutKey);
  let selected = c.currentModelOption();
  const threadRef = c.ctx.chat.state.threadRef;
  if (selected && threadRef && !hasThreadModelPick(threadRef)) {
    const preferred = modelLoadoutOptions(getModelOptions(c.scopeKey()), c.loadout).find(
      (option) => presetModelId(option.value) === presetModelId(selected!.value),
    );
    if (preferred && preferred.value !== selected.value) {
      rememberThreadPick(threadRef, preferred.value);
      selected = preferred;
    }
  }
  if (!selected) return;
  const saved = c.loadout.find((entry) => entry.value === selected.value);
  if (!saved) return;
  const normalized = normalizeLoadoutEntry(c, saved, selected);
  if (threadRef && hasThreadModelPick(threadRef)) {
    c.effortOverride ??= normalized.effort;
    c.fastModeOverride ??= normalized.fast;
  } else {
    c.restoredLoadout = normalized;
  }
}

function syncRuntimeSelection(c: Composer, agent?: Agent): void {
  const selected = c.currentModelOption();
  if (agent && selected) agent.state.model = selected.model;
  c.ctx.chat.drawActiveChat(agent);
  if (c.pendingComposerFocus) c.focusComposerEnd();
}

export async function changeScopeRuntime(
  c: Composer,
  change: RuntimeChange,
  agent: Agent,
  preserveSelection = false,
): Promise<void> {
  if (c.options.prepareSubmit) {
    if (change.modelId) selectModel(c, change.modelId, agent);
    return;
  }
  const request = ++c.runtimeRequest;
  const scopeId = c.scopeKey();
  if (!scopeId) return;
  c.state.error = "";
  const current = preserveSelection ? c.currentModelOption() : undefined;
  const settings = current ? activeLoadoutEntry(c, current) : undefined;
  const before = { ...c.revision };
  try {
    await saveRuntimeConfig(scopeId, change);
    if (request !== c.runtimeRequest || scopeId !== c.scopeKey()) return;
    if (c.revision.model === before.model) {
      if (current && settings) {
        if (c.revision.effort === before.effort) c.effortOverride = settings.effort;
        if (c.revision.fast === before.fast) c.fastModeOverride = settings.fast;
        if (c.ctx.chat.state.threadRef) rememberThreadPick(c.ctx.chat.state.threadRef, current.value);
        rememberActiveTweaks(c, current);
      } else if (!change.keep && c.revision.effort === before.effort && c.revision.fast === before.fast) {
        c.clearChatSelection();
      }
    }
    syncRuntimeSelection(c, agent);
    c.modelPicker.place();
  } catch (e) {
    if (request !== c.runtimeRequest || scopeId !== c.scopeKey()) return;
    c.state.error = errMessage(e, "Could not update the scope default.");
    c.ctx.chat.drawActiveChat(agent);
  }
}

function activeLoadoutEntry(c: Composer, selected: ModelOption): LoadoutEntry {
  return {
    value: selected.value,
    effort: c.state.effortLevel,
    fast: modelSupportsFastMode(c.scopeKey(), selected.model.id) && c.state.fastMode === true,
  };
}

function normalizeLoadoutEntry(c: Composer, entry: LoadoutEntry, option: ModelOption): LoadoutEntry {
  return {
    value: option.value,
    effort: supportedEffort(option.model, entry.effort, defaultEffortForModel(option.model)),
    fast: entry.fast && modelSupportsFastMode(c.scopeKey(), option.model.id),
  };
}

function seededLoadout(c: Composer, selected: ModelOption): LoadoutEntry[] {
  const latest = loadLoadout(c.loadoutKey);
  if (latest.length) c.loadout = latest;
  const active = activeLoadoutEntry(c, selected);
  if (!c.loadout.length) {
    c.loadout = [active];
    const other = getModelOptions(c.scopeKey()).find(
      (option) => option.model.id !== selected.model.id && option.model.provider !== selected.model.provider,
    );
    if (other) c.loadout.push({ value: other.value, effort: defaultEffortForModel(other.model), fast: false });
  }
  return reconcileLoadout(c.loadout, getModelOptions(c.scopeKey()), active).map((entry) =>
    normalizeLoadoutEntry(c, entry, modelOptionFor(entry.value, c.scopeKey())!),
  );
}

function rememberActiveTweaks(c: Composer, selected: ModelOption): void {
  c.loadout = upsertLoadout(seededLoadout(c, selected), activeLoadoutEntry(c, selected));
  saveLoadout(c.loadout, c.loadoutKey);
}

function applyLoadout(c: Composer, entry: LoadoutEntry, agent: Agent): void {
  const option = modelOptionFor(entry.value, c.scopeKey());
  if (!option) return;
  const previous = c.currentModelOption();
  if (previous) rememberActiveTweaks(c, previous);
  const wasOpen = c.state.openMenu === "loadout";
  selectModel(c, entry.value, agent);
  const normalized = normalizeLoadoutEntry(c, entry, option);
  c.state.effortLevel = normalized.effort;
  c.state.fastMode = normalized.fast;
  c.loadout = upsertLoadout(c.loadout, activeLoadoutEntry(c, option));
  saveLoadout(c.loadout, c.loadoutKey);
  c.modelPicker.resetSection();
  c.state.openMenu = wasOpen ? "loadout" : null;
  c.ctx.chat.drawActiveChat(agent);
  c.modelPicker.place();
}

function addLoadoutEntry(c: Composer, option: ModelOption, agent: Agent): void {
  const current = c.currentModelOption();
  if (!current || seededLoadout(c, current).length >= LOADOUT_CAP) return;
  applyLoadout(c, { value: option.value, effort: defaultEffortForModel(option.model), fast: false }, agent);
  c.state.menuQuery = "";
}

export function selectModel(c: Composer, value: string, agent: Agent): void {
  const option = modelOptionFor(value, c.scopeKey());
  if (!option) return;
  ++c.revision.model;
  const previousDefaultEffort = defaultEffortForModel(c.currentModelOption()?.model);
  if (c.ctx.chat.state.threadRef) rememberThreadPick(c.ctx.chat.state.threadRef, option.value);
  agent.state.model = option.model;
  if (c.state.effortLevel === previousDefaultEffort) {
    c.state.effortLevel = defaultEffortForModel(option.model);
  }
  c.state.openMenu = null;
  c.ctx.chat.drawActiveChat(agent);
}

function selectEffort(c: Composer, level: EffortLevel, agent: Agent): void {
  const selected = c.currentModelOption();
  if (!selected || !effortLevelsForModel(selected.model).some((option) => option.value === level)) return;
  c.state.effortLevel = level;
  rememberActiveTweaks(c, selected);
  c.ctx.chat.drawActiveChat(agent);
  c.modelPicker.place();
}

export function toggleFastMode(c: Composer, agent: Agent): void {
  const selected = c.currentModelOption();
  if (c.approvalPending()) return;
  if (selected && isUltrafastModel(selected.model.id)) {
    const target = ultrafastChoice(getModelOptions(c.scopeKey()), selected);
    if (target) applyLoadout(c, { ...activeLoadoutEntry(c, selected), value: target.value, fast: true }, agent);
    return;
  }
  if (!selected || !modelSupportsFastMode(c.scopeKey(), selected.model.id)) return;
  c.state.fastMode = !c.state.fastMode === true;
  rememberActiveTweaks(c, selected);
  c.ctx.chat.drawActiveChat(agent);
  c.modelPicker.place();
}

export function composerPicker(c: Composer) {
  return createModelPicker<Agent>({
    host: () => c.ctx.chat.state.host,
    redraw: () => c.ctx.chat.drawActiveChat(),
    scopeKey: () => c.scopeKey(),
    state: c.state,
    presets: {
      entries: (selected) => seededLoadout(c, selected),
      save: (entries) => {
        c.loadout = entries;
        saveLoadout(entries, c.loadoutKey);
      },
      add: (option, agent) => addLoadoutEntry(c, option, agent),
    },
    activeEntry: (selected) => activeLoadoutEntry(c, selected),
    apply: (entry, agent) => applyLoadout(c, entry, agent),
    selectEffort: (level, agent) => selectEffort(c, level, agent),
    toggleFastMode: (agent) => toggleFastMode(c, agent),
    effectiveFastMode: () => c.state.fastMode === true,
    changeDefault: (change, agent, keepOpen) => changeScopeRuntime(c, change, agent, keepOpen),
    showDefaultAction: !c.options.prepareSubmit,
    showInheritAction: !c.options.prepareSubmit,
  });
}
