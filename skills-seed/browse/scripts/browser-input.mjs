import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function installBrowserInput(browser, modulePath) {
  const { version } = JSON.parse(await readFile(join(dirname(modulePath), "package.json"), "utf8"));
  if (version !== "1.64.0") throw new Error("Browser input requires Playwright 1.64.0");
  const server = browser._connection?.toImpl?.(browser);
  if (!(server?._crPages instanceof Map) || !server.instrumentation?.addListener || !server._platform)
    throw new Error("Browser input requires the pinned in-process Chromium server");
  const keyboards = new Map();
  const modifier = server._platform() === "mac" ? "Meta" : "Control";
  const resolve = (key) => (key === "ControlOrMeta" ? modifier : key);
  const prepare = () => {
    for (const page of server._crPages.values()) {
      const keyboard = page._page.keyboard;
      if (keyboards.has(keyboard)) continue;
      const originals = { down: keyboard.down, up: keyboard.up, ensureModifiers: keyboard.ensureModifiers };
      keyboard.down = function (progress, key) {
        return originals.down.call(this, progress, resolve(key));
      };
      keyboard.up = function (progress, key) {
        return originals.up.call(this, progress, resolve(key));
      };
      keyboard.ensureModifiers = function (progress, modifiers) {
        return originals.ensureModifiers.call(this, progress, modifiers.map(resolve));
      };
      keyboards.set(keyboard, originals);
    }
  };
  const listener = {
    onBeforeCall(_progress, object) {
      if (object.attribution.browser === server) prepare();
    },
    onPageOpen(page) {
      if (page.attribution.browser === server) prepare();
    },
    onPageClose(page) {
      const keyboard = page.keyboard;
      const originals = keyboards.get(keyboard);
      if (originals) Object.assign(keyboard, originals);
      keyboards.delete(keyboard);
    },
  };
  server.instrumentation.addListener(listener, null);
  prepare();
  const dispose = () => {
    browser.off("disconnected", dispose);
    server.instrumentation.removeListener(listener);
    for (const [keyboard, originals] of keyboards) Object.assign(keyboard, originals);
    keyboards.clear();
  };
  browser.on("disconnected", dispose);
  return dispose;
}
