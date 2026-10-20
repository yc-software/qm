import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";

const handlers = new Map();
const windows = [];
const opened = [];
let stopped = 0;
mock.module("../runtime.mjs", {
  namedExports: {
    stopComputer: () => {
      stopped++;
    },
  },
});
let allowed = false;
let failure = false;
class Window extends EventEmitter {
  constructor() {
    super();
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = {};
    this.webContents.setWindowOpenHandler = () => {};
    windows.push(this);
  }
  async loadURL(url) {
    this.webContents.mainFrame.url = url;
  }
  show() {}
  getBounds() {
    return {};
  }
  setPosition() {}
  setAlwaysOnTop() {}
  close() {
    this.emit("closed");
  }
}
mock.module("electron", {
  namedExports: {
    app: {
      isPackaged: false,
      getName: () => "QM-cu",
      getFileIcon: async () => ({ toDataURL: () => "data:image/png;base64,AA==" }),
    },
    BrowserWindow: Window,
    nativeImage: { createFromPath: () => ({ resize: () => ({ toDataURL: () => "data:image/png;base64,AA==" }) }) },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
    shell: {
      openExternal: async (url) => {
        opened.push(url);
      },
      showItemInFolder: () => {},
    },
  },
});
mock.module("node:child_process", {
  namedExports: {
    execFile: (_file, _args, _options, callback) => {
      if (failure) callback(new Error("Native helper unavailable"));
      else
        callback(null, {
          stdout: JSON.stringify({ type: "permissions", accessibility: allowed, screen_recording: allowed }),
        });
    },
  },
});
const { registerComputerPermissions, showComputerPermissions, focusComputerPermissions } =
  await import("../permissions.mjs");
registerComputerPermissions();

test("permission setup validates sender, checks grants before continuing, and can reopen", async (t) => {
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", { value: platform }));
  const pending = showComputerPermissions();
  await new Promise((resolve) => setImmediate(resolve));
  const window = windows.at(-1);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const call = (name, ...args) => handlers.get(`qm:permissions-${name}`)(event, ...args);
  await assert.rejects(handlers.get("qm:permissions-status")({ sender: {} }), /Untrusted/);
  await assert.rejects(
    handlers.get("qm:permissions-settings")({ ...event, senderFrame: { url: event.senderFrame.url } }, "accessibility"),
    /Untrusted/,
  );
  await assert.rejects(call("settings", "__proto__"), /Unknown/);
  await call("settings", "accessibility");
  assert.match(opened[0], /Privacy_Accessibility$/);
  assert.equal((await call("status")).name, "QM-cu");
  assert.equal(await call("close", true), false);
  failure = true;
  await assert.rejects(call("status"), /Native helper unavailable/);
  failure = false;
  allowed = true;
  assert.equal(await call("close", true), true);
  await pending;
  assert.equal(stopped, 1);
  assert.equal(focusComputerPermissions(), false);
  await showComputerPermissions(true);
  assert.equal(windows.length, 1);
  const reopened = showComputerPermissions();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(windows.length, 2);
  windows.at(-1).close();
  await reopened;
});
