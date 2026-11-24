const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pillHost", {
  open: () => ipcRenderer.invoke("qm:pill-open"),
  stop: () => ipcRenderer.invoke("qm:pill-stop"),
  onState: (callback) => ipcRenderer.on("qm:pill-state", (_event, state) => callback(state)),
  onLevel: (callback) => ipcRenderer.on("qm:pill-level", (_event, speaker, level) => callback(speaker, level)),
});
