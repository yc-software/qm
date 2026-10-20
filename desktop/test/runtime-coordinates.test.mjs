import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../runtime.js", import.meta.url), "utf8");

test("coordinate actions require a screenshot of the current process, window and geometry", async () => {
  const calls = [];
  const observation = {
    app: "Fixture",
    pid: 100,
    window_id: 200,
    window: "Document",
    frame: { x: 10, y: 20, w: 100, h: 100 },
    elements: 1,
    tree: "[1] Button",
    diffed: false,
    removed: [],
  };
  const window = {
    deskHost: {
      async request(command) {
        calls.push(JSON.parse(JSON.stringify(command)));
        if (command.type === "act") return { type: "acted", completed: 1 };
        return {
          type: "observation",
          ...structuredClone(observation),
          ...(command.screenshot
            ? { screenshot: { png_base64: "", frame: { ...observation.frame, x: observation.frame.x - 10, w: 200 } } }
            : {}),
        };
      },
    },
  };
  vm.runInNewContext(source, {
    window,
    console: {},
    Blob,
    atob,
    btoa,
    createImageBitmap: async () => ({ width: 400, height: 200, close() {} }),
    OffscreenCanvas: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage() {} };
      }
      async convertToBlob() {
        return new Blob(["fixture"]);
      }
    },
  });
  const app = await window.computer.getApp("Fixture", { emit: false });
  assert.throws(() => app.click([20, 10]), /screenshot/i);
  await app.getScreenshot({ emit: false });
  await app.getAXState({ emit: false });
  await app.click([20, 10]);
  assert.deepEqual(calls.at(-1).actions[0].target.point, { x: 0, y: 5 });
  const alias = await window.computer.getApp("/Applications/Fixture.app", { emit: false });
  await app.click([20, 10]);
  observation.window_id += 1;
  await alias.getAXState({ emit: false });
  const beforeAliasClick = calls.length;
  assert.throws(() => app.click([20, 10]), /screenshot/i);
  assert.equal(calls.length, beforeAliasClick);
  await app.getScreenshot({ emit: false });
  for (const change of [
    () => {
      observation.frame.w += 10;
    },
    () => {
      observation.frame.x -= 20;
    },
    () => {
      observation.window_id += 1;
    },
    () => {
      observation.pid += 1;
    },
  ]) {
    change();
    await app.getAXState({ emit: false });
    const before = calls.length;
    assert.throws(() => app.click([20, 10]), /screenshot/i);
    assert.equal(calls.length, before);
    await app.click(1);
    await app.getScreenshot({ emit: false });
    await app.click([20, 10]);
    assert.deepEqual(calls.at(-1).actions[0].target.point, { x: 0, y: 5 });
  }
  const nativeWindowId = observation.window_id;
  for (const invalidId of [undefined, null, 0, -1, 0.5, 0x100000000, "200"]) {
    observation.window_id = invalidId;
    await assert.rejects(alias.getAXState({ emit: false }), /native window ID/);
    const before = calls.length;
    assert.throws(() => app.click([20, 10]), /screenshot/i);
    assert.equal(calls.length, before);
    await assert.rejects(app.getScreenshot({ emit: false }), /native window ID/);
    assert.throws(() => app.click([20, 10]), /screenshot/i);
    observation.window_id = nativeWindowId;
    await app.getScreenshot({ emit: false });
    await app.click([20, 10]);
  }
});

test("screenshot conversion releases decoded pixels after drawing and on drawing failure", async () => {
  for (const fail of [false, true]) {
    const events = [];
    const window = {
      deskHost: {
        async request() {
          return {
            type: "observation",
            app: "Fixture",
            window: "Document",
            pid: 1,
            window_id: 2,
            frame: { x: 0, y: 0, w: 2000, h: 1000 },
            elements: 0,
            tree: "",
            diffed: false,
            removed: [],
            screenshot: { png_base64: "" },
          };
        },
      },
    };
    vm.runInNewContext(source, {
      window,
      console: {},
      Blob,
      atob,
      btoa,
      createImageBitmap: async () => ({
        width: 2000,
        height: 1000,
        close() {
          events.push("close");
        },
      }),
      OffscreenCanvas: class {
        constructor(width, height) {
          this.width = width;
          this.height = height;
        }
        getContext() {
          return {
            drawImage() {
              events.push("draw");
              if (fail) throw new Error("draw failed");
            },
          };
        }
        async convertToBlob() {
          events.push("encode");
          return new Blob(["fixture"]);
        }
      },
    });
    const pending = window.computer.getApp("Fixture", { emit: false });
    if (fail) {
      await assert.rejects(pending, /draw failed/);
      assert.deepEqual(events, ["draw", "close"]);
    } else {
      const app = await pending;
      assert.deepEqual(events, ["draw", "close", "encode"]);
      assert.deepEqual(JSON.parse(JSON.stringify(await app.getScreenshot({ emit: false }))), {
        width: 1568,
        height: 784,
      });
    }
  }
});
