const EASING = "cubic-bezier(0.5, 1, 0.89, 1)";
let running: ViewTransition | null = null;

const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const span = (from: number, to: number) => Math.round(180 + 6 * Math.sqrt(Math.abs(to - from)));

export function inRail(element: Element): boolean {
  const host = element.closest(".side-chat-markers");
  return host !== null && getComputedStyle(host).containerName === "side-notes";
}

export function glide(element: HTMLElement, from: number): void {
  const to = element.getBoundingClientRect().height;
  if (Math.abs(to - from) < 1 || typeof element.animate !== "function" || still()) return;
  element.animate({ height: [`${from}px`, `${to}px`] }, { duration: span(from, to), easing: EASING });
}

function settle(card: HTMLElement, from: number) {
  const to = card.getBoundingClientRect().height;
  const rail = inRail(card);
  const track = !rail || to > from;
  const hold = track && to < from ? Math.round(span(from, to) * 0.6) : 0;
  if (track) glide(card, from);
  for (const part of card.children)
    part.animate?.(
      { opacity: [0, 1], translate: ["0 4px", "0 0"] },
      { duration: 130, delay: to > from ? 0 : hold + 40, easing: "ease-out", fill: "backwards" },
    );
  return { to, rail, track, hold };
}

export async function morph(card: HTMLElement | null, update: () => void): Promise<void> {
  if (!card?.isConnected || still()) return update();
  const from = card.getBoundingClientRect().height;
  if (typeof document.startViewTransition !== "function" || running) {
    update();
    await new Promise(requestAnimationFrame);
    if (card.isConnected) settle(card, from);
    return;
  }
  const root = document.documentElement;
  const view = card.closest(".chat-scroll")?.getBoundingClientRect();
  if (view)
    root.style.setProperty(
      "--side-chat-clip",
      `${view.top}px ${innerWidth - view.right}px ${innerHeight - view.bottom}px ${view.left}px`,
    );
  card.style.viewTransitionName = "side-chat-card";
  root.classList.add("side-chat-morph");
  const transition = document.startViewTransition(async () => {
    update();
    await new Promise((resolve) => setTimeout(resolve));
    if (!card.isConnected) return;
    const { to, rail, track, hold } = settle(card, from);
    root.classList.toggle("side-chat-track", track);
    root.style.setProperty("--side-chat-morph", `${span(from, to)}ms`);
    root.style.setProperty("--side-chat-fade", rail ? "140ms" : "80ms");
    root.style.setProperty("--side-chat-hold", `${hold}ms`);
  });
  running = transition;
  void transition.finished.finally(() => {
    if (running === transition) running = null;
    card.style.viewTransitionName = "";
    if (!running) root.classList.remove("side-chat-morph", "side-chat-track");
  });
  await transition.updateCallbackDone.catch(() => {});
}
