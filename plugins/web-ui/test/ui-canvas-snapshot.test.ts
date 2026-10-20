import assert from "node:assert/strict";
import { test } from "node:test";
import { fitSnapshot } from "../src/ui-canvas.ts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

test("snapshots fit the byte budget by trimming html first, then css, sessions and the screenshot", () => {
  const snapshot = { url: "u", html: "é".repeat(5_000), css: "c".repeat(2_000), sessions: [{ id: "a" }] };
  const small = fitSnapshot(snapshot, 100_000);
  assert.deepEqual(small, snapshot, "untouched when it fits");
  const fitted = fitSnapshot(snapshot, 6_000);
  assert.ok(bytes(fitted) <= 6_000);
  assert.deepEqual(fitted.truncated, ["html"]);
  assert.equal(fitted.css, snapshot.css);
  const tiny = fitSnapshot({ ...snapshot, screenshot: { dataUrl: "x".repeat(3_000) } }, 200);
  assert.ok(bytes(tiny) <= 200);
  assert.deepEqual(tiny.truncated, ["html", "css", "sessions", "screenshot"]);
});
