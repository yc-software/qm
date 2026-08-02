import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocale, LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES } from "../src/i18n/locale.ts";

test("every supported locale has a native name", () => {
  for (const locale of SUPPORTED_LOCALES) {
    assert.equal(typeof LOCALE_NATIVE_NAMES[locale], "string");
    assert.ok(LOCALE_NATIVE_NAMES[locale].length > 0);
  }
  assert.deepEqual(Object.keys(LOCALE_NATIVE_NAMES).sort(), [...SUPPORTED_LOCALES].sort());
});

test("isLocale accepts only registry entries", () => {
  for (const locale of SUPPORTED_LOCALES) assert.ok(isLocale(locale));
  assert.ok(!isLocale("fr"));
  assert.ok(!isLocale("zh"));
  assert.ok(!isLocale(""));
  assert.ok(!isLocale(null));
  assert.ok(!isLocale(undefined));
  assert.ok(!isLocale(42));
});
