import { test } from "node:test";
import assert from "node:assert/strict";
import { nearDuplicateMatches } from "../src/memory/near-duplicates.ts";
import { unitVector } from "../src/model/embeddings.ts";

const at = (degrees: number) => [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];

test("a stored match wins, later lines fold into an earlier similar line, and dissimilar lines stay new", () => {
  assert.deepEqual(nearDuplicateMatches([at(0), at(10), at(90), at(95), at(40)], ["7", undefined, undefined]), [
    { factId: "7" },
    { line: 0 },
    undefined,
    { line: 2 },
    undefined,
  ]);
});

test("the cutoff sits at cosine 0.9", () => {
  const just = (Math.acos(0.9) * 180) / Math.PI;
  assert.deepEqual(nearDuplicateMatches([at(0), at(just - 0.1)], []), [undefined, { line: 0 }]);
  assert.deepEqual(nearDuplicateMatches([at(0), at(just + 0.1)], []), [undefined, undefined]);
  assert.deepEqual(nearDuplicateMatches([unitVector([3, 4])], []), [undefined]);
});
