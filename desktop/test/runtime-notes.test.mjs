import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../runtime.js", import.meta.url), "utf8");

function runtime(onRequest = () => {}) {
  const window = {
    deskHost: {
      async request(command) {
        onRequest(command);
        const { app } = command;
        if (command.type === "act") return { type: "acted", completed: 1 };
        return {
          type: "observation",
          app,
          bundle_id: app,
          window: "Test window",
          frame: { w: 100, h: 100 },
          elements: 1,
          tree: "[1] TextField",
          diffed: false,
          removed: [],
        };
      },
    },
  };
  vm.runInNewContext(source, { window, console: {} });
  return window;
}

test("app notes emit once per bundle across App objects and output drains", async () => {
  const window = runtime();
  await window.computer.getApp("com.google.Chrome");
  assert.match(window.__drain().text, /App usage notes \(com\.google\.Chrome\)/);
  await window.computer.getApp("com.google.Chrome");
  assert.doesNotMatch(window.__drain().text, /App usage notes/);
  await window.computer.getApp("notion.id");
  assert.match(window.__drain().text, /App usage notes \(notion\.id\)/);
});

test("silent observations do not consume an app's one-time notes", async () => {
  const window = runtime();
  const app = await window.computer.getApp("com.tinyspeck.slackmacgap", { emit: false });
  assert.equal(window.__drain().text, "");
  await app.getAXState();
  assert.match(window.__drain().text, /App usage notes/);
  await app.getAXState();
  assert.doesNotMatch(window.__drain().text, /App usage notes/);
});

test("unknown apps have no invented notes, and a new runtime emits notes again", async () => {
  const window = runtime();
  await window.computer.getApp("test.unknown");
  assert.doesNotMatch(window.__drain().text, /App usage notes/);
  await window.computer.getApp("com.apple.finder");
  assert.match(window.__drain().text, /App usage notes/);
  const next = runtime();
  await next.computer.getApp("com.apple.finder");
  assert.match(next.__drain().text, /App usage notes/);
});

test("setValue forwards explicit submission and rejects invalid options before sending", async () => {
  const calls = [];
  const window = runtime((command) => calls.push(JSON.parse(JSON.stringify(command))));
  const app = await window.computer.getApp("test.app", { emit: false });
  await app.setValue(7, 42, { submit: false });
  assert.deepEqual(calls.at(-1).actions, [{ type: "set_value", index: 7, value: "42", submit: false }]);
  await app.setValue(8, "search", { submit: true });
  assert.equal(calls.at(-1).actions[0].submit, true);
  await app.setValue(9, "unchosen");
  assert.equal(Object.hasOwn(calls.at(-1).actions[0], "submit"), false);
  const before = calls.length;
  assert.throws(() => app.setValue(7, "bad", { submit: "true" }), /must be true or false/);
  assert.equal(calls.length, before);
});
