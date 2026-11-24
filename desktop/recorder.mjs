import { BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(directory, "recorder.html");
const pageUrl = pathToFileURL(page).href;
const speakers = new Set(["me", "others"]);
let active;

export function registerRecorder() {
  const isolated = session.fromPartition("qm-recorder");
  const ours = (contents) => active !== undefined && contents === active.window.webContents;
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("file:") }));
  isolated.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(ours(contents) && permission === "media" && details.requestingUrl === pageUrl),
  );
  isolated.setPermissionCheckHandler((contents, permission) => ours(contents) && permission === "media");
  isolated.setDisplayMediaRequestHandler((request, callback) =>
    callback(
      active && request.frame === active.window.webContents.mainFrame
        ? { video: request.frame, audio: "loopback" }
        : {},
    ),
  );
  const handle = (channel, run) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!ours(event.sender) || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pageUrl)
        throw new Error("Untrusted recorder request");
      return run(active, ...args);
    });
  handle("qm:recorder-segment", (current, speaker, at, bytes) => {
    if (!speakers.has(speaker) || !Number.isFinite(at) || !(bytes instanceof Uint8Array))
      throw new Error("Invalid recorder segment");
    current.segment(speaker, at, bytes);
  });
  handle("qm:recorder-track", (current, speaker, problem) => {
    if (!speakers.has(speaker) || typeof problem !== "string") throw new Error("Invalid recorder track");
    current.track(speaker, problem);
  });
  handle("qm:recorder-done", (current) => current.finished());
  handle("qm:recorder-local", (current) => current.local);
}

export function startCapture(segment, track, local) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: session.fromPartition("qm-recorder"),
      preload: path.join(directory, "recorder-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  const done = Promise.withResolvers();
  active = { window, segment, track, local, finished: done.resolve };
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", (_event, details) => {
    for (const speaker of speakers) track(speaker, `The recorder stopped: ${details.reason}`);
    done.resolve();
  });
  const loaded = window.loadFile(page).catch((error) => {
    for (const speaker of speakers) track(speaker, `The recorder did not load: ${error.message}`);
    done.resolve();
  });
  return async () => {
    await loaded;
    if (!window.isDestroyed()) window.webContents.send("qm:recorder-stop");
    await done.promise;
    if (active?.window === window) active = undefined;
    window.destroy();
  };
}
