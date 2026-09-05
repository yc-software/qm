import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "../../../cli/src/passwords.ts";
import { readPasswordHashes, validPassword, verifyPassword } from "../src/passwords.ts";

test("broker verifies CLI-generated passwords with Unicode and significant whitespace", async () => {
  const password = "  correct horse 🔐 battery  ";
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password.trim(), hash), false);
  assert.equal(await verifyPassword("a different long password", hash), false);
  assert.equal(await verifyPassword(password, undefined), false);
  assert.notEqual(await hashPassword(password), hash);
});

test("password lengths count Unicode characters without truncation", async () => {
  for (const length of [14, 15, 128, 129]) {
    assert.equal(validPassword("🔐".repeat(length)), length >= 15 && length <= 128);
  }
  const password = "🔐".repeat(128);
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(`${password}x`, hash), false);
  await assert.rejects(hashPassword("x".repeat(129)));
  await assert.rejects(hashPassword("x".repeat(14)));
});

test("password credentials reject malformed hashes and ambiguous normalized identities", async () => {
  const hash = await hashPassword("correct horse battery staple");
  const parsed = readPasswordHashes(JSON.stringify({ " Admin@Example.com ": hash }));
  assert.equal(parsed?.get("admin@example.com"), hash);
  assert.equal(readPasswordHashes(JSON.stringify({ "Admin@example.com": hash, "admin@example.com": hash })), null);
  for (const raw of [undefined, "", "{}", "[]", "null", '"password"', "not-json"]) {
    assert.equal(readPasswordHashes(raw), null);
  }
  for (const invalid of ["plaintext", hash.replace("32768", "2"), `${hash}=`, hash.slice(0, -1), 123]) {
    assert.equal(readPasswordHashes(JSON.stringify({ "admin@example.com": invalid })), null);
  }
});
