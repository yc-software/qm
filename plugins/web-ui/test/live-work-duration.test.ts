import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { WorkBlock } from "../src/core-bridge.ts";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement", "Document", "CSSStyleSheet", "customElements"] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
const { html, render, nothing } = await import("lit");
const { liveWorkDuration } = await import("../src/live-work-duration.ts");

test("the live label advances between chat renders and stops when disconnected", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 157_980 });
  const work: WorkBlock = { status: "working", startedAt: 100_000, activity: [] };
  const host = document.createElement("div");
  const part = render(html`${liveWorkDuration(work)}`, host);
  assert.equal(host.textContent, "57s");
  t.mock.timers.tick(50);
  assert.equal(host.textContent, "58s");
  part.setConnected(false);
  t.mock.timers.tick(1000);
  assert.equal(host.textContent, "58s");
  part.setConnected(true);
  assert.equal(host.textContent, "59s");
  t.mock.timers.tick(1000);
  assert.equal(host.textContent, "1m 0s");
  render(nothing, host);
  t.mock.timers.tick(100);
  assert.equal(host.textContent, "");
});

test("approval waits keep their recorded duration", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 157_230 });
  const work: WorkBlock = {
    status: "working",
    startedAt: 100_000,
    activity: [
      { item: item("ToolCall", { seq: 1, callId: "c1", body: { command: "help" }, createdAt: 101_000 }) },
      {
        item: item("ToolResult", { seq: 2, callId: "c1", body: { blocked: "needs_approval" }, createdAt: 108_120 }),
      },
    ],
  };
  const host = document.createElement("div");
  render(html`${liveWorkDuration(work)}`, host);
  assert.equal(host.textContent, "8s");
  t.mock.timers.tick(1000);
  assert.equal(host.textContent, "8s");
  render(nothing, host);
});

test("the live label keeps its seconds in a two-digit slot without changing the text", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 109_000 });
  const work: WorkBlock = { status: "working", startedAt: 100_000, activity: [] };
  const host = document.createElement("div");
  render(html`${liveWorkDuration(work)}`, host);
  const seconds = () => host.querySelector(".work-elapsed-seconds")?.textContent;
  assert.equal(host.textContent, "9s");
  assert.equal(seconds(), "9");
  t.mock.timers.tick(1000);
  assert.equal(host.textContent, "10s");
  assert.equal(seconds(), "10");
  t.mock.timers.tick(59_000);
  assert.equal(host.textContent, "1m 9s");
  assert.equal(seconds(), "9");
  t.mock.timers.tick(3_600_000);
  assert.equal(host.textContent, "1h 1m 9s");
  assert.equal(seconds(), "9");
  render(nothing, host);
});
