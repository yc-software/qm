import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

test("permission view renders checks, reacts to grants, and sends settings and drag requests", async () => {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(await readFile(new URL("../permissions.html", import.meta.url), "utf8"), {
    runScripts: "dangerously",
    virtualConsole,
  });
  let ready = false;
  let dragged = false;
  let pane;
  dom.window.permissions = {
    status: async () => ({
      name: "QM-cu",
      accessibility: ready,
      screen_recording: ready,
      icon: "data:image/png;base64,AA==",
    }),
    settings: async (value) => {
      pane = value;
    },
    drag: () => {
      dragged = true;
    },
  };
  try {
    const document = dom.window.document;
    const script = document.createElement("script");
    script.textContent = await readFile(new URL("../permissions.js", import.meta.url), "utf8");
    document.body.append(script);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, []);
    assert.match(document.querySelector("h1").textContent, /QM-cu/);
    assert.equal(document.getElementById("accessibility-status").textContent, "Needs access");
    document.querySelector('[data-settings="accessibility"]').click();
    assert.equal(pane, "accessibility");
    document.getElementById("drag").dispatchEvent(new dom.window.Event("dragstart", { cancelable: true }));
    assert.equal(dragged, true);
    document.querySelector('[data-settings="screen_recording"]').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pane, "screen_recording");
    assert.match(document.getElementById("destination").textContent, /Screen & System Audio Recording/);
    ready = true;
    document.getElementById("check").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(document.getElementById("continue").hidden, false);
    assert.equal(document.getElementById("enable").hidden, true);
  } finally {
    dom.window.close();
  }
});
