import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Check, ChevronDown, ChevronRight, GripVertical, Plus, Sparkles, Star, X, Zap } from "lucide";
import { icon, modelMark } from "./ui";
import { getRuntimeConfig, saveRuntimeConfig } from "./runtime-config-store";
import {
  EFFORT_LEVELS,
  effortLabel,
  defaultEffortForModel,
  defaultModelValue,
  getModelOptions,
  getHarnessOptions,
  harnessSupportsEffort,
  harnessSupportsFastMode,
  type EffortLevel,
  type ModelOption,
} from "./model-options";
import { modelSupportsFastMode } from "./pi-models";
import {
  LOADOUT_CAP,
  reorderLoadout,
  effortLevelsForHarness,
  compatibleHarnessOptions,
  loadoutModelId,
  modelLoadoutOptions,
  type LoadoutEntry,
} from "./composer-loadout";
import { tip } from "./tooltip";
import { isPhone } from "./viewport";
import { burstEffortConfetti } from "./effort-confetti";

const EFFORT_PEAK_FLOOR = EFFORT_LEVELS.findIndex((option) => option.value === "xhigh");

function effortText(level: EffortLevel | string): TemplateResult | string {
  const label = effortLabel(level as EffortLevel);
  const rank = EFFORT_LEVELS.findIndex((option) => option.value === level);
  return rank >= EFFORT_PEAK_FLOOR ? html`<span class="effort-peak">${label}</span>` : label;
}

interface ModelPickerBindings<T> {
  host(): HTMLElement | null;
  redraw(): void;
  scopeKey(): string | null;
  state: { openMenu: string | null; menuQuery: string; effortLevel: EffortLevel };
  entries(selected: ModelOption): LoadoutEntry[];
  activeEntry(selected: ModelOption): LoadoutEntry;
  saveEntries(entries: LoadoutEntry[]): void;
  apply(entry: LoadoutEntry, target: T): void;
  add(option: ModelOption, target: T): void;
  selectEffort(effort: EffortLevel, target: T): void;
  selectHarness(harness: string, target: T): void;
  toggleFastMode(target: T): void;
  effectiveFastMode(): boolean;
  changeDefault(change: Parameters<typeof saveRuntimeConfig>[1], target: T, keepOpen?: boolean): Promise<unknown>;
  showDefaultAction?: boolean;
}

