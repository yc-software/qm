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

test("app permissions offer explicit view-only email grants outside the directory", () => {
  assert.match(source, /Add people by name or email/);
  assert.match(source, /emailCandidate/);
  assert.match(source, /Add \$\{emailCandidate\(\)\} with view access/);
  assert.match(source, /selected\.email \? "view" : access/);
  assert.match(source, /email \? \{ email \} : \{ scope \}/);
  assert.match(source.replace(/\s+/g, " "), /This does not add them to your organization/);
  assert.match(source, /Access granted, but no invitation email was sent/);
});
