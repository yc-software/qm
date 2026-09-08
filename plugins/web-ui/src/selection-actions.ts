import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ChevronRight, Copy, MessageCircleQuestionMark, Quote, Sparkle } from "lucide";
import { copyText, icon } from "./ui.ts";

export interface SelectionComposer {
  insertText(text: string, opts?: { submit?: boolean }): void;
}

interface SelectedPassage {
  text: string;
  rect: DOMRect;
  stack: HTMLElement;
  composer: SelectionComposer;
}

interface ShownSelection extends SelectedPassage {
  returnFocus: HTMLElement | null;
}

const EDGE = 8;

let host: HTMLDivElement | null = null;
let shown: ShownSelection | null = null;
let prompt = "";
let pointerDown = false;
let composerFor: (stack: HTMLElement) => SelectionComposer | null = () => null;

export function registerSelectionActions(resolve: (stack: HTMLElement) => SelectionComposer | null): void {
  composerFor = resolve;
  document.addEventListener("selectionchange", () => {
    if (!pointerDown && !insideToolbar(document.activeElement)) evaluate();
  });
  document.addEventListener("pointerdown", (e) => {
    if (insideToolbar(e.target)) return;
    pointerDown = true;
    hide();
  });
  for (const type of ["pointerup", "pointercancel"] as const) {
    document.addEventListener(type, (e) => {
      pointerDown = false;
      if (!insideToolbar(e.target)) evaluate();
    });
  }
  document.addEventListener("keyup", (e) => {
    if (!insideToolbar(e.target)) evaluate();
  });
  document.addEventListener("keydown", (e) => {
    if (!shown) return;
    if (e.key === "Escape") hide();
    else if (e.key === "Tab" && !e.shiftKey && !insideToolbar(document.activeElement)) {
      e.preventDefault();
      host?.querySelector<HTMLInputElement>(".selection-toolbar-input")?.focus();
    }
  });
  document.addEventListener(
    "scroll",
    (e) => {
      if (!insideToolbar(e.target)) hide();
    },
    { capture: true, passive: true },
  );
}

function insideToolbar(target: EventTarget | null): boolean {
  return Boolean(host && target && host.contains(target as Node));
}

function stackOf(node: Node | null): HTMLElement | null {
  const el = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
  return el?.closest<HTMLElement>(".message-stack") ?? null;
}

function selectedPassage(): SelectedPassage | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  const stack = stackOf(sel.anchorNode);
  if (!text || !stack || stack !== stackOf(sel.focusNode) || stack.closest(".readonly-chat")) return null;
  const composer = composerFor(stack);
  return composer ? { text, rect: sel.getRangeAt(0).getBoundingClientRect(), stack, composer } : null;
}

function evaluate(): void {
  const passage = selectedPassage();
  if (!passage) {
    hide();
    return;
  }
  shown = { ...passage, returnFocus: shown?.returnFocus ?? (document.activeElement as HTMLElement | null) };
  draw();
  place();
}

function hide(): void {
  if (!shown) return;
  const { stack, returnFocus } = shown;
  shown = null;
  prompt = "";
  if (insideToolbar(document.activeElement)) focusTranscript(stack, returnFocus);
  draw();
}

function focusTranscript(stack: HTMLElement, previous: HTMLElement | null): void {
  if (previous?.isConnected && previous !== document.body) {
    previous.focus({ preventScroll: true });
    return;
  }
  const scroller = stack.closest<HTMLElement>(".chat-scroll");
  if (!scroller) return;
  scroller.tabIndex = -1;
  scroller.focus({ preventScroll: true });
}

function ensureHost(): HTMLDivElement {
  if (!host) {
    host = document.createElement("div");
    host.className = "selection-actions-host";
    document.body.appendChild(host);
  }
  return host;
}

function draw(): void {
  render(shown ? toolbarTpl(shown) : nothing, ensureHost());
}

function place(): void {
  const bar = host?.firstElementChild as HTMLElement | null;
  if (!bar || !shown) return;
  const { rect } = shown;
  const { width, height } = bar.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const centered = rect.left + rect.width / 2 - width / 2;
  const left = Math.min(Math.max(EDGE, centered), Math.max(EDGE, viewportWidth - width - EDGE));
  const below = rect.bottom + EDGE;
  const top = below + height > viewportHeight - EDGE ? rect.top - height - EDGE : below;
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(Math.max(EDGE, top))}px`;
}

function quoted(text: string): string {
  return `> ${text.split("\n").join("\n> ")}\n\n`;
}

function handOff(text: string, submit: boolean): void {
  if (!shown) return;
  const { composer } = shown;
  hide();
  composer.insertText(text, { submit });
}

function copySelection(): void {
  if (!shown) return;
  void copyText(shown.text);
  hide();
}

function submitAsk(): void {
  const ask = prompt.trim();
  if (!ask || !shown) return;
  handOff(`${quoted(shown.text)}${ask}`, true);
}

function onPromptInput(e: Event): void {
  prompt = (e.currentTarget as HTMLInputElement).value;
  draw();
}

function onPromptKeydown(e: KeyboardEvent): void {
  if (e.key !== "Enter") return;
  e.preventDefault();
  submitAsk();
}

function toolbarTpl(s: ShownSelection): TemplateResult {
  const ask = prompt.trim();
  return html`<div class="selection-toolbar" role="toolbar" aria-label="Selection actions">
    <input
      class="selection-toolbar-input"
      type="text"
      placeholder="Describe edits"
      aria-label="Describe edits"
      autocomplete="off"
      .value=${live(prompt)}
      @input=${onPromptInput}
      @keydown=${onPromptKeydown}
    />
    <span class="selection-toolbar-divider"></span>
    <button
      type="button"
      class="selection-toolbar-btn"
      data-action="quote"
      @click=${() => handOff(quoted(s.text), false)}
    >
      ${icon(Quote, 13)}Quote
    </button>
    <button
      type="button"
      class="selection-toolbar-btn"
      data-action="explain"
      @click=${() => handOff(`${quoted(s.text)}Explain this.`, true)}
    >
      ${icon(MessageCircleQuestionMark, 13)}Explain
    </button>
    <button type="button" class="selection-toolbar-btn" data-action="ask" ?disabled=${!ask} @click=${submitAsk}>
      ${icon(Sparkle, 13)}Ask
    </button>
    <button type="button" class="selection-toolbar-btn" data-action="copy" @click=${copySelection}>
      ${icon(Copy, 13)}Copy
    </button>
    <button
      type="button"
      class="selection-toolbar-btn selection-toolbar-send"
      aria-label="Ask about the selection"
      ?disabled=${!ask}
      @click=${submitAsk}
    >
      ${icon(ChevronRight, 13)}
    </button>
  </div>`;
}
