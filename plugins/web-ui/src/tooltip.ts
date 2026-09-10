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
  hideTooltip();
  if (!text || hoverless()) return;
  anchor = target;
  target.setAttribute("data-qm-tooltip-anchor", "");
  const el = ensureEl();
  el.textContent = text;
  el.classList.toggle("beside", !!target.closest('[data-tip-placement="right"]'));
  el.classList.add("visible");
}

export function hideTooltip(target?: Element): void {
  if (target && anchor && target !== anchor) return;
  tipEl?.classList.remove("visible");
  anchor?.removeAttribute("data-qm-tooltip-anchor");
  anchor = null;
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
