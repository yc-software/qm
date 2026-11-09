import "@mariozechner/mini-lit/dist/CopyButton.js";
import type { CopyButton } from "@mariozechner/mini-lit/dist/CopyButton.js";
import { LitElement, html } from "lit";
import { attachTooltip, hideTooltip } from "./tooltip.ts";

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

  protected async updated(): Promise<void> {
    const copy = this.querySelector<CopyButton>("copy-button");
    await copy?.updateComplete;
    const button = copy?.querySelector("button");
    if (!this.isConnected || !button) return;
    button.setAttribute("aria-label", "Copy draft");
    attachTooltip(button, "Copy draft");
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    const button = this.querySelector("copy-button button");
    if (button) hideTooltip(button);
  }

  render() {
    const text = this.text.replace(/\n+$/, "");
    return html`<div class="draft-card-header">
        <span class="draft-card-label">Draft</span>
        <copy-button .text=${text} title=""></copy-button>
      </div>
      <div class="draft-card-body">${text}</div>`;
  }
}

if (!customElements.get("qm-draft")) customElements.define("qm-draft", DraftCard);
