const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("recorderHost", {
  segment: (speaker, at, bytes) => ipcRenderer.invoke("qm:recorder-segment", speaker, at, bytes),
  track: (speaker, problem) => ipcRenderer.invoke("qm:recorder-track", speaker, problem),
  local: () => ipcRenderer.invoke("qm:recorder-local"),
  done: () => ipcRenderer.invoke("qm:recorder-done"),
  onStop: (callback) => ipcRenderer.once("qm:recorder-stop", () => callback()),
});
