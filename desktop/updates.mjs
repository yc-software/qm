import { app, autoUpdater } from "electron";
import { updateElectronApp, UpdateSourceType } from "update-electron-app";

export function startUpdates(prepareRestart) {
  if (!app.isPackaged || process.platform !== "darwin" || process.arch !== "arm64") return undefined;
  let restarting = false;
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.StaticStorage,
      baseUrl: "https://github.com/yc-software/qm/releases/download/desktop-updates",
    },
    updateInterval: "5 minutes",
    onNotifyUser: () => {
      if (restarting) return;
      restarting = true;
      Promise.resolve()
        .then(prepareRestart)
        .then(() => autoUpdater.quitAndInstall())
        .catch((error) => {
          restarting = false;
          console.error("QM could not prepare to install its update", error);
        });
    },
  });
  return () => autoUpdater.checkForUpdates();
}
