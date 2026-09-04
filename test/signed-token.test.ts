import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeProtectedHeader } from "jose";
import { mintSignedPayload, signingKeyId, verifySignedPayload } from "../src/auth/signed-token.ts";

const SECRET = "test-secret";

test("round-trips an arbitrary JSON value", async () => {
  const value = { actorId: "U1", nested: { n: 7 }, list: ["a", "b"] };
  const token = await mintSignedPayload(value, SECRET);
  assert.deepEqual(await verifySignedPayload(token, SECRET), value);
});

test("mints a compact JWS with an HS256 alg header and a kid derived from the secret", async () => {
  const token = await mintSignedPayload({ ok: true }, SECRET);
  assert.equal(token.split(".").length, 3);
  const header = decodeProtectedHeader(token);
  assert.equal(header.alg, "HS256");
  assert.equal(header.kid, signingKeyId(SECRET));
});

test("rejects tampered payloads, tampered signatures, and the wrong secret", async () => {
  const token = await mintSignedPayload({ ok: true }, SECRET);
  const [, payload] = (await mintSignedPayload({ ok: false }, SECRET)).split(".");
  const [header, , sig] = token.split(".");
  assert.equal(await verifySignedPayload(`${header}.${payload}.${sig}`, SECRET), null);
  assert.equal(await verifySignedPayload(token.slice(0, -1) + "X", SECRET), null);
  assert.equal(await verifySignedPayload(token, "other-secret"), null);
});

test("key rotation: a verifier holding several secrets accepts tokens minted under any of them", async () => {
  const oldSecret = "old-secret";
  const oldToken = await mintSignedPayload({ v: 1 }, oldSecret);
  const newToken = await mintSignedPayload({ v: 2 }, SECRET);
  assert.deepEqual(await verifySignedPayload(oldToken, [SECRET, oldSecret]), { v: 1 });
  assert.deepEqual(await verifySignedPayload(newToken, [SECRET, oldSecret]), { v: 2 });
  assert.equal(await verifySignedPayload(oldToken, [SECRET]), null);
});

test("malformed tokens are null, never throws", async () => {
  for (const bad of ["", ".", "x", ".sig", "payload.", "a.b.c", "..", " . ", "a.b.c.d"]) {
    assert.equal(await verifySignedPayload(bad, SECRET), null, JSON.stringify(bad));
  }
});

test("still verifies the retired HMAC wire formats (hex and base64url digests)", async () => {
  assert.deepEqual(
    await verifySignedPayload(
      "eyJhY3RvcklkIjoiVTEiLCJzY29wZUlkIjoicGVyc29uYWw6VTEiLCJleHAiOjE3ODEwMDAwMDAwMDB9." +
        "48970bbdda5eb8744f1b8e134266e028b8291100ad3a864d2aea9556b4375890",
      "s3cret",
    ),
    { actorId: "U1", scopeId: "personal:U1", exp: 1781000000000 },
  );
  assert.deepEqual(
    await verifySignedPayload(
      "eyJkZXBsb3ltZW50SWQiOiJkLTEiLCJleHAiOjE3ODEwMDAwMDAwMDB9." + "HrVy5rOz6W6IbfEdNPhUsmVbOjuhId7wMnnSTL2EQSk",
      "s3cret",
    ),
    { deploymentId: "d-1", exp: 1781000000000 },
  );
});

test("a legacy token verifies under a rotated secret list too", async () => {
  const legacy =
    "eyJkZXBsb3ltZW50SWQiOiJkLTEiLCJleHAiOjE3ODEwMDAwMDAwMDB9." + "HrVy5rOz6W6IbfEdNPhUsmVbOjuhId7wMnnSTL2EQSk";
  assert.deepEqual(await verifySignedPayload(legacy, ["new-secret", "s3cret"]), {
    deploymentId: "d-1",
    exp: 1781000000000,
  });
  assert.equal(await verifySignedPayload(legacy, ["new-secret"]), null);
});
