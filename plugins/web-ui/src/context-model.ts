import { html, nothing, type TemplateResult } from "lit";
import { fetchRuntimeConfig, updateRuntimeConfig, type RuntimeConfig } from "./core-bridge";
import {
  EFFORT_LEVELS,
  effortLabel,
  harnessSupportsEffort,
  runtimeModelOptions,
  type EffortLevel,
  type ModelOption,
} from "./model-options";
import { fieldSelect } from "./ui";
import { errMessage } from "../../chassis/src/errors";

const INHERIT = "";

export const contextModelState = {
  scope: null as string | null,
  loading: false,
  saving: false,
  pending: null as string | null,
  pendingEffort: null as string | null,
  config: null as RuntimeConfig | null,
  notice: "",
  noticeKind: "" as "" | "saved" | "error",
};

let loadSeq = 0;
let redraw: () => void = () => {};

export function resetContextModel(): void {
  loadSeq += 1;
  contextModelState.scope = null;
  contextModelState.loading = false;
  contextModelState.saving = false;
  contextModelState.pending = null;
  contextModelState.pendingEffort = null;
  contextModelState.config = null;
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
  const config = await fetchRuntimeConfig(scopeId);
  if (seq !== loadSeq) return;
  contextModelState.config = config;
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
  return EFFORT_LEVELS.filter(({ value }) => {
    if (value === "ultracode") return harnessId === "pi";
    if (value === "max") return harnessId !== "codex";
    return true;
  });
}

function selectedEffort(config: RuntimeConfig): string {
  return config.scopeOverride?.effortLevel ?? "auto";
}

async function choose(scope: string, value: string, effort?: string): Promise<void> {
  if (contextModelState.saving) return;
  const seq = loadSeq;
  contextModelState.saving = true;
  contextModelState.pending = value;
  contextModelState.pendingEffort = effort ?? null;
  contextModelState.notice = "";
  contextModelState.noticeKind = "";
  redraw();
  try {
    const sep = value.indexOf(":");
    const harnessId = value.slice(0, sep);
    const config = await updateRuntimeConfig(
      scope,
      value === INHERIT
        ? { inherit: true }
        : {
            harnessId,
            modelId: value.slice(sep + 1),
            ...(effort && effortLevelsFor(harnessId).some((o) => o.value === effort) ? { effortLevel: effort } : {}),
          },
    );
    if (seq !== loadSeq) return;
    contextModelState.config = config;
    const effortNote = config.scopeOverride?.effortLevel
      ? ` · ${effortLabel(config.scopeOverride.effortLevel as EffortLevel)} effort`
      : "";
    contextModelState.notice = `Saved — new conversations here run on ${labelForRuntime(config, config.effective)}${effortNote}.`;
    contextModelState.noticeKind = "saved";
  } catch (e) {
    if (seq !== loadSeq) return;
    contextModelState.notice = errMessage(e, "Couldn't change the model — try again.");
    contextModelState.noticeKind = "error";
  } finally {
    if (seq === loadSeq) {
      contextModelState.saving = false;
      contextModelState.pending = null;
      contextModelState.pendingEffort = null;
      redraw();
    }
  }
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
  const multiHarness = new Set(options.map((o) => o.harnessId)).size > 1;
  const selected = contextModelState.pending ?? selectedValue(config);
  const stalePin = selected !== INHERIT && !options.some((o) => o.value === selected);
  const isSlack = scopeId.startsWith("channel:");
  const pinnedHarness = selected === INHERIT ? null : selected.slice(0, selected.indexOf(":"));
  const effort = contextModelState.pendingEffort ?? selectedEffort(config);
  const effortOptions = pinnedHarness ? effortLevelsFor(pinnedHarness) : [];
  const showEffort = pinnedHarness !== null && harnessSupportsEffort(pinnedHarness);
  return html`
    <section class="context-panel context-model" aria-labelledby="context-model-title">
      <div class="context-panel-heading">
        <div>
          <h2 class="context-panel-title" id="context-model-title">Model</h2>
          <p class="context-panel-copy">The model every conversation here starts on.</p>
        </div>
      </div>
      ${fieldSelect({
        id: "context-model-select",
        className: "context-model-select",
        focusKey: "context-model",
        ariaLabel: "Default model for this project",
        disabled: contextModelState.saving,
        value: selected,
        onChange: (value) => {
          const nextHarness = value.slice(0, value.indexOf(":"));
          const carry =
            value !== INHERIT && effortLevelsFor(nextHarness).some((o) => o.value === effort) ? effort : undefined;
          void choose(scopeId, value, carry);
        },
        options: [
          html`<option value=${INHERIT} ?selected=${selected === INHERIT}>
            Org default (${labelForRuntime(config, config.orgDefault)})
          </option>`,
          ...options.map(
            (o) =>
              html`<option value=${o.value} ?selected=${o.value === selected}>${optionLabel(o, multiHarness)}</option>`,
          ),
          ...(stalePin
            ? [
                html`<option value=${selected} selected>
                  ${labelForRuntime(config, config.scopeOverride!)} — no longer offered
                </option>`,
              ]
            : []),
        ],
      })}
      ${
        showEffort
          ? html`<label class="context-model-effort">
              <span class="context-model-effort-label">Default effort</span>
              ${fieldSelect({
                id: "context-effort-select",
                className: "context-effort-select",
                focusKey: "context-effort",
                ariaLabel: "Default effort level for this project",
                disabled: contextModelState.saving,
                value: effort,
                compact: true,
                onChange: (value) => void choose(scopeId, selected, value),
                options: effortOptions.map(
                  (o) => html`<option value=${o.value} ?selected=${o.value === effort}>${o.label}</option>`,
                ),
              })}
            </label>`
          : nothing
      }
      <p class="context-model-hint">
        ${
          selected === INHERIT
            ? "Following the org default — it changes when the org's does."
            : "Pinned for this project. Anyone in a chat can still pick a different model for that conversation."
        }
        ${isSlack ? " The pinned Slack header (when enabled below) names this model." : ""}
      </p>
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
