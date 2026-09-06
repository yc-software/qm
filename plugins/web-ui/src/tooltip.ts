import { nothing } from "lit";
import { AsyncDirective, directive, type ElementPart, type PartInfo, PartType } from "lit/async-directive.js";

let tipEl: HTMLDivElement | null = null;
let anchor: Element | null = null;

function ensureEl(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "qm-tooltip";
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function hoverless(): boolean {
  return typeof window?.matchMedia === "function" && window.matchMedia("(hover: none)").matches;
}

function showTooltip(target: Element, text: string): void {
  if (!text || hoverless()) return;
  anchor = target;
  const el = ensureEl();
  el.textContent = text;
  el.classList.add("visible");
  // Measure after content is set.
  const r = target.getBoundingClientRect();
  const tr = el.getBoundingClientRect();
  const clamp = (value: number, extent: number) => Math.max(6, Math.min(value, extent - 6));
  const beside = target.closest('[data-tip-placement="right"]') && r.right + 7 + tr.width <= window.innerWidth - 6;
  if (beside) {
    el.style.left = `${Math.round(r.right + 7)}px`;
    el.style.top = `${Math.round(clamp(r.top + r.height / 2 - tr.height / 2, window.innerHeight - tr.height))}px`;
    return;
  }
  let top = r.top - tr.height - 7;
  if (top < 6) top = r.bottom + 7; // no room above — flip below
  el.style.left = `${Math.round(clamp(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width))}px`;
  el.style.top = `${Math.round(top)}px`;
}

export function hideTooltip(target?: Element): void {
  if (target && anchor && target !== anchor) return;
  anchor = null;
  tipEl?.classList.remove("visible");
}

const attached = new WeakMap<Element, TooltipBinding>();

interface TooltipBinding {
  text: string;
  enter: () => void;
  leave: () => void;
}

export function attachTooltip(el: Element, text: string): void {
  const existing = attached.get(el);
  if (existing) {
    existing.text = text;
    if (anchor === el) showTooltip(el, text);
    return;
  }
  const binding: TooltipBinding = {
    text,
    enter: () => showTooltip(el, binding.text),
    leave: () => hideTooltip(el),
  };
  attached.set(el, binding);
  el.addEventListener("mouseenter", binding.enter);
  el.addEventListener("focus", binding.enter);
  el.addEventListener("mouseleave", binding.leave);
  el.addEventListener("blur", binding.leave);
  el.addEventListener("click", binding.leave);
}

function detachTooltip(el: Element): void {
  const binding = attached.get(el);
  if (!binding) return;
  attached.delete(el);
  el.removeEventListener("mouseenter", binding.enter);
  el.removeEventListener("focus", binding.enter);
  el.removeEventListener("mouseleave", binding.leave);
  el.removeEventListener("blur", binding.leave);
  el.removeEventListener("click", binding.leave);
  hideTooltip(el);
}

class TipDirective extends AsyncDirective {
  private el: Element | null = null;
  private text = "";

  constructor(partInfo: PartInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.ELEMENT) throw new Error("tip() belongs on an element, not an attribute");
  }

  render(_text: string): typeof nothing {
    return nothing;
  }

  override update(part: ElementPart, [text]: [string]): typeof nothing {
    this.text = text ?? "";
    this.el = part.element;
    attachTooltip(this.el, this.text);
    return nothing;
  }

  protected override disconnected(): void {
    if (this.el) detachTooltip(this.el);
  }

  protected override reconnected(): void {
    if (this.el) attachTooltip(this.el, this.text);
  }
}

export const tip = directive(TipDirective);
