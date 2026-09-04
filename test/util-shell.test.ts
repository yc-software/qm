import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { shq } from "../src/util/shell.ts";

test("shq: plain, embedded-quote, and hostile inputs round-trip through a real shell", () => {
  for (const s of [
    "plain",
    "two words",
    "it's quoted",
    "'leading and trailing'",
    "a'b'c''d",
    "$(rm -rf /) `id` $HOME ; & | > < \\ \n newline",
    "",
  ]) {
    const out = execFileSync("sh", ["-c", `printf %s ${shq(s)}`], { encoding: "utf8" });
    assert.equal(out, s);
  }
});

test("shq: golden form matches the pre-consolidation escaping", () => {
  assert.equal(shq("it's"), `'it'\\''s'`);
  assert.equal(shq("plain"), `'plain'`);
});
