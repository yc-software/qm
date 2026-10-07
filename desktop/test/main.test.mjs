import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test(
  "desktop handoff redeems once, cancels stale completion, and opens the authenticated session",
  { timeout: 10_000 },
  async () => {
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
    const initialLoad = Promise.withResolvers();
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
          getURL: () => this.url,
          send() {},
          setWindowOpenHandler: (handler) => {
            this.popup = handler;
          },
        });
        windows.push(this);
      }
      async loadURL(url) {
        this.url = url;
        initialLoad.resolve();
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
      await initialLoad.promise;
      assert.equal(windows[0].url, "https://old.example/");
      for (const destination of ["about:blank", "https://old.example/file.pdf", "blob:https://old.example/id"]) {
        const popup = windows[0].popup({ url: destination });
        assert.equal(popup.action, "allow");
        assert.equal(popup.overrideBrowserWindowOptions.webPreferences.sandbox, true);
        assert.equal(popup.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
        assert.equal(popup.overrideBrowserWindowOptions.webPreferences.preload.endsWith("workspace-preload.cjs"), true);
      }
      assert.equal(windows[0].url, "https://old.example/");
      assert.deepEqual(windows[0].popup({ url: "file:///tmp/private" }), { action: "deny" });
      assert.equal(opened.length, 0);
      const frame = { url: "https://old.example/" };
      windows[0].webContents.mainFrame = frame;
      const browserEvent = { sender: windows[0].webContents, senderFrame: frame };
      await assert.rejects(handlers.get("qm:open-browser")(browserEvent, "https://evil.example/"));
      await assert.rejects(
        handlers.get("qm:open-browser")({ ...browserEvent, senderFrame: { url: frame.url } }, "/settings"),
      );
      await assert.rejects(handlers.get("qm:open-browser")(browserEvent, "https://user:pass@old.example/"));
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
      assert.equal(windows[0].isDestroyed(), true);
      windows[0].webContents.emit("will-redirect", { preventDefault() {} }, "https://old.example/auth/login");
      assert.equal(opened.length, 1);
      const callback = (index) => {
        const browser = new URL(opened[index]);
        const request = browser.searchParams.has("returnTo")
          ? new URL(browser.searchParams.get("returnTo"), browser)
          : browser;
        return `qm-desktop://auth/callback?code=test-code&state=${request.searchParams.get("state")}`;
      };
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
      assert.deepEqual(
        windows[2].popup({
          url: "https://new.example/auth/trusted/login?returnTo=%2Fdrop%2Ftest%2Fform%3Ft%3Dtest-token",
        }),
        { action: "deny" },
      );
      assert.equal(opened.length, 2);
      app.emit("open-url", event, callback(1));
      assert.equal(requests.length, 2);
      assert.equal(requests[1].url, "https://new.example/auth/desktop/redeem");
      requests[1].resolve({ ok: true });
      await tick();
      assert.equal(flushes, 1);
      assert.equal(windows.at(-1).url, "https://new.example/drop/test/form?t=test-token");
      assert.equal(new URL(opened[1]).pathname, "/auth/trusted/login");
      assert.equal(opened[1].includes("test-token"), false);
      assert.equal(windows[3].isDestroyed(), true);
      const active = windows.at(-1);
      const child = new BrowserWindow({});
      child.url = "https://new.example/file.pdf";
      active.webContents.emit("did-create-window", child);
      let blockedChild = false;
      child.webContents.emit(
        "will-navigate",
        {
          preventDefault() {
            blockedChild = true;
          },
        },
        "file:///tmp/private",
      );
      assert.equal(blockedChild, true);
      assert.equal(active.isDestroyed(), false);
      active.webContents.emit("will-redirect", { preventDefault() {} }, "https://new.example/auth/login");
      assert.equal(child.isDestroyed(), true);
      const cancelled = windows.at(-1);
      cancelled.close();
      app.emit("open-url", event, callback(2));
      await tick();
      assert.equal(requests.length, 2);
      assert.deepEqual(errors, []);
    } finally {
      if (original === undefined) delete process.env.QM_DESKTOP_URL;
      else process.env.QM_DESKTOP_URL = original;
      mock.restoreAll();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
