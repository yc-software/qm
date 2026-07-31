import { html, nothing, type TemplateResult } from "lit";
import { fetchRuntimeConfig, updateRuntimeConfig, type RuntimeConfig } from "./core-bridge";
import { runtimeModelOptions, type ModelOption } from "./model-options";
import { fieldSelect } from "./ui";
import { errMessage } from "../../chassis/src/errors";

const INHERIT = "";

export const contextModelState = {
  scope: null as string | null,
  loading: false,
  saving: false,
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

async function choose(scope: string, value: string): Promise<void> {
  if (contextModelState.saving) return;
  const seq = loadSeq;
  contextModelState.saving = true;
  contextModelState.notice = "";
  contextModelState.noticeKind = "";
  redraw();
  try {
    const sep = value.indexOf(":");
    const config = await updateRuntimeConfig(
      scope,
      value === INHERIT ? { inherit: true } : { harnessId: value.slice(0, sep), modelId: value.slice(sep + 1) },
    );
    if (seq !== loadSeq) return;
    contextModelState.config = config;
    contextModelState.notice = `Saved — new conversations here run on ${labelForRuntime(config, config.effective)}.`;
    contextModelState.noticeKind = "saved";
  } catch (e) {
    if (seq !== loadSeq) return;
    contextModelState.notice = errMessage(e, "Couldn't change the model — try again.");
    contextModelState.noticeKind = "error";
  } finally {
    if (seq === loadSeq) {
      contextModelState.saving = false;
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
  const selected = selectedValue(config);
  const stalePin = selected !== INHERIT && !options.some((o) => o.value === selected);
  const isSlack = scopeId.startsWith("channel:");
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
        onChange: (value) => void choose(scopeId, value),
        options: [
          html`<option value=${INHERIT}>Org default (${labelForRuntime(config, config.orgDefault)})</option>`,
          ...options.map((o) => html`<option value=${o.value}>${optionLabel(o, multiHarness)}</option>`),
          ...(stalePin
            ? [
                html`<option value=${selected}>
                  ${labelForRuntime(config, config.scopeOverride!)} — no longer offered
                </option>`,
              ]
            : []),
        ],
      })}
      <p class="context-model-hint">
        ${
          selected === INHERIT
            ? "Following the org default — it changes when the org's does."
            : "Pinned for this project. Anyone in a chat can still pick a different model for that conversation."
        }
        ${isSlack ? " The channel description in Slack names this model." : ""}
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
