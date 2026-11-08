import { LitElement, html } from "lit";
import { Check, Copy } from "lucide";
import { icon } from "./icons.ts";
import { tip } from "./tooltip.ts";
import { copyText } from "./ui.ts";

export class DraftCard extends LitElement {
  static properties = { text: {} };

  declare text: string;

  constructor() {
    super();
    this.text = "";
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render() {
    const text = this.text.replace(/\n+$/, "");
    return html`<div class="draft-card-header">
        <span class="draft-card-label">Draft</span>
        <button
          class="msg-copy"
          type="button"
          aria-label="Copy draft"
          ${tip("Copy draft")}
          @click=${(event: Event) => void copyText(text, event.currentTarget as HTMLButtonElement)}
        >
          ${icon(Copy, 13)}${icon(Check, 13)}
        </button>
      </div>
      <div class="draft-card-body">${text}</div>`;
  }
}

if (!customElements.get("qm-draft")) customElements.define("qm-draft", DraftCard);
