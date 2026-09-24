import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmbedAncestors } from "../src/deploy/embed-ancestors.ts";

test("embed ancestors: https origins on named hosts, lowercased and deduplicated", () => {
  assert.deepEqual(
    parseEmbedAncestors([" https://Internal.Example.com ", "https://*.example.com", "https://internal.example.com"]),
    ["https://internal.example.com", "https://*.example.com"],
  );
  assert.deepEqual(parseEmbedAncestors([]), [], "an empty list switches embedding off");
  assert.deepEqual(parseEmbedAncestors(["https://a-b.example.com"]), ["https://a-b.example.com"]);
});

test("embed ancestors: anything that could widen framing beyond a named origin is refused", () => {
  for (const bad of [
    ["*"],
    ["https://*"],
    ["http://internal.example.com"],
    ["javascript:alert(1)"],
    ["https://internal.example.com/path"],
    ["https://internal.example.com:8443"],
    ["https://*.com"],
    ["https://1.2.3.4"],
    ["https://-x.example.com"],
    ["https://x-.example.com"],
    ["internal.example.com"],
    "https://internal.example.com",
    [42],
    Array.from({ length: 17 }, (_, i) => `https://h${i}.example.com`),
  ]) {
    assert.equal(parseEmbedAncestors(bad), null, JSON.stringify(bad));
  }
});
