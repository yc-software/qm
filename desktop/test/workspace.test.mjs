import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const preload = await readFile(new URL("../workspace-preload.cjs", import.meta.url), "utf8");

async function workspace(platform = "darwin") {
  const dom = new JSDOM('<div id="sidebar-body"></div><textarea></textarea>', { runScripts: "outside-only" });
  const { window } = dom;
  window.process = { platform };
  const listeners = new Map();
  window.require = () => ({
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: { invoke() {}, on: (name, listener) => listeners.set(name, listener) },
  });
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
    cycle: (step) => listeners.get("qm:cycle-tab")({}, step),
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

function panes(app, layout) {
  const dock = app.window.document.createElement("div");
  dock.className = "split-dock";
  const activated = [];
  const groups = layout.map(({ tabs, active = 0, focused = false }, g) => {
    const group = app.window.document.createElement("div");
    group.className = `dv-groupview ${focused ? "dv-active-group" : "dv-inactive-group"}`;
    group.innerHTML = '<div class="dv-tabs-and-actions-container"><div class="dv-tabs-container"></div></div>';
    const strip = group.querySelector(".dv-tabs-container");
    tabs.forEach((name, t) => {
      const tab = app.window.document.createElement("div");
      tab.className = `dv-tab${t === active ? " dv-active-tab" : ""}`;
      tab.textContent = name;
      tab.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        activated.push(`${g}:${name}`);
        for (const other of strip.children) other.classList.toggle("dv-active-tab", other === tab);
      });
      strip.append(tab);
    });
    dock.append(group);
    return group;
  });
  app.window.document.body.append(dock);
  return { activated, groups, dock };
}

test("cycle-tab commands move through the focused pane's tabs in strip order, wrap, and follow iframe focus", async () => {
  const app = await workspace();
  try {
    const { activated, groups } = panes(app, [
      { tabs: ["a", "b"] },
      { tabs: ["x", "y", "z"], active: 1, focused: true },
    ]);
    for (const step of [1, 1, -1, -1, -1]) app.cycle(step);
    assert.deepEqual(activated, ["1:z", "1:x", "1:z", "1:y", "1:x"]);
    const frame = app.window.document.createElement("iframe");
    groups[0].append(frame);
    frame.focus();
    app.cycle(1);
    assert.deepEqual(activated.slice(5), ["0:b"]);
  } finally {
    app.close();
  }
});

test("cycle-tab commands do nothing for single-tab panes, hidden canvases or open dialogs", async () => {
  const app = await workspace();
  try {
    const { activated, groups, dock } = panes(app, [{ tabs: ["only"], focused: true }, { tabs: ["a", "b"] }]);
    app.cycle(1);
    groups[0].classList.replace("dv-active-group", "dv-inactive-group");
    groups[1].classList.replace("dv-inactive-group", "dv-active-group");
    const dialog = app.window.document.createElement("dialog");
    dialog.open = true;
    app.window.document.body.append(dialog);
    app.cycle(1);
    dialog.remove();
    dock.hidden = true;
    app.cycle(1);
    assert.deepEqual(activated, []);
  } finally {
    app.close();
  }
});
