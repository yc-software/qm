import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/deploy-permissions.ts", import.meta.url), "utf8");

test("app permissions expose explicit private and public general-access states", () => {
  assert.match(source, /General access/);
  assert.match(source, /Restricted/);
  assert.match(source, /Anyone with the link/);
  assert.match(source, /No sign-in required/);
  assert.match(source, /JSON\.stringify\(\{ public: value === "public" \}\)/);
  assert.match(source, /Public\. Anyone can open this app\./);
});
