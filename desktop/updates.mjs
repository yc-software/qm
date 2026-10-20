import { app, autoUpdater } from "electron";
import { updateElectronApp, UpdateSourceType } from "update-electron-app";

export function startUpdates(prepareRestart, resume = () => {}) {
  if (!app.isPackaged || process.platform !== "darwin" || process.arch !== "arm64") return undefined;
  let restarting = false;
  let downloaded = false;
  autoUpdater.on("error", () => {
    restarting = false;
    resume();
  });
  const install = async () => {
    if (!downloaded || restarting) return;
    restarting = true;
    try {
      if (!(await prepareRestart())) {
        restarting = false;
        resume();
        return;
      }
      autoUpdater.quitAndInstall();
    } catch (error) {
      restarting = false;
      resume();
      console.error("QM could not prepare to install its update", error);
    }
  };
  const retry = setInterval(() => void install(), 5000);
  retry.unref();
  app.on("will-quit", () => clearInterval(retry));
  const updater = updateElectronApp({
    updateSource: {
      type: UpdateSourceType.StaticStorage,
      baseUrl: "https://github.com/yc-software/qm/releases/download/desktop-updates",
    },
    updateInterval: "5 minutes",
    onNotifyUser: () => {
      updater.stopUpdates();
      downloaded = true;
      void install();
    },
  });
  return () => (downloaded ? void install() : autoUpdater.checkForUpdates());
}
