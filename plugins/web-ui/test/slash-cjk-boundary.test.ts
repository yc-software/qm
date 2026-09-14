import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

const tokenBody = composer.match(/const SLASH_TOKEN = \/(.*)\/;/)?.[1];
const groupIndex = Number(composer.match(/return m \? \(m\[(\d)\] \?\? ""\) : null;/)?.[1]);

test("SLASH_TOKEN and slashQuery stay adjacent and one capture group", () => {
  assert.ok(tokenBody, "SLASH_TOKEN regex literal must exist");
  assert.ok(Number.isInteger(groupIndex) && groupIndex >= 1, "slashQuery must read a capture group");
});

const SLASH_TOKEN = new RegExp(tokenBody!);
const slashQuery = (draft: string): string | null => {
  const m = draft.match(SLASH_TOKEN);
  return m ? (m[groupIndex] ?? "") : null;
};

test("a slash after CJK text arms the skill menu — CJK characters are word boundaries", () => {
  assert.equal(slashQuery("你好/"), "");
  assert.equal(slashQuery("帮我写周报/"), "");
  assert.equal(slashQuery("你好/office"), "office");
  assert.equal(slashQuery("周报。/发"), null, "non-ASCII typed after the slash ends the token");
});

test("Japanese kana and Korean Hangul are boundaries too", () => {
  assert.equal(slashQuery("こんにちは/"), "");
  assert.equal(slashQuery("レポート/off"), "off");
  assert.equal(slashQuery("보고서/"), "");
  assert.equal(slashQuery("보고서/office"), "office");
});

test("a slash after latin text still requires a word boundary", () => {
  assert.equal(slashQuery("hello/"), null, "mid-word slash stays inert (paths, URLs)");
  assert.equal(slashQuery("see /office"), "office");
  assert.equal(slashQuery("/office"), "office");
  assert.equal(slashQuery("draft 2026/09"), null, "dates stay inert — no skill matches numeric queries");
});

test("the boundary class covers CJK punctuation and fullwidth forms", () => {
  assert.equal(slashQuery("清单，/"), "");
  assert.equal(slashQuery("报表、/"), "");
  assert.equal(slashQuery("你好，/off"), "off");
});

test("acceptSkill keeps replacing the trailing token with the boundary prefix intact", () => {
  assert.match(composer, /\.replace\(SLASH_TOKEN, \(_m, pre: string\) => `\$\{pre\}\/\$\{skill\.name\} `\)/);
  const replace = (draft: string): string => draft.replace(SLASH_TOKEN, (_m, pre) => `${pre}/office-docs `);
  assert.equal(replace("你好/"), "你好/office-docs ");
  assert.equal(replace("see /"), "see /office-docs ");
  assert.equal(replace("/off"), "/office-docs ");
});
