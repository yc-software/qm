import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");

// A fork whose only unloaded prefix is collapsed pre-fork history shows no
// "earlier" button (adjusted count 0) but MUST keep its refresh anchor —
// otherwise every settled turn refetches the transcript unbounded.
test("the refresh anchor derives from raw earlier entries, not the fork-adjusted count", () => {
  assert.match(chat, /const rawEarlier = page\.earlierEntries \?\? 0;/);
  assert.match(
    chat,
    /chatState\.transcriptAnchorSeq = rawEarlier > 0 \? \(page\.entries\?\.\[0\]\?\.seq \?\? null\) : null;/,
  );
  assert.match(chat, /const rawRemaining = page\.earlierEntries \?\? 0;/);
  assert.match(
    chat,
    /chatState\.transcriptAnchorSeq = rawRemaining > 0 \? \(page\.entries\?\.\[0\]\?\.seq \?\? null\) : null;/,
  );
  assert.match(
    chat,
    /setTranscriptWindow\(anchorSeq: number \| null, earlierCount: number, hasEarlier = earlierCount > 0\)/,
  );
  assert.match(sessions, /conv\.setTranscriptWindow\(anchorSeq, earlier, \(entriesRes\.earlierEntries \?\? 0\) > 0\);/);
});

// Badge navigation must probe access itself: a listed-but-unreadable origin
// otherwise slips past the controller's error path into a torn-down view.
test("origin navigation fetches the source transcript before opening it", () => {
  assert.match(chat, /const page = await transcriptFetcher\(sourceId, \{ tailTurns: TAIL_TURNS \}\);/);
  assert.match(chat, /await sessionOpener\(source, Promise\.resolve\(page\)\);/);
});
