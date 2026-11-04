import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inlineScript } from "../../chassis/src/inline-script.ts";

test("inlineScript hashes the newline-normalized text a browser parses", () => {
  const { text, hash } = inlineScript("var a = 1;\r\nvar b = 2;\rvar c = 3;");
  assert.equal(text, "var a = 1;\nvar b = 2;\nvar c = 3;");
  assert.equal(hash, `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`);
  assert.doesNotMatch(text, /\r/);
});

test("inlineScript leaves an already-normalized multi-line script untouched", () => {
  const source = "(function () {\n  return 1;\n})();";
  assert.deepEqual(inlineScript(source), {
    text: source,
    hash: `sha256-${createHash("sha256").update(source, "utf8").digest("base64")}`,
  });
});
