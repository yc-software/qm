import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("desktop handoff redeems once, cancels stale completion, and opens the authenticated session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qm-desktop-test-"));
  await writeFile(path.join(directory, "instance.json"), JSON.stringify({ url: "https://old.example/auth/login" }));
  const app = Object.assign(new EventEmitter(), {
    setName() {},
    requestSingleInstanceLock: () => true,
    quit() {},
    whenReady: async () => {},
    getPath: () => directory,
    setAsDefaultProtocolClient() {},
  });
  const handlers = new Map();
  const windows = [];
  const opened = [];
  const requests = [];
  const errors = [];
  let flushes = 0;
  const session = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    cookies: {
      flushStore: async () => {
        flushes++;
      },
    },
    fetch: (url, options) => new Promise((resolve) => requests.push({ url, options, resolve })),
  };
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = Object.assign(new EventEmitter(), {
        session,
        send() {},
        setWindowOpenHandler: (handler) => {
          this.popup = handler;
        },
      });
      windows.push(this);
    }
    async loadURL(url) {
      this.url = url;
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    isDestroyed() {
      return !!this.destroyed;
    }
    close() {
      this.destroy();
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  mock.module("electron", {
    namedExports: {
      app,
      BrowserWindow,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} },
      shell: {
        openExternal: async (url) => {
          opened.push(url);
        },
      },
      session: { fromPartition: () => session },
      dialog: { showErrorBox: (...args) => errors.push(args), showMessageBox: async (...args) => errors.push(args) },
    },
  });
  const original = process.env.QM_DESKTOP_URL;
  delete process.env.QM_DESKTOP_URL;
  try {
    await import("../main.mjs");
    for (let n = 0; n < 100 && !windows.length; n++) await tick();
    assert.equal(windows[0].url, "https://old.example/");
    let prevented = false;
    windows[0].webContents.emit(
      "will-redirect",
      {
        preventDefault() {
          prevented = true;
        },
      },
      "https://old.example/auth/login",
    );
    assert.equal(prevented, true);
    assert.equal(opened.length, 1);
    const callback = (index) =>
      `qm-desktop://auth/callback?code=test-code&state=${new URL(opened[index]).searchParams.get("state")}`;
    const event = { preventDefault() {} };
    app.emit("open-url", event, callback(0));
    app.emit("open-url", event, callback(0));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.credentials, "include");
    const setup = windows[1];
    assert.deepEqual(
      await handlers.get("qm:connect")(
        { sender: setup.webContents, senderFrame: { url: setup.url } },
        "https://new.example/",
      ),
      { ok: true },
    );
    assert.equal(requests[0].options.signal.aborted, true);
    requests[0].resolve({ ok: true });
    await tick();
    assert.equal(windows.length, 3);
    assert.equal(windows[2].url, "https://new.example/");
    assert.equal(windows[2].isDestroyed(), false);
    assert.equal(flushes, 0);
    assert.deepEqual(windows[2].popup({ url: "https://new.example/auth/trusted/login" }), { action: "deny" });
    assert.equal(opened.length, 2);
    app.emit("open-url", event, callback(1));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "https://new.example/auth/desktop/redeem");
    requests[1].resolve({ ok: true });
    await tick();
    assert.equal(flushes, 1);
    assert.equal(windows.at(-1).url, "https://new.example/");
    assert.equal(windows[3].isDestroyed(), true);
    assert.deepEqual(errors, []);
  } finally {
    if (original === undefined) delete process.env.QM_DESKTOP_URL;
    else process.env.QM_DESKTOP_URL = original;
    mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
});
