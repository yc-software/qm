import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const preload = await readFile(new URL("../workspace-preload.cjs", import.meta.url), "utf8");

async function workspace(platform = "darwin") {
  const dom = new JSDOM('<div id="sidebar-body"></div><textarea></textarea>', { runScripts: "outside-only" });
  const { window } = dom;
  window.process = { platform };
  window.require = () => ({ contextBridge: { exposeInMainWorld() {} }, ipcRenderer: { invoke() {} } });
  window.HTMLElement.prototype.checkVisibility = function () {
    return !this.closest("[hidden], .collapsed, .sidebar-closed");
  };
  await new Promise((resolve) => window.addEventListener("DOMContentLoaded", resolve));
  window.eval(preload);
  window.dispatchEvent(new window.Event("DOMContentLoaded"));
  const list = window.document.querySelector("#sidebar-body");
  const opened = [];
  const add = (id, hidden = false) => {
    const row = window.document.createElement("div");
    row.className = "session-row";
    row.dataset.sessionId = id;
    row.hidden = hidden;
    row.innerHTML = `<a class="session" href="/s/${id}">Session ${id}</a>`;
    row.firstChild.addEventListener("click", (event) => {
      event.preventDefault();
      opened.push(id);
    });
    list.append(row);
    return row;
  };
  const key = (key, options = {}, type = "keydown") => {
    const event = new window.KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...options });
    window.document.querySelector("textarea").dispatchEvent(event);
    return event;
  };
  return {
    window,
    list,
    opened,
    add,
    key,
    close: () => {
      window.dispatchEvent(new window.Event("blur"));
      window.close();
    },
  };
}

test("Command shortcuts match expanded sidebar order, exclude hidden and duplicate sessions, and stop at nine", async () => {
  const app = await workspace();
  try {
    app.add("hidden", true);
    app.add("first");
    app.add("first");
    for (let i = 2; i <= 11; i++) app.add(String(i));
    app.key("Meta", { metaKey: true });
    const hints = [...app.list.querySelectorAll("[data-qm-shortcut]")];
    assert.equal(hints.length, 9);
    assert.equal(hints[0].textContent, "Session first");
    assert.equal(hints[8].dataset.qmShortcut, "⌘9");
    assert.equal(app.key("2", { metaKey: true }).defaultPrevented, true);
    assert.deepEqual(app.opened, ["2"]);
    app.key("2", { metaKey: true, repeat: true });
    assert.deepEqual(app.opened, ["2"]);
    assert.equal(app.key("0", { metaKey: true }).defaultPrevented, false);
    app.key("Meta", {}, "keyup");
    assert.equal(app.window.document.documentElement.hasAttribute("data-qm-shortcuts"), false);
  } finally {
    app.close();
  }
});

test("hints follow reordered and removed rows while Command is held and clear on blur", async () => {
  const app = await workspace();
  try {
    const first = app.add("first");
    const second = app.add("second");
    app.key("Meta", { metaKey: true });
    app.list.prepend(second);
    await Promise.resolve();
    assert.equal(second.firstChild.dataset.qmShortcut, "⌘1");
    first.remove();
    await Promise.resolve();
    assert.equal(first.firstChild.hasAttribute("data-qm-shortcut"), false);
    app.key("1", { metaKey: true });
    assert.deepEqual(app.opened, ["second"]);
    app.window.dispatchEvent(new app.window.Event("blur"));
    assert.equal(app.window.document.documentElement.hasAttribute("data-qm-shortcuts"), false);
  } finally {
    app.close();
  }
});

test("modal dialogs, hidden sidebar, composition and extra modifiers do not switch sessions", async () => {
  const app = await workspace();
  try {
    app.add("first");
    for (const options of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { isComposing: true }]) {
      assert.equal(app.key("1", { metaKey: true, ...options }).defaultPrevented, false);
    }
    app.list.classList.add("sidebar-closed");
    app.key("1", { metaKey: true });
    app.list.classList.remove("sidebar-closed");
    const dialog = app.window.document.createElement("dialog");
    dialog.open = true;
    app.window.document.body.append(dialog);
    app.key("1", { metaKey: true });
    assert.deepEqual(app.opened, []);
  } finally {
    app.close();
  }
});

test("non-Mac desktop uses Control without intercepting bare number keys", async () => {
  const app = await workspace("linux");
  try {
    const first = app.add("first");
    app.key("1");
    app.key("1", { metaKey: true });
    assert.deepEqual(app.opened, []);
    app.key("1", { ctrlKey: true });
    assert.deepEqual(app.opened, ["first"]);
    assert.equal(first.firstChild.dataset.qmShortcut, "Ctrl 1");
  } finally {
    app.close();
  }
});

test("the compact sidebar remains a shortcut target when it is an accessible modal drawer", async () => {
  const app = await workspace();
  try {
    const sidebar = app.window.document.createElement("aside");
    sidebar.className = "sidebar";
    sidebar.setAttribute("role", "dialog");
    sidebar.setAttribute("aria-modal", "true");
    app.list.replaceWith(sidebar);
    sidebar.append(app.list);
    app.add("first");
    app.key("1", { metaKey: true });
    assert.deepEqual(app.opened, ["first"]);
  } finally {
    app.close();
  }
});
