export const PHONE_MAX_WIDTH = 860;

let query: MediaQueryList | undefined;
const phoneQuery = () => (query ??= window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`));

export function isPhone(): boolean {
  return phoneQuery().matches;
}

export function isTouch(): boolean {
  return window.matchMedia("(hover: none)").matches;
}

export function onPhoneChange(fn: (phone: boolean) => void): () => void {
  const query = phoneQuery();
  const listener = (e: MediaQueryListEvent) => fn(e.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
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
