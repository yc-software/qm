import { PHONE_MAX_WIDTH } from "./viewport";
import { closeOpenSessionMenu } from "./session-actions";
import { attachTooltip } from "./tooltip";
import { appState } from "./shell-state";
import { trapDialogFocus } from "./dialog-focus";
import { renderSidebarTop } from "./shell";

const appEl = document.getElementById("app");
if (!appEl) throw new Error("missing #app");
export const root: HTMLElement = appEl;

const narrowViewport = window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`);
export let sidebarOpen = !narrowViewport.matches;

const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 520;
const SIDEBAR_W_KEY = "webui:sidebar-w";

export function applySavedSidebarWidth(): void {
  const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
  if (Number.isFinite(saved) && saved >= SIDEBAR_MIN_W && saved <= SIDEBAR_MAX_W) {
    document.documentElement.style.setProperty("--sidebar-w", `${saved}px`);
  }
}

export function startSidebarResize(e: PointerEvent): void {
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  const startX = e.clientX;
  const sidebar = root.querySelector<HTMLElement>(".sidebar");
  if (!sidebar) return;
  const startW = sidebar.getBoundingClientRect().width;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing-sidebar");
  let w = startW;
  const drag = new AbortController();
  const onUp = () => {
    drag.abort();
    document.body.classList.remove("resizing-sidebar");
    localStorage.setItem(SIDEBAR_W_KEY, String(Math.round(w)));
  };
  handle.addEventListener(
    "pointermove",
    (ev) => {
      w = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, startW + (ev.clientX - startX)));
      document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
    },
    { signal: drag.signal },
  );
  handle.addEventListener("pointerup", onUp, { signal: drag.signal });
  handle.addEventListener("lostpointercapture", onUp, { signal: drag.signal });
}

export function resetSidebarWidth(): void {
  document.documentElement.style.removeProperty("--sidebar-w");
  localStorage.removeItem(SIDEBAR_W_KEY);
}

export function toggleSidebar(): void {
  setSidebarOpen(!sidebarOpen);
}

export function closeSidebarOnNarrowView(): void {
  if (!narrowViewport.matches || !sidebarOpen) return;
  setSidebarOpen(false, false);
  requestAnimationFrame(() => appState.mainEl?.focus({ preventScroll: true }));
}

const EDGE_PX = 28;
const SWIPE_PX = 56;
let swipe: { x: number; y: number; fromEdge: boolean; onDrawer: boolean } | null = null;
appEl.addEventListener(
  "touchstart",
  (e) => {
    if (!narrowViewport.matches || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    const target = e.target as Element | null;
    const onDrawer = Boolean(target?.closest(".sidebar, .sidebar-scrim"));
    const fromEdge = !sidebarOpen && t.clientX <= EDGE_PX;
    if (!fromEdge && !(sidebarOpen && onDrawer)) return;
    swipe = { x: t.clientX, y: t.clientY, fromEdge, onDrawer };
  },
  { passive: true },
);
appEl.addEventListener(
  "touchend",
  (e) => {
    if (!swipe) return;
    const t = e.changedTouches[0];
    const s = swipe;
    swipe = null;
    if (!t) return;
    const dx = t.clientX - s.x;
    const dy = Math.abs(t.clientY - s.y);
    if (Math.abs(dx) < SWIPE_PX || dy > Math.abs(dx) * 0.8) return;
    if (s.fromEdge && dx > 0 && !sidebarOpen) setSidebarOpen(true);
    else if (s.onDrawer && dx < 0 && sidebarOpen) setSidebarOpen(false, false);
  },
  { passive: true },
);
appEl.addEventListener("touchcancel", () => (swipe = null), { passive: true });

narrowViewport.addEventListener("change", (event) => {
  if (event.matches && sidebarOpen) setSidebarOpen(false, false);
  else syncSidebarAccessibility(false);
});

function setSidebarOpen(open: boolean, moveFocus = true): void {
  if (open && narrowViewport.matches) document.dispatchEvent(new CustomEvent("qm:close-overlays"));
  sidebarOpen = open;
  root.querySelector(".layout")?.classList.toggle("sidebar-closed", !sidebarOpen);
  root.querySelector(".sidebar")?.setAttribute("data-tip-placement", open ? "top" : "right");
  updateSidebarToggleLabels();
  renderSidebarTop();
  syncSidebarAccessibility(moveFocus);
}

export function syncSidebarAccessibility(moveFocus: boolean): void {
  const sidebar = root.querySelector<HTMLElement>(".sidebar");
  const main = root.querySelector<HTMLElement>(".main");
  const scrim = root.querySelector<HTMLButtonElement>(".sidebar-scrim");
  const modal = narrowViewport.matches && sidebarOpen;
  if (!sidebar || !main || !scrim) return;
  main.inert = modal;
  sidebar.setAttribute("role", modal ? "dialog" : "navigation");
  if (modal) sidebar.setAttribute("aria-modal", "true");
  else sidebar.removeAttribute("aria-modal");
  scrim.hidden = !modal;
  if (!moveFocus || !narrowViewport.matches) return;

  const next = sidebarOpen
    ? sidebar.querySelector<HTMLElement>(".sidebar-collapse-toggle")
    : root.querySelector<HTMLElement>(".mobile-menu-btn");
  requestAnimationFrame(() => next?.focus());
}

export function onSidebarKeydown(event: KeyboardEvent): void {
  if (!narrowViewport.matches || !sidebarOpen) return;
  if (event.key === "Escape" && event.defaultPrevented) return;
  if (event.key === "Escape" && closeOpenSessionMenu()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  trapDialogFocus(event, () => setSidebarOpen(false));
}

export function sidebarToggleLabel(): string {
  return sidebarOpen ? "Hide sidebar" : "Show sidebar";
}

export function updateSidebarToggleLabels(): void {
  const collapseLabel = sidebarToggleLabel();
  root.querySelectorAll<HTMLButtonElement>(".sidebar-toggle").forEach((btn) => {
    btn.setAttribute("aria-expanded", sidebarOpen ? "true" : "false");
    btn.setAttribute("aria-label", collapseLabel);
    attachTooltip(btn, collapseLabel);
  });
}
