const DURATION_MS = 220;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";

export function animateDetailsToggle(event: MouseEvent, beforeOpen?: (details: HTMLDetailsElement) => void): void {
  const summary = event.currentTarget as HTMLElement;
  const details = summary.parentElement;
  if (!(details instanceof HTMLDetailsElement) || typeof details.animate !== "function") return;
  if (event.defaultPrevented) return;
  if ((event.target as Element).closest("a, button, input, select, textarea")) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  event.preventDefault();
  if (details.getAnimations().length) return;
  const closing = details.open;
  const from = details.getBoundingClientRect().height;
  details.open = true;
  if (!closing) beforeOpen?.(details);
  const to = closing ? summary.getBoundingClientRect().height : details.getBoundingClientRect().height;
  details.toggleAttribute("data-closing", closing);
  details.style.overflow = "hidden";
  const timing = { duration: DURATION_MS, easing: EASING };
  details.animate({ height: [`${from}px`, `${to}px`] }, timing).onfinish = () => {
    details.removeAttribute("data-closing");
    details.style.overflow = "";
    if (closing) details.open = false;
  };
  if (closing) return;
  for (let body = summary.nextElementSibling; body; body = body.nextElementSibling)
    body.animate({ opacity: [0, 1], transform: ["translateY(-4px)", "none"] }, timing);
}
