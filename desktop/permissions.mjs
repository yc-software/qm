import { app, BrowserWindow, ipcMain, shell, screen, nativeImage } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { stopComputer } from "./runtime.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(path.join(directory, "permissions.html")).href;
const execute = promisify(execFile);
const panes = {
  accessibility: "Privacy_Accessibility",
  screen_recording: "Privacy_ScreenCapture",
};
let window;
let completion;
let finish;
let icon;

async function status(prompt = false) {
  const binary =
    process.env.QM_DESK_BIN ??
    (app.isPackaged ? path.join(process.resourcesPath, "desk") : path.join(directory, "desk/target/release/desk"));
  const { stdout } = await execute(binary, ["permissions", ...(prompt ? ["--prompt"] : [])], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const result = JSON.parse(stdout);
  if (result.type !== "permissions") throw new Error(result.message ?? "Could not check computer permissions");
  return { accessibility: result.accessibility === true, screen_recording: result.screen_recording === true };
}

export function registerComputerPermissions() {
  const assertWindow = (event) => {
    if (
      event.sender !== window?.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== url
    )
      throw new Error("Untrusted permission request");
  };
  ipcMain.handle("qm:permissions-status", async (event) => {
    assertWindow(event);
    return { ...(await status()), name: app.getName(), icon: icon?.toDataURL() };
  });
  ipcMain.handle("qm:permissions-prompt", async (event) => {
    assertWindow(event);
    return status(true);
  });
  ipcMain.handle("qm:permissions-settings", async (event, permission) => {
    assertWindow(event);
    if (!Object.hasOwn(panes, permission)) throw new Error("Unknown permission");
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    window.setPosition(area.x + area.width - 580, area.y + Math.max(0, Math.floor((area.height - 790) / 2)));
    window.setAlwaysOnTop(true, "floating");
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${panes[permission]}`);
  });
  ipcMain.handle("qm:permissions-finder", (event) => {
    assertWindow(event);
    shell.showItemInFolder(appBundle());
  });
  ipcMain.on("qm:permissions-drag", (event) => {
    assertWindow(event);
    if (icon && app.isPackaged) event.sender.startDrag({ file: appBundle(), icon });
  });
  ipcMain.handle("qm:permissions-close", async (event, proceed) => {
    assertWindow(event);
    if (proceed) {
      const current = await status();
      if (!current.accessibility || !current.screen_recording) return false;
    }
    if (proceed) stopComputer();
    window?.close();
    return true;
  });
}

function appBundle() {
  return path.resolve(process.execPath, "../../..");
}

export function focusComputerPermissions() {
  if (!window) return false;
  window.show();
  return true;
}

export async function showComputerPermissions(onlyIfMissing = false) {
  if (process.platform !== "darwin") return;
  if (window) {
    window.show();
    return completion;
  }
  if (onlyIfMissing) {
    try {
      const current = await status();
      if (current.accessibility && current.screen_recording) return;
    } catch (error) {
      console.error("Computer permission preflight failed:", error.message);
    }
    if (window) return completion;
  }
  completion = new Promise((resolve) => {
    finish = resolve;
  });
  window = new BrowserWindow({
    title: `${app.getName()} · Computer access`,
    width: 560,
    height: 790,
    resizable: false,
    backgroundColor: "#f7f6f2",
    webPreferences: {
      preload: path.join(directory, "permissions-preload.cjs"),
      sandbox: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.on("closed", () => {
    window = undefined;
    finish();
  });
  icon = nativeImage.createFromPath(path.join(directory, "assets/qm.png")).resize({ width: 64, height: 64 });
  if (window) await window.loadURL(url);
  return completion;
}
