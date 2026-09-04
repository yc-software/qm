import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { getVerifier } from "../src/webhooks/verifiers.ts";

const SECRET = "shhh";
const hmac = (body: string, prefix = "") => prefix + createHmac("sha256", SECRET).update(body).digest("hex");

test("github verifier accepts a valid X-Hub-Signature-256 and rejects a forged one", () => {
  const v = getVerifier("github")!;
  const rawBody = JSON.stringify({ action: "opened" });
  const good = {
    secret: SECRET,
    headers: { "x-hub-signature-256": hmac(rawBody, "sha256="), "x-github-delivery": "d-1" },
    rawBody,
  };
  assert.equal(v.verify(good), true);
  assert.equal(v.verify({ ...good, rawBody: rawBody + "x" }), false);
  assert.equal(v.verify({ ...good, secret: undefined }), false);
});

test("github dedup key ignores the unsigned delivery header, so a replay with a fresh id still dedups", () => {
  const v = getVerifier("github")!;
  const rawBody = JSON.stringify({ action: "opened" });
  const replayed = { secret: SECRET, headers: { "x-github-delivery": "d-1" }, rawBody };
  const freshId = { secret: SECRET, headers: { "x-github-delivery": "d-2" }, rawBody };
  assert.equal(v.deliveryId(replayed), v.deliveryId(freshId));
  assert.notEqual(v.deliveryId(replayed), v.deliveryId({ ...replayed, rawBody: JSON.stringify({ action: "closed" }) }));
});

test("github verifier treats a ping event as a handshake (ack, no turn)", () => {
  const v = getVerifier("github")!;
  const rawBody = "{}";
  const input = {
    secret: SECRET,
    headers: { "x-hub-signature-256": hmac(rawBody, "sha256="), "x-github-event": "ping" },
    rawBody,
  };
  assert.equal(v.handshake?.(input, {}), "pong");
  assert.equal(v.handshake?.({ ...input, headers: { "x-github-event": "push" } }, {}), null);
});

test("slack verifier validates v0 signature over v0:ts:body and echoes url_verification", () => {
  const v = getVerifier("slack")!;
  const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = hmac(`v0:${ts}:${rawBody}`, "v0=");
  const input = { secret: SECRET, headers: { "x-slack-signature": sig, "x-slack-request-timestamp": ts }, rawBody };
  assert.equal(v.verify(input), true);
  assert.equal(v.handshake?.(input, JSON.parse(rawBody)), "abc123");
  assert.equal(
    v.verify({ ...input, headers: { "x-slack-signature": sig, "x-slack-request-timestamp": String(Number(ts) + 1) } }),
    false,
  );
});

test("slack verifier rejects stale or garbage timestamps even when the signature matches", () => {
  const v = getVerifier("slack")!;
  const rawBody = JSON.stringify({ event_id: "Ev1" });
  const stale = String(Math.floor(Date.now() / 1000) - 6 * 60);
  const staleSig = hmac(`v0:${stale}:${rawBody}`, "v0=");
  assert.equal(
    v.verify({
      secret: SECRET,
      headers: { "x-slack-signature": staleSig, "x-slack-request-timestamp": stale },
      rawBody,
    }),
    false,
  );
  const garbageSig = hmac(`v0:nonsense:${rawBody}`, "v0=");
  assert.equal(
    v.verify({
      secret: SECRET,
      headers: { "x-slack-signature": garbageSig, "x-slack-request-timestamp": "nonsense" },
      rawBody,
    }),
    false,
  );
});

test("slack dedup key is the signed body's event_id, not the unsigned x-slack-event-id header", () => {
  const v = getVerifier("slack")!;
  const rawBody = JSON.stringify({ event_id: "Ev1" });
  assert.equal(v.deliveryId({ headers: { "x-slack-event-id": "Ev-forged" }, rawBody }), "Ev1");
  const formBody = "payload=%7B%7D";
  assert.equal(
    v.deliveryId({ headers: {}, rawBody: formBody }),
    v.deliveryId({ headers: { "x-slack-event-id": "other" }, rawBody: formBody }),
  );
});

test("stripe verifier validates t=…,v1=… over `t.body` and uses the event id for dedup", () => {
  const v = getVerifier("stripe")!;
  const rawBody = JSON.stringify({ id: "evt_123", type: "charge.failed" });
  const t = "1700000000";
  const v1 = hmac(`${t}.${rawBody}`);
  const input = { secret: SECRET, headers: { "stripe-signature": `t=${t},v1=${v1}` }, rawBody };
  assert.equal(v.verify(input), true);
  assert.equal(v.deliveryId(input), "evt_123");
  assert.equal(v.verify({ ...input, headers: { "stripe-signature": `t=${t},v1=deadbeef` } }), false);
});

test("stripe verifier accepts any valid v1 signature during key rotation", () => {
  const v = getVerifier("stripe")!;
  const rawBody = JSON.stringify({ id: "evt_rot" });
  const t = "1700000000";
  const valid = hmac(`${t}.${rawBody}`);
  const rotated = { secret: SECRET, headers: { "stripe-signature": `t=${t},v1=oldkeysig,v1=${valid}` }, rawBody };
  assert.equal(v.verify(rotated), true);
  assert.equal(v.verify({ ...rotated, headers: { "stripe-signature": `t=${t},v1=oldkeysig,v1=alsobad` } }), false);
});

test("hmac-sha256 verifier accepts bare hex or sha256= prefixed signatures", () => {
  const v = getVerifier("hmac-sha256")!;
  const rawBody = "payload";
  assert.equal(v.verify({ secret: SECRET, headers: { "x-signature": hmac(rawBody) }, rawBody }), true);
  assert.equal(v.verify({ secret: SECRET, headers: { "x-signature": hmac(rawBody, "sha256=") }, rawBody }), true);
  assert.equal(v.verify({ secret: SECRET, headers: { "x-signature": "nope" }, rawBody }), false);
});

test("hmac-sha256 dedup key is the signed body, ignoring the unsigned x-delivery-id header", () => {
  const v = getVerifier("hmac-sha256")!;
  const rawBody = "payload";
  assert.equal(
    v.deliveryId({ headers: { "x-delivery-id": "a" }, rawBody }),
    v.deliveryId({ headers: { "x-delivery-id": "b" }, rawBody }),
  );
});

test("an unknown scheme has no verifier", () => {
  assert.equal(getVerifier("paypal"), null);
  assert.equal(getVerifier("none"), null);
});
