import { test } from "node:test";
import assert from "node:assert/strict";
import { createErrorLog, withErrorReporting } from "../src/admin/error-log.ts";
import { errorAlreadyReported, markErrorReported } from "../src/util/errors.ts";
import { createTenantContext, runWithTenant } from "../src/tenancy/context.ts";

test("an error the orchestrator recorded is recognized by the worker, and unmarked or non-object throws are not", () => {
  const recorded = new Error("boom");
  withErrorReporting(createErrorLog()).record(
    { category: "turn", code: "error", message: "boom", scopeLabel: "s" },
    recorded,
  );
  assert.equal(errorAlreadyReported(recorded), true);
  assert.equal(errorAlreadyReported(new Error("boom")), false, "identity, not message, decides");
  markErrorReported("a string throw");
  assert.equal(errorAlreadyReported("a string throw"), false);
});

test("error-report deduplication markers stay isolated across concurrent tenant contexts", async () => {
  const contexts = ["alpha", "beta"].map((id) => createTenantContext({ id, env: {}, pooled: true }));
  const error = new Error("shared infrastructure failure");
  const reported = Promise.withResolvers<void>();
  await Promise.all(
    contexts.map((context, index) =>
      runWithTenant(context, async () => {
        if (index === 1) await reported.promise;
        assert.equal(errorAlreadyReported(error), false);
        const errors = withErrorReporting(createErrorLog());
        errors.record({ category: "turn", code: "error", message: error.message, scopeLabel: "s" }, error);
        assert.equal(errorAlreadyReported(error), true);
        reported.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(errorAlreadyReported(error), true);
        assert.equal((await errors.list()).length, 1);
      }),
    ),
  );
  assert.equal(errorAlreadyReported(error), false);
});
