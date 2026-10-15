import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domSnapshot } from "./browser-snapshot.mjs";
import { withBrowserCleanup as withCleanup } from "./browser-errors.mjs";

const keyAliases = {
  CTRL: "Control",
  CONTROL: "Control",
  CMD: "Meta",
  COMMAND: "Meta",
  META: "Meta",
  ALT: "Alt",
  OPTION: "Alt",
  SHIFT: "Shift",
  ENTER: "Enter",
  RETURN: "Enter",
  ESC: "Escape",
  ESCAPE: "Escape",
  TAB: "Tab",
  SPACE: "Space",
  BACKSPACE: "Backspace",
  DELETE: "Delete",
  UP: "ArrowUp",
  DOWN: "ArrowDown",
  LEFT: "ArrowLeft",
  RIGHT: "ArrowRight",
  ARROWUP: "ArrowUp",
  ARROWDOWN: "ArrowDown",
  ARROWLEFT: "ArrowLeft",
  ARROWRIGHT: "ArrowRight",
  HOME: "Home",
  END: "End",
  PAGEUP: "PageUp",
  PAGEDOWN: "PageDown",
};
const keyName = (key) => keyAliases[key.toUpperCase()] || key;

async function withKeys(page, keys, action) {
  const held = [];
  const errors = [];
  let result;
  try {
    for (const key of keys || []) {
      held.push(keyName(key));
      await page.keyboard.down(held.at(-1));
    }
    result = await action();
  } catch (error) {
    errors.push(error);
  } finally {
    for (const key of held.reverse()) {
      try {
        await page.keyboard.up(key);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Browser input and key cleanup failed");
  return result;
}

function coordinateInput(page) {
  return {
    click: ({ x, y, button = 1, keypress = [] }) =>
      withKeys(page, keypress, async () => {
        if (button !== 4 && button !== 5)
          return page.mouse.click(x, y, { button: { 1: "left", 2: "middle", 3: "right" }[button] || button });
        const session = await page.context().newCDPSession(page);
        const modifiers = keypress
          .map(keyName)
          .reduce((mask, key) => mask | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[key] || 0), 0);
        const event = { x, y, button: button === 4 ? "back" : "forward", clickCount: 1, modifiers };
        return withCleanup(
          () =>
            session.send("Input.dispatchMouseEvent", {
              ...event,
              type: "mousePressed",
              buttons: button === 4 ? 8 : 16,
            }),
          () => session.send("Input.dispatchMouseEvent", { ...event, type: "mouseReleased", buttons: 0 }),
          () => session.detach(),
        );
      }),
    double_click: ({ x, y, keypress = [] }) => withKeys(page, keypress, () => page.mouse.dblclick(x, y)),
    move: ({ x, y, keys = [] }) => withKeys(page, keys, () => page.mouse.move(x, y)),
    drag: ({ path, keys = [] }) =>
      withKeys(page, keys, async () => {
        if (!path?.length) throw new Error("drag requires a nonempty path");
        await page.mouse.move(path[0].x, path[0].y);
        return withCleanup(
          async () => {
            await page.mouse.down();
            for (const point of path.slice(1)) await page.mouse.move(point.x, point.y);
          },
          () => page.mouse.up(),
        );
      }),
    scroll: ({ x, y, scrollX = 0, scrollY = 0, keypress = [] }) =>
      withKeys(page, keypress, async () => {
        await page.mouse.move(x, y);
        await page.mouse.wheel(scrollX, scrollY);
      }),
    keypress: ({ keys }) => withKeys(page, keys, async () => {}),
    type: ({ text }) => page.keyboard.insertText(text),
  };
}

function clipboard(page) {
  return {
    readText: () => page.evaluate(() => navigator.clipboard.readText()),
    writeText: (text) => page.evaluate((value) => navigator.clipboard.writeText(value), text),
    read: () =>
      page.evaluate(async () =>
        Promise.all(
          (await navigator.clipboard.read()).map(async (item) => ({
            presentationStyle: item.presentationStyle,
            entries: await Promise.all(
              item.types.map(async (type) => {
                const blob = await item.getType(type);
                if (type.startsWith("text/")) return { mimeType: type, text: await blob.text() };
                const bytes = new Uint8Array(await blob.arrayBuffer());
                let binary = "";
                for (const byte of bytes) binary += String.fromCharCode(byte);
                return { mimeType: type, base64: btoa(binary) };
              }),
            ),
          })),
        ),
      ),
    write: (items) =>
      page.evaluate(
        async (data) =>
          navigator.clipboard.write(
            data.map(
              (item) =>
                new globalThis.ClipboardItem(
                  Object.fromEntries(
                    item.entries.map((entry) => {
                      if ((typeof entry.text === "string") === (typeof entry.base64 === "string"))
                        throw new Error("Clipboard entry requires exactly one of text or base64");
                      const content =
                        entry.text ?? Uint8Array.from(atob(entry.base64), (character) => character.charCodeAt(0));
                      return [entry.mimeType, new Blob([content], { type: entry.mimeType })];
                    }),
                  ),
                  { presentationStyle: item.presentationStyle || "unspecified" },
                ),
            ),
          ),
        items,
      ),
  };
}

export function createBrowserClient(nativeBrowser, options = {}) {
  const tabs = new WeakMap();
  const pages = () => nativeBrowser.contexts().flatMap((context) => context.pages());
  function tab(page) {
    if (tabs.has(page)) return tabs.get(page);
    const cua = coordinateInput(page);
    const snapshot = (settings) => domSnapshot(page, settings);
    const expectNavigation = async (action, { timeoutMs, ...settings } = {}) => {
      const [response] = await Promise.all([
        page.waitForNavigation({ ...settings, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) }),
        Promise.resolve().then(action),
      ]);
      return response;
    };
    if (!("domSnapshot" in page)) page.domSnapshot = snapshot;
    if (!("expectNavigation" in page)) page.expectNavigation = expectNavigation;
    const result = {
      id: page._guid,
      playwright: page,
      goto: (...args) => page.goto(...args),
      back: (...args) => page.goBack(...args),
      forward: (...args) => page.goForward(...args),
      reload: (...args) => page.reload(...args),
      close: (...args) => page.close(...args),
      title: () => page.title(),
      url: () => page.url(),
      evaluate: (...args) => page.evaluate(...args),
      screenshot: async (settings = {}) => {
        if (typeof settings === "string") settings = { path: settings };
        const path =
          settings.path || join(options.outputDir || tmpdir(), `browser-${randomUUID()}.${settings.type || "png"}`);
        await page.screenshot({ ...settings, path });
        return path;
      },
      getJsDialog: ({ timeoutMs, ...settings } = {}) =>
        page.waitForEvent("dialog", {
          ...settings,
          ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
        }),
      cua,
      dom_cua: {
        get_visible_dom: snapshot,
        locator: (node_id) => page.getByRef(node_id),
        click: ({ node_id, ...settings }) => page.getByRef(node_id).click(settings),
        double_click: ({ node_id, ...settings }) => page.getByRef(node_id).dblclick(settings),
        scroll: async ({ node_id, x = 0, y = 0 }) => {
          if (node_id) await page.getByRef(node_id).hover();
          await page.mouse.wheel(x, y);
        },
        type: cua.type,
        keypress: cua.keypress,
      },
      clipboard: clipboard(page),
      dev: {
        logs: async ({ filter, levels, limit = 200 } = {}) => {
          if (limit === 0) return [];
          const messages = await page.consoleMessages();
          return messages
            .map((message) => ({
              level: message.type() === "warning" ? "warn" : message.type(),
              message: message.text(),
              location: message.location(),
            }))
            .filter((entry) => (!levels || levels.includes(entry.level)) && (!filter || entry.message.includes(filter)))
            .slice(-Math.max(0, limit));
        },
      },
    };
    tabs.set(page, result);
    options.extendTab?.(result, page);
    return result;
  }
  return {
    playwright: nativeBrowser,
    tabs: {
      list: async () =>
        Promise.all(pages().map(async (page) => ({ id: tab(page).id, title: await page.title(), url: page.url() }))),
      get: (id) => {
        const page = pages().find((candidate) => candidate._guid === id);
        if (!page) throw new Error(`No open tab with id ${id}`);
        return tab(page);
      },
      selected: async () => {
        const candidates = pages().reverse();
        for (const page of candidates) if (await page.evaluate(() => globalThis.document.hasFocus())) return tab(page);
        return candidates[0] ? tab(candidates[0]) : undefined;
      },
      new: async (url, settings) => {
        const context = options.context || nativeBrowser.contexts()[0] || (await nativeBrowser.newContext());
        const page = await context.newPage();
        if (url) await page.goto(url, settings);
        return tab(page);
      },
      content: async () =>
        Promise.all(pages().map(async (page) => ({ id: tab(page).id, content: await domSnapshot(page) }))),
    },
  };
}
