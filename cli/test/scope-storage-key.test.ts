import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeStorageKey } from "../src/scope-storage-key.ts";

test("scope storage keys keep their persisted format", () => {
  assert.equal(scopeStorageKey("personal:U123"), "personal__U123");
  assert.equal(scopeStorageKey("channel:team/engineering"), "channel__team__engineering--e0d6b9a2c732");
  assert.equal(scopeStorageKey("personal:josh@example.com"), "personal__josh__example.com--10a055c43ea3");
  assert.equal(scopeStorageKey("personal:λ"), "personal____--4bff5926cebf");
});
