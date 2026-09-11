import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

test("a deep-linked session absent from the sidebar is recovered only through the authorized transcript", () => {
  const branch = source.slice(
    source.indexOf("if (wantedSession && !viewIntent && wanted !== \"app-edit\")"),
    source.indexOf("if (wanted === \"app-edit\")"),
  );

  assert.match(branch, /fetchTranscript\(wantedSession, \{ tailTurns: TAIL_TURNS \}\)\.catch\(\(\) => null\)/);
  assert.match(branch, /const linked = \(await transcript\)\?\.session;/);
  assert.match(branch, /await openSession\(linked, transcript, approvalsPrefetch \?\? undefined\);/);
  assert.ok(branch.indexOf("if (linked)") < branch.indexOf("That conversation wasn't found"));
});
