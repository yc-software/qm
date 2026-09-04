/** Lightweight floating tooltip — our own styled element, never the browser's
 * native `title` bubble. Anchored above the target, clamped to the viewport,
 * appended to <body> so list-row overflow clipping can't hide it. */

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

export function showTooltip(target: Element, text: string): void {
  if (!text) return;
  anchor = target;
  const el = ensureEl();
  el.textContent = text;
  el.classList.add("visible");
  // Measure after content is set.
  const r = target.getBoundingClientRect();
  const tr = el.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
  let top = r.top - tr.height - 7;
  if (top < 6) top = r.bottom + 7; // no room above — flip below
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

export function hideTooltip(target?: Element): void {
  if (target && anchor && target !== anchor) return;
  anchor = null;
  tipEl?.classList.remove("visible");
}
