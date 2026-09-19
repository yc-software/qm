import { ifDefined } from "lit/directives/if-defined.js";
import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import type { SettingState } from "./setting-state.ts";

export function saveButton(s: SettingState, label = "Apply", disabled = false) {
  return html`<button
    class=${classMap({ primary: true, dirty: s.dirty })}
    data-save=${s.key}
    ?disabled=${!s.dirty || s.saving || disabled}
  >
    ${label}
  </button>`;
}

export function settingStatus(s: Pick<SettingState, "message" | "tone"> & { key?: string }, id = "st-" + s.key) {
  return html`<span class=${classMap({ status: true, [s.tone]: !!s.tone })} id=${id}>${s.message}</span>`;
}

export function saveFooter(s: SettingState, label = "Apply", disabled = false) {
  return html`<div class="foot">${saveButton(s, label, disabled)}${settingStatus(s)}</div>`;
}

export function choiceGroup(
  options: {
    name: string;
    value: string;
    onChange: (event: Event) => void;
    choiceFor?: string;
    checkboxFor?: string;
  },
  choices: [value: string, title: string, description: string][],
) {
  return html`<div class="choice-stack">
    ${choices.map(
      ([value, title, description]) =>
        html`<label class="posture-choice"
          ><input
            type="radio"
            name=${options.name}
            value=${value}
            data-choice-for=${ifDefined(options.choiceFor)}
            data-checkbox-for=${ifDefined(options.checkboxFor)}
            ?checked=${options.value === value}
            @change=${options.onChange}
          /><span><strong>${title}</strong><small>${description}</small></span></label
        >`,
    )}
  </div>`;
}
