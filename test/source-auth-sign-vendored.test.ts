import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const canonical = readFileSync(join(repoRoot, "src/auth/source-auth-sign.ts"), "utf8");

test("chassis signer copy is byte-identical to the core signer", () => {
  const copy = readFileSync(join(repoRoot, "plugins/chassis/src/source-auth-sign.ts"), "utf8");
  assert.equal(
    copy,
    canonical,
    "plugins/chassis/src/source-auth-sign.ts drifted from src/auth/source-auth-sign.ts — re-copy it",
  );
});
