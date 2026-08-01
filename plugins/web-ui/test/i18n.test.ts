import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocale, translate } from "../src/i18n.ts";

test("locale resolution prefers a saved choice and otherwise follows the browser", () => {
  assert.equal(resolveLocale("en", ["ru-RU"]), "en");
  assert.equal(resolveLocale(null, ["ru-RU", "en-US"]), "ru");
  assert.equal(resolveLocale("unsupported", ["de-DE"]), "en");
});

test("English messages remain the source text", () => {
  assert.equal(translate("en", "New chat"), "New chat");
  assert.equal(translate("en", "Refresh {name}", { name: "files" }), "Refresh files");
});

test("Russian messages translate text and interpolate values", () => {
  assert.equal(translate("ru", "New chat"), "Новый чат");
  assert.equal(translate("ru", "Refresh {name}", { name: "файлы" }), "Обновить: файлы");
});

test("unknown messages safely fall back to their source text", () => {
  assert.equal(translate("ru", "Untranslated server detail"), "Untranslated server detail");
});
