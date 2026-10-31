import { test } from "node:test";
import assert from "node:assert/strict";
import { withErrorReporting } from "../src/admin/error-log.ts";
import { errorAlreadyReported, markErrorReported } from "../src/util/errors.ts";
import { createPostgresErrorLog } from "../src/admin/postgres-error-log.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("an error the orchestrator recorded is recognized by the worker, and unmarked or non-object throws are not", () => {
  const recorded = new Error("boom");
  withErrorReporting(createPostgresErrorLog(testDatabaseUrl())).record(
    { category: "turn", code: "error", message: "boom", scopeLabel: "s" },
    recorded,
  );
  assert.equal(errorAlreadyReported(recorded), true);
  assert.equal(errorAlreadyReported(new Error("boom")), false, "identity, not message, decides");
  markErrorReported("a string throw");
  assert.equal(errorAlreadyReported("a string throw"), false);
});
