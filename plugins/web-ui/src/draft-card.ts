import "@mariozechner/mini-lit/dist/CopyButton.js";
import { LitElement, html } from "lit";

/** A ```draft fence: text the person will copy and send elsewhere, shown as a card with a copy button. */
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
        <copy-button .text=${text} title="Copy draft"></copy-button>
      </div>
      <div class="draft-card-body">${text}</div>`;
  }
}

if (!customElements.get("qm-draft")) customElements.define("qm-draft", DraftCard);
