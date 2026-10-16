import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

test("pending permission setup takes activation and does not open a workspace after quitting", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qm-permission-startup-"));
  await writeFile(path.join(directory, "instance.json"), JSON.stringify({ url: "https://trial.example/" }));
  const entered = Promise.withResolvers();
  const dismissed = Promise.withResolvers();
  let permissionOpen = false;
  let focused = 0;
  let stopped = 0;
  let created = 0;
  const errors = [];
  const app = Object.assign(new EventEmitter(), {
    setName() {},
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    getPath: () => directory,
    setAsDefaultProtocolClient() {},
    quit() {},
  });
  mock.module("../permissions.mjs", {
    namedExports: {
      registerComputerPermissions() {},
      showComputerPermissions: async () => {
        permissionOpen = true;
        entered.resolve();
        await dismissed.promise;
      },
      focusComputerPermissions: () => {
        if (!permissionOpen) return false;
        focused++;
        return true;
      },
    },
  });
  mock.module("../runtime.mjs", {
    namedExports: { stopComputer: () => stopped++, registerComputerRuntime() {}, callComputer() {} },
  });
  mock.module("electron", {
    namedExports: {
      app,
      BrowserWindow: class {
        constructor() {
          created++;
          throw new Error("Workspace should not open");
        }
      },
      ipcMain: { handle() {} },
      Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} },
      shell: {},
      session: { fromPartition: () => ({}) },
      dialog: { showErrorBox: (...args) => errors.push(args) },
    },
  });
  const original = process.env.QM_DESKTOP_URL;
  delete process.env.QM_DESKTOP_URL;
  try {
    await import("../main.mjs");
    await entered.promise;
    app.emit("activate");
    app.emit("second-instance", {}, []);
    assert.equal(focused, 2);
    assert.equal(created, 0);
    app.emit("before-quit");
    permissionOpen = false;
    dismissed.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, 1);
    assert.equal(created, 0);
    assert.deepEqual(errors, []);
  } finally {
    if (original === undefined) delete process.env.QM_DESKTOP_URL;
    else process.env.QM_DESKTOP_URL = original;
    mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
});
