const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("permissions", {
  status: () => ipcRenderer.invoke("qm:permissions-status"),
  prompt: () => ipcRenderer.invoke("qm:permissions-prompt"),
  settings: (permission) => ipcRenderer.invoke("qm:permissions-settings", permission),
  finder: () => ipcRenderer.invoke("qm:permissions-finder"),
  move: () => ipcRenderer.invoke("qm:permissions-move"),
  drag: () => ipcRenderer.send("qm:permissions-drag"),
  close: (proceed) => ipcRenderer.invoke("qm:permissions-close", proceed),
});
