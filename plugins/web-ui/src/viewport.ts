export const PHONE_MAX_WIDTH = 860;

const query = window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`);

export function isPhone(): boolean {
  return query.matches;
}

export function isTouch(): boolean {
  return window.matchMedia("(hover: none)").matches;
}

const listeners = new Set<(phone: boolean) => void>();
query.addEventListener("change", (e) => {
  for (const fn of listeners) fn(e.matches);
});

export function onPhoneChange(fn: (phone: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    if (vv.scale !== 1) return;
    document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    document.documentElement.style.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  apply();
}