export function createModelPicker<T>(bindings: ModelPickerBindings<T>) {
  const {
    scopeKey,
    state: composerState,
    entries: seededLoadout,
    activeEntry: activeLoadoutEntry,
    apply: applyLoadout,
    add: addLoadoutEntry,
    selectEffort,
    selectHarness,
    toggleFastMode,
    effectiveFastMode,
    changeDefault: changeScopeRuntime,
  } = bindings;
  const loadoutMenuId = `model-picker-${crypto.randomUUID()}`;
  let loadoutSection: "effort" | "add" | "harness" | null = null;
  let loadoutSectionHovered = false;
  let loadoutCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let draggedModel: string | null = null;
  let disposed = false;

  function removeLoadoutEntry(value: string, selected: ModelOption): void {
    if (value === activeLoadoutEntry(selected).value) return;
    const entries = seededLoadout(selected);
    const index = entries.findIndex((entry) => entry.value === value);
    const next = entries.filter((entry) => entry.value !== value);
    bindings.saveEntries(next);
    bindings.redraw();
    placeLoadout();
    requestAnimationFrame(() => {
      const rows = bindings.host()?.querySelectorAll<HTMLButtonElement>(".loadout-pick");
      rows?.[Math.max(0, Math.min(index, next.length - 1))]?.focus();
    });
  }

  function clearLoadoutDropTargets(): void {
    bindings
      .host()
      ?.querySelectorAll(".loadout-row.drop-target")
      .forEach((row) => {
        row.classList.remove("drop-target", "drop-after");
      });
  }

  function moveLoadout(value: string, targetValue: string, selected: ModelOption): void {
    bindings.saveEntries(reorderLoadout(seededLoadout(selected), value, targetValue));
    bindings.redraw();
    placeLoadout();
  }

  function modelGlyph(option: ModelOption): TemplateResult {
    const provider = option.displayProvider ?? String(option.model.provider);
    const mark =
      option.harnessId === "codex"
        ? modelMark("codex", 16)
        : (modelMark(provider, 16) ?? modelMark(option.harnessId, 16));
    return html`<span class="loadout-icon" data-provider=${provider} aria-hidden="true"
      >${mark ?? icon(Sparkles, 16)}</span
    >`;
  }

  function loadoutRow(
    entry: LoadoutEntry,
    at: number,
    selected: ModelOption,
    agent: T,
  ): TemplateResult | typeof nothing {
    const option = getModelOptions(scopeKey()).find((option) => option.value === entry.value);
    if (!option) return nothing;
    const active = entry.value === activeLoadoutEntry(selected).value;
    const settings = active ? activeLoadoutEntry(selected) : entry;
    const isDefault = entry.value === defaultModelValue(scopeKey());
    const activeRuntimeConfig = getRuntimeConfig(scopeKey());
    const canMakeDefault =
      bindings.showDefaultAction !== false &&
      activeRuntimeConfig !== null &&
      (!isDefault ||
        settings.effort !== (activeRuntimeConfig.effective.effortLevel ?? defaultEffortForModel(option.model)) ||
        settings.fast !== (activeRuntimeConfig.effective.fastMode === true));
    return html` <div
      class="loadout-row ${active ? "active" : ""} ${canMakeDefault || isDefault ? "has-default-action" : ""}"
      @dragover=${(e: DragEvent) => {
        if (!draggedModel || draggedModel === entry.value) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        clearLoadoutDropTargets();
        const row = e.currentTarget as HTMLElement;
        row.classList.add("drop-target");
        row.classList.toggle(
          "drop-after",
          seededLoadout(selected).findIndex((item) => item.value === draggedModel) < at,
        );
      }}
      @dragleave=${(e: DragEvent) => {
        const row = e.currentTarget as HTMLElement;
        if (!(e.relatedTarget instanceof Node) || !row.contains(e.relatedTarget)) {
          row.classList.remove("drop-target", "drop-after");
        }
      }}
      @drop=${(e: DragEvent) => {
        if (!draggedModel) return;
        e.preventDefault();
        e.stopPropagation();
        clearLoadoutDropTargets();
        moveLoadout(draggedModel, entry.value, selected);
        draggedModel = null;
      }}
    >
      <button
        type="button"
        class="loadout-drag"
        draggable="true"
        aria-label=${`Reorder ${option.label}; use Up or Down`}
        @dragstart=${(e: DragEvent) => {
          e.stopPropagation();
          draggedModel = entry.value;
          e.dataTransfer?.setData("text/plain", entry.value);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
          (e.currentTarget as HTMLElement).closest(".loadout-row")?.classList.add("dragging");
        }}
        @dragend=${(e: DragEvent) => {
          draggedModel = null;
          clearLoadoutDropTargets();
          (e.currentTarget as HTMLElement).closest(".loadout-row")?.classList.remove("dragging");
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          e.stopPropagation();
          const next = seededLoadout(selected)[at + (e.key === "ArrowUp" ? -1 : 1)];
          if (next) {
            moveLoadout(entry.value, next.value, selected);
            requestAnimationFrame(() => {
              const handles = bindings.host()?.querySelectorAll<HTMLButtonElement>(".loadout-drag");
              handles?.[at + (e.key === "ArrowUp" ? -1 : 1)]?.focus();
            });
          }
        }}
      >
        ${icon(GripVertical, 13)}
      </button>
      <button
        class="loadout-pick"
        type="button"
        role="menuitemradio"
        aria-checked=${active ? "true" : "false"}
        @click=${(event: MouseEvent) => {
          burstEffortConfetti(event, settings.effort, option.harnessId);
          dismissSelection();
          applyLoadout(entry, agent);
        }}
      >
        ${modelGlyph(option)}
        <span class="loadout-model-copy">
          <span class="loadout-title">
            <span class="loadout-name">${option.label}</span>
            ${isDefault ? html`<span class="loadout-default">my default</span>` : nothing}
          </span>
          <span class="loadout-details">
            <span class="loadout-harness">${option.harnessLabel}</span>
            <span>${effortText(settings.effort)}</span>
            ${settings.fast ? html`<span class="loadout-bolt" aria-label="Fast">${icon(Zap, 10)}</span>` : nothing}
          </span>
        </span>
        <span class="loadout-end">${active ? icon(Check, 15) : nothing}</span>
      </button>
      ${
        canMakeDefault
          ? html`<button
              class="loadout-make-default"
              data-default=${isDefault ? "true" : "false"}
              type="button"
              role="menuitem"
              aria-label=${`Make ${option.label} default`}
              ${tip("Make default")}
              @click=${async (event: MouseEvent) => {
                const row = (event.currentTarget as HTMLElement).closest(".loadout-row");
                await changeScopeRuntime(
                  {
                    harnessId: option.harnessId,
                    modelId: option.model.id,
                    effortLevel: settings.effort,
                    fastMode: settings.fast,
                  },
                  agent,
                  true,
                );
                row?.querySelector<HTMLElement>(".loadout-pick")?.focus();
                placeLoadout();
              }}
            >
              ${icon(Star, 14)}
            </button>`
          : nothing
      }
      ${isDefault && !canMakeDefault ? html`<span class="loadout-default-star" role="img" aria-label="My default" ${tip("My default")}>${icon(Star, 14)}</span>` : nothing}
      ${
        !active
          ? html`<button
              class="loadout-remove"
              type="button"
              aria-label=${`Remove ${option.label} from presets`}
              ${tip("Remove from presets")}
              @click=${() => removeLoadoutEntry(entry.value, selected)}
            >
              ${icon(X, 14)}
            </button>`
          : nothing
      }
    </div>`;
  }

  function cancelLoadoutClose(): void {
    if (loadoutCloseTimer === null) return;
    clearTimeout(loadoutCloseTimer);
    loadoutCloseTimer = null;
  }

  function loadoutSubmenuHasFocus(): boolean {
    return bindings.host()?.querySelector<HTMLElement>(".loadout-submenu")?.matches(":focus-within") === true;
  }

  function queueLoadoutClose(): void {
    if (isPhone() || !loadoutSectionHovered || !loadoutSection || loadoutSubmenuHasFocus()) return;
    const section = loadoutSection;
    cancelLoadoutClose();
    loadoutCloseTimer = setTimeout(() => {
      loadoutCloseTimer = null;
      if (loadoutSection === section && !loadoutSubmenuHasFocus()) closeLoadoutSection(false);
    }, 140);
  }

  function trackLoadoutHover(e: MouseEvent): void {
    if (isPhone() || !loadoutSection) return;
    const target = e.target as HTMLElement;
    if (target.closest(".loadout-submenu") || target.closest(`[data-loadout-section="${loadoutSection}"]`))
      cancelLoadoutClose();
    else queueLoadoutClose();
  }

  function openLoadoutSection(section: "effort" | "add" | "harness", keyboard = false): void {
    cancelLoadoutClose();
    if (loadoutSection === section && !keyboard) return;
    loadoutSection = section;
    bindings.redraw();
    placeLoadout();
    if (keyboard)
      requestAnimationFrame(() => {
        const menu = bindings.host()?.querySelector<HTMLElement>(".loadout-submenu");
        const target =
          menu?.querySelector<HTMLElement>('input, [aria-checked="true"]') ??
          [...(menu?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])].find(
            (button) => button.offsetParent !== null,
          );
        target?.focus();
      });
  }

  function closeLoadoutSection(refocus = true): void {
    cancelLoadoutClose();
    const previous = loadoutSection;
    loadoutSection = null;
    loadoutSectionHovered = false;
    bindings.redraw();
    placeLoadout();
    if (previous && refocus)
      requestAnimationFrame(() =>
        bindings.host()?.querySelector<HTMLElement>(`[data-loadout-section="${previous}"]`)?.focus(),
      );
  }

  function loadoutSubmenu(agent: T, selected: ModelOption): TemplateResult | typeof nothing {
    if (!loadoutSection) return nothing;
    const effort = loadoutSection === "effort";
    const entries = seededLoadout(selected);
    const query = composerState.menuQuery.trim().toLocaleLowerCase();
    const catalog = modelLoadoutOptions(getModelOptions(scopeKey()), entries, selected.harnessId).filter(
      (option) =>
        !entries.some((entry) => loadoutModelId(entry.value) === option.model.id) &&
        (!query || `${option.harnessLabel} ${option.label}`.toLocaleLowerCase().includes(query)),
    );
    return html`<div
      class="loadout-submenu"
      role="menu"
      aria-label=${{ effort: "Effort levels", harness: "Run with", add: "Add models" }[loadoutSection]}
      @mouseenter=${() => cancelLoadoutClose()}
      @mouseleave=${() => queueLoadoutClose()}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "ArrowLeft" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeLoadoutSection();
        } else menuArrowKeys(e);
      }}
    >
      <button class="loadout-back" type="button" @click=${() => closeLoadoutSection()}>
        ${icon(ChevronDown, 13)} Back
      </button>
      ${
        effort
          ? effortLevelsForHarness(selected.harnessId).map(
              (level) =>
                html` <button
                  class="loadout-effort"
                  type="button"
                  role="menuitemradio"
                  aria-checked=${composerState.effortLevel === level.value ? "true" : "false"}
                  @click=${(event: MouseEvent) => {
                    burstEffortConfetti(event, level.value, selected.harnessId);
                    selectEffort(level.value, agent);
                    closeLoadoutSection();
                  }}
                >
                  <span>${effortText(level.value)}</span
                  >${composerState.effortLevel === level.value ? icon(Check, 15) : nothing}
                </button>`,
            )
          : nothing
      }
      ${
        loadoutSection === "harness"
          ? getHarnessOptions(scopeKey()).map((harness) => {
              const compatible = compatibleHarnessOptions(getModelOptions(scopeKey()), selected.model.id).some(
                (option) => option.harnessId === harness.value,
              );
              const reason = compatible ? "" : `${harness.label} cannot run ${selected.label}.`;
              return html`<button
                class="loadout-effort"
                type="button"
                role="menuitemradio"
                aria-checked=${harness.value === selected.harnessId ? "true" : "false"}
                aria-disabled=${compatible ? "false" : "true"}
                aria-description=${reason || nothing}
                ${tip(reason)}
                @click=${() => {
                  if (!compatible) return;
                  bindings.host()?.querySelector<HTMLElement>(".loadout-button")?.focus();
                  closeLoadoutSection();
                  selectHarness(harness.value, agent);
                }}
              >
                <span class="loadout-harness-option"
                  >${modelMark(harness.value, 15) ?? nothing}<span>${harness.label}</span></span
                >
                ${harness.value === selected.harnessId ? icon(Check, 15) : nothing}
              </button>`;
            })
          : nothing
      }
      ${
        loadoutSection === "add"
          ? html` <label class="loadout-search"
                ><span class="sr-only">Search models</span>
                <input
                  type="search"
                  data-focus-key=${`${loadoutMenuId}-search`}
                  placeholder="Search models…"
                  .value=${live(composerState.menuQuery)}
                  @input=${(e: InputEvent) => {
                    const input = e.currentTarget as HTMLInputElement;
                    const selection = [input.selectionStart, input.selectionEnd] as const;
                    composerState.menuQuery = input.value;
                    bindings.redraw();
                    positionLoadout();
                    const next = bindings.host()?.querySelector<HTMLInputElement>(".loadout-search input");
                    next?.focus();
                    if (selection[0] !== null && selection[1] !== null)
                      next?.setSelectionRange(selection[0], selection[1]);
                  }}
                />
              </label>
              ${catalog.map(
                (option) =>
                  html`<button
                    class="menu-option"
                    type="button"
                    role="menuitem"
                    aria-label=${`Add ${option.label} to presets`}
                    @click=${() => {
                      dismissSelection();
                      addLoadoutEntry(option, agent);
                    }}
                  >
                    ${modelGlyph(option)}<span class="menu-option-copy"
                      ><span>${option.label}</span><span class="loadout-meta">${option.harnessLabel}</span></span
                    ><span class="loadout-add-label" aria-hidden="true">Add</span>
                  </button>`,
              )}
              ${catalog.length ? nothing : html`<div class="loadout-empty">No models found</div>`}`
          : nothing
      }
    </div>`;
  }

  function loadoutHarnessControl(selected: ModelOption): TemplateResult {
    const options = getHarnessOptions(scopeKey());
    const value = html`<span class="loadout-harness-option"
      >${modelMark(selected.harnessId, 15) ?? nothing}<span>${selected.harnessLabel}</span></span
    >`;
    if (options.length < 2)
      return html`<div class="loadout-setting loadout-setting-static">
        <span class="loadout-setting-label">Run with</span><span class="loadout-setting-value">${value}</span>
      </div>`;
    return html`<div class="loadout-submenu-anchor">
      <button
        class="loadout-setting ${loadoutSection === "harness" ? "open" : ""}"
        type="button"
        role="menuitem"
        data-loadout-section="harness"
        aria-haspopup="menu"
        aria-expanded=${loadoutSection === "harness" ? "true" : "false"}
        @mouseenter=${() => {
          if (isPhone()) return;
          loadoutSectionHovered = true;
          openLoadoutSection("harness");
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            loadoutSectionHovered = false;
            openLoadoutSection("harness", true);
          }
        }}
        @click=${(e: MouseEvent) => {
          loadoutSectionHovered = e.detail !== 0 && !isPhone();
          openLoadoutSection("harness", e.detail === 0);
        }}
      >
        <span class="loadout-setting-label">Run with</span>
        <span class="loadout-setting-value">${value}<span class="loadout-end">${icon(ChevronRight, 14)}</span></span>
      </button>
    </div>`;
  }

  function render(agent: T, choice: ModelOption | undefined, disabled: boolean): TemplateResult {
    const selected = choice ?? getModelOptions(scopeKey())[0];
    if (!selected) return html`<span class="context-model-status">No models available</span>`;
    const open = composerState.openMenu === "loadout";
    const entries = seededLoadout(selected);
    const modelSupportsFast = modelSupportsFastMode(scopeKey(), selected.model.id);
    const fastAvailable = !!choice && harnessSupportsFastMode(selected.harnessId) && modelSupportsFast;
    const fastUnsupportedReason = modelSupportsFast ? "Not supported by this harness" : "Not supported by this model";
    const fastOn = fastAvailable && effectiveFastMode();
    return html`<div
      class="menu-control loadout-control"
      data-align="left"
      @keydown=${(event: KeyboardEvent) => {
        if (
          disabled ||
          !fastAvailable ||
          event.defaultPrevented ||
          !event.metaKey ||
          !event.shiftKey ||
          event.code !== "KeyE"
        )
          return;
        event.preventDefault();
        toggleFastMode(agent);
      }}
    >
      <button
        class="menu-button loadout-button"
        data-focus-key=${`${loadoutMenuId}-trigger`}
        type="button"
        aria-label=${choice ? `Model: ${choice.label}, ${effortLabel(composerState.effortLevel)} effort${fastOn ? ", Fast" : ""}` : "Choose model"}
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls=${loadoutMenuId}
        ?disabled=${disabled}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            cancelLoadoutClose();
            loadoutSection = null;
            loadoutSectionHovered = false;
            composerState.openMenu = "loadout";
            bindings.redraw();
            placeLoadout();
            requestAnimationFrame(() => bindings.host()?.querySelector<HTMLElement>(".loadout-pick")?.focus());
          }
        }}
        @click=${(e: Event) => {
          e.stopPropagation();
          cancelLoadoutClose();
          loadoutSection = null;
          loadoutSectionHovered = false;
          composerState.menuQuery = "";
          composerState.openMenu = open ? null : "loadout";
          bindings.redraw();
          placeLoadout();
        }}
      >
        <span class="menu-label">${choice?.label ?? "Choose model"}</span>
        ${choice ? html`<span class="menu-suffix">${effortText(composerState.effortLevel)}</span>` : nothing}
        ${fastOn ? html`<span class="loadout-bolt">${icon(Zap, 13)}</span>` : nothing}${icon(ChevronDown, 13)}
      </button>
      ${
        open && !disabled
          ? html`<div
              class="menu-popover loadout-popover"
              popover="manual"
              id=${loadoutMenuId}
              role="menu"
              aria-label="Model settings"
              @click=${(e: Event) => e.stopPropagation()}
              @mouseover=${(e: MouseEvent) => trackLoadoutHover(e)}
              @mouseleave=${() => queueLoadoutClose()}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeMenus();
                  bindings.redraw();
                  requestAnimationFrame(() => bindings.host()?.querySelector<HTMLElement>(".loadout-button")?.focus());
                } else if (!(e.target as HTMLElement).closest(".loadout-submenu")) menuArrowKeys(e);
              }}
            >
              <div class="loadout-panel">
                <div class="loadout-head">Presets</div>
                <div class="loadout-list">${entries.map((entry, at) => loadoutRow(entry, at, selected, agent))}</div>
                <div
                  class="loadout-submenu-anchor"
                  ${tip(entries.length >= LOADOUT_CAP ? "Remove a preset to add another." : "")}
                >
                  <button
                    class="loadout-add ${loadoutSection === "add" ? "open" : ""}"
                    type="button"
                    role="menuitem"
                    data-loadout-section="add"
                    aria-haspopup="menu"
                    aria-expanded=${loadoutSection === "add" ? "true" : "false"}
                    ?disabled=${entries.length >= LOADOUT_CAP}
                    @mouseenter=${() => {
                      if (isPhone() || entries.length >= LOADOUT_CAP) return;
                      loadoutSectionHovered = true;
                      openLoadoutSection("add");
                    }}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "ArrowRight") {
                        e.preventDefault();
                        loadoutSectionHovered = false;
                        openLoadoutSection("add", true);
                      }
                    }}
                    @click=${(e: MouseEvent) => {
                      loadoutSectionHovered = e.detail !== 0 && !isPhone();
                      openLoadoutSection("add", e.detail === 0);
                    }}
                  >
                    ${icon(Plus, 16)}<span>Add models</span><span class="loadout-end">${icon(ChevronRight, 14)}</span>
                  </button>
                </div>
                ${
                  choice
                    ? html`<div class="loadout-divider"></div>
                        ${loadoutHarnessControl(selected)}
                        ${
                          harnessSupportsEffort(selected.harnessId)
                            ? html`<div class="loadout-submenu-anchor">
                                <button
                                  class="loadout-setting ${loadoutSection === "effort" ? "open" : ""}"
                                  type="button"
                                  role="menuitem"
                                  data-loadout-section="effort"
                                  aria-haspopup="menu"
                                  aria-expanded=${loadoutSection === "effort" ? "true" : "false"}
                                  @mouseenter=${() => {
                                    if (isPhone()) return;
                                    loadoutSectionHovered = true;
                                    openLoadoutSection("effort");
                                  }}
                                  @keydown=${(e: KeyboardEvent) => {
                                    if (e.key === "ArrowRight") {
                                      e.preventDefault();
                                      loadoutSectionHovered = false;
                                      openLoadoutSection("effort", true);
                                    }
                                  }}
                                  @click=${(e: MouseEvent) => {
                                    loadoutSectionHovered = e.detail !== 0 && !isPhone();
                                    openLoadoutSection("effort", e.detail === 0);
                                  }}
                                >
                                  <span class="loadout-setting-label">Effort</span
                                  ><span class="loadout-setting-value"
                                    >${effortText(composerState.effortLevel)}<span class="loadout-end"
                                      >${icon(ChevronRight, 14)}</span
                                    ></span
                                  >
                                </button>
                              </div>`
                            : nothing
                        }
                        <button
                          class="loadout-setting"
                          type="button"
                          role="menuitemcheckbox"
                          aria-label="Fast"
                          aria-checked=${fastOn ? "true" : "false"}
                          ?disabled=${!fastAvailable}
                          @click=${() => toggleFastMode(agent)}
                        >
                          <span class="loadout-setting-label">Fast</span>
                          <span class="loadout-setting-value">
                            <span class="loadout-shortcut">${fastAvailable ? "⌘⇧E" : fastUnsupportedReason}</span>
                            <span class="loadout-toggle ${fastOn ? "on" : ""}" aria-hidden="true">
                              <span class="loadout-knob"></span>
                            </span>
                          </span>
                        </button>`
                    : nothing
                }
              </div>
              ${getRuntimeConfig(scopeKey())?.scopeOverride ? html`<div class="loadout-foot"><button class="loadout-foot-btn" type="button" @click=${() => changeScopeRuntime({ inherit: true }, agent)}>Use org default</button></div>` : nothing}
              ${loadoutSubmenu(agent, selected)}
            </div>`
          : nothing
      }
    </div>`;
  }

  function menuArrowKeys(e: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (target.matches("input") && !["ArrowDown", "ArrowUp"].includes(e.key)) return;
    const menu = target.closest<HTMLElement>('[role="menu"]');
    if (!menu) return;
    const buttons = [...menu.querySelectorAll<HTMLElement>("button:not(:disabled)")].filter(
      (button) =>
        button.closest('[role="menu"]') === menu &&
        button.offsetParent !== null &&
        !button.classList.contains("loadout-drag"),
    );
    if (!buttons.length) return;
    e.preventDefault();
    e.stopPropagation();
    const at = buttons.indexOf(target);
    let next = at + (e.key === "ArrowUp" ? -1 : 1);
    if (at < 0 && e.key === "ArrowUp") next = buttons.length - 1;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = buttons.length - 1;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  }

  function positionLoadout(): void {
    if (disposed) return;
    const host = bindings.host();
    const menu = host?.querySelector<HTMLElement>(".loadout-popover");
    const trigger = host?.querySelector<HTMLElement>(".loadout-button");
    if (!menu || !trigger) return;
    if (typeof menu.showPopover === "function" && !menu.matches(":popover-open")) menu.showPopover();
    const viewport = window.visualViewport;
    const top = (viewport?.offsetTop ?? 0) + 12;
    const left = (viewport?.offsetLeft ?? 0) + 12;
    const right = left + (viewport?.width ?? window.innerWidth) - 24;
    const bottom = top + (viewport?.height ?? window.innerHeight) - 24;
    const rect = trigger.getBoundingClientRect();
    const above = rect.top - top - 8;
    const below = bottom - rect.bottom - 8;
    const up = above >= below;
    menu.style.maxHeight = `${Math.max(140, up ? above : below)}px`;
    menu.style.left = `${Math.max(left, Math.min(rect.left, right - menu.offsetWidth))}px`;
    menu.style.top = `${up ? Math.max(top, rect.top - menu.offsetHeight - 8) : rect.bottom + 8}px`;
    menu.style.bottom = "auto";
    const submenu = menu.querySelector<HTMLElement>(".loadout-submenu");
    const anchor = menu.querySelector<HTMLElement>(`[data-loadout-section="${loadoutSection}"]`);
    if (!submenu || !anchor) return;
    const menuRect = menu.getBoundingClientRect();
    const width = Math.min(260, right - left);
    const roomRight = right - menuRect.right - 4;
    const roomLeft = menuRect.left - left - 4;
    const inline = Math.max(roomLeft, roomRight) < width;
    submenu.classList.toggle("inline", inline);
    if (inline) {
      submenu.style.width = "";
      submenu.style.left = "";
      submenu.style.top = "";
      submenu.style.maxHeight = `${Math.max(120, (up ? above : below) - 80)}px`;
      menu.style.top = `${up ? Math.max(top, rect.top - menu.offsetHeight - 8) : rect.bottom + 8}px`;
    } else {
      submenu.style.width = `${width}px`;
      submenu.style.maxHeight = `${bottom - top}px`;
      submenu.style.left = `${roomRight >= width ? menuRect.right + 4 : menuRect.left - width - 4}px`;
      submenu.style.top = `${Math.max(top, Math.min(anchor.getBoundingClientRect().top - 6, bottom - submenu.offsetHeight))}px`;
    }
  }

  function placeLoadout(): void {
    requestAnimationFrame(positionLoadout);
  }

  window.addEventListener("resize", placeLoadout);
  window.visualViewport?.addEventListener("resize", placeLoadout);

  function resetSection(): void {
    cancelLoadoutClose();
    loadoutSection = null;
    loadoutSectionHovered = false;
  }

  function dismissSelection(): void {
    closeMenus();
    requestAnimationFrame(() => bindings.host()?.querySelector<HTMLElement>(".loadout-button")?.focus());
  }

  function closeMenus(): void {
    resetSection();
    composerState.openMenu = null;
  }

  function outsideClick(event: Event): void {
    if (composerState.openMenu !== "loadout") return;
    const target = event.target;
    if (target instanceof Element && bindings.host()?.contains(target) && target.closest(".loadout-control")) return;
    closeMenus();
    bindings.redraw();
  }

  document.addEventListener("click", outsideClick);

  function dispose(): void {
    disposed = true;
    resetSection();
    document.removeEventListener("click", outsideClick);
    window.removeEventListener("resize", placeLoadout);
    window.visualViewport?.removeEventListener("resize", placeLoadout);
  }

  return { render, place: placeLoadout, resetSection, dispose };
}
