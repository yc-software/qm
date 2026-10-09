import { html, nothing, render } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { EMOJI_ROWS, type EmojiRow } from "./emoji-data";
import { filterEmoji, rowForName } from "./emoji-picker";

export function emojiToken(
  value: string,
  caret: number,
): { start: number; end: number; query: string; complete: boolean } | null {
  const complete = value[caret - 1] === ":";
  const end = complete ? caret - 1 : caret;
  let start = end;
  while (start > 0 && "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-".includes(value[start - 1]!))
    start--;
  if (start === end || value[start - 1] !== ":") return null;
  start--;
  if (start > 0 && !" \n\t([{\"'".includes(value[start - 1]!)) return null;
  return { start, end: caret, query: value.slice(start + 1, end), complete };
}

class EmojiCompletion extends AsyncDirective {
  private input!: HTMLTextAreaElement;
  private popup: HTMLDivElement | null = null;
  private token: ReturnType<typeof emojiToken> = null;
  private matches: EmojiRow[] = [];
  private active = 0;
  private id = `emoji-${crypto.randomUUID()}`;

  render(_value: string) {
    return nothing;
  }

  override update(part: ElementPart, [value]: [string]) {
    if (!this.input) {
      this.input = part.element as HTMLTextAreaElement;
      this.listen();
    }
    if (this.token && value !== this.input.value) this.close();
    return nothing;
  }

  private listen() {
    this.input.addEventListener("input", this.onInput, true);
    this.input.addEventListener("keydown", this.onKeydown, true);
    this.input.addEventListener("click", this.close);
    this.input.addEventListener("blur", this.close);
  }

  private close = () => {
    if (this.popup) {
      render(nothing, this.popup);
      this.popup.remove();
      this.popup = null;
    }
    this.token = null;
    this.matches = [];
    this.input.removeAttribute("aria-controls");
    this.input.removeAttribute("aria-activedescendant");
    this.input.removeAttribute("aria-autocomplete");
  };

  private onInput = (event: Event) => {
    this.close();
    if ((event as InputEvent).isComposing || this.input.selectionStart !== this.input.selectionEnd) return;
    this.token = emojiToken(this.input.value, this.input.selectionStart);
    if (!this.token) return;
    if (this.token.complete) {
      const row = rowForName(this.token.query);
      if (row && (event as InputEvent).inputType === "insertText") {
        const value = this.input.value;
        const caret = this.input.selectionStart;
        setTimeout(() => {
          if (this.isConnected && this.input.value === value && this.input.selectionStart === caret) this.insert(row);
        });
      }
      return;
    }
    if (this.token.query.length < 2) return;
    const query = this.token.query;
    this.matches = filterEmoji(EMOJI_ROWS, query).slice(0, 8);
    const exact = rowForName(query);
    if (exact) this.matches = [exact, ...this.matches.filter((row) => row !== exact)].slice(0, 8);
    this.active = 0;
    if (this.matches.length) this.draw();
  };

  private insert(row: EmojiRow) {
    if (!this.current()) return;
    const token = this.token!;
    this.close();
    this.input.setSelectionRange(token.start, token.end);
    if (this.input.ownerDocument.execCommand?.("insertText", false, row.c)) return;
    this.input.setRangeText(row.c, token.start, token.end, "end");
    this.input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: row.c }),
    );
  }

  private current(): boolean {
    const token = this.token;
    if (!token) return false;
    if (
      this.input.selectionStart !== token.end ||
      this.input.selectionEnd !== token.end ||
      this.input.value.slice(token.start, token.end) !== `:${token.query}${token.complete ? ":" : ""}`
    ) {
      this.close();
      return false;
    }
    return true;
  }

  private draw() {
    if (!this.popup) {
      this.popup = document.createElement("div");
      this.popup.className = "slash-popover emoji-completion";
      this.popup.id = this.id;
      this.popup.setAttribute("role", "listbox");
      this.popup.setAttribute("aria-label", "Emoji");
      this.input.insertAdjacentElement("afterend", this.popup);
      this.input.setAttribute("aria-controls", this.id);
      this.input.setAttribute("aria-autocomplete", "list");
    }
    this.input.setAttribute("aria-activedescendant", `${this.id}-${this.active}`);
    render(
      html`${this.matches.map(
        (row, index) =>
          html`<button
            type="button"
            role="option"
            tabindex="-1"
            id=${`${this.id}-${index}`}
            class="slash-option ${index === this.active ? "active" : ""}"
            aria-selected=${index === this.active}
            @mousedown=${(event: MouseEvent) => event.preventDefault()}
            @click=${() => this.insert(row)}
          >
            <span class="slash-icon">${row.c}</span><span>:${row.n}:</span>
          </button>`,
      )}`,
      this.popup,
    );
  }

  private onKeydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || !this.popup || !this.current()) return;
    if (event.ctrlKey || event.metaKey) {
      this.close();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
    } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.insert(this.matches[this.active]!);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.active = (this.active + (event.key === "ArrowDown" ? 1 : this.matches.length - 1)) % this.matches.length;
      this.draw();
    } else if (["ArrowLeft", "ArrowRight", "Home", "End", "Tab"].includes(event.key)) this.close();
  };

  protected override disconnected() {
    this.close();
    this.input.removeEventListener("input", this.onInput, true);
    this.input.removeEventListener("keydown", this.onKeydown, true);
    this.input.removeEventListener("click", this.close);
    this.input.removeEventListener("blur", this.close);
  }

  protected override reconnected() {
    this.listen();
  }
}

export const emojiCompletion = directive(EmojiCompletion);
