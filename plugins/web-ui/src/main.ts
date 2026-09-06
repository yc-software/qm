import "dockview-core/dist/styles/dockview.css";
import "./shell.css";
import { bootSafely, closeUserMenu } from "./shell";
import "./draft-review";
import { registerChatSearchHotkey } from "./search";
import { registerSessionJumpHotkeys } from "./session-jump";
import { closeFormMenus } from "./ui";
import { allConversations } from "./conversations";
import {
  clearSessionSelection,
  closeOpenSessionMenu,
  closeSessionSelectionColor,
  renderList,
  sessionsState,
} from "./sessions";
import { isPhone, onPhoneChange } from "./viewport";

function closeComposerMenus(keepOpenWithin: Element | null): boolean {
  let changed = false;
  for (const conv of allConversations()) {
    if (keepOpenWithin && conv.state.host?.contains(keepOpenWithin)) continue;
    if (!conv.composer.closeMenus()) continue;
    changed = true;
    conv.redraw();
  }
  return changed;
}

document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  const inside = target?.closest(".menu-control, .composer-wrap") ?? null;
  closeComposerMenus(inside);
  if (!target?.closest(".form-menu-control")) closeFormMenus();
  if (sessionsState.openMenuId && !target?.closest(".session-menu")) {
    sessionsState.openMenuId = null;
    renderList();
  }
  if (!target?.closest(".multi-select-color")) closeSessionSelectionColor();
  if (!target?.closest(".user-menu")) closeUserMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeComposerMenus(null);
  closeOpenSessionMenu();
  clearSessionSelection();
  closeFormMenus();
  closeUserMenu();
});

onPhoneChange(() => {
  for (const conv of allConversations()) conv.redraw();
});

document.addEventListener(
  "pointerdown",
  (e) => {
    if (!isPhone()) return;
    const target = e.target as Element | null;
    if (!target?.matches(".menu-popover, .session-menu-popover")) return;
    const r = target.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
    e.preventDefault();
    e.stopPropagation();
    closeComposerMenus(null);
    closeFormMenus();
    closeOpenSessionMenu();
    closeUserMenu();
  },
  true,
);

document.addEventListener("qm:close-overlays", () => {
  closeComposerMenus(null);
  closeFormMenus();
  closeOpenSessionMenu();
  closeUserMenu();
});

let sheetSwipe: { y: number; el: HTMLElement } | null = null;
document.addEventListener(
  "touchstart",
  (e) => {
    if (!isPhone() || e.touches.length !== 1) return;
    const el = (e.target as Element | null)?.closest<HTMLElement>(".menu-popover, .session-menu-popover") ?? null;
    if (!el || el.scrollTop > 0) return;
    sheetSwipe = { y: e.touches[0]!.clientY, el };
  },
  { passive: true },
);
document.addEventListener(
  "touchend",
  (e) => {
    if (!sheetSwipe) return;
    const t = e.changedTouches[0];
    const dy = t ? t.clientY - sheetSwipe.y : 0;
    sheetSwipe = null;
    if (dy < 72) return;
    closeComposerMenus(null);
    closeFormMenus();
    closeOpenSessionMenu();
    closeUserMenu();
  },
  { passive: true },
);

registerChatSearchHotkey();
registerSessionJumpHotkeys();
void bootSafely();
