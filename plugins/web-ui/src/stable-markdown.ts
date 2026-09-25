import "./marked-dedupe.ts";
import "./mermaid-block.ts";
import { MarkdownBlock } from "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "@mariozechner/mini-lit/dist/CodeBlock.js";
import { ReactiveElement, render, type PropertyValues } from "lit";
import morphdom from "morphdom";
import { marked, type Tokens } from "marked";

export class StableMarkdown extends ReactiveElement {
  static properties = {
    content: {},
    isThinking: { type: Boolean },
    isStreaming: { type: Boolean },
    streamingBaseline: {},
  };

  declare content: string;
  declare isThinking: boolean;
  declare isStreaming: boolean;
  declare streamingBaseline: string;
  private baselineText = "";
  private renderedText = "";
  private readonly fades = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  private readonly renderer = new MarkdownBlock();
  private readonly staging = document.createElement("div");

  constructor() {
    super();
    this.content = "";
    this.isThinking = false;
    this.isStreaming = false;
    this.streamingBaseline = "";
    this.renderer.escapeHtml = false;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.classList.add("markdown-content");
    this.style.display = "block";
  }

  disconnectedCallback(): void {
    this.clearFades();
    super.disconnectedCallback();
  }

  private textNodes(root: Node): Text[] {
    const result: Text[] = [];
    const visit = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent?.trim() || node.parentElement?.closest("p, h1, h2, h3, h4, h5, h6, li, td, th"))
          result.push(node as Text);
      } else if (
        node.nodeType !== Node.ELEMENT_NODE ||
        !["code-block", "qm-mermaid", "svg", "style", "script"].includes((node as Element).localName)
      )
        node.childNodes.forEach(visit);
    };
    visit(root);
    return result;
  }

  private finishFade(span: HTMLElement): void {
    if (!this.fades.has(span)) return;
    span.classList.remove("tok-in");
    clearTimeout(this.fades.get(span));
    this.fades.delete(span);
  }

  private clearFades(): void {
    for (const span of this.fades.keys()) this.finishFade(span);
  }

  private prepareFades(target: HTMLElement, animate: boolean): void {
    const nodes = this.textNodes(target);
    const text = nodes.map((node) => node.data).join("");
    if (this.baselineText.length > this.renderedText.length && this.baselineText.startsWith(this.renderedText))
      this.renderedText = this.baselineText;
    const ranges: Array<{ start: number; end: number; active: boolean }> = [];
    let offset = 0;
    if (!animate) this.clearFades();
    if (text.startsWith(this.renderedText)) {
      for (const node of this.textNodes(this)) {
        if (node.parentElement?.classList.contains("stream-chunk"))
          ranges.push({ start: offset, end: offset + node.length, active: this.fades.has(node.parentElement) });
        offset += node.length;
      }
      if (animate && text.length > this.renderedText.length)
        ranges.push({ start: this.renderedText.length, end: text.length, active: true });
    } else this.clearFades();
    offset = 0;
    let rangeIndex = 0;
    for (const node of nodes) {
      const end = offset + node.length;
      const fragments: Node[] = [];
      let consumed = 0;
      while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= offset) rangeIndex++;
      for (let i = rangeIndex; i < ranges.length && ranges[i]!.start < end; i++) {
        const range = ranges[i]!;
        const start = Math.max(offset, range.start) - offset;
        const stop = Math.min(end, range.end) - offset;
        if (stop <= start) continue;
        if (start > consumed) fragments.push(document.createTextNode(node.data.slice(consumed, start)));
        const span = document.createElement("span");
        span.className = range.active ? "stream-chunk tok-in" : "stream-chunk";
        span.textContent = node.data.slice(start, stop);
        fragments.push(span);
        consumed = stop;
      }
      if (fragments.length) {
        if (consumed < node.length) fragments.push(document.createTextNode(node.data.slice(consumed)));
        node.replaceWith(...fragments);
      }
      offset = end;
    }
    this.renderedText = text;
  }

  private streamingContent(content: string): string {
    if (!this.isStreaming || !content.includes("|")) return content;
    const normalized = content.replace(/\r\n?/g, "\n");
    if (/\n[\t >]*\n[\t >]*$/.test(normalized)) return content;
    let last = marked.lexer(normalized.trimEnd()).at(-1);
    while (last?.type === "blockquote" || last?.type === "list")
      last =
        last.type === "blockquote"
          ? (last as Tokens.Blockquote).tokens.at(-1)
          : (last as Tokens.List).items.at(-1)?.tokens.at(-1);
    if (!last || (!["paragraph", "text"].includes(last.type) && !(last.type === "heading" && last.raw.includes("\n"))))
      return content;
    const lines = last.raw.trimEnd().split("\n");
    let start = lines.length - 1;
    if (start > 0 && /^[ |:-]+$/.test(lines[start]!) && lines[start - 1]!.includes("|")) start--;
    const header = marked.Lexer.lexInline(lines[start]!);
    if (!header.some((token) => token.type === "text" && token.raw.includes("|"))) return content;
    const source = normalized.trimEnd().split("\n");
    while (/^\s*(>\s*)+$/.test(source.at(-1) ?? "")) source.pop();
    return source.slice(0, source.length - (lines.length - start)).join("\n");
  }

  protected update(changed: PropertyValues): void {
    const completion = Promise.withResolvers<void>();
    this.dispatchEvent(new window.CustomEvent("qm-content-updating", { bubbles: true, detail: completion.promise }));
    try {
      if (changed.has("streamingBaseline")) {
        const baseline = document.createElement("div");
        this.renderer.content = this.streamingContent(this.streamingBaseline);
        render(this.renderer.render(), baseline);
        this.baselineText = this.textNodes(baseline)
          .map((node) => node.data)
          .join("");
      }
      this.renderer.content = this.streamingContent(this.content);
      this.renderer.isThinking = this.isThinking;
      render(this.renderer.render(), this.staging);
      const target = this.staging.cloneNode(true) as HTMLElement;
      for (const code of target.querySelectorAll("code-block")) {
        if (code.getAttribute("language")?.toLowerCase() !== "mermaid") continue;
        const diagram = document.createElement("qm-mermaid");
        diagram.setAttribute(
          "code",
          new TextDecoder().decode(
            Uint8Array.from(atob(code.getAttribute("code") ?? ""), (character) => character.charCodeAt(0)),
          ),
        );
        if (this.isStreaming) diagram.setAttribute("pending", "");
        code.replaceWith(diagram);
      }
      const animate = this.isStreaming && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      this.prepareFades(target, animate);
      morphdom(this, target, {
        childrenOnly: true,
        onBeforeElUpdated: (current, next) => {
          if (["code-block", "qm-mermaid"].includes(current.localName)) {
            for (const name of ["code", "language", "pending"]) {
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
      for (const span of this.querySelectorAll<HTMLElement>("span.tok-in")) {
        if (this.fades.has(span)) continue;
        span.addEventListener("animationend", () => this.finishFade(span), { once: true });
        this.fades.set(
          span,
          setTimeout(() => this.finishFade(span), 220),
        );
      }
      for (const [span, timer] of this.fades) {
        if (this.contains(span)) continue;
        clearTimeout(timer);
        this.fades.delete(span);
      }
      super.update(changed);
      const updated = (): void => {
        this.dispatchEvent(new window.Event("qm-content-updated", { bubbles: true }));
        completion.resolve();
      };
      const codeUpdates = [...this.querySelectorAll<ReactiveElement>("code-block")].map((code) => code.updateComplete);
      if (codeUpdates.length) {
        void Promise.allSettled(codeUpdates)
          .then(() =>
            Promise.allSettled(
              [...this.querySelectorAll<ReactiveElement>("code-block copy-button")].map(
                (button) => button.updateComplete,
              ),
            ),
          )
          .then(updated, updated);
      } else updated();
    } catch (error) {
      completion.resolve();
      throw error;
    }
  }
}

if (!customElements.get("qm-markdown")) customElements.define("qm-markdown", StableMarkdown);
