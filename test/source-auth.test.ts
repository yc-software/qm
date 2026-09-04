import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSourceAuth,
  signRequest,
  verifySignature,
  SOURCE_AUTH_REPLAY_WINDOW_MS,
} from "../src/auth/source-auth.ts";
import { createMemoryReplayDedupe } from "../src/auth/replay-dedupe.ts";

const SECRET = "unit-test-secret";
const W = SOURCE_AUTH_REPLAY_WINDOW_MS;

function signedReq(tsSec: number, body: string, eventId = `evt-${tsSec}-${body}`) {
  return { signature: signRequest(SECRET, tsSec, body), timestamp: tsSec, body, eventId };
}

test("a non-numeric timestamp is rejected even when the signature matches the NaN canonical string", () => {
  const body = "POST\n/v1/turns\n{}";
  const forged = { signature: signRequest(SECRET, Number.NaN, body), timestamp: Number.NaN, body };
  const r = verifySignature(SECRET, forged, Date.now(), W);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /invalid timestamp/);
});

test("verify: accepts a fresh signed request once, rejects the replay as a duplicate", async () => {
  const clock = 1_000_000_000_000;
  const auth = createSourceAuth({ signingSecret: SECRET, now: () => clock });
  const req = signedReq(Math.floor(clock / 1000), "hello");
  assert.deepEqual(await auth.verify(req), { ok: true });
  const replay = await auth.verify(req);
  assert.equal(replay.ok, false);
  assert.match((replay as { reason: string }).reason, /duplicate/);
});

test("dedupe covers the FULL acceptance window: a future-stamped request can't be replayed late in its life", async () => {
  let clock = 1_000_000_000_000;
  const t0 = clock;
  const auth = createSourceAuth({ signingSecret: SECRET, now: () => clock });

  const futureTs = Math.floor((t0 + W) / 1000);
  const req = signedReq(futureTs, "future-stamped");
  assert.deepEqual(await auth.verify(req), { ok: true });

  for (let i = 1; i <= 3; i++) {
    clock = t0 + Math.floor((i * W) / 2);
    assert.deepEqual(await auth.verify(signedReq(Math.floor(clock / 1000), `filler-${i}`)), { ok: true });
  }

  clock = t0 + Math.floor(1.9 * W);
  const replay = await auth.verify(req);
  assert.equal(replay.ok, false);
  assert.match((replay as { reason: string }).reason, /duplicate/);

  clock = futureTs * 1000 + W + 1000;
  const stale = await auth.verify(req);
  assert.equal(stale.ok, false);
  assert.match((stale as { reason: string }).reason, /stale/);
});

test("a replay at the exact staleness boundary (|now - ts| == window) is still a duplicate", async () => {
  let clock = 1_000_000_000_000;
  const auth = createSourceAuth({ signingSecret: SECRET, now: () => clock });
  const ts = Math.floor(clock / 1000);
  const req = signedReq(ts, "boundary");
  assert.deepEqual(await auth.verify(req), { ok: true });

  clock = ts * 1000 + W;
  const replay = await auth.verify(req);
  assert.equal(replay.ok, false);
  assert.match((replay as { reason: string }).reason, /duplicate/);
});

test("a shared dedupe store closes the cross-instance replay window", async () => {
  const clock = 1_000_000_000_000;
  const now = () => clock;
  const shared = createMemoryReplayDedupe(now);
  const instanceA = createSourceAuth({ signingSecret: SECRET, now, dedupe: shared });
  const instanceB = createSourceAuth({ signingSecret: SECRET, now, dedupe: shared });

  const req = signedReq(Math.floor(clock / 1000), "cross-instance");
  assert.deepEqual(await instanceA.verify(req), { ok: true });
  const replay = await instanceB.verify(req);
  assert.equal(replay.ok, false);
  assert.match((replay as { reason: string }).reason, /duplicate/);
});
