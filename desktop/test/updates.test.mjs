import assert from "node:assert/strict";
import { mock, test } from "node:test";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("updates restart only after preparation succeeds, without prompting", async () => {
  const app = { isPackaged: false };
  let options;
  let checks = 0;
  let restarts = 0;
  const errors = [];
  mock.method(console, "error", (...args) => errors.push(args));
  mock.module("electron", {
    namedExports: { app, autoUpdater: { checkForUpdates: () => checks++, quitAndInstall: () => restarts++ } },
  });
  mock.module("update-electron-app", {
    namedExports: { UpdateSourceType: { StaticStorage: 1 }, updateElectronApp: (value) => (options = value) },
  });
  try {
    const { startUpdates } = await import("../updates.mjs");
    assert.equal(
      startUpdates(() => {}),
      undefined,
    );
    assert.equal(options, undefined);
    if (process.platform !== "darwin" || process.arch !== "arm64") return;
    app.isPackaged = true;
    const prepared = Promise.withResolvers();
    const check = startUpdates(() => prepared.promise);
    check();
    assert.equal(checks, 1);
    assert.equal(options.updateSource.type, 1);
    assert.equal(options.updateInterval, "5 minutes");
    options.onNotifyUser();
    options.onNotifyUser();
    await tick();
    assert.equal(restarts, 0);
    prepared.resolve();
    await tick();
    assert.equal(restarts, 1);
    startUpdates(() => Promise.reject(new Error("disk full")));
    options.onNotifyUser();
    await tick();
    assert.equal(restarts, 1);
    assert.match(errors.find((args) => args[1] instanceof Error)[1].message, /disk full/);
  } finally {
    mock.restoreAll();
  }
});
