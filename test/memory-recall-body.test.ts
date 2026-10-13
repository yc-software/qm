import assert from "node:assert/strict";
import test from "node:test";
import { recallBody } from "../src/memory/memory-service.ts";
import { RECALL_MAX_CHARS } from "../src/memory/notebook.ts";

test("recallBody returns a short notebook unchanged", () => {
  assert.equal(recallBody("  - one\n- two  "), "- one\n- two");
  assert.equal(recallBody("   "), "");
});

test("recallBody marks a truncated notebook and keeps whole lines", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `- fact number ${i} with some padding text`);
  const body = lines.join("\n");
  const out = recallBody(body);
  const [marker = "", ...rest] = out.split("\n");
  assert.match(
    marker,
    /^\(\d+ earlier characters of this notebook are not shown here; read the full notebook to see them\.\)$/,
  );
  assert.ok(rest.length > 0);
  for (const line of rest) assert.ok(lines.includes(line));
  assert.equal(rest.at(-1), lines.at(-1));
  assert.ok(rest.join("\n").length <= RECALL_MAX_CHARS);
  assert.equal(Number(marker.match(/\d+/)![0]) + rest.join("\n").length, body.length);
});
