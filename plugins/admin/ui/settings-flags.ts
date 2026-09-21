import { mountTemplate } from "./shared.ts";
import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
let config: any;
const state = {
  rows: [] as any[],
  scope: "",
  available: false,
  selected: new Set<string>(),
  feature: "command_scoped_credentials",
  saving: false,
  message: "",
  choices: [] as any[],
  selector: null as Node | null,
};
let redraw = () => {};
export function configureFlags(options: any) {
  config = options;
}
function selector() {
  const choices = state.choices.filter(
    (row) => state.feature !== "persistent_subagents" || row.scopeId.startsWith("personal:"),
  );
  for (const id of state.selected) if (!choices.some((row) => row.scopeId === id)) state.selected.delete(id);
  state.selector = config.buildSelector(choices, state.selected, redraw);
  redraw();
}
export async function loadFlags(data: any, scope: string) {
  if (state.scope !== scope) {
    state.selected.clear();
    state.message = "";
  }
  state.scope = scope;
  state.available = scope.startsWith("org:") && "featureFlags" in data;
  state.rows = data.featureFlags || [];
  redraw();
  if (!state.available) return;
  const choices = await config.loadChoices();
  if (state.scope !== scope) return;
  state.choices = choices || [];
  selector();
}
async function update(scopeId: string, on: boolean, featureName: string) {
  const scope = state.scope;
  state.saving = true;
  state.message = on ? "Enabling…" : "Disabling…";
  redraw();
  let result;
  try {
    result = await config.save(scope, { featureName, scopeId, on });
  } catch {
    if (scope === state.scope) state.message = "Could not save. Your selection is preserved; try again.";
    return false;
  }
  if (scope !== state.scope) return false;
  if (!result.ok) {
    state.message = result.error || result.data?.message || "Save failed.";
    return false;
  }
  let row = state.rows.find((row) => row.featureName === featureName);
  if (!row) {
    row = { featureName, enabledScopes: [] };
    state.rows.push(row);
  }
  row.enabledScopes = on
    ? [...new Set([...row.enabledScopes, scopeId])]
    : row.enabledScopes.filter((id: string) => id !== scopeId);
  state.message = on ? "Enabled." : "Disabled.";
  return true;
}
async function remove(scopeId: string, featureName: string) {
  if (state.saving) return;
  try {
    await update(scopeId, false, featureName);
  } finally {
    state.saving = false;
    redraw();
  }
}
async function add() {
  if (state.saving || !state.selected.size) return;
  const feature = state.feature;
  const selected = [...state.selected];
  try {
    for (const id of selected) {
      if (!(await update(id, true, feature))) break;
      state.selected.delete(id);
    }
  } finally {
    state.saving = false;
    selector();
  }
}
function template() {
  const enabled = state.rows.flatMap((row) =>
    (row.enabledScopes || []).map((scopeId: string) => ({ featureName: row.featureName, scopeId })),
  );
  return html`<section
    class=${classMap({ card: true, "sv-customize": true, hidden: !state.available })}
    id="card-feature-flags"
  >
    <div class="head">
      <h2>Feature flags</h2>
      <p>Enable a feature for selected scopes. Changes apply on the next turn without a restart.</p>
    </div>
    <div class="body">
      <div id="feature-flag-list" class=${enabled.length ? "" : "hint"}>
        ${
          enabled.length
            ? repeat(
                enabled,
                (r) => r.featureName + ":" + r.scopeId,
                (r) =>
                  html`<div class="setting-row">
                    <code>${r.featureName + ": " + r.scopeId}</code
                    ><button class="danger" ?disabled=${state.saving} @click=${() => remove(r.scopeId, r.featureName)}>
                      Disable
                    </button>
                  </div>`,
              )
            : "No enabled scopes."
        }
      </div>
      <div class="editor-grid" style="margin-top: 16px">
        <label
          >Feature<select
            id="feature-flag-name"
            .value=${state.feature}
            ?disabled=${state.saving}
            @change=${(e: Event) => {
              state.feature = (e.target as HTMLSelectElement).value;
              selector();
            }}
          >
            <option value="command_scoped_credentials">Command-scoped credentials</option>
            <option value="persistent_subagents">Persistent subagents</option>
            <option value="inbox_loops">Inbox Loops</option>
          </select></label
        >
        <div>
          <div id="feature-flag-scope-label">People and scopes</div>
          <div id="feature-flag-scopes" aria-labelledby="feature-flag-scope-label" ?inert=${state.saving}>
            ${state.selector || "Loading people and scopes…"}
          </div>
          <span class="hint">Persistent subagents are available for personal scopes only.</span>
        </div>
      </div>
    </div>
    <div class="foot">
      <button class="primary" id="feature-flag-enable" ?disabled=${state.saving || !state.selected.size} @click=${add}>
        + Add flag</button
      ><span class="status" id="st-feature-flags">${state.message}</span>
    </div>
  </section>`;
}
export function mountFlags() {
  redraw = mountTemplate('template[data-settings-card="card-feature-flags"]', template);
}
