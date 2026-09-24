import { noChange } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";

export function annotationText(quote: string, comment: string): string {
  return `${quote
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n${comment.trim()}`;
}

interface AnnotationOptions {
  key: unknown;
  selector: string;
  add: (text: string, root: HTMLElement) => void;
}

class AnnotationDirective extends AsyncDirective {
  private root?: HTMLElement;
  private options?: AnnotationOptions;
  private popup?: HTMLDivElement;
  private editing = false;
  private cleanup?: () => void;

  render(_options: AnnotationOptions) {
    return noChange;
  }

  override update(part: ElementPart, [options]: [AnnotationOptions]) {
    if (this.options?.key !== options.key) this.close();
    this.options = options;
    this.root = part.element as HTMLElement;
    if (!this.cleanup) this.install();
    return noChange;
  }

  private close = () => {
    this.popup?.remove();
    this.popup = undefined;
    this.editing = false;
  };

  private install() {
    const root = this.root!;
    root.dataset.annotationRoot = "";
    const show = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        !["Shift", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      )
        return;
      if (this.popup?.contains(event.target as Node)) return;
      if (this.editing || !root.isConnected || !this.options) return;
      this.close();
      const selection = window.getSelection();
      let quote: string;
      let anchor: DOMRect;
      const target = event.target;
      if (target instanceof HTMLTextAreaElement && target.matches(this.options.selector)) {
        if (target.closest("[data-annotation-root]") !== root) return;
        quote = target.value.slice(target.selectionStart, target.selectionEnd).trim();
        anchor = target.getBoundingClientRect();
      } else {
        if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
        const range = selection.getRangeAt(0);
        const content = (node: Node) =>
          (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest(this.options!.selector);
        const start = content(range.startContainer);
        const end = content(range.endContainer);
        if (!start || start !== end || start.closest("[data-annotation-root]") !== root) return;
        if (start.closest("input, textarea, [contenteditable=true]")) return;
        quote = selection.toString().trim();
        anchor = range.getBoundingClientRect();
      }
      if (!quote) return;
      const popup = document.createElement("div");
      popup.className = "annotation-popover";
      popup.setAttribute("role", "group");
      popup.setAttribute("aria-label", "Selected text actions");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      button.textContent = "Add comment";
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        this.editing = true;
        popup.classList.add("editing");
        popup.setAttribute("role", "dialog");
        popup.setAttribute("aria-label", "Comment on selected text");
        const excerpt = document.createElement("blockquote");
        excerpt.textContent = quote;
        const input = document.createElement("textarea");
        input.placeholder = "Add a comment…";
        input.setAttribute("aria-label", "Comment");
        input.rows = 3;
        const actions = document.createElement("div");
        actions.className = "annotation-actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", this.close);
        const add = document.createElement("button");
        add.type = "button";
        add.className = "btn primary";
        add.textContent = "Add to chat";
        add.disabled = true;
        input.addEventListener("input", () => {
          add.disabled = !input.value.trim();
        });
        const submit = () => {
          if (!input.value.trim() || !root.isConnected) return;
          const text = annotationText(quote, input.value);
          this.close();
          selection?.removeAllRanges();
          this.options?.add(text, root);
        };
        add.addEventListener("click", submit);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        });
        actions.append(cancel, add);
        popup.replaceChildren(excerpt, input, actions);
        position();
        input.focus();
      });
      popup.append(button);
      root.append(popup);
      this.popup = popup;
      const position = () => {
        const bounds = popup.getBoundingClientRect();
        popup.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
        popup.style.top = `${Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - bounds.height - 8))}px`;
      };
      position();
    };
    const outside = (event: PointerEvent) => {
      if (!this.editing && !this.popup?.contains(event.target as Node)) this.close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.popup) {
        event.stopPropagation();
        this.close();
      }
    };
    const scroll = () => {
      if (!this.editing) this.close();
    };
    root.addEventListener("pointerup", show);
    root.addEventListener("keyup", show);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", this.close);
    this.cleanup = () => {
      root.removeEventListener("pointerup", show);
      root.removeEventListener("keyup", show);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", this.close);
      delete root.dataset.annotationRoot;
      this.close();
    };
  }

  protected override disconnected() {
    this.cleanup?.();
    this.cleanup = undefined;
  }

  protected override reconnected() {
    this.install();
  }
}

export const annotate = directive(AnnotationDirective);
