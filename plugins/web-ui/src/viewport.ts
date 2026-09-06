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
  let wasOpen = false;
  const apply = () => {
    const h = Math.round(vv.height);
    document.documentElement.style.setProperty("--vvh", `${h}px`);

    const open = window.innerHeight - h > 120;
    document.documentElement.classList.toggle("kbd-open", open);
    if (open) {
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      document.documentElement.style.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
    } else {
      document.documentElement.style.setProperty("--vv-top", "0px");
    }
    if (open === wasOpen) return;
    wasOpen = open;
    if (!open) return;

    for (const el of document.querySelectorAll<HTMLElement>(".chat-scroll")) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      if (nearBottom) el.scrollTop = el.scrollHeight;
    }
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  window.addEventListener("scroll", apply, { passive: true });
  apply();
}
