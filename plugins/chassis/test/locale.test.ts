import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptLanguageLocale,
  catalogProblems,
  defaultLocale,
  formatMessage,
  normalizeLocale,
  resolveLocale,
} from "../src/locale.ts";

test("locale normalization accepts only Japanese and English", () => {
  assert.equal(normalizeLocale("ja-JP"), "ja");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("fr"), null);
  assert.equal(normalizeLocale("<script>"), null);
});

test("locale priority is explicit, deployment, browser, English", () => {
  assert.equal(resolveLocale({ explicit: "en", defaultLocale: "ja", acceptLanguage: "ja-JP" }), "en");
  assert.equal(resolveLocale({ defaultLocale: "ja", acceptLanguage: "en-US" }), "ja");
  assert.equal(resolveLocale({ acceptLanguage: "ja-JP" }), "ja");
  assert.equal(resolveLocale({}), "en");
});

test("Accept-Language honors quality weights", () => {
  assert.equal(acceptLanguageLocale("en-US;q=0.6, ja-JP;q=0.9"), "ja");
  assert.equal(acceptLanguageLocale("fr-FR, en;q=0.8"), "en");
  assert.equal(acceptLanguageLocale("en;q=0, ja;q=0"), null);
  assert.equal(acceptLanguageLocale("ja;q=0.8, en;q=0.8"), "ja");
});

test("message interpolation and catalog audit are deterministic", () => {
  assert.equal(formatMessage("Hello {name}, {count}", { name: "A", count: 2 }), "Hello A, 2");
  assert.equal(formatMessage("Hello {name}"), "Hello {name}");
  assert.deepEqual(catalogProblems({ greeting: "Hello {name}" }, { greeting: "こんにちは {name}" }), []);
  assert.deepEqual(catalogProblems({ greeting: "Hello {name}" }, { extra: "余分" }), [
    "missing key: greeting",
    "extra key: extra",
  ]);
  assert.deepEqual(catalogProblems({ greeting: "Hello {name}" }, { greeting: "こんにちは {person}" }), [
    "placeholder mismatch: greeting",
  ]);
});
