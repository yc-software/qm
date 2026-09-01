import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/search.ts", import.meta.url), "utf8");

test("every agent label in the search palette follows deployment branding", () => {
  assert.match(source, /hit\.entryType === "user"[\s\S]*?: brandName\(\)/);
  assert.match(source, /Ask \$\{brandName\(\)\} to find it/);
  assert.match(source, /where \$\{brandName\(\)\} hunts down the matching session/);
  assert.match(source, /ask \$\{brandName\(\)\} in a new chat/);
  assert.doesNotMatch(source, /Ask QM|QM hunts|ask QM/);
});
