import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLocale,
  LOCALE_NATIVE_NAMES,
  matchLocale,
  negotiateLocale,
  normalizeLocale,
  SUPPORTED_LOCALES,
  translate,
} from "../../chassis/src/i18n.ts";

test("every supported locale has a native name", () => {
  for (const locale of SUPPORTED_LOCALES) {
    assert.equal(typeof LOCALE_NATIVE_NAMES[locale], "string");
    assert.ok(LOCALE_NATIVE_NAMES[locale].length > 0);
  }
});

test("isLocale accepts only registry entries", () => {
  assert.ok(isLocale("en"));
  assert.ok(isLocale("zh-CN"));
  assert.ok(!isLocale("fr"));
  assert.ok(!isLocale("zh"));
  assert.ok(!isLocale(""));
  assert.ok(!isLocale(null));
  assert.ok(!isLocale(42));
});

test("matchLocale maps BCP-47 tags by primary subtag", () => {
  assert.equal(matchLocale("en-US"), "en");
  assert.equal(matchLocale("EN"), "en");
  assert.equal(matchLocale("zh"), "zh-CN");
  assert.equal(matchLocale("zh-Hans-CN"), "zh-CN");
  assert.equal(matchLocale("ja-JP"), "ja");
  assert.equal(matchLocale("ko-KR"), "ko");
});

test("matchLocale declines traditional Chinese and unknown tags", () => {
  assert.equal(matchLocale("zh-TW"), null);
  assert.equal(matchLocale("zh-Hant"), null);
  assert.equal(matchLocale("zh-HK"), null);
  assert.equal(matchLocale("fr-FR"), null);
  assert.equal(matchLocale("*"), null);
  assert.equal(matchLocale(""), null);
  assert.equal(matchLocale(null), null);
});

test("normalizeLocale falls back to en", () => {
  assert.equal(normalizeLocale("fr-FR"), "en");
  assert.equal(normalizeLocale(undefined), "en");
  assert.equal(normalizeLocale("ko"), "ko");
});

test("negotiateLocale honors q-values and order", () => {
  assert.equal(negotiateLocale("fr-FR,fr;q=0.9,en-US;q=0.8"), "en");
  assert.equal(negotiateLocale("en-US;q=0.7,ja-JP;q=0.9"), "ja");
  assert.equal(negotiateLocale("zh-TW,ko;q=0.5"), "ko");
  assert.equal(negotiateLocale("fr-FR"), "en");
  assert.equal(negotiateLocale(null), "en");
  assert.equal(negotiateLocale("fr-FR", "ja"), "ja");
});

test("translate falls back to the key and interpolates named params", () => {
  const catalog = { "New chat": "新对话", "Hide {title}": "隐藏{title}" };
  assert.equal(translate(catalog, "New chat"), "新对话");
  assert.equal(translate(catalog, "Missing key"), "Missing key");
  assert.equal(translate(null, "New chat"), "New chat");
  assert.equal(translate(catalog, "Hide {title}", { title: "Files" }), "隐藏Files");
  assert.equal(translate({ "N={n}": "N={n}" }, "N={n}", { n: 3 }), "N=3");
});
