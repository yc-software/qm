import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const settings = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("liquid glass is only a Mac desktop theme", () => {
  const glassCss = css.slice(css.indexOf('html[data-qm-desktop="darwin"].glass'));
  assert.match(settings, /function macDesktop\(\): boolean/);
  assert.match(settings, /dataset\.qmDesktop === "darwin"/);
  assert.match(settings, /stored === "glass"\) return macDesktop\(\) \? stored : "system"/);
  assert.match(settings, /choice === "glass" && macDesktop\(\)/);
  assert.equal(css.includes("html.glass {"), false);
  assert.ok(glassCss.length > 0);
  assert.equal(glassCss.includes("backdrop-filter"), false);
});
