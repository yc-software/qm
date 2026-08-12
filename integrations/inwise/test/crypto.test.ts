import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptJson,
  derivePairingKey,
  encryptJson,
  generateEncodedKeyPair,
  pairingVerificationCode,
  requestAad,
} from "../common/crypto.js";

test("pairing peers derive the same key and decrypt authenticated JSON", () => {
  const cli = generateEncodedKeyPair();
  const edge = generateEncodedKeyPair();
  const cliKey = derivePairingKey(cli.privateKey, edge.publicKey, "pair-1");
  const edgeKey = derivePairingKey(edge.privateKey, cli.publicKey, "pair-1");
  assert.deepEqual(cliKey, edgeKey);
  assert.equal(
    pairingVerificationCode(cliKey, "pair-1"),
    pairingVerificationCode(edgeKey, "pair-1"),
  );

  const attacker = generateEncodedKeyPair();
  const attackedKey = derivePairingKey(
    cli.privateKey,
    attacker.publicKey,
    "pair-1",
  );
  assert.notEqual(
    pairingVerificationCode(cliKey, "pair-1"),
    pairingVerificationCode(attackedKey, "pair-1"),
  );

  const aad = requestAad("pair-1", "request-1");
  const envelope = encryptJson(cliKey, { query: "launch" }, aad);
  assert.deepEqual(decryptJson(edgeKey, envelope, aad), { query: "launch" });
  assert.throws(() =>
    decryptJson(edgeKey, envelope, requestAad("pair-1", "wrong")),
  );
});
