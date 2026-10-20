import { emojiCompletion } from "./emoji-completion";
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";

export function composerInput(options: {
  value: string;
  placeholder: string;
  disabled: boolean;
  label?: string;
  maxLength?: number;
  onInput: (event: InputEvent) => void;
  onKeydown: (event: KeyboardEvent) => void;
  onPaste?: (event: ClipboardEvent) => void;
}): TemplateResult {
  return html`<textarea
    class="composer-input"
    ${emojiCompletion(options.value)}
    dir="auto"
    rows="1"
    aria-label=${options.label ?? nothing}
    maxlength=${options.maxLength ?? nothing}
    placeholder=${options.placeholder}
    ?disabled=${options.disabled}
    .value=${live(options.value)}
    @input=${options.onInput}
    @keydown=${options.onKeydown}
    @paste=${options.onPaste ?? nothing}
  ></textarea>`;
}

export function resizeComposerInput(input: HTMLTextAreaElement, minHeight = 48): void {
  const wrap = input.closest<HTMLElement>(".composer-wrap");
  const wrapHeight = wrap?.style.height ?? "";
  if (wrap) wrap.style.height = `${wrap.getBoundingClientRect().height}px`;
  input.style.height = "auto";
  const cap = parseFloat(getComputedStyle(input).maxHeight) || 180;
  const content = input.scrollHeight;
  input.style.height = `${Math.min(cap, Math.max(minHeight, content))}px`;
  if (wrap) wrap.style.height = wrapHeight;
  input.style.overflowY = content > cap ? "auto" : "hidden";
  if (content <= cap) input.scrollTop = 0;
}
