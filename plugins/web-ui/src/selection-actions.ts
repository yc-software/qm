import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ChevronRight, Copy, MessageCircleQuestionMark, Quote, Sparkle } from "lucide";
import { copyText, icon } from "./ui.ts";

export interface SelectionComposer {
  insertText(text: string): void;
}

interface SelectedPassage {
  text: string;
  anchor: Node | null;
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
let dismissed: Pick<SelectedPassage, "text" | "anchor"> | null = null;
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
    dismissed = null;
    hide();
  });
  for (const type of ["pointerup", "pointercancel"] as const) {
    document.addEventListener(type, (e) => {
      pointerDown = false;
      if (!insideToolbar(e.target)) evaluate();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (!shown) return;
    if (e.key === "Escape") dismiss();
    else if (e.key === "Tab") onTab(e, shown.stack);
  });
  document.addEventListener(
    "scroll",
    (e) => {
      if (shown && !insideToolbar(e.target) && !insideToolbar(document.activeElement)) evaluate();
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

function scrollerOf(stack: HTMLElement): HTMLElement | null {
  return stack.closest<HTMLElement>(".chat-scroll");
}

function selectedPassage(): SelectedPassage | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  const stack = stackOf(sel.anchorNode);
  if (!text || !stack || stack !== stackOf(sel.focusNode)) return null;
  const composer = composerFor(stack);
  if (!composer) return null;
  return { text, anchor: sel.anchorNode, rect: sel.getRangeAt(0).getBoundingClientRect(), stack, composer };
}

function offscreen({ rect, stack }: SelectedPassage): boolean {
  const view = scrollerOf(stack)?.getBoundingClientRect();
  const top = Math.max(0, view?.top ?? 0);
  const bottom = Math.min(document.documentElement.clientHeight, view?.bottom ?? Infinity);
  return rect.bottom < top || rect.top > bottom;
}

function evaluate(): void {
  const passage = selectedPassage();
  if (passage && dismissed?.text === passage.text && dismissed.anchor === passage.anchor) return;
  dismissed = null;
  if (!passage || offscreen(passage)) {
    hide();
    return;
  }
  shown = { ...passage, returnFocus: shown?.returnFocus ?? (document.activeElement as HTMLElement | null) };
  draw();
  place();
}

function dismiss(): void {
  if (shown) dismissed = { text: shown.text, anchor: shown.anchor };
  hide();
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
  const scroller = scrollerOf(stack);
  if (previous?.isConnected && previous !== document.body && previous !== scroller) {
    previous.focus({ preventScroll: true });
    return;
  }
  if (!scroller) return;
  scroller.tabIndex = -1;
  scroller.setAttribute("data-quiet-focus", "");
  scroller.addEventListener("blur", () => scroller.removeAttribute("data-quiet-focus"), { once: true });
  scroller.focus({ preventScroll: true });
}

function visibleControls(): HTMLElement[] {
  return [...ensureHost().querySelectorAll<HTMLElement>("input, button:not([disabled])")].filter(
    (el) => getComputedStyle(el).display !== "none",
  );
}

function onTab(e: KeyboardEvent, stack: HTMLElement): void {
  const active = document.activeElement as HTMLElement | null;
  const controls = visibleControls();
  if (insideToolbar(active)) {
    if (active !== (e.shiftKey ? controls[0] : controls.at(-1))) return;
    e.preventDefault();
    hide();
    return;
  }
  if (e.shiftKey || (active !== document.body && active !== scrollerOf(stack))) return;
  e.preventDefault();
  controls[0]?.focus();
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

function handOff(text: string): void {
  if (!shown) return;
  const { composer } = shown;
  dismiss();
  composer.insertText(text);
}

function copySelection(): void {
  if (!shown) return;
  void copyText(shown.text);
  dismiss();
}

function submitAsk(): void {
  const ask = prompt.trim();
  if (!ask || !shown) return;
  handOff(`${quoted(shown.text)}${ask}`);
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
    <button type="button" class="selection-toolbar-btn" data-action="quote" @click=${() => handOff(quoted(s.text))}>
      ${icon(Quote, 13)}Quote
    </button>
    <button
      type="button"
      class="selection-toolbar-btn"
      data-action="explain"
      @click=${() => handOff(`${quoted(s.text)}Explain this.`)}
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
