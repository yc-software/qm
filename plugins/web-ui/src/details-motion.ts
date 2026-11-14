const DURATION_MS = 220;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";
const running = new WeakMap<HTMLDetailsElement, Animation>();

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function animateDetailsToggle(event: MouseEvent): void {
  const summary = event.currentTarget as HTMLElement | null;
  const details = summary?.parentElement;
  if (!(details instanceof HTMLDetailsElement) || typeof details.animate !== "function" || reducedMotion()) return;
  event.preventDefault();
  const previous = running.get(details);
  const from = details.getBoundingClientRect().height;
  previous?.cancel();
  const closing = previous ? details.dataset.motion === "opening" : details.open;
  if (!closing) details.open = true;
  const to = closing ? summary!.getBoundingClientRect().height : details.getBoundingClientRect().height;
  details.dataset.motion = closing ? "closing" : "opening";
  details.style.overflow = "hidden";
  const animation = details.animate({ height: [`${from}px`, `${to}px`] }, { duration: DURATION_MS, easing: EASING });
  running.set(details, animation);
  const body = summary!.nextElementSibling;
  if (!closing && body instanceof HTMLElement)
    body.animate(
      { opacity: [0, 1], transform: ["translateY(-4px)", "none"] },
      { duration: DURATION_MS, easing: EASING },
    );
  animation.onfinish = () => {
    running.delete(details);
    delete details.dataset.motion;
    details.style.overflow = "";
    if (closing) details.open = false;
  };
  animation.oncancel = () => {
    if (running.get(details) === animation) running.delete(details);
  };
}
