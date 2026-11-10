import test from "node:test";
import assert from "node:assert/strict";
import { checkControlledLiveSession } from "../src/live-session.ts";

function success(body: string): Record<string, unknown> {
  const request = JSON.parse(body);
  assert.deepEqual(Object.keys(request).sort(), ["expectedDeploymentId", "requestId"]);
  assert.equal(request.expectedDeploymentId, "core:release");
  return { ok: true, requestId: request.requestId, deploymentId: "core:release" };
}

test("live session accepts whitespace heartbeats before the final result", async () => {
  await checkControlledLiveSession("core:release", async (body) => ({
    status: 200,
    body: ` \n\t\n${JSON.stringify(success(body))}\n`,
  }));
});

test("live session requires an explicit final success bound to request and deployment", async () => {
  for (const patch of [
    { ok: false, error: "sensitive server error" },
    { ok: undefined },
    { requestId: "another-request" },
    { deploymentId: "stale" },
  ]) {
    let calls = 0;
    await assert.rejects(
      checkControlledLiveSession("core:release", async (body) => {
        calls++;
        return { status: 200, body: JSON.stringify({ ...success(body), ...patch }) };
      }),
      (error: Error) => {
        assert.match(error.message, /did not confirm success/);
        assert.doesNotMatch(error.message, /sensitive server error/);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("live session never retries an ambiguous, truncated or refused response", async () => {
  for (const kind of ["disconnect", "heartbeat-only", "truncated", "http-error", "superseded"]) {
    let calls = 0;
    await assert.rejects(
      checkControlledLiveSession("core:release", async () => {
        calls++;
        if (kind === "disconnect") throw new Error("Bearer secret must never escape");
        if (kind === "superseded") return { status: 409, body: '{"error":"deployment_smoke_superseded"}' };
        return {
          status: kind === "http-error" ? 503 : 200,
          body: kind === "heartbeat-only" ? " \n\n" : '{"ok":true',
        };
      }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /Bearer secret/);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});
