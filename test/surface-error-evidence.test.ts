import assert from "node:assert/strict";
import { test } from "node:test";
import { createErrorLog, withErrorReporting } from "../src/admin/error-log.ts";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../src/core/orchestrator/surface-tools.ts";
import { redactSecrets } from "../src/harness/redact-secrets.ts";
import { errorAlreadyReported } from "../src/util/errors.ts";
import { turnPostKeys } from "../src/core/orchestrator/turn-helpers.ts";

for (const operation of ["post", "readFile", "setStandingOrder"] as const) {
  test(`surface ${operation} retains redacted error evidence`, async (t) => {
    const errors = withErrorReporting(createErrorLog());
    const error = Object.assign(
      new TypeError("upstream failed sk-surface-secret-12345", { cause: new Error("socket closed") }),
      {
        code: "ECONNRESET",
        status: 503,
        password: "surface-secret",
      },
    );
    const recorded = t.mock.method(errors, "record");
    const fail = async () => {
      throw error;
    };
    const tools = createSurfaceToolDeps({
      deps: { errors, deliveries: { enqueue: fail }, channelPolicy: { set: fail } },
      input: { surfaceTools: true },
      actor: { id: "U1" },
      conversation: { kind: "channel", channelRef: "C1" },
      session: { id: "S1" },
      scopeId: "channel:C1",
      defaultDestination: { type: "slack", target: "C1:123" },
      strictReadOnly: false,
      blobTransfer: { open: fail },
      postProvenance: () => ({}),
      postKeys: turnPostKeys("run-test"),
      spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
    } as unknown as SurfaceToolsContext)!;
    const invoke = {
      post: () => tools.post("hello"),
      readFile: () => tools.readFile("a".repeat(32)),
      setStandingOrder: () => tools.setStandingOrder("watch"),
    };
    const result = await invoke[operation]();
    assert.equal(result.ok, false);
    const reported = recorded.mock.calls[0]!.arguments[1];
    assert.ok(reported instanceof Error);
    assert.notEqual(reported, error);
    assert.equal(reported.name, error.name);
    assert.equal(reported.stack, redactSecrets(error.stack!));
    assert.equal(reported.cause, undefined);
    assert.ok(!JSON.stringify(reported).includes("surface-secret"));
    assert.ok(!reported.message.includes("surface-secret"));
    assert.equal(errorAlreadyReported(error), true);
    const rows = await errors.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sessionId, "S1");
    assert.equal(rows[0]!.scopeLabel, "channel:C1");
    for (const evidence of ["socket closed", "ECONNRESET", "status=503", "surface-error-evidence.test.ts"])
      assert.ok(rows[0]!.message.includes(evidence), evidence);
    assert.ok(!rows[0]!.message.includes("surface-secret"));
  });
}
