import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { render } = await import("lit");
const { groupAvatarStackTpl } = await import("../src/group-avatars.ts");

function mount(...args: Parameters<typeof groupAvatarStackTpl>): HTMLElement {
  const host = document.createElement("div");
  render(groupAvatarStackTpl(...args), host);
  return host;
}

test("group avatar stack shows photos, initials, and the extra class", () => {
  const host = mount(
    [
      { principalId: "a", displayName: "Maya", avatarUrl: "https://example.test/maya.png" },
      { principalId: "b", displayName: "theo" },
    ],
    "context-row-avatars",
  );
  const stack = host.querySelector(".group-avatar-stack.context-row-avatars")!;
  assert.equal(stack.getAttribute("aria-label"), "With Maya, theo");
  assert.equal(stack.querySelector("img.group-avatar")?.getAttribute("src"), "https://example.test/maya.png");
  assert.equal(stack.querySelector(".group-avatar.initial")?.textContent, "T");
});

test("group avatar stack caps at two faces plus a count past three members", () => {
  const people = ["A", "B", "C", "D"].map((name) => ({ principalId: name, displayName: name }));
  const host = mount(people);
  assert.equal(host.querySelectorAll(".group-avatar.initial").length, 2);
  assert.equal(host.querySelector(".group-avatar.more")?.textContent, "+2");
});

test("group avatar stack renders nothing without members", () => {
  assert.equal(mount([]).querySelector(".group-avatar-stack"), null);
});
