import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

const LIGHT_SURFACES = ["#ffffff", "#f5f5f5"];
const DARK_SURFACES = ["#070f18", "#18212c"];
const AA_NORMAL_TEXT = 4.5;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => channel(Number.parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function rampAfter(marker: string): string[] {
  const rule = css.slice(css.indexOf(marker));
  const spectrum = /linear-gradient\(\s*90deg,([^)]*)\)/.exec(rule);
  assert.ok(spectrum, `no spectrum gradient found after ${marker}`);
  return [...spectrum![1]!.matchAll(/#[0-9a-f]{6}/g)].map((m) => m[0]);
}

test("the Extra high spectrum clears AA on the surfaces it is painted on", () => {
  const light = rampAfter(".effort-peak {");
  const dark = rampAfter(":root.dark .effort-peak,");
  assert.equal(light.length, 9);
  assert.equal(dark.length, 9);
  for (const [ramp, surfaces] of [
    [light, LIGHT_SURFACES],
    [dark, DARK_SURFACES],
  ] as const) {
    for (const stop of ramp) {
      for (const surface of surfaces) {
        assert.ok(
          contrast(stop, surface) >= AA_NORMAL_TEXT,
          `${stop} on ${surface} is ${contrast(stop, surface).toFixed(2)}:1, below ${AA_NORMAL_TEXT}:1`,
        );
      }
    }
  }
});

test("the hover glint darkens light surfaces and lightens dark ones", () => {
  const light = css.slice(css.indexOf(".effort-peak {"), css.indexOf(":root.dark .effort-peak,"));
  const dark = css.slice(css.indexOf(":root.dark .effort-peak,"));
  assert.match(light, /linear-gradient\(105deg,[^)]*rgb\(0 0 0 \/ 0?\.\d+\)/);
  assert.match(dark, /linear-gradient\(105deg,[^)]*rgb\(255 255 255 \/ 0?\.\d+\)/);
});

test("the spectrum never leaves the label invisible when the paint is dropped", () => {
  for (const guard of ["@supports not ((background-clip: text) or (-webkit-background-clip: text))", "@media print"]) {
    const block = css.slice(css.indexOf(guard), css.indexOf("}", css.indexOf("color: inherit;", css.indexOf(guard))));
    assert.match(block, /background-image: none;/, `${guard} must drop the gradient, not just restore the colour`);
    assert.match(block, /color: inherit;/, `${guard} must restore a visible colour`);
  }
  assert.match(css, /\.effort-peak::selection \{\s*color: var\(--foreground\);/);
});
