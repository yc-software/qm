const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function inRail(element: Element): boolean {
  const host = element.closest(".side-chat-markers");
  return host !== null && getComputedStyle(host).containerName === "side-notes";
}

export function appear(element: Element | null | undefined): void {
  if (typeof element?.animate !== "function" || still()) return;
  element.animate({ opacity: [0, 1], translate: ["0 4px", "0 0"] }, { duration: 140, easing: "ease-out" });
}

export function leave(element: Element | null | undefined): Promise<unknown> | undefined {
  if (!element?.isConnected || typeof element.animate !== "function" || still()) return undefined;
  return element
    .animate({ opacity: [1, 0], translate: ["0 0", "0 4px"] }, { duration: 100, easing: "ease-in", fill: "forwards" })
    .finished.catch(() => {});
}
