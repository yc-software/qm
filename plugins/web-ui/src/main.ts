import "dockview-core/dist/styles/dockview.css";
import "./shell.css";
import { swallow } from "../../chassis/src/errors";
import { appState, boot, renderAuthGate } from "./shell";
import { closeFormMenus } from "./ui";
import { drawActiveChat } from "./chat";
import { composerState, slashQuery } from "./composer";
import { closeOpenSessionMenu, renderList, sessionsState } from "./sessions";
import { closeDeployMenu } from "./deploys";

document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  let redrawChat = false;
  if (composerState.openMenu && !target?.closest(".menu-control")) {
    composerState.openMenu = null;
    redrawChat = true;
  }
  if (!composerState.slashDismissed && slashQuery(composerState.draft) !== null && !target?.closest(".composer-wrap")) {
    composerState.slashDismissed = true;
    redrawChat = true;
  }
  if (!target?.closest(".form-menu-control")) closeFormMenus();
  if (sessionsState.openMenuId && !target?.closest(".session-menu")) {
    sessionsState.openMenuId = null;
    renderList();
  }
  closeDeployMenu(target);
  if (redrawChat) drawActiveChat();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  let changed = false;
  if (composerState.openMenu) {
    composerState.openMenu = null;
    changed = true;
  }
  if (!composerState.slashDismissed && slashQuery(composerState.draft) !== null) {
    composerState.slashDismissed = true;
    changed = true;
  }
  closeOpenSessionMenu();
  changed = closeDeployMenu(null, true) || changed;
  changed = closeFormMenus() || changed;
  if (changed) drawActiveChat();
});

void boot().catch((e: unknown) => {
  if (appState.me) swallow("web-ui: boot", e);
  else renderAuthGate({ kind: "unreachable" });
});
