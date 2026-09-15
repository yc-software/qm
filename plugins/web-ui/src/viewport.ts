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

// How long after a composer focus / keyboard transition we keep re-asserting the wanted state.
// iOS fires focus-reveal scrolls, visualViewport resizes and pans in device-dependent order,
// sometimes without any event we can hook — a short rAF settle loop self-heals whatever order
// they land in.
const SETTLE_MS = 900;
const NEAR_BOTTOM_PX = 160;
const KBD_MIN_PX = 120;

export function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  let wasOpen = false;

  // Chat anchors are captured when the composer is focused — BEFORE the keyboard opens and
  // Safari's focus-reveal scrolling mangles scroll positions. Capturing at the kbd-open
  // transition (as before) is too late: by then the browser may already have scrolled
  // .chat-scroll, so "near bottom" read false and the chat was left wherever Safari dumped it
  // (often the very top, with the composer pinned at the top of the screen).
  type Anchor = { el: HTMLElement; pinBottom: boolean; top: number };
  let anchors: Anchor[] = [];
  let settleUntil = 0;
  let settleRaf = 0;

  const captureAnchors = () => {
    anchors = [...document.querySelectorAll<HTMLElement>(".chat-scroll")].map((el) => ({
      el,
      pinBottom: el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX,
      top: el.scrollTop,
    }));
  };

  const restoreAnchors = () => {
    for (const a of anchors) {
      if (!a.el.isConnected) continue;
      if (a.pinBottom) {
        const bottom = a.el.scrollHeight - a.el.clientHeight;
        if (a.el.scrollTop < bottom - 1) a.el.scrollTop = a.el.scrollHeight;
      } else if (Math.abs(a.el.scrollTop - a.top) > 1) {
        a.el.scrollTop = a.top;
      }
    }
  };

  const apply = () => {
    const h = Math.round(vv.height);
    document.documentElement.style.setProperty("--vvh", `${h}px`);

    const open = window.innerHeight - h > KBD_MIN_PX;
    document.documentElement.classList.toggle("kbd-open", open);
    if (open) {
      // Undo the browser's focus-reveal scroll of the layout viewport; --vv-top compensates
      // for pure visual-viewport pans that window.scrollTo cannot touch.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      document.documentElement.style.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
    } else {
      document.documentElement.style.setProperty("--vv-top", "0px");
    }
    if (open !== wasOpen) {
      wasOpen = open;
      if (open && !anchors.length) captureAnchors();
      if (!open) anchors = [];
      startSettle();
    }
    if (open && Date.now() < settleUntil) restoreAnchors();
  };

  const raf = (cb: () => void): number =>
    typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(cb)
      : (window.setTimeout(cb, 16) as unknown as number);
  const settleTick = () => {
    apply();
    if (Date.now() < settleUntil) settleRaf = raf(settleTick);
    else settleRaf = 0;
  };
  const startSettle = () => {
    settleUntil = Date.now() + SETTLE_MS;
    if (!settleRaf) settleRaf = raf(settleTick);
  };

  // The user's own touch outranks our enforcement: stop re-pinning the moment they interact.
  document.addEventListener(
    "touchstart",
    () => {
      settleUntil = 0;
    },
    { passive: true },
  );

  document.addEventListener("focusin", (e) => {
    if (!isTouch()) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest(".composer-wrap")) return;
    captureAnchors();
    startSettle();
  });

  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  window.addEventListener("scroll", apply, { passive: true });
  apply();
}
