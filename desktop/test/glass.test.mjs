import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWindowGlass } from "../glass.mjs";

function page(extra = {}) {
  const calls = [];
  const win = {
    calls,
    isDestroyed: () => false,
    setVibrancy: (value) => calls.push(["vibrancy", value]),
    setBackgroundColor: (value) => calls.push(["background", value]),
    ...extra,
  };
  return win;
}

test("desktop glass follows the macOS material that Electron can actually use", () => {
  const other = page();
  applyWindowGlass(other, "light", "win32");
  assert.deepEqual(other.calls, []);

  const light = page();
  applyWindowGlass(light, "light", "darwin");
  assert.deepEqual(light.calls, [
    ["vibrancy", "under-window"],
    ["background", "#00000000"],
  ]);
  const dark = page();
  applyWindowGlass(dark, "dark", "darwin");
  assert.equal(dark.calls[0][1], "hud");
  const off = page();
  applyWindowGlass(off, "off", "darwin");
  assert.deepEqual(off.calls.at(-1), ["background", "#f5f4f0"]);

  const calls = [];
  const glass = page({
    isGlassEffectSupported: () => true,
    setGlassEffect: (value) => calls.push(["glass", value]),
    setVibrancy: (value) => calls.push(["vibrancy", value]),
    setBackgroundColor: (value) => calls.push(["background", value]),
  });
  applyWindowGlass(glass, "light", "darwin");
  assert.deepEqual(calls, [
    ["vibrancy", null],
    ["glass", { style: "clear" }],
    ["background", "#00000000"],
  ]);

  const old = page({ isGlassEffectSupported: () => false, setGlassEffect() {} });
  applyWindowGlass(old, "dark", "darwin");
  assert.equal(old.calls[0][1], "hud");

  const failed = [];
  const broken = page({
    isGlassEffectSupported: () => true,
    setGlassEffect() {
      failed.push("glass");
      throw new Error("unsupported");
    },
    setVibrancy: (value) => failed.push(value),
  });
  applyWindowGlass(broken, "dark", "darwin");
  assert.deepEqual(failed, [null, "glass", "hud"]);

  const cleared = [];
  const offNative = page({
    setGlassEffect: (value) => cleared.push(value),
    setVibrancy: (value) => cleared.push(value),
  });
  applyWindowGlass(offNative, "off", "darwin");
  assert.deepEqual(cleared, [null, null]);
});
