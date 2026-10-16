import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const page = path.join(path.dirname(fileURLToPath(import.meta.url)), "cursor.html");
let overlays = [];
let watching = false;
let at;
let idle;

function reset() {
  for (const { window } of overlays) window.destroy();
  overlays = [];
}

function overlay(bounds) {
  const window = new BrowserWindow({
    ...bounds,
    type: process.platform === "darwin" ? "panel" : undefined,
    frame: false,
    transparent: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  window.setIgnoreMouseEvents(true);
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  window.setContentProtection(true);
  return { window, bounds, ready: window.loadFile(page) };
}

function hide() {
  for (const { window } of overlays) window.hide();
  at = undefined;
}

export async function flyTo(point) {
  clearTimeout(idle);
  if (!watching) {
    watching = true;
    for (const change of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(change, reset);
  }
  if (!overlays.length) overlays = screen.getAllDisplays().map(({ bounds }) => overlay(bounds));
  const { x, y } = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).bounds;
  const target = overlays.find(({ bounds }) => bounds.x === x && bounds.y === y) ?? overlays[0];
  const from = at ?? screen.getCursorScreenPoint();
  at = point;
  for (const other of overlays) if (other !== target) other.window.hide();
  await target.ready;
  target.window.showInactive();
  const local = (p) => [p.x - target.bounds.x, p.y - target.bounds.y];
  await target.window.webContents.executeJavaScript(
    `fly(${JSON.stringify(local(from))}, ${JSON.stringify(local(point))})`,
  );
  idle = setTimeout(hide, 2500);
}
