import { test } from "node:test";
import assert from "node:assert/strict";

import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import {
  piLastAssistantTextOrThrow,
  piTurnError,
} from "../src/harness/pi-harness.ts";
import { retryBackoffMs } from "../src/runs/run-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";

const actor: Principal = { id: "internal:U1", type: "internal" };
function turn(text: string): OrchestratorInput {
  return {
    actor,
    conversation: { kind: "dm", threadRef: "t-602", audience: [actor] },
    origin: { kind: "direct" },
    text,
  };
}

/** A pi AssistantTextSession whose last assistant message stopped with `error`. */
function errorSession(errorMessage: string): {
  getLastAssistantText: () => string;
  messages: unknown[];
} {
  return {
    getLastAssistantText: () => "",
    messages: [{ role: "assistant", stopReason: "error", errorMessage }],
  };
}

test("a rate-limit provider error is retryable, not terminal (#602)", () => {
  // The exact failure shape from the issue's runs table: a rate limit that
  // used to park the run after one attempt because every provider error was
  // classified NonRetryableTurnError.
  const session = errorSession(
    '{"error":{"type":"rate_limit_error","message":"[1113][Insufficient balance]"}}',
  );
  assert.throws(() => piLastAssistantTextOrThrow(session as never), (err: Error) => {
    assert.equal(err instanceof NonRetryableTurnError, false, "rate limit must be retryable");
    assert.match(err.message, /rate_limit_error/);
    return true;
  });
  const turnErr = piTurnError(session as never, new Error("wrapped"));
  assert.equal(turnErr instanceof NonRetryableTurnError, false);
});

test("transient provider errors (overload, 5xx, timeout) are retryable (#602)", () => {
  for (const type of ["overloaded_error", "api_error", "server_error", "timeout_error"]) {
    const session = errorSession(`{"error":{"type":"${type}","message":"brief provider hiccup"}}`);
    const err = piTurnError(session as never, new Error("wrapped"));
    assert.equal(
      err instanceof NonRetryableTurnError,
      false,
      `${type} must be retryable`,
    );
  }
});

test("permanent provider errors stay non-retryable (#602)", () => {
  for (const type of ["authentication_error", "permission_error", "invalid_request_error"]) {
    const session = errorSession(`{"error":{"type":"${type}","message":"bad key"}}`);
    const err = piTurnError(session as never, new Error("wrapped"));
    assert.ok(err instanceof NonRetryableTurnError, `${type} must stay non-retryable`);
    assert.match(err.message, new RegExp(type));
  }
});

test("non-JSON provider errors keep the historical non-retryable class", () => {
  const session = errorSession("plain provider failure text");
  assert.ok(piTurnError(session as never, new Error("wrapped")) instanceof NonRetryableTurnError);
});

test("retryBackoffMs spaces error retries exponentially (#602)", () => {
  assert.equal(retryBackoffMs(1), 5_000);
  assert.equal(retryBackoffMs(2), 10_000);
  assert.equal(retryBackoffMs(3), 20_000);
  assert.equal(retryBackoffMs(9), 60_000, "capped at 60s");
});

test("an error-requeued run is not claimable until the backoff passes (#602)", async () => {
  const { runs } = createMemoryRunStore();
  const { run } = await runs.enqueue({ sessionId: "s-602", request: turn("hi") });

  const first = await runs.claim("w1", 60_000);
  assert.ok(first, "first claim succeeds");

  const requeued = await runs.fail(run!.id, first!.leaseToken!, "Model provider API error", {
    retry: true,
  });
  assert.equal(requeued.requeued, true);

  // Inside the backoff window the retry is NOT claimable — the retry used to
  // be immediate, re-hitting a rate-limited provider back-to-back.
  const tooSoon = await runs.claim("w1", 60_000);
  assert.equal(tooSoon, null, "backed-off retry must not be claimable");

  // claimById honors the same not-before.
  const byId = await runs.claimById(run!.id, "w1", 60_000);
  assert.equal(byId, null, "claimById honors the backoff window");
});

test("a fresh run (no error) is claimable immediately (#602)", async () => {
  const { runs } = createMemoryRunStore();
  await runs.enqueue({ sessionId: "s-602b", request: turn("hi") });
  const claimed = await runs.claim("w1", 60_000);
  assert.ok(claimed, "no backoff on the first attempt");
});
