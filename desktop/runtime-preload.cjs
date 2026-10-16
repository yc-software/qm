const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deskHost", {
  request: (cmd) => ipcRenderer.invoke("qm:runtime-desk", cmd),
});
