import { app, BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(directory, "pill.html");
const pageUrl = pathToFileURL(page).href;
const width = 420;
const height = 64;
let window;
let latest;

export function registerPill({ open, stop }) {
  const handle = (channel, run) =>
    ipcMain.handle(channel, (event) => {
      if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pageUrl)
        throw new Error("Untrusted pill request");
      run();
    });
  handle("qm:pill-open", () => {
    app.focus({ steal: true });
    open();
  });
  handle("qm:pill-stop", stop);
}

export function showPill(state) {
  latest = state;
  if (!state) {
    window?.destroy();
    window = undefined;
    return;
  }
  if (window) return window.webContents.send("qm:pill-state", state);
  const { workArea } = screen.getPrimaryDisplay();
  window = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + workArea.height - height - 8,
    type: "panel",
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    acceptFirstMouse: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(directory, "pill-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const shown = window;
  shown.setAlwaysOnTop(true, "floating");
  shown.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  shown.on("closed", () => {
    if (window === shown) window = undefined;
  });
  shown.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  shown.webContents.on("will-navigate", (event) => event.preventDefault());
  shown.webContents.on("did-finish-load", () => {
    if (shown.isDestroyed()) return;
    shown.webContents.send("qm:pill-state", latest);
    shown.showInactive();
  });
  void shown.loadFile(page);
}

export function pillLevel(speaker, level) {
  window?.webContents.send("qm:pill-level", speaker, level);
}
