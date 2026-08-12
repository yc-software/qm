import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateEncodedKeyPair } from "../common/crypto.js";
import { createRelayServer } from "../relay/server.js";

test("relay pairs a CLI and edge without persisting or returning raw secrets", async (t) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "inwise-qm-relay-"));
  const stateFile = join(temporaryDirectory, "state.json");
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  const server = createRelayServer({ pairingTtlMs: 2_000, stateFile });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const cli = generateEncodedKeyPair();
  const edge = generateEncodedKeyPair();

  const createdResponse = await fetch(`${base}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cliPublicKey: cli.publicKey }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as {
    pairingId: string;
    code: string;
    cliToken: string;
  };

  const claimResponse = await fetch(`${base}/v1/pairings/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: created.code,
      edgePublicKey: edge.publicKey,
      deviceName: "Test laptop",
    }),
  });
  assert.equal(claimResponse.status, 200);
  const claimed = (await claimResponse.json()) as {
    deviceId: string;
    edgeToken: string;
    cliPublicKey: string;
  };
  assert.equal(claimed.cliPublicKey, cli.publicKey);

  const statusResponse = await fetch(
    `${base}/v1/pairings/${created.pairingId}`,
    {
      headers: { authorization: `Bearer ${created.cliToken}` },
    },
  );
  const status = (await statusResponse.json()) as Record<string, unknown>;
  assert.deepEqual(status, {
    status: "paired",
    edgePublicKey: edge.publicKey,
    deviceName: "Test laptop",
  });
  assert.equal(JSON.stringify(status).includes(created.cliToken), false);
  assert.equal(JSON.stringify(status).includes(claimed.edgeToken), false);
  const persisted = readFileSync(stateFile, "utf8");
  assert.equal(persisted.includes(created.code), false);
  assert.equal(persisted.includes(created.cliToken), false);
  assert.equal(persisted.includes(claimed.edgeToken), false);

  const unauthorized = await fetch(`${base}/v1/pairings/${created.pairingId}`, {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(unauthorized.status, 401);
});
