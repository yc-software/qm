import { test } from "node:test";
import assert from "node:assert/strict";
import { isHalt, routeWake, type Wake } from "../src/wake/wake.ts";

const addressed = (over: Partial<Wake> = {}): Wake => ({
  situation: "addressed",
  ts: "100",
  text: "do the thing",
  ...over,
});

test("no live run ⇒ ENGAGE (start a turn)", () => {
  assert.deepEqual(routeWake(addressed(), false), { kind: "engage" });
});

test("a live run + a normal message ⇒ STEER the live turn (never a second turn)", () => {
  const route = routeWake(addressed({ text: "actually make it blue" }), true);
  assert.equal(route.kind, "steer");
  assert.equal((route as { signal: string }).signal, "steer");
  assert.equal((route as { text?: string }).text, "actually make it blue");
});

test("a live run + a HALT (bare stop) ⇒ route through the existing ABORT interrupt, not context", () => {
  const route = routeWake(addressed({ text: "stop", halt: true }), true);
  assert.equal(route.kind, "steer");
  assert.equal((route as { signal: string }).signal, "abort");
  assert.equal((route as { text?: string }).text, undefined, "abort carries no steer text");
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

test("an empty mid-turn message is dropped (nothing to steer with)", () => {
  assert.deepEqual(routeWake(addressed({ text: "   " }), true), { kind: "drop", reason: "empty-mid-turn" });
});

test("a live DETECTION-GATED run + an addressed message ⇒ ENGAGE (never risk stranding the steer at the gate)", () => {
  assert.deepEqual(routeWake(addressed({ text: "why did you do it wrong?" }), true, true), { kind: "engage" });
});

test("a live DETECTION-GATED run + an addressed HALT ⇒ still ABORT (harmless if stranded)", () => {
  const route = routeWake(addressed({ text: "stop", halt: true }), true, true);
  assert.equal(route.kind, "steer");
  assert.equal((route as { signal: string }).signal, "abort");
});

test("a live DETECTION-GATED run + a non-addressed update ⇒ still STEER (the mirror re-imports a stranded one)", () => {
  const route = routeWake({ situation: "ambientUpdate", ts: "101", text: "and another thing" }, true, true);
  assert.equal(route.kind, "steer");
  assert.equal((route as { signal: string }).signal, "steer");
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
