import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { page, draw as redraw } from "./settings.ts";
const state = {
  rows: [] as any[],
  scope: "",
  available: false,
  selected: new Set<string>(),
  feature: "persistent_subagents",
  saving: false,
  message: "",
  choices: [] as any[],
};
function feature() {
  return state.rows.find((row) => row.featureName === state.feature);
}
function choices() {
  const rows = state.choices.filter((row) => !feature()?.personalOnly || row.scopeId.startsWith("personal:"));
  for (const id of state.selected) if (!rows.some((row) => row.scopeId === id)) state.selected.delete(id);
  return rows;
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
  const r = await page.api("GET", "/api/scopes");
  if (state.scope !== scope || !r.ok) return;
  state.choices = (r.data.scopes || []).map((row: any) => ({ scopeId: row.scopeId, label: row.label || row.scopeId }));
  redraw();
}
async function update(scopeId: string, on: boolean, featureName: string) {
  const scope = state.scope;
  state.saving = true;
  state.message = on ? "Enabling…" : "Disabling…";
  redraw();
  let result;
  try {
    result = await page.api("PUT", "/api/scopes/" + encodeURIComponent(scope) + "/feature-flags", {
      featureName,
      scopeId,
      on,
    });
  } catch {
    if (scope === state.scope) state.message = "Could not save. Your selection is preserved; try again.";
    return false;
  }
  if (scope !== state.scope) return false;
  if (!result.ok) {
    state.message = result.data?.message || "Save failed.";
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
    redraw();
  }
}
export function flagsCard() {
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
                  html`<div class="feature-flag-row">
                    <code>${r.featureName + ": " + r.scopeId}</code
                    ><button
                      class="btn danger"
                      ?disabled=${state.saving}
                      @click=${() => remove(r.scopeId, r.featureName)}
                    >
                      Disable
                    </button>
                  </div>`,
              )
            : "No enabled scopes."
        }
      </div>
      <div class="feature-flag-editor">
        <label
          >Feature<select
            id="feature-flag-name"
            ?disabled=${state.saving}
            @change=${(e: Event) => {
              state.feature = (e.target as HTMLSelectElement).value;
              redraw();
            }}
          >
            ${state.rows.map((row) => html`<option value=${row.featureName} .selected=${row.featureName === state.feature}>${row.label}</option>`)}
          </select></label
        >
        <div>
          <div id="feature-flag-scope-label">People and scopes</div>
          <select
            multiple
            size="8"
            id="feature-flag-scopes"
            aria-labelledby="feature-flag-scope-label"
            ?disabled=${state.saving}
            @change=${(e: Event) => {
              state.selected = new Set([...(e.target as HTMLSelectElement).selectedOptions].map((o) => o.value));
              redraw();
            }}
          >
            ${choices().map((row) => html`<option value=${row.scopeId} .selected=${state.selected.has(row.scopeId)}>${row.label}</option>`)}
          </select>
          <span class="hint">${feature()?.hint ?? ""}</span>
        </div>
      </div>
    </div>
    <div class="foot">
      <button
        class="btn primary"
        id="feature-flag-enable"
        ?disabled=${state.saving || !state.selected.size}
        @click=${add}
      >
        + Add flag</button
      ><span class="status" id="st-feature-flags">${state.message}</span>
    </div>
  </section>`;
}
