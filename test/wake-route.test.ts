import { test } from "node:test";
import assert from "node:assert/strict";
import { isHalt, routeWake, type Wake } from "../src/wake/wake.ts";

const addressed = (over: Partial<Wake> = {}): Wake => ({
  situation: "addressed",
  text: "do the thing",
  ...over,
});

test("a live run + a normal message ⇒ STEER the live turn (never a second turn)", () => {
  const route = routeWake(addressed({ text: "actually make it blue" }));
  assert.equal(route.kind, "steer");
  assert.equal((route as { signal: string }).signal, "steer");
  assert.equal((route as { text?: string }).text, "actually make it blue");
});

test("a live run + a HALT (bare stop) ⇒ route through the existing ABORT interrupt, not context", () => {
  const route = routeWake(addressed({ text: "stop", halt: true }));
  assert.equal(route.kind, "steer");
  assert.equal((route as { signal: string }).signal, "abort");
  assert.equal((route as { text?: string }).text, undefined, "abort carries no steer text");
});

test("an empty mid-turn message is a caller bug, so it throws instead of vanishing", () => {
  assert.throws(() => routeWake(addressed({ text: "   " })), /no text and no files/);
});

test("a live DETECTION-GATED run + an addressed message ⇒ ENGAGE (never risk stranding the steer at the gate)", () => {
  assert.deepEqual(routeWake(addressed({ text: "why did you do it wrong?" }), true), { kind: "engage" });
});

test("a live DETECTION-GATED run + an addressed HALT ⇒ still ABORT (harmless if stranded)", () => {
  const route = routeWake(addressed({ text: "stop", halt: true }), true);
  assert.equal(route.kind, "steer");
  assert.equal((route as { signal: string }).signal, "abort");
});

test("a live DETECTION-GATED run + a non-addressed update ⇒ still STEER (the mirror re-imports a stranded one)", () => {
  const route = routeWake({ situation: "ambientUpdate", text: "and another thing" }, true);
  assert.equal(route.kind, "steer");
  assert.equal((route as { signal: string }).signal, "steer");
});

test("isHalt matches a bare stop (any case, optional . or !) and nothing wordier", () => {
  for (const s of ["stop", "STOP", "Stop.", "stop!", "  stop  "]) assert.ok(isHalt(s), s);
  for (const s of ["stop the build", "please stop", "stopwatch", ""]) assert.ok(!isHalt(s), s);
});

test("a captionless file mid-run steers instead of dropping", () => {
  const route = routeWake({ situation: "ambientUpdate", hasFiles: true });
  assert.equal(route.kind, "steer");
});

test("no text and no files throws", () => {
  assert.throws(() => routeWake({ situation: "ambientUpdate" }));
});
