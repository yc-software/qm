import { ifDefined } from "lit/directives/if-defined.js";
import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import type { SettingState } from "./setting-state.ts";

export const cardClass = (s: SettingState, kind: string, extra: Record<string, boolean> = {}) =>
  classMap({ card: true, [kind]: true, hidden: !s.available, dirty: s.dirty, ...extra });

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
            .checked=${options.value === value}
            @change=${options.onChange}
          /><span><strong>${title}</strong><small>${description}</small></span></label
        >`,
    )}
  </div>`;
}

type FieldOptions = {
  type?: string;
  placeholder?: string;
  auto?: string;
  cls?: unknown;
  flex?: boolean;
  disabled?: boolean;
};
export function textField(
  label: string,
  hint: string | number,
  id: string,
  value: string,
  set: (value: string) => void,
  o: FieldOptions = {},
) {
  return html`<label
    style=${"display: block; margin-bottom: 8px" + (o.flex ? "; flex: 1" : "")}
    class=${ifDefined(o.cls)}
    >${label}${typeof hint === "string" ? html` <span class="hint">${hint}</span>` : "\n" + " ".repeat(hint)}<input
      type=${o.type || "text"}
      id=${id}
      .value=${value}
      @input=${(e: Event) => set((e.target as HTMLInputElement).value)}
      ?disabled=${!!o.disabled}
      placeholder=${ifDefined(o.placeholder)}
      autocomplete=${ifDefined(o.auto)}
      style="width: 100%"
  /></label>`;
}

export function toggleField(
  label: string,
  indent: number,
  checked: boolean,
  set: (on: boolean) => void,
  o: { id?: string; name?: string; value?: string; cls?: unknown } = {},
) {
  return html`<label
    class=${ifDefined(o.cls)}
    style=${`display: flex; align-items: center; gap: ${o.value ? "8px" : "10px"}; cursor: pointer; margin-bottom: ${o.value ? "6px" : "10px"}`}
    ><input
      type=${o.value ? "radio" : "checkbox"}
      name=${ifDefined(o.name)}
      value=${ifDefined(o.value)}
      id=${ifDefined(o.id)}
      .checked=${checked}
      @change=${(e: Event) => set((e.target as HTMLInputElement).checked)}
      style="width: auto"
    />${"\n" + " ".repeat(indent) + label}</label
  >`;
}
