import { test } from "node:test";
import assert from "node:assert/strict";
import { densityTierFor, type DensityTier } from "../src/density.ts";

test("a roomy pane renders full", () => {
  assert.equal(densityTierFor(1200, 800), "full");
  assert.equal(densityTierFor(471, 541), "full");
});

test("squeezing either axis degrades to compact", () => {
  assert.equal(densityTierFor(470, 800), "compact");
  assert.equal(densityTierFor(1200, 540), "compact");
});

test("small panes render as cards on either axis", () => {
  assert.equal(densityTierFor(1200, 300), "card");
  assert.equal(densityTierFor(250, 800), "card");
});

test("height alone decides a strip — too short for anything else", () => {
  assert.equal(densityTierFor(1200, 96), "strip");
  assert.equal(densityTierFor(200, 96), "strip");
  assert.equal(densityTierFor(1200, 97), "card");
});

test("growing a pane never yields a denser tier", () => {
  const rank: Record<DensityTier, number> = { strip: 0, card: 1, compact: 2, full: 3 };
  const sizes = [40, 96, 97, 250, 251, 300, 301, 470, 471, 540, 541, 900];
  for (const w of sizes) {
    for (const h of sizes) {
      const here = rank[densityTierFor(w, h)];
      for (const w2 of sizes) {
        for (const h2 of sizes) {
          if (w2 < w || h2 < h) continue;
          assert.ok(rank[densityTierFor(w2, h2)] >= here, `(${w},${h}) → (${w2},${h2}) got denser`);
        }
      }
    }
  }
});
