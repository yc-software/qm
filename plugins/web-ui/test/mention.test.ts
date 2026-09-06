import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitMentions, mentionTokens, mentionQuery, replaceMentionToken } from "../src/mention.ts";

describe("splitMentions", () => {
  it("returns plain text untouched when no @ present", () => {
    assert.deepEqual(splitMentions("今天开会", ["李四"]), [{ text: "今天开会", mention: false }]);
  });

  it("returns plain text when no known names are supplied", () => {
    assert.deepEqual(splitMentions("@李四 看一下", []), [{ text: "@李四 看一下", mention: false }]);
  });

  it("chips a known member mention", () => {
    assert.deepEqual(splitMentions("请@李四复核", ["李四", "王五"]), [
      { text: "请", mention: false },
      { text: "@李四", mention: true },
      { text: "复核", mention: false },
    ]);
  });

  it("chips multiple mentions and matches case-insensitively", () => {
    assert.deepEqual(splitMentions("@Amy和@李四对齐", ["amy", "李四"]), [
      { text: "@Amy", mention: true },
      { text: "和", mention: false },
      { text: "@李四", mention: true },
      { text: "对齐", mention: false },
    ]);
  });

  it("leaves unknown mentions as plain text", () => {
    assert.deepEqual(splitMentions("@路人甲 你好", ["李四"]), [{ text: "@路人甲 你好", mention: false }]);
  });

  it("keeps adjacent CJK punctuation out of the mention token", () => {
    assert.deepEqual(splitMentions("@李四，收到", ["李四"]), [
      { text: "@李四", mention: true },
      { text: "，收到", mention: false },
    ]);
  });

  it("does not chip an at-sign embedded in an ascii word", () => {
    assert.deepEqual(splitMentions("mail user@bob about it", ["bob"]), [
      { text: "mail user@bob about it", mention: false },
    ]);
  });
});

describe("mentionTokens", () => {
  it("extracts unique tokens capped at five", () => {
    assert.deepEqual(mentionTokens("@a @b @a @c @d @e @f @g"), ["a", "b", "c", "d", "e"]);
  });

  it("skips email-interior at-signs", () => {
    assert.deepEqual(mentionTokens("普通文本 邮箱是a@b.c"), []);
  });
});

describe("mentionQuery", () => {
  it("arms at message start", () => {
    assert.equal(mentionQuery("@李"), "李");
    assert.equal(mentionQuery("@"), "");
  });

  it("arms after CJK text without a space", () => {
    assert.equal(mentionQuery("帮我看下@李四"), "李四");
    assert.equal(mentionQuery("请@amy复"), "amy复");
  });

  it("arms after whitespace", () => {
    assert.equal(mentionQuery("hello @zh"), "zh");
  });

  it("does not arm inside ascii words or emails", () => {
    assert.equal(mentionQuery("a@b"), null);
    assert.equal(mentionQuery("mail me tony@ex"), null);
    assert.equal(mentionQuery("没有at符号"), null);
  });

  it("does not arm when the cursor text after @ contains a space", () => {
    assert.equal(mentionQuery("@李 你好"), null);
  });
});

describe("replaceMentionToken", () => {
  it("keeps the preceding CJK text when inserting", () => {
    assert.equal(replaceMentionToken("帮我看下@李四", "@李四 "), "帮我看下@李四 ");
  });

  it("keeps a leading space when inserting", () => {
    assert.equal(replaceMentionToken("hello @zh", "@Amy "), "hello @Amy ");
  });

  it("inserts at message start", () => {
    assert.equal(replaceMentionToken("@李", "@李四 "), "@李四 ");
  });
});
