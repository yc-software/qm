import { app, BrowserWindow, dialog, ipcMain, Menu, shell, session as electronSession } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLogin, loginCallback } from "./login.mjs";
import { instanceUrl, externalUrl, browserLoginUrl, loginDestination } from "./url.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const setupUrl = pathToFileURL(path.join(directory, "setup.html")).href;
let mainWindow;
let setupWindow;
let target;
let pendingLogin;
let loginStatus = "";

app.setName("QM");
app.on("open-url", (event, url) => {
  event.preventDefault();
  void finishBrowserSignIn(url);
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    const callback = argv.find((arg) => arg.startsWith("qm-desktop:"));
    if (callback) void finishBrowserSignIn(callback);
    const window = setupWindow ?? mainWindow;
    if (window?.isMinimized()) window.restore();
    window?.show();
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox("QM could not start", error.message);
      app.quit();
    });
}

function openExternal(url) {
  if (externalUrl(url)) {
    shell.openExternal(url).catch((error) => dialog.showErrorBox("Could not open link", error.message));
  }
}

function showSetup() {
  if (setupWindow) return setupWindow.show();
  setupWindow = new BrowserWindow({
    title: "Welcome to QM",
    width: 1040,
    height: 760,
    minWidth: 700,
    minHeight: 650,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f7f6f2",
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  setupWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setupWindow.on("closed", () => {
    setupWindow = undefined;
    if (pendingLogin) mainWindow?.destroy();
  });
  setupWindow.loadURL(setupUrl);
}

function instanceSession(url) {
  return electronSession.fromPartition(`persist:qm-${new URL(url).origin}`);
}

async function beginBrowserSignIn(url) {
  pendingLogin?.controller.abort();
  const attempt = { ...createLogin(url), controller: new AbortController() };
  pendingLogin = attempt;
  loginStatus = "Finish signing in in your browser. This window will open your workspace when you're done.";
  mainWindow?.hide();
  showSetup();
  setupWindow.webContents.send("qm:login-status", loginStatus);
  try {
    await shell.openExternal(attempt.url);
  } catch {
    if (pendingLogin !== attempt) return;
    pendingLogin = undefined;
    loginStatus = "Could not open your browser. Try connecting again.";
    setupWindow?.webContents.send("qm:login-status", loginStatus);
  }
}

async function finishBrowserSignIn(url) {
  if (pendingLogin?.redeeming) return;
  const code = loginCallback(url, pendingLogin);
  if (!code) return;
  const attempt = pendingLogin;
  attempt.redeeming = true;
  try {
    const response = await instanceSession(attempt.instance).fetch(
      new URL("/auth/desktop/redeem", attempt.instance).href,
      {
        method: "POST",
        redirect: "error",
        credentials: "include",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(attempt.instance).origin },
        body: new URLSearchParams({ code, verifier: attempt.verifier, state: attempt.state }).toString(),
        signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(15_000)]),
      },
    );
    if (pendingLogin !== attempt) return;
    if (!response.ok) throw new Error("Sign-in could not be completed. Please connect again to get a fresh link.");
    await instanceSession(attempt.instance).cookies.flushStore();
    if (pendingLogin !== attempt) return;
    pendingLogin = undefined;
    loginStatus = "";
    void showInstance(attempt.instance);
    setupWindow?.close();
  } catch {
    if (pendingLogin !== attempt) return;
    pendingLogin = undefined;
    loginStatus = "Sign-in could not be completed. Please connect again to get a fresh link.";
    showSetup();
    setupWindow.webContents.send("qm:login-status", loginStatus);
  }
}

async function showInstance(url) {
  pendingLogin?.controller.abort();
  pendingLogin = undefined;
  if (browserLoginUrl(url, new URL(url).origin)) url = loginDestination(url, url);
  if (mainWindow) mainWindow.destroy();
  const window = new BrowserWindow({
    title: "QM",
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#f5f4f0",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 20, y: 20 } } : {}),
    webPreferences: {
      session: instanceSession(url),
      preload: path.join(directory, "workspace-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow = window;
  const origin = new URL(url).origin;
  const session = window.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  let handedOff = false;
  const navigate = (event, destination) => {
    if (event.isMainFrame === false) return;
    const destinationUrl = new URL(destination);
    if (browserLoginUrl(destination, origin)) {
      event.preventDefault();
      handedOff = true;
      void beginBrowserSignIn(loginDestination(destination, url, window.webContents.getURL()));
    } else if (destinationUrl.origin !== origin) {
      event.preventDefault();
      handedOff = true;
      openExternal(destination);
    }
  };
  window.webContents.on("will-navigate", navigate);
  window.webContents.on("will-redirect", navigate);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url: destination }) => {
    if (browserLoginUrl(destination, origin)) {
      handedOff = true;
      void beginBrowserSignIn(loginDestination(destination, url, window.webContents.getURL()));
    } else if (new URL(destination).origin === origin) {
      window.loadURL(destination).catch((error) => {
        if (error.code !== "ERR_ABORTED") dialog.showErrorBox("Could not open page", error.message);
      });
    } else openExternal(destination);
    return { action: "deny" };
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  try {
    await window.loadURL(url);
  } catch (error) {
    if (window.isDestroyed() || handedOff || error.code === "ERR_ABORTED") return;
    await dialog.showMessageBox(window, {
      type: "error",
      message: "Could not connect to QM",
      detail:
        "Check that your instance is running and the URL is correct. You can retry with View → Reload or change the URL with QM → Change Instance.",
    });
    showSetup();
  }
}

async function start() {
  app.setAsDefaultProtocolClient("qm-desktop");
  const configPath = path.join(app.getPath("userData"), "instance.json");
  try {
    target = instanceUrl(JSON.parse(await readFile(configPath, "utf8")).url);
  } catch (error) {
    if (error.code !== "ENOENT") dialog.showErrorBox("QM settings could not be read", error.message);
  }
  if (process.env.QM_DESKTOP_URL) target = instanceUrl(process.env.QM_DESKTOP_URL);
  const assertSetup = (event) => {
    if (event.sender !== setupWindow?.webContents || event.senderFrame?.url !== setupUrl) {
      throw new Error("Untrusted settings request");
    }
  };
  ipcMain.handle("qm:current-instance", (event) => {
    assertSetup(event);
    return { url: target ?? "", status: loginStatus };
  });
  ipcMain.handle("qm:connect", async (event, value) => {
    assertSetup(event);
    try {
      const url = instanceUrl(value);
      await writeFile(configPath, JSON.stringify({ url }), { mode: 0o600 });
      target = url;
      void showInstance(url);
      setupWindow.close();
      return { ok: true };
    } catch (error) {
      return { error: error.message };
    }
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "QM",
        submenu: [
          { role: "about" },
          { label: "Change Instance…", accelerator: "CmdOrCtrl+,", click: showSetup },
          {
            label: "Open in Browser",
            click: () => {
              if (target) openExternal(target);
            },
          },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
  app.on("activate", () => {
    if (setupWindow) setupWindow.show();
    else if (pendingLogin) showSetup();
    else if (mainWindow) mainWindow.show();
    else if (target) void showInstance(target);
    else showSetup();
  });
  if (target) await showInstance(target);
  else showSetup();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
