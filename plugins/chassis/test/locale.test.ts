import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptLanguageLocale,
  catalogProblems,
  formatMessage,
  normalizeLocale,
  resolveLocale,
} from "../src/locale.ts";

test("locale normalization accepts structurally valid Japanese and English tags", () => {
  assert.equal(normalizeLocale("ja-JP"), "ja");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("en-419"), "en");
  assert.equal(normalizeLocale("en-abc12"), "en");
  assert.equal(normalizeLocale("en-a-extended"), "en");
  assert.equal(normalizeLocale("ja-x-private"), "ja");
  assert.equal(normalizeLocale("en-US-u-ca-gregory"), "en");
  assert.equal(normalizeLocale("en-US-GB"), null);
  assert.equal(normalizeLocale("en-a"), null);
  assert.equal(normalizeLocale("ja-x"), null);
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
  assert.equal(acceptLanguageLocale("ja;q=0, en;q=0.5"), "en");
  assert.equal(acceptLanguageLocale("ja;q=0.8, en;q=0.8"), "ja");
  assert.equal(acceptLanguageLocale("en;q=0.7 , ja ; q=0.8"), "ja");
  assert.equal(acceptLanguageLocale("ja;q=.8, en;q=0.7"), "en");
  assert.equal(acceptLanguageLocale("ja;q=1e-1, en;q=0.2"), "en");
  assert.equal(acceptLanguageLocale("ja;q=01, en;q=0.9"), "en");
  assert.equal(acceptLanguageLocale("ja;q=0.1234, en;q=0.1"), "en");
  assert.equal(acceptLanguageLocale("ja;q=1.001, en;q=0.9"), "en");
  assert.equal(acceptLanguageLocale("ja;q, en;q=0.5"), "en");
  assert.equal(acceptLanguageLocale("ja;foo=bar, en;q=0.5"), "en");
  assert.equal(acceptLanguageLocale("ja;q=0.4;q=0, en;q=0.3"), "en");
  assert.equal(acceptLanguageLocale("ja;q = 0.8, en;q=0.7"), "en");
  assert.equal(acceptLanguageLocale("ja;q= 0.8, en;q=0.7"), "en");
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

test("catalog audits own special keys without prototype lookups", () => {
  const en = Object.create(null) as Record<string, string>;
  en.toString = "Hello {name}";
  en.constructor = "Hello {name}";
  Object.defineProperty(en, "__proto__", { value: "Hello {name}", enumerable: true });
  const translated = {
    toString: "こんにちは {name}",
    extra: "余分",
  } as Record<string, string>;
  Object.defineProperty(translated, "__proto__", { value: "こんにちは {person}", enumerable: true });
  assert.deepEqual(catalogProblems(en, translated), [
    "missing key: constructor",
    "extra key: extra",
    "placeholder mismatch: __proto__",
  ]);
});
