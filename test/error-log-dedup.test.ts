import { test } from "node:test";
import assert from "node:assert/strict";
import { errorAlreadyRecorded, markErrorRecorded } from "../src/admin/error-log.ts";

test("an error the orchestrator recorded is recognized by the worker, and unmarked or non-object throws are not", () => {
  const recorded = new Error("boom");
  markErrorRecorded(recorded);
  assert.equal(errorAlreadyRecorded(recorded), true);
  assert.equal(errorAlreadyRecorded(new Error("boom")), false, "identity, not message, decides");
  markErrorRecorded("a string throw");
  assert.equal(errorAlreadyRecorded("a string throw"), false);
});
