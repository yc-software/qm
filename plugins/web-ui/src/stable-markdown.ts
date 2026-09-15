import "./marked-dedupe.ts";
import { MarkdownBlock } from "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "@mariozechner/mini-lit/dist/CodeBlock.js";
import { ReactiveElement, render, type PropertyValues } from "lit";
import morphdom from "morphdom";

export class StableMarkdown extends ReactiveElement {
  static properties = { content: {}, isThinking: { type: Boolean } };

  declare content: string;
  declare isThinking: boolean;
  private readonly renderer = new MarkdownBlock();
  private readonly staging = document.createElement("div");

  constructor() {
    super();
    this.content = "";
    this.isThinking = false;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.classList.add("markdown-content");
    this.style.display = "block";
  }

  protected update(changed: PropertyValues): void {
    this.renderer.content = this.content;
    this.renderer.isThinking = this.isThinking;
    render(this.renderer.render(), this.staging);
    morphdom(this, this.staging.cloneNode(true), {
      childrenOnly: true,
      onBeforeElUpdated: (current, next) => {
        if (current.localName === "code-block") {
          for (const name of ["code", "language"]) {
            const value = next.getAttribute(name);
            if (value !== current.getAttribute(name)) {
              if (value === null) current.removeAttribute(name);
              else current.setAttribute(name, value);
            }
          }
          return false;
        }
        for (let i = 0; i < current.childNodes.length; i++) {
          const from = current.childNodes[i];
          const to = next.childNodes[i];
          if (from?.nodeType !== Node.TEXT_NODE || to?.nodeType !== Node.TEXT_NODE) continue;
          const before = from.nodeValue ?? "";
          const after = to.nodeValue ?? "";
          if (after.length > before.length && after.startsWith(before))
            (from as Text).appendData(after.slice(before.length));
        }
        return !current.isEqualNode(next);
      },
    });
    super.update(changed);
  }
}

if (!customElements.get("qm-markdown")) customElements.define("qm-markdown", StableMarkdown);
