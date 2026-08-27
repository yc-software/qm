import { appState } from "./shell-state";
import { isMac } from "./search";

export function registerSessionJumpHotkeys(): void {
  document.addEventListener("keydown", (e) => {
    if (!(isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (!digit) return;
    const target = appState.listEl?.querySelectorAll<HTMLAnchorElement>("a.session")[Number(digit) - 1];
    if (!target) return;
    e.preventDefault();
    target.click();
  });
}
