import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalPayload, signRequest } from "../src/auth/source-auth-sign.ts";
import {
  createSignedPrivateTurnObserver,
  privateTurnObserverSignaturePayload,
} from "../src/api/signed-private-turn-observer.ts";
import { observePrivateTurn, type PrivateTurnObservation } from "../src/api/private-turn-observer.ts";

const secret = "private-turn-observer-signing-secret-0123456789";
const observation: PrivateTurnObservation = {
  source: "web_chat",
  eventRef: `qm-private-turn:${"a".repeat(64)}`,
  conversationRef: "web:owner:private",
  principalRef: "internal:owner",
  audienceRef: "personal:internal:owner",
  workspaceRef: "org:default-org",
  observedAt: "2026-08-28T00:00:00.000Z",
  inputSha256: "b".repeat(64),
};

test("signed private-turn observer sends a redirect-refusing idempotent canonical request", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const observer = createSignedPrivateTurnObserver({
    endpoint: "https://observer.example.test/v1/private-turns?tenant=default",
    signingSecret: secret,
    now: () => 1_777_593_600_000,
    fetch: async (input, init) => {
      captured = { url: String(input), init: init ?? {} };
      return new Response(null, { status: 202 });
    },
  });
  assert.equal(await observer.observe(observation), "accepted");
  assert.equal(captured?.url, "https://observer.example.test/v1/private-turns?tenant=default");
  assert.equal(captured?.init.method, "POST");
  assert.equal(captured?.init.redirect, "error");
  const body = captured?.init.body as string;
  assert.equal(body.includes("private secret"), false);
  const headers = captured?.init.headers as Record<string, string>;
  assert.equal(headers["x-idempotency-key"], observation.eventRef);
  assert.equal(JSON.parse(body).eventRef, headers["x-idempotency-key"]);
  assert.equal(headers["x-timestamp"], "1777593600");
  assert.equal(
    headers["x-signature"],
    signRequest(
      secret,
      1_777_593_600,
      canonicalPayload(
        "POST",
        "/v1/private-turns?tenant=default",
        privateTurnObserverSignaturePayload(headers["x-idempotency-key"], body),
      ),
    ),
  );
  assert.notEqual(
    headers["x-signature"],
    signRequest(
      secret,
      1_777_593_600,
      canonicalPayload(
        "POST",
        "/v1/private-turns?tenant=default",
        privateTurnObserverSignaturePayload(`qm-private-turn:${"f".repeat(64)}`, body),
      ),
    ),
  );
  const tamperedBody = JSON.stringify({ ...JSON.parse(body), eventRef: `qm-private-turn:${"e".repeat(64)}` });
  assert.notEqual(
    headers["x-signature"],
    signRequest(
      secret,
      1_777_593_600,
      canonicalPayload(
        "POST",
        "/v1/private-turns?tenant=default",
        privateTurnObserverSignaturePayload(headers["x-idempotency-key"], tamperedBody),
      ),
    ),
  );
});

test("private-turn observer timeout aborts the active fetch and completes cleanup", async () => {
  let active = 0;
  let aborted = 0;
  let capturedSignal: AbortSignal | undefined;
  const observer = createSignedPrivateTurnObserver({
    endpoint: "https://observer.example.test/private-turns",
    signingSecret: secret,
    fetch: async (_input, init) => {
      active += 1;
      capturedSignal = init?.signal ?? undefined;
      await new Promise<void>((_resolve, reject) => {
        capturedSignal?.addEventListener(
          "abort",
          () => {
            active -= 1;
            aborted += 1;
            reject(capturedSignal?.reason);
          },
          { once: true },
        );
      });
      throw new Error("unreachable");
    },
  });
  assert.equal(await observePrivateTurn(observer, observation, 5), "unconfirmed");
  assert.equal(capturedSignal?.aborted, true);
  assert.equal(aborted, 1);
  assert.equal(active, 0);
});

test("timed-out retries share one network attempt until an abort-resistant fetch settles", async () => {
  let attempts = 0;
  let active = 0;
  let maximumActive = 0;
  let release: (() => void) | undefined;
  let capturedSignal: AbortSignal | undefined;
  const observer = createSignedPrivateTurnObserver({
    endpoint: "https://observer.example.test/private-turns",
    signingSecret: secret,
    fetch: async (_input, init) => {
      attempts += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      capturedSignal = init?.signal ?? undefined;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      active -= 1;
      return new Response(null, { status: 202 });
    },
  });
  assert.equal(await observePrivateTurn(observer, observation, 5), "unconfirmed");
  assert.equal(capturedSignal?.aborted, true);
  assert.throws(
    () => observer.observe({ ...observation, inputSha256: "c".repeat(64) }),
    /identity is already bound to a different observation/u,
  );
  assert.equal(await observePrivateTurn(observer, observation, 5), "unconfirmed");
  assert.equal(attempts, 1);
  assert.equal(maximumActive, 1);
  release?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 0);

  const afterCleanup = observer.observe(observation);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  release?.();
  assert.equal(await afterCleanup, "accepted");
  assert.equal(maximumActive, 1);
});

test("signed private-turn observer maps duplicate and retry-safe status classes", async () => {
  for (const [status, expected] of [
    [208, "duplicate"],
    [409, "duplicate"],
    [429, "unconfirmed"],
    [500, "unconfirmed"],
  ] as const) {
    const observer = createSignedPrivateTurnObserver({
      endpoint: "https://observer.example.test/private-turns",
      signingSecret: secret,
      fetch: async () => new Response(null, { status }),
    });
    assert.equal(await observer.observe(observation), expected);
  }
});

test("signed private-turn observer rejects unsafe endpoints and weak secrets", () => {
  for (const endpoint of [
    "http://observer.example.test/private-turns",
    "https://user:pass@observer.example.test/private-turns",
    "https://observer.example.test/private-turns#fragment",
    "https://observer.example.test./private-turns",
  ]) {
    assert.throws(
      () => createSignedPrivateTurnObserver({ endpoint, signingSecret: secret }),
      /endpoint must be an HTTPS URL/u,
    );
  }
  assert.throws(
    () =>
      createSignedPrivateTurnObserver({
        endpoint: "https://observer.example.test/private-turns",
        signingSecret: "short",
      }),
    /at least 32 characters/u,
  );
});
