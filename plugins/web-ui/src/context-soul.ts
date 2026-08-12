import { html, nothing, type TemplateResult } from "lit";
import { fetchScopeSoul, updateScopeSoul, type ScopeSoul } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";

export const contextSoulState = {
  scope: null as string | null,
  loading: false,
  saving: false,
  value: "",
  saved: "",
  data: null as ScopeSoul | null,
  notice: "",
  error: false,
};

let loadSeq = 0;
let redraw: () => void = () => {};

export function resetContextSoul(): void {
  loadSeq += 1;
  contextSoulState.scope = null;
  contextSoulState.loading = false;
  contextSoulState.saving = false;
  contextSoulState.value = "";
  contextSoulState.saved = "";
  contextSoulState.data = null;
  contextSoulState.notice = "";
  contextSoulState.error = false;
}

export async function loadContextSoul(scope: string, onChange: () => void): Promise<void> {
  redraw = onChange;
  if (contextSoulState.scope === scope) return;
  resetContextSoul();
  const seq = ++loadSeq;
  contextSoulState.scope = scope;
  contextSoulState.loading = true;
  redraw();
  try {
    const data = await fetchScopeSoul(scope);
    if (seq !== loadSeq) return;
    contextSoulState.data = data;
    contextSoulState.value = data.soul ?? "";
    contextSoulState.saved = contextSoulState.value;
  } catch (error) {
    if (seq !== loadSeq) return;
    contextSoulState.notice = errMessage(error, "Couldn't load project instructions.");
    contextSoulState.error = true;
  } finally {
    if (seq === loadSeq) {
      contextSoulState.loading = false;
      redraw();
    }
  }
}

async function save(): Promise<void> {
  if (!contextSoulState.scope || contextSoulState.saving) return;
  contextSoulState.saving = true;
  contextSoulState.notice = "";
  contextSoulState.error = false;
  redraw();
  try {
    await updateScopeSoul(contextSoulState.scope, contextSoulState.value.trim());
    contextSoulState.value = contextSoulState.value.trim();
    contextSoulState.saved = contextSoulState.value;
    contextSoulState.notice = "Saved. New turns will use these project instructions.";
  } catch (error) {
    contextSoulState.notice = errMessage(error, "Couldn't save project instructions.");
    contextSoulState.error = true;
  } finally {
    contextSoulState.saving = false;
    redraw();
  }
}

export function contextSoulSection(scope: string): TemplateResult | typeof nothing {
  if (contextSoulState.scope !== scope) return nothing;
  return html`
    <section class="context-panel context-soul" aria-labelledby="context-soul-title">
      <div class="context-panel-heading">
        <div>
          <h2 class="context-panel-title" id="context-soul-title">Project instructions</h2>
          <p class="context-panel-copy">Added to every system prompt in this project.</p>
        </div>
      </div>
      ${
        contextSoulState.loading
          ? html`<div class="context-panel-loading">Loading…</div>`
          : html`
              <textarea
                class="context-soul-input"
                rows="7"
                aria-label="Project instructions"
                placeholder="Describe the project's goals, constraints, tone, and working conventions."
                .value=${contextSoulState.value}
                ?disabled=${contextSoulState.saving || !contextSoulState.data}
                @input=${(event: InputEvent) => {
                  contextSoulState.value = (event.currentTarget as HTMLTextAreaElement).value;
                  contextSoulState.notice = "";
                  contextSoulState.error = false;
                  redraw();
                }}
              ></textarea>
              <p class="context-soul-hint">
                Organization and security instructions remain authoritative. Clear this field to inherit them without
                project additions.
              </p>
              <div class="context-soul-actions">
                <button
                  class="btn primary"
                  type="button"
                  ?disabled=${contextSoulState.saving || !contextSoulState.data || contextSoulState.value === contextSoulState.saved}
                  @click=${() => void save()}
                >
                  ${contextSoulState.saving ? "Saving…" : "Save instructions"}
                </button>
                ${
                  contextSoulState.notice
                    ? html`<span
                        class=${`context-soul-status ${contextSoulState.error ? "error" : ""}`}
                        aria-live="polite"
                        >${contextSoulState.notice}</span
                      >`
                    : nothing
                }
              </div>
            `
      }
    </section>
  `;
}
