import { test } from "node:test";
import assert from "node:assert/strict";
import { isHalt, routeWake, type Wake } from "../src/wake/wake.ts";

const addressed = (over: Partial<Wake> = {}): Wake => ({
  situation: "addressed",
  ts: "100",
  text: "do the thing",
  ...over,
});

test("a HALT with nothing running is a no-op DROP (no run to abort)", () => {
  assert.deepEqual(routeWake(addressed({ text: "stop", halt: true }), false), {
    kind: "drop",
    reason: "halt-nothing-running",
  });
});

test("the agent's own post never acts — DROP as self (coverage only)", () => {
  assert.equal(routeWake(addressed({ isSelf: true }), true).kind, "drop");
  assert.equal(routeWake(addressed({ isSelf: true }), false).kind, "drop");
});

test("isHalt matches a bare stop (any case, optional . or !) and nothing wordier", () => {
  for (const s of ["stop", "STOP", "Stop.", "stop!", "  stop  "]) assert.ok(isHalt(s), s);
  for (const s of ["stop the build", "please stop", "stopwatch", ""]) assert.ok(!isHalt(s), s);
});

test("a captionless file mid-run steers (names the file) instead of dropping", () => {
  const route = routeWake({ situation: "engagedUpdate", ts: "1", fileNames: ["screenshot.png"] }, true);
  assert.equal(route.kind, "steer");
  assert.match((route as { text?: string }).text ?? "", /screenshot\.png/);
});

test("text plus files steers with both", () => {
  const route = routeWake({ situation: "engagedUpdate", ts: "1", text: "here you go", fileNames: ["a.pdf"] }, true);
  assert.equal(route.kind, "steer");
  const text = (route as { text?: string }).text ?? "";
  assert.match(text, /here you go/);
  assert.match(text, /a\.pdf/);
});

test("no text and no files still drops", () => {
  const route = routeWake({ situation: "engagedUpdate", ts: "1" }, true);
  assert.equal(route.kind, "drop");
});
