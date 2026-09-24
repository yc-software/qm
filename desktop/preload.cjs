const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qm", {
  onLoginStatus: (callback) => ipcRenderer.on("qm:login-status", (_event, status) => callback(status)),
  currentInstance: () => ipcRenderer.invoke("qm:current-instance"),
  connect: (url) => ipcRenderer.invoke("qm:connect", url),
});
