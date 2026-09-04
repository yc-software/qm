import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeStorageKey as cliScopeStorageKey } from "../cli/src/scope-storage-key.ts";
import { scopeStorageKey as coreScopeStorageKey } from "../src/util/scope-storage-key.ts";

test("the deployment proof command derives the same scope key as core", () => {
  for (const scopeId of [
    "personal:U123",
    "channel:C123",
    "personal:josh@example.com",
    "channel:team/engineering",
    "personal:λ",
  ]) {
    assert.equal(cliScopeStorageKey(scopeId), coreScopeStorageKey(scopeId));
  }
});
