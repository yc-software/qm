import type { Api, Model } from "@earendil-works/pi-ai";
import { isPeakEffort } from "./composer-loadout";

const COLORS = ["#e8843a", "#e45d79", "#a78bfa", "#60a5fa", "#5cc074", "#f6cc46"];
let activeBurst: HTMLElement | null = null;
let activeAnchor: Element | null = null;

export function burstEffortConfetti(
  event: Event,
  level: string,
  harnessId: string,
  model: Model<Api> | undefined,
): void {
  if (!isPeakEffort(harnessId, model, level) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const target = event.currentTarget as HTMLElement | null;
  if (!target?.isConnected || typeof target.animate !== "function") return;
  const anchor = target.querySelector<HTMLElement>(".effort-peak") ?? target;
  if (activeBurst && activeAnchor === anchor) return;
  const rect = anchor.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  activeBurst?.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
  activeBurst?.remove();
  const burst = document.createElement("div");
  burst.className = "effort-confetti";
  burst.setAttribute("aria-hidden", "true");
  burst.setAttribute("popover", "manual");
  burst.style.left = `${rect.left + rect.width / 2}px`;
  burst.style.top = `${rect.top + rect.height / 2}px`;
  document.body.appendChild(burst);
  burst.showPopover?.();
  activeBurst = burst;
  activeAnchor = anchor;
  const animations: Promise<Animation>[] = [];
  for (let index = 0; index < 14; index++) {
    const piece = document.createElement("span");
    piece.style.backgroundColor = COLORS[index % COLORS.length];
    burst.appendChild(piece);
    const x = (index - 6.5) * 8 + Math.random() * 10 - 5;
    const rise = 24 + Math.random() * 26;
    const spin = (index % 2 ? 1 : -1) * (100 + Math.random() * 150);
    animations.push(
      piece.animate(
        [
          { transform: "translate(-50%, -50%) scale(0.4) rotate(0deg)", opacity: 0 },
          {
            transform: `translate(${x * 0.6}px, ${-rise}px) scale(1) rotate(${spin * 0.5}deg)`,
            opacity: 1,
            offset: 0.4,
          },
          { transform: `translate(${x}px, ${16 + Math.random() * 18}px) scale(0.6) rotate(${spin}deg)`, opacity: 0 },
        ],
        { duration: 620 + Math.random() * 140, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "forwards" },
      ).finished,
    );
  }
  void Promise.allSettled(animations).then(() => {
    burst.remove();
    if (activeBurst === burst) {
      activeBurst = null;
      activeAnchor = null;
    }
  });
}
