import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { mintCapabilityToken, verifyCapabilityToken, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { packCapabilityParticipants, unpackCapabilityParticipants } from "../src/auth/capability-participants.ts";
import { mintSignedPayload, verifySignedPayload } from "../src/auth/signed-token.ts";
import type { Principal } from "../src/types.ts";

const secret = "participants-test-secret";
const alice: Principal = { id: "alice", type: "internal", teamIds: ["engineering"] };
const bob: Principal = { id: "bob", type: "internal" };
const guest: Principal = { id: "guest", type: "guest" };
const base: CapabilityClaims = { actorId: "alice", scopeId: "channel:room", exp: Date.now() + 60_000 };

test("every encoding preserves distinct authorization audiences, missing rosters, ordering and assertions", async () => {
  const rosters: (Principal[] | undefined)[] = [
    undefined,
    [],
    [alice],
    [alice, bob],
    [guest, alice, alice],
    [{ ...alice, type: "guest" }],
    [{ ...alice, teamIds: ["finance"], displayName: "Alice" }],
  ];
  for (const members of rosters)
    for (const keychainMembers of rosters) {
      const claims = {
        ...base,
        ...(members !== undefined ? { members } : {}),
        ...(keychainMembers !== undefined ? { keychainMembers } : {}),
      };
      const expected = await verifyCapabilityToken(await mintCapabilityToken(claims, secret), secret);
      for (const compression of [false, true]) {
        const actual = await verifyCapabilityToken(
          await mintCapabilityToken(claims, secret, { compression, participants: true }),
          secret,
        );
        assert.deepEqual(actual, expected);
      }
    }
});

test("shared records preserve duplicate positions without introducing mutable aliases", () => {
  const claims = { ...base, members: [alice, bob, alice], keychainMembers: [bob, alice] };
  const packed = packCapabilityParticipants(claims);
  assert.deepEqual(packed.participants, { records: [alice, bob], scope: [0, 1, 0], keychain: [1, 0] });
  const decoded = unpackCapabilityParticipants(packed) as unknown as CapabilityClaims;
  assert.deepEqual(decoded, claims);
  decoded.members![0]!.teamIds!.push("changed");
  assert.deepEqual(decoded.keychainMembers![1]!.teamIds, ["engineering"]);
  assert.deepEqual(decoded.members![2]!.teamIds, ["engineering"]);
});

test("large consolidated tokens round-trip every audience with signature, expiry and rotation checks", async () => {
  const members = Array.from({ length: 120 }, (_, i) => ({
    id: `person-${i}@example.test`,
    type: "internal" as const,
    teamIds: ["engineering"],
    displayName: `Person ${i}`,
  }));
  for (const aud of [
    undefined,
    "control-plane",
    "oauth-consent",
    "credential-broker",
    "egress-proxy",
    "blob-transfer",
    "secret-drop",
  ]) {
    const claims = { ...base, aud, members, keychainMembers: members };
    const legacy = await mintCapabilityToken(claims, secret);
    const consolidated = await mintCapabilityToken(claims, secret, { participants: true });
    assert.ok(consolidated.length < legacy.length * 0.65);
    for (const compression of [false, true]) {
      const token = await mintCapabilityToken(claims, secret, { compression, participants: true });
      assert.deepEqual(
        await verifyCapabilityToken(token, ["old", secret]),
        await verifyCapabilityToken(legacy, secret),
      );
      assert.equal(await verifyCapabilityToken(token, "wrong"), null);
      assert.equal(await verifyCapabilityToken(token, secret, base.exp), null);
      const pieces = token.split(".");
      const signature = Buffer.from(pieces[2]!, "base64url");
      signature[0] = signature[0]! ^ 1;
      pieces[2] = signature.toString("base64url");
      assert.equal(await verifyCapabilityToken(pieces.join("."), secret), null);
      if (compression) assert.ok(token.length < 8192);
    }
    const oldReader = (await verifySignedPayload(consolidated, secret)) as Record<string, unknown>;
    assert.equal(oldReader.actorId, undefined);
    assert.equal(oldReader.scopeId, undefined);
  }
});

test("participant decoding rejects malformed indices, mixed formats and expansion bombs", async () => {
  const valid = { encoding: "participants-v1", claims: base, participants: { records: [alice], scope: [0] } };
  const bad = [
    ...[-1, 1, 0.5, "0", null, Number.MAX_SAFE_INTEGER].map((index) => ({
      ...valid,
      participants: { records: [alice], scope: [index] },
    })),
    ...[null, {}, "0"].map((scope) => ({ ...valid, participants: { records: [alice], scope } })),
    { ...valid, claims: { ...base, members: [] } },
    { ...valid, claims: { ...base, keychainMembers: [] } },
    { ...valid, claims: { ...base, encoding: "participants-v1" } },
    { ...valid, participants: { records: [{ id: "alice", type: "invalid" }], scope: [0] } },
    { ...valid, participants: { records: [{ ...alice, teamIds: [1] }], scope: [0] } },
    { ...valid, participants: { records: [{ ...alice, displayName: "x".repeat(20000) }], scope: Array(60).fill(0) } },
    { ...valid, claims: { ...base, threadRef: "x".repeat(1024 * 1024) } },
  ];
  for (const value of bad) {
    assert.equal(await verifyCapabilityToken(await mintSignedPayload(value, secret), secret), null);
    const envelope = { encoding: "deflate-raw", claims: deflateRawSync(JSON.stringify(value)).toString("base64url") };
    assert.equal(await verifyCapabilityToken(await mintSignedPayload(envelope, secret), secret), null);
  }
  await assert.rejects(
    mintCapabilityToken(
      {
        ...base,
        members: [{ ...alice, displayName: "x".repeat(600000) }],
        keychainMembers: [{ ...alice, displayName: "x".repeat(600000) }],
      },
      secret,
      { participants: true, compression: true },
    ),
    /size limit/,
  );
});
