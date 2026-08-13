import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  decryptJson,
  derivePairingKey,
  encryptJson,
  generateEncodedKeyPair,
  requestAad,
  responseAad,
} from "../common/crypto.js";
import type { BridgeRequest, EncryptedEnvelope, PairingFile, RelayRequest } from "../common/protocol.js";
import { callInwise } from "../cli/commands.js";
import { createRelayServer } from "../relay/server.js";
import { MemoryRelayStore } from "../relay/store.js";

test("CLI and edge exchange only encrypted read-only calls through the relay", async (t) => {
  const server = createRelayServer({ requestTimeoutMs: 3_000 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const relayUrl = `http://127.0.0.1:${port}`;
  const cliKeys = generateEncodedKeyPair();
  const edgeKeys = generateEncodedKeyPair();

  const created = (await fetch(`${relayUrl}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cliPublicKey: cliKeys.publicKey }),
  }).then((response) => response.json())) as {
    pairingId: string;
    code: string;
    cliToken: string;
  };
  const claimed = (await fetch(`${relayUrl}/v1/pairings/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: created.code,
      edgePublicKey: edgeKeys.publicKey,
      deviceName: "Test",
    }),
  }).then((response) => response.json())) as {
    deviceId: string;
    edgeToken: string;
  };

  const config: PairingFile = {
    pairingId: created.pairingId,
    relayUrl,
    cliToken: created.cliToken,
    cliPublicKey: cliKeys.publicKey,
    cliPrivateKey: cliKeys.privateKey,
    edgePublicKey: edgeKeys.publicKey,
    confirmedAt: new Date(0).toISOString(),
  };
  const key = derivePairingKey(edgeKeys.privateKey, cliKeys.publicKey, created.pairingId);

  await assert.rejects(
    () => callInwise({ ...config, confirmedAt: undefined }, "search_meetings", { query: "launch plan" }),
    /Pairing keys are not verified/,
  );

  const edge = (async () => {
    const polled = await fetch(`${relayUrl}/v1/devices/${claimed.deviceId}/requests?wait=2`, {
      headers: { authorization: `Bearer ${claimed.edgeToken}` },
    });
    assert.equal(polled.status, 200);
    const request = (await polled.json()) as RelayRequest;
    assert.equal(JSON.stringify(request.envelope).includes("launch plan"), false);
    const command = decryptJson<BridgeRequest>(key, request.envelope, requestAad(created.pairingId, request.requestId));
    assert.deepEqual(command, {
      tool: "search_meetings",
      args: { query: "launch plan" },
    });
    const envelope: EncryptedEnvelope = encryptJson(
      key,
      { ok: true, result: [{ id: "meeting-1", title: "Launch review" }] },
      responseAad(created.pairingId, request.requestId),
    );
    const responded = await fetch(`${relayUrl}/v1/devices/${claimed.deviceId}/requests/${request.requestId}/response`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${claimed.edgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ envelope }),
    });
    assert.equal(responded.status, 204);
  })();

  const result = await callInwise(config, "search_meetings", {
    query: "launch plan",
  });
  await edge;
  assert.deepEqual(result, [{ id: "meeting-1", title: "Launch review" }]);

  await assert.rejects(() => callInwise(config, "update_action_status", {}), /Unsupported or write-capable tool/);
});

test("CLI resumes polling an accepted request after relay restart", async () => {
  const store = new MemoryRelayStore();
  const first = createRelayServer({ store, requestTimeoutMs: 5_000 });
  await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
  const { port } = first.address() as AddressInfo;
  const relayUrl = `http://127.0.0.1:${port}`;
  const cliKeys = generateEncodedKeyPair();
  const edgeKeys = generateEncodedKeyPair();
  const created = (await fetch(`${relayUrl}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cliPublicKey: cliKeys.publicKey }),
  }).then((response) => response.json())) as {
    pairingId: string;
    code: string;
    cliToken: string;
  };
  const claimed = (await fetch(`${relayUrl}/v1/pairings/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: created.code,
      edgePublicKey: edgeKeys.publicKey,
      deviceName: "Restart test",
    }),
  }).then((response) => response.json())) as {
    deviceId: string;
    edgeToken: string;
  };
  const config: PairingFile = {
    pairingId: created.pairingId,
    relayUrl,
    cliToken: created.cliToken,
    cliPublicKey: cliKeys.publicKey,
    cliPrivateKey: cliKeys.privateKey,
    edgePublicKey: edgeKeys.publicKey,
    confirmedAt: new Date(0).toISOString(),
  };
  const resultPromise = callInwise(config, "get_connection_status", {});
  const polled = await fetch(`${relayUrl}/v1/devices/${claimed.deviceId}/requests?wait=2`, {
    headers: { authorization: `Bearer ${claimed.edgeToken}` },
  });
  assert.equal(polled.status, 200);
  const request = (await polled.json()) as RelayRequest;
  await new Promise<void>((resolve) => first.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 300));

  const second = createRelayServer({ store, requestTimeoutMs: 5_000 });
  await new Promise<void>((resolve) => second.listen(port, "127.0.0.1", resolve));
  try {
    const key = derivePairingKey(edgeKeys.privateKey, cliKeys.publicKey, created.pairingId);
    const envelope = encryptJson(
      key,
      { ok: true, result: { connected: true } },
      responseAad(created.pairingId, request.requestId),
    );
    const responded = await fetch(`${relayUrl}/v1/devices/${claimed.deviceId}/requests/${request.requestId}/response`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${claimed.edgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ envelope }),
    });
    assert.equal(responded.status, 204);
    assert.deepEqual(await resultPromise, { connected: true });
  } finally {
    await new Promise<void>((resolve) => second.close(() => resolve()));
  }
});
