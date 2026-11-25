import assert from "node:assert/strict";
import { mock, test } from "node:test";

let windows = 0;
const values = { "__drain()": { text: "", images: [] }, __docs: "DOCS" };
const evaluate = async (_method, { expression }) =>
  expression in values
    ? { result: { value: values[expression] } }
    : { result: { type: "number", description: expression } };
class Window {
  webContents = { setWindowOpenHandler() {}, on() {}, debugger: { attach() {}, sendCommand: evaluate } };
  constructor() {
    windows++;
  }
  loadFile = async () => {};
  isDestroyed = () => false;
  destroy() {}
}
const partition = { webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {} };
mock.module("electron", {
  namedExports: { BrowserWindow: Window, ipcMain: { handle() {} }, session: { fromPartition: () => partition } },
});
mock.module("../desk.mjs", { namedExports: { desk: { stop() {}, request: async () => ({}) } } });
const { callComputer, stopComputer } = await import("../runtime.mjs");
const run = async (code, client, ms = 30_000) => (await callComputer({ code }, client, Date.now() + ms)).content;

test("the next turn takes over the computer right after the last one, with fresh state", async () => {
  assert.match(await run("1", "w:a"), /^DOCS[\s\S]*=> 1/);
  assert.doesNotMatch(await run("2", "w:a"), /DOCS/);
  const opened = windows;
  assert.match(await run("3", "w:b"), /^DOCS[\s\S]*=> 3/);
  assert.equal(windows, opened + 1);
  stopComputer("w:b");
  await assert.rejects(run("4", "w:b"), /Desktop turn has ended/);
  assert.match(await run("5", "w:c"), /=> 5/);
});
