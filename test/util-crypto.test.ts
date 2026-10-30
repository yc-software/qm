import { test } from "node:test";
import assert from "node:assert/strict";
import { hashId } from "../src/util/crypto.ts";

test("hashId: byte-identical to every pre-consolidation call-site shape", () => {
  assert.equal(hashId(["personal:user@acme.com"], 6), "7d4ccb");
  assert.equal(hashId(["U123"], 8), "64a7152b");
  assert.equal(hashId(["U123"], 8).toUpperCase(), "64A7152B");
  assert.equal(hashId(["sess-1", "rm -rf /tmp/x"]), "b98f7ba7c301df89");
  assert.equal(hashId(["owner-1", "github", "default"]), "82d5322cb43d9fae");
  assert.equal(hashId(["@dana", "channel:C1"]), "54004d8e9f0e437b");
  assert.equal(hashId(["actor-1", "personal:U1", "*", "git push"], 24), "72c78a1fae66177817bb2933");
});

test("hashId: NUL join means part boundaries matter", () => {
  assert.notEqual(hashId(["ab", "c"]), hashId(["a", "bc"]));
  assert.notEqual(hashId(["ab"]), hashId(["a", "b"]));
});
