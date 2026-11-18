import { html, nothing, type TemplateResult } from "lit";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";

interface Babysitter {
  enabled: boolean;
  mode?: string;
  rules?: string;
  modes?: string[];
  defaultRules?: string;
}

const MODE_LABELS: Record<string, string> = {
  gated: "Gated",
  every_step: "Every step",
  all_text: "All text",
  turn_end: "Turn end",
};

let saved: Babysitter = { enabled: false };
let draft = { mode: "", rules: "" };
let status = "";

export async function loadBabysitter(redraw: () => void): Promise<void> {
  try {
    saved = await api<Babysitter>("/api/babysitter");
    draft = { mode: saved.mode ?? "", rules: saved.rules ?? "" };
  } catch (error) {
    status = errMessage(error);
  }
  redraw();
}

async function save(redraw: () => void): Promise<void> {
  status = "Saving…";
  redraw();
  try {
    await api("/api/babysitter", { method: "POST", body: JSON.stringify(draft) });
    saved = { ...saved, ...draft };
    status = "Saved. Applies from the next turn.";
  } catch (error) {
    status = errMessage(error);
  }
  redraw();
}

export function babysitterRow(redraw: () => void): TemplateResult | typeof nothing {
  if (!saved.enabled) return nothing;
  const dirty = draft.mode !== saved.mode || draft.rules !== saved.rules;
  return html`
    <div class="settings-row resource-form">
      <div class="settings-row-copy">
        <div class="settings-row-title">Babysitter</div>
        <div class="settings-row-note">
          Checks each turn against these rules and adds a reminder when the agent heads toward breaking one.
        </div>
      </div>
      <div class="settings-choice" role="radiogroup" aria-label="Babysitter mode">
        ${(saved.modes ?? []).map(
          (mode) => html`
            <button
              class="settings-choice-option ${draft.mode === mode ? "selected" : ""}"
              type="button"
              role="radio"
              aria-checked=${draft.mode === mode ? "true" : "false"}
              @click=${() => {
                draft.mode = mode;
                redraw();
              }}
            >
              <span>${MODE_LABELS[mode] ?? mode}</span>
            </button>
          `,
        )}
      </div>
      <textarea
        id="babysitter-rules"
        aria-label="Babysitter rules"
        rows="12"
        .value=${draft.rules}
        @input=${(e: Event) => {
          draft.rules = (e.target as HTMLTextAreaElement).value;
          redraw();
        }}
      ></textarea>
      <button class="btn primary" type="button" ?disabled=${!dirty || !draft.rules.trim()} @click=${() => save(redraw)}>
        Save
      </button>
      <button
        class="btn"
        type="button"
        ?disabled=${draft.rules === saved.defaultRules}
        @click=${() => {
          draft.rules = saved.defaultRules ?? "";
          redraw();
        }}
      >
        Reset to default rules
      </button>
      ${status ? html`<span class="hint" role="status">${status}</span>` : nothing}
    </div>
  `;
}
