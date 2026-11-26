import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../runtime.js", import.meta.url), "utf8");

const observation = {
  type: "observation",
  app: "Fixture",
  pid: 100,
  window_id: 200,
  window: "Document",
  frame: { x: 0, y: 0, w: 100, h: 100 },
  elements: 1,
  tree: "[1] Button",
  diffed: false,
  removed: [],
};

function runtime(answer) {
  const calls = [];
  const window = {
    deskHost: {
      async request(command) {
        calls.push(JSON.parse(JSON.stringify(command)));
        const reply = answer?.(command);
        if (reply) return reply;
        if (command.type === "act") return { type: "acted", completed: 1 };
        return structuredClone(observation);
      },
    },
  };
  vm.runInNewContext(source, {
    window,
    console: {},
    Blob,
    atob,
    btoa,
    createImageBitmap: async () => ({ width: 100, height: 100, close() {} }),
    OffscreenCanvas: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage() {} };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array([1])]);
      }
    },
  });
  return { window, calls };
}

test("a screenshot-only request asks desk to skip the tree walk", async () => {
  const { window, calls } = runtime((command) =>
    command.type === "observe" && command.screenshot
      ? {
          ...structuredClone(observation),
          tree: "",
          elements: 0,
          screenshot: { png_base64: "", frame: observation.frame },
        }
      : undefined,
  );
  const app = await window.computer.getApp("Fixture", { emit: false });
  assert.equal(calls.at(-1).tree, true);
  await app.getScreenshot();
  assert.equal(calls.at(-1).tree, false);
  assert.equal(calls.at(-1).screenshot, true);
  const out = window.__drain();
  assert.doesNotMatch(out.text, /Button/);
  assert.equal(out.images.length, 1);
});

test("a failed screenshot still returns and emits the tree that was built", async () => {
  const { window } = runtime((command) =>
    command.screenshot
      ? { ...structuredClone(observation), screenshot_error: "Screen Recording not granted" }
      : undefined,
  );
  const app = await window.computer.getApp("Fixture", { emit: false });
  const state = await app.getAXStateAndScreenshot();
  const { text, images } = window.__drain();
  assert.match(text, /\[1\] Button/);
  assert.match(text, /\[screenshot unavailable: Screen Recording not granted\]/);
  assert.equal(images.length, 0);
  assert.equal(state.tree, "[1] Button");
  assert.throws(() => app.click([5, 5]), /Get a current screenshot/);
});

test("expect conditions are sent with the action and their outcomes are reported", async () => {
  const outcomes = [
    { status: "verified", detail: "element 40 is gone" },
    { status: "already", detail: "element 40 is gone before the action, so it was not sent" },
    { status: "unmet", detail: "after 2000 ms, element 40 is still present" },
  ];
  const { window, calls } = runtime((command) =>
    command.type === "act" && command.expect ? { type: "acted", completed: 1, outcome: outcomes.shift() } : undefined,
  );
  const app = await window.computer.getApp("Fixture", { emit: false });
  assert.deepEqual(JSON.parse(JSON.stringify(await app.click(12, { expect: { gone: 40 } }))), {
    status: "verified",
    detail: "element 40 is gone",
  });
  assert.deepEqual(calls.at(-1).expect, { condition: { type: "gone", index: 40 } });
  assert.equal((await app.click(12, { expect: { gone: 40 } })).status, "already");
  assert.equal((await app.pressKey("escape", { expect: { noWindow: "Save", timeoutMs: 500 } })).status, "unmet");
  assert.deepEqual(calls.at(-1).expect, { condition: { type: "window", title: "Save", open: false }, timeout_ms: 500 });
  assert.equal(
    window.__drain().text,
    [
      "Outcome (verified): element 40 is gone",
      "Outcome (already): element 40 is gone before the action, so it was not sent",
      "Outcome (unmet): after 2000 ms, element 40 is still present",
    ].join("\n"),
  );
  await app.setValue(7, true, { expect: { value: 9, equals: true } });
  assert.deepEqual(calls.at(-1).expect.condition, { type: "value", index: 9, equals: "true" });
  await app.typeText("hi", { expect: { window: "Saved" } });
  assert.deepEqual(calls.at(-1).expect.condition, { type: "window", title: "Saved", open: true });
  assert.equal(await app.scroll(null, "down"), undefined);
  assert.equal(Object.hasOwn(calls.at(-1), "expect"), false);
});

test("malformed expectations are refused before anything is sent", async () => {
  const { window, calls } = runtime();
  const app = await window.computer.getApp("Fixture", { emit: false });
  const before = calls.length;
  assert.throws(() => app.click(1, { expect: { gone: 1, window: "Save" } }), /exactly one of/);
  assert.throws(() => app.click(1, { expect: { closed: 1 } }), /exactly one of/);
  assert.throws(() => app.click(1, { expect: { value: 3 } }), /needs equals/);
  assert.throws(() => app.click(1, { expect: { gone: 3, equals: "x" } }), /needs equals/);
  assert.throws(() => app.click(1, { expect: { gone: "3" } }), /element id/);
  assert.throws(() => app.click(1, { expect: { window: "" } }), /window title/);
  assert.throws(() => app.click(1, { expect: { gone: 3, timeoutMs: 1.5 } }), /timeoutMs/);
  assert.throws(() => app.typeText("x", { expect: null }), /must be an object/);
  assert.equal(calls.length, before);
});

test("windows can be listed and one targeted for observations and actions", async () => {
  const windows = [
    {
      id: 200,
      title: "Document",
      role: "AXWindow",
      subrole: "AXStandardWindow",
      frame: observation.frame,
      focused: true,
      main: true,
      minimized: false,
      parent: null,
    },
    {
      id: 300,
      title: "Inspector",
      role: "AXWindow",
      subrole: "AXFloatingWindow",
      frame: { x: 0, y: 0, w: 50.4, h: 80 },
      focused: false,
      main: false,
      minimized: false,
      parent: null,
    },
    {
      id: 301,
      title: "Export",
      role: "AXWindow",
      subrole: "AXSheet",
      frame: null,
      focused: false,
      main: false,
      minimized: false,
      parent: 200,
    },
  ];
  const { window, calls } = runtime((command) => {
    if (command.type === "windows") return { type: "windows", windows: structuredClone(windows) };
    if (command.type === "observe" && command.window === 999)
      return { type: "error", code: "no_window", message: "Fixture has no open window 999" };
    return undefined;
  });
  const app = await window.computer.getApp("Fixture", { emit: false });
  assert.equal(Object.hasOwn(calls.at(-1), "window"), false);
  const listed = await app.listWindows();
  assert.equal(listed.length, 3);
  assert.equal(
    window.__drain().text,
    [
      '[200] StandardWindow "Document" 100x100 (focused, main)',
      '[300] FloatingWindow "Inspector" 50x80',
      '[301] Sheet "Export" (sheet of 200)',
    ].join("\n"),
  );
  await app.useWindow(300);
  assert.deepEqual([calls.at(-1).type, calls.at(-1).window, calls.at(-1).diff], ["observe", 300, false]);
  await app.click(4);
  assert.equal(calls.at(-1).window, 300);
  await app.listWindows();
  assert.match(window.__drain().text, /\[300\] FloatingWindow "Inspector" 50x80 \(targeted\)/);
  await assert.rejects(app.useWindow(999), /no open window 999/);
  await app.getAXState();
  assert.equal(calls.at(-1).window, 300);
  await assert.rejects(app.useWindow(1.5), /window id from listWindows/);
  await app.useWindow(null);
  assert.equal(Object.hasOwn(calls.at(-1), "window"), false);
});
