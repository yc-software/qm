import { appState } from "./shell-state";
import { isMac } from "./search";
import { startNewChatInLastScope } from "./sessions";
import { hasExactPrimaryModifier, matchesPrimaryShortcut } from "./shortcut";

export function registerNewSessionHotkey(): void {
  document.addEventListener("keydown", (e) => {
    if (!appState.me || !appState.mainEl?.isConnected || !matchesPrimaryShortcut(e, "n", isMac)) return;
    e.preventDefault();
    startNewChatInLastScope();
  });
}

export function registerSessionJumpHotkeys(): void {
  document.addEventListener("keydown", (e) => {
    if (!hasExactPrimaryModifier(e, isMac)) return;
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (!digit) return;
    const target = appState.listEl?.querySelectorAll<HTMLAnchorElement>("a.session")[Number(digit) - 1];
    if (!target) return;
    e.preventDefault();
    target.click();
  });
}
