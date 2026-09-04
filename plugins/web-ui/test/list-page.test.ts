import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("list search uses its purpose as an accessible name", () => {
  const source = readFileSync(new URL("../src/list-page.ts", import.meta.url), "utf8");
  assert.equal(source.includes("aria-label=${o.search.placeholder"), true);
});
