import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("a surface post renders as conversation speech on both render paths, never as a bare tool row", () => {
  assert.match(
    chat,
    /const speech = postSpeechText\(item\.row, work\.status === "working" \|\| work\.status === "thinking"\);\s*if \(speech\) return messageRow\(\{ \.\.\.item\.row\.call!, payload: \{ text: speech \} \}\);/,
    "live timeline rows must turn a post's text into a message row, gated on live work status so unconfirmed posts never render as speech inside settled folds",
  );
  assert.match(
    chat,
    /const speech = postSpeechText\(it\.row\);\s*if \(speech\) \{\s*flushSeg\(\);\s*parts\.push\(html`<div class="work-said">\$\{markdown\(speech\)\}<\/div>`\);\s*\} else \{\s*seg\.push\(it\);/,
    "settled folds must flush the segment and render the confirmed post text as a work-said bubble instead of folding it away",
  );
});

test("the live dock previews an in-flight post instead of showing a generic step", () => {
  assert.match(
    chat,
    /const posting = postSpeechText\(row, true\);\s*if \(posting\) \{\s*return \{\s*icon: MessageSquare,\s*label: secs > 0 \? `Posting message for \$\{secs\}s` : "Posting message",\s*detail: firstLine\(posting, 60\),\s*\};\s*\}/,
  );
});
